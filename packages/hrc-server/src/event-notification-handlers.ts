import { createHash, randomUUID } from 'node:crypto'

import type { HrcDomainError } from 'hrc-core'
import type {
  FederationInteractiveLifecycleSignal,
  HrcEventEnvelope,
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { appendHrcEvent } from './hrc-event-helper.js'
import { extractTextFromTurnMessagePayload } from './messages.js'
import { isRecord } from './parsers/common.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { TurnResponseFinalizer } from './server-types.js'
import { timestamp } from './server-util.js'

export function appendEvent(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  eventKind: string,
  eventJson: Record<string, unknown>
): HrcLifecycleEvent {
  return appendHrcEvent(this.db, eventKind, {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    payload: eventJson,
  })
}

export function appendInflightRejected(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtimeId: string,
  runId: string,
  reason: string,
  prompt: string,
  inputType: string | undefined,
  error: HrcDomainError
): HrcDomainError {
  const knownRun = this.db.runs.getByRunId(runId)
  const event = appendHrcEvent(this.db, 'inflight.rejected', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    ...(knownRun ? { runId } : {}),
    runtimeId,
    errorCode: error.code,
    payload: {
      reason,
      requestedRunId: runId,
      prompt,
      ...(inputType ? { inputType } : {}),
    },
  })
  this.notifyEvent(event)
  return error
}

export function notifyEvent(
  this: HrcServerInstanceForHandlers,
  event: HrcEventEnvelope | HrcLifecycleEvent
): void {
  for (const subscriber of this.followSubscribers) {
    subscriber(event)
  }
  // Project canonical lifecycle events onto headless-viewer status bars. Pure
  // observer: never authority, never throws, never blocks dispatch (T-04439).
  this.headlessViewerStatus.observe(event)
  if ('hrcSeq' in event) {
    this.maybeRelayFederatedInteractiveLifecycle(event)
  }
  if (
    'hrcSeq' in event &&
    (event.eventKind === 'turn.completed' ||
      event.eventKind === 'turn.failed' ||
      event.eventKind === 'turn.interrupted' ||
      event.eventKind === 'turn.zombied' ||
      event.eventKind === 'turn.reaped')
  ) {
    // The durable row is claimed atomically by the drain. Do not await here:
    // notification fan-out must remain synchronous, and duplicate terminal
    // projections are harmless because only one drain per session can run.
    void this.drainDurableHeadlessTurnInputs(event.hostSessionId)
  }
  if (
    'hrcSeq' in event &&
    (event.eventKind === 'turn.completed' ||
      event.eventKind === 'turn.zombied' ||
      event.eventKind === 'turn.reaped') &&
    event.runId
  ) {
    this.finalizeSemanticTurnResponse(event)
  }
}

export function notifyMessageSubscribers(
  this: HrcServerInstanceForHandlers,
  record: HrcMessageRecord
): void {
  for (const subscriber of this.messageSubscribers) {
    subscriber(record)
  }
}

export function insertAndNotifyMessage(
  this: HrcServerInstanceForHandlers,
  input: Parameters<HrcDatabase['messages']['insert']>[0]
): HrcMessageRecord {
  const record = this.db.messages.insert(input)
  this.notifyMessageSubscribers(record)
  this.maybeCompleteInteractiveSemanticTurn(record)
  return record
}

export function maybeCompleteInteractiveSemanticTurn(
  this: HrcServerInstanceForHandlers,
  response: HrcMessageRecord
): void {
  if (
    response.kind !== 'dm' ||
    response.phase !== 'response' ||
    response.replyToMessageId === undefined
  ) {
    return
  }

  const request = this.db.messages.getById(response.replyToMessageId)
  if (
    !request ||
    request.execution.mode !== 'interactive' ||
    (request.execution.transport !== 'tmux' && request.execution.transport !== 'ghostty') ||
    request.execution.runId === undefined ||
    request.execution.hostSessionId === undefined ||
    request.execution.generation === undefined
  ) {
    return
  }
  const transport = request.execution.transport

  const runId = request.execution.runId
  const run = this.db.runs.getByRunId(runId)
  if (!run || run.completedAt !== undefined || run.status === 'completed') {
    return
  }
  const runtime =
    request.execution.runtimeId !== undefined
      ? this.db.runtimes.getByRuntimeId(request.execution.runtimeId)
      : null

  if (runtime?.controllerKind === 'harness-broker') {
    this.db.messages.updateExecution(response.messageId, {
      state: 'completed',
      mode: 'interactive',
      sessionRef: request.execution.sessionRef,
      hostSessionId: request.execution.hostSessionId,
      generation: request.execution.generation,
      runtimeId: request.execution.runtimeId,
      runId,
      transport,
    })
    this.db.messages.updateExecution(request.messageId, {
      state: 'completed',
    })
    this.turnResponseFinalizers.delete(runId)

    writeServerLog('INFO', 'semantic_turn.interactive_broker_response_recorded', {
      requestMessageId: request.messageId,
      responseMessageId: response.messageId,
      runId,
      state: 'completed',
    })
    return
  }

  const now = timestamp()
  this.db.runs.markCompleted(runId, {
    status: 'completed',
    completedAt: now,
    updatedAt: now,
  })

  this.db.messages.updateExecution(response.messageId, {
    state: 'completed',
    mode: 'interactive',
    sessionRef: request.execution.sessionRef,
    hostSessionId: request.execution.hostSessionId,
    generation: request.execution.generation,
    runtimeId: request.execution.runtimeId,
    runId,
    transport,
  })
  this.db.messages.updateExecution(request.messageId, {
    state: 'completed',
  })

  const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
    ts: now,
    hostSessionId: request.execution.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: request.execution.generation,
    runId,
    runtimeId: request.execution.runtimeId,
    transport,
    payload: {
      success: true,
      transport,
      delivery: 'interactive-literal',
      body: response.body,
      replyMessageId: response.messageId,
    },
  })
  this.notifyEvent(completedEvent)

  writeServerLog('INFO', 'semantic_turn.interactive_response_finalized', {
    requestMessageId: request.messageId,
    responseMessageId: response.messageId,
    runId,
    state: 'completed',
  })
}

function deterministicInteractiveSignalMessageId(requestMessageId: string, sourceHrcSeq: number) {
  const hex = createHash('sha256')
    .update(`federation-interactive-signal\0${requestMessageId}\0${sourceHrcSeq}`)
    .digest('hex')
    .slice(0, 32)
    .split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `msg-${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function acpRunIdFromFederatedRequest(request: HrcMessageRecord): string | undefined {
  const ingress = request.metadataJson?.['federationIngress']
  if (!isRecord(ingress)) return undefined
  const delivery = ingress['delivery']
  if (!isRecord(delivery)) return undefined
  const runtimeIntent = delivery['runtimeIntent']
  if (!isRecord(runtimeIntent)) return undefined
  const launch = runtimeIntent['launch']
  if (!isRecord(launch)) return undefined
  const env = launch['env']
  if (!isRecord(env)) return undefined
  const acpRunId = env['ACP_RUN_ID']
  return typeof acpRunId === 'string' && acpRunId.trim().length > 0 ? acpRunId.trim() : undefined
}

/**
 * Relay one durable semantic signal for a federated AskUserQuestion start.
 * General lifecycle streaming remains node-local; the origin receives only
 * the interactive bracket needed to present and answer the waiting turn.
 */
export function maybeRelayFederatedInteractiveLifecycle(
  this: HrcServerInstanceForHandlers,
  event: HrcLifecycleEvent
): void {
  if (
    event.eventKind !== 'turn.tool_call' ||
    event.runId === undefined ||
    !isRecord(event.payload) ||
    event.payload['toolName'] !== 'AskUserQuestion'
  ) {
    return
  }

  const request = this.db.messages.getLatestRequestByRunId(event.runId)
  if (
    request === undefined ||
    request.phase !== 'request' ||
    !isRecord(request.metadataJson?.['federationIngress']) ||
    this.federationOriginOutbox === undefined
  ) {
    return
  }

  const acpRunId = acpRunIdFromFederatedRequest(request)
  const signal: FederationInteractiveLifecycleSignal = {
    version: 1,
    type: 'ask_user_question',
    sourceHrcSeq: event.hrcSeq,
    ...(acpRunId === undefined ? {} : { acpRunId }),
    event: {
      eventKind: 'turn.tool_call',
      ts: event.ts,
      hostSessionId: event.hostSessionId,
      scopeRef: event.scopeRef,
      laneRef: event.laneRef,
      generation: event.generation,
      ...(event.runtimeId === undefined ? {} : { runtimeId: event.runtimeId }),
      runId: event.runId,
      ...(event.transport === undefined ? {} : { transport: event.transport }),
      payload: event.payload,
    },
  }
  const inserted = this.db.messages.insertIdempotent({
    messageId: deterministicInteractiveSignalMessageId(request.messageId, event.hrcSeq),
    kind: 'system',
    phase: 'response',
    from: request.to,
    to: request.from,
    body: '',
    replyToMessageId: request.messageId,
    rootMessageId: request.rootMessageId,
    execution: { state: 'not_applicable' },
    metadataJson: { federationInteractiveSignal: signal },
  })
  if (inserted.outcome === 'duplicate') return

  this.notifyMessageSubscribers(inserted.record)
  writeServerLog('INFO', 'federation.interactive_signal.queued', {
    signalMessageId: inserted.record.messageId,
    requestMessageId: request.messageId,
    sourceHrcSeq: event.hrcSeq,
    acpRunId,
    scopeRef: event.scopeRef,
    runId: event.runId,
    runtimeId: event.runtimeId,
    toolName: event.payload['toolName'],
  })
  void this.federationOriginOutbox.routeResponse(inserted.record).catch((error: unknown) => {
    writeServerLog('WARN', 'federation.interactive_signal.queue_failed', {
      signalMessageId: inserted.record.messageId,
      requestMessageId: request.messageId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

function parseMessageAddress(value: unknown): HrcMessageAddress | undefined {
  if (!isRecord(value)) return undefined
  if (value['kind'] === 'entity' && (value['entity'] === 'human' || value['entity'] === 'system')) {
    return { kind: 'entity', entity: value['entity'] }
  }
  if (value['kind'] === 'session' && typeof value['sessionRef'] === 'string') {
    return { kind: 'session', sessionRef: value['sessionRef'] }
  }
  return undefined
}

/**
 * Rebuild a turn-response finalizer from durable state (T-04025).
 *
 * Only semantic-turn-handoff requests carry the `semanticTurnHandoff` metadata
 * marker; DM-path requests are answered by the recipient's explicit reply DM
 * and must never be auto-finalized. Skips requests already finalized (terminal
 * execution state or an existing response) so recovery cannot double-insert.
 */
function recoverDurableTurnResponseFinalizer(
  db: HrcDatabase,
  runId: string
): { finalizer: TurnResponseFinalizer; request: HrcMessageRecord } | undefined {
  const request = db.messages.getLatestRequestByRunId(runId)
  if (!request) return undefined
  const marker = isRecord(request.metadataJson)
    ? request.metadataJson['semanticTurnHandoff']
    : undefined
  if (marker === undefined) return undefined
  if (request.execution.state === 'completed' || request.execution.state === 'failed') {
    return undefined
  }
  if (db.messages.hasResponseTo(request.messageId)) return undefined

  const respondTo = isRecord(marker) ? parseMessageAddress(marker['respondTo']) : undefined
  const mode = request.execution.mode
  return {
    request,
    finalizer: {
      requestMessageId: request.messageId,
      from: request.to,
      to: respondTo ?? request.from,
      mode:
        mode === 'headless' || mode === 'interactive' || mode === 'nonInteractive'
          ? mode
          : 'interactive',
      sessionRef: request.execution.sessionRef ?? '',
    },
  }
}

export function finalizeSemanticTurnResponse(
  this: HrcServerInstanceForHandlers,
  event: HrcLifecycleEvent
): void {
  const runId = event.runId
  if (!runId) return

  let finalizer = this.turnResponseFinalizers.get(runId)
  let request: HrcMessageRecord | undefined
  if (finalizer) {
    this.turnResponseFinalizers.delete(runId)
    request = this.db.messages.getById(finalizer.requestMessageId)
  } else {
    // T-04025: the finalizer map is in-memory and a durable-broker turn can
    // outlive the daemon that dispatched it. Rebuild the finalizer from the
    // durable request row (marked at handoff time) so a completed turn always
    // persists its response, attached client or not.
    const recovered = recoverDurableTurnResponseFinalizer(this.db, runId)
    if (!recovered) return
    finalizer = recovered.finalizer
    request = recovered.request
    writeServerLog('INFO', 'semantic_turn_handoff.finalizer_recovered', {
      requestMessageId: request.messageId,
      runId,
      eventKind: event.eventKind,
    })
  }
  if (!request) return

  const run = this.db.runs.getByRunId(runId)
  const runtimeId = event.runtimeId ?? run?.runtimeId
  const hostSessionId = event.hostSessionId
  const generation = event.generation
  const transport = event.transport ?? run?.transport
  const failed = Boolean(event.errorCode) || run?.status === 'failed'
  const bufferedOutput = this.db.runtimeBuffers
    .listByRunId(runId)
    .map((chunk) => chunk.text)
    .join('')
  const semanticOutput =
    bufferedOutput.length > 0
      ? ''
      : this.db.hrcEvents
          .listByRun(runId, { eventKind: 'turn.message' })
          .map((messageEvent) => extractTextFromTurnMessagePayload(messageEvent.payload))
          .join('')
  const body =
    bufferedOutput.length > 0
      ? bufferedOutput
      : semanticOutput.length > 0
        ? semanticOutput
        : (run?.errorMessage ?? '')

  const response = this.insertAndNotifyMessage({
    messageId: `msg-${randomUUID()}`,
    kind: 'dm',
    phase: 'response',
    from: finalizer.from,
    to: finalizer.to,
    body,
    replyToMessageId: request.messageId,
    rootMessageId: request.rootMessageId,
    execution: {
      state: failed ? 'failed' : 'completed',
      mode: finalizer.mode,
      sessionRef: finalizer.sessionRef,
      hostSessionId,
      generation,
      ...(runtimeId ? { runtimeId } : {}),
      runId,
      ...(transport === 'sdk' ||
      transport === 'tmux' ||
      transport === 'headless' ||
      transport === 'ghostty'
        ? { transport }
        : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(run?.errorMessage ? { errorMessage: run.errorMessage } : {}),
    },
  })

  void this.federationOriginOutbox?.routeResponse(response).catch((error: unknown) => {
    writeServerLog('WARN', 'federation.response.queue_failed', {
      responseMessageId: response.messageId,
      requestMessageId: request.messageId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  this.db.messages.updateExecution(request.messageId, {
    state: failed ? 'failed' : 'completed',
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(run?.errorMessage ? { errorMessage: run.errorMessage } : {}),
  })

  writeServerLog('INFO', 'semantic_turn_handoff.response_finalized', {
    requestMessageId: request.messageId,
    responseMessageId: response.messageId,
    runId,
    state: failed ? 'failed' : 'completed',
  })
}

export const eventNotificationHandlersMethods = {
  appendEvent,
  appendInflightRejected,
  notifyEvent,
  notifyMessageSubscribers,
  insertAndNotifyMessage,
  maybeCompleteInteractiveSemanticTurn,
  maybeRelayFederatedInteractiveLifecycle,
  finalizeSemanticTurnResponse,
}

export type EventNotificationHandlersMethods = typeof eventNotificationHandlersMethods
