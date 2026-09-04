import { randomUUID } from 'node:crypto'

import type { HrcDomainError } from 'hrc-core'
import type {
  FederationSemanticTurnSignal,
  HrcEventEnvelope,
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { TURN_TEXT_LIMIT, appendHrcEvent } from './hrc-event-helper.js'
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
  // T-07236 — HRC→ACP reason-coded event bridge. Same observer discipline as
  // the notification fan-out above and one step further: emission is detached, so
  // the bridge cannot delay, fail, or otherwise reach the write that produced
  // this event. Disabled unless explicitly configured.
  this.acpEventBridge.observe(event)
  if ('hrcSeq' in event) {
    this.mailKicker.observeLifecycleEvent(event)
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
    void this.drainDurableHeadlessTurnInputs(event.hostSessionId).catch((error) => {
      writeServerLog('WARN', 'turn_input_queue.detached_drain_failed', {
        hostSessionId: event.hostSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
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
    request.execution.transport !== 'tmux' ||
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
    if (
      isRecord(request.metadataJson?.['federationIngress']) &&
      request.execution.sessionRef !== undefined &&
      request.execution.runtimeId !== undefined
    ) {
      const signal: FederationSemanticTurnSignal = {
        version: 1,
        type: 'terminal',
        // Interactive broker finalization is response-authored: unlike the
        // headless path there is deliberately no destination turn.completed
        // event. The durable response sequence is its monotonic source cursor.
        sourceHrcSeq: response.messageSeq,
        identity: {
          sessionRef: request.execution.sessionRef,
          scopeRef: run.scopeRef,
          laneRef: run.laneRef,
          hostSessionId: request.execution.hostSessionId,
          runtimeId: request.execution.runtimeId,
          runId,
          generation: request.execution.generation,
          mode: 'interactive',
          transport,
        },
        outcome: 'completed',
      }
      this.db.messages.updateMetadata(response.messageId, {
        federationSemanticTurnSignal: signal,
      })
    }
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
  if (request.metadataJson?.['federationSemanticTurnOrigin'] === true) return undefined
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

/**
 * The canonical body a completed semantic turn exposes to its response path.
 *
 * Rev 6 auto-reply, the semantic handoff finalizer, the dispatcher response and
 * the mail diagnostics deliberately share this function: a run has one response
 * projection, regardless of which consumer reads it. TURN_TEXT_LIMIT is the
 * existing turn-text bound; returning the marker keeps inherited truncation
 * observable to the reconciler.
 *
 * The body is the turn's FINAL assistant message, never a join (T-07969). Since
 * the T-07873 Claude authority cutover a turn emits every assistant message it
 * produced — the mid-turn narration flagged `final:false` and exactly one
 * `final:true`. Joining them put "I'll start by reading the task spec" ahead of
 * the answer in every auto-reply and truncated long turns before reaching it.
 * Lance ruled 2026-09-04 that agent notices are not part of a reply.
 *
 * Selection order, and why each step is where it is:
 *
 *   1. Empty segments are dropped BEFORE the finality pick, so a turn whose
 *      final message is empty falls back to its last message with text rather
 *      than projecting a blank reply. One rule, no special case.
 *   2. The last segment flagged `final === true` wins. "Last" matters: a legacy
 *      hook-derived cumulative `turn.message` can land after the broker's rows,
 *      and it carries no flag, so a flagged row still beats it.
 *   3. With nothing flagged (transports predating the flag) the last non-empty
 *      segment is the answer — the same message the flag would have named.
 *
 * The raw runtime buffer is the FALLBACK, not the authority, and the ORDER is
 * the whole defect. The buffer is turn-scoped where a reply needs to be
 * final-message-scoped: it accumulates every assistant text chunk the turn
 * produced and the old code called that concatenation the response. Because it
 * was tested FIRST and is written for every transport, the semantic branch that
 * would have given the right answer was unreachable on any transport that
 * buffers — which is why this was never a tmux-specific bug and why the fix is
 * a branch reorder rather than a new rule bolted onto a dead path.
 *
 * The buffer stays a faithful raw stream: `hrc capture` serves sdk/headless
 * runtimes from these same rows, the analogue of a tmux pane capture, and it is
 * still the only body a delta-only transport produces. Narrowing the reply must
 * not narrow that surface, so this reads around the buffer, never rewrites it.
 *
 * Nothing here assumes a run HAS a final message. "Exactly one `final:true` per
 * run" is a terminal-state invariant; a turn still in flight has emitted its
 * narration and not yet its answer, and the fallback projects its latest line.
 */
export function projectSemanticTurnResponse(
  db: HrcDatabase,
  runId: string
): { body: string; truncated: boolean } {
  const run = db.runs.getByRunId(runId)
  const segments = db.hrcEvents
    .listByRun(runId, { eventKind: 'turn.message' })
    .map((messageEvent) => ({
      text: extractTextFromTurnMessagePayload(messageEvent.payload),
      final: isFinalTurnMessagePayload(messageEvent.payload),
    }))
    .filter((segment) => segment.text.length > 0)
  // `lib` is ES2022 here, so no Array.findLast: walk back to the last flagged
  // segment and fall through to the last segment when nothing is flagged.
  let finalSegment = segments.at(-1)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment?.final === true) {
      finalSegment = segment
      break
    }
  }
  const unbounded =
    finalSegment !== undefined
      ? finalSegment.text
      : (bufferedTurnOutput(db, runId) ?? run?.errorMessage ?? '')
  return {
    body: unbounded.slice(0, TURN_TEXT_LIMIT),
    truncated: unbounded.length > TURN_TEXT_LIMIT,
  }
}

/** The raw runtime-buffer stream for a run, or undefined when it wrote nothing. */
function bufferedTurnOutput(db: HrcDatabase, runId: string): string | undefined {
  const buffered = db.runtimeBuffers
    .listByRunId(runId)
    .map((chunk) => chunk.text)
    .join('')
  return buffered.length > 0 ? buffered : undefined
}

/** Read the broker finality flag the mapper carries on a `turn.message` payload. */
function isFinalTurnMessagePayload(payload: unknown): boolean {
  return isRecord(payload) && payload['final'] === true
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
  const runtimeId = event.runtimeId ?? run?.runtimeId ?? request.execution.runtimeId
  const hostSessionId = event.hostSessionId
  const generation = event.generation
  const transport = event.transport ?? run?.transport ?? request.execution.transport
  const failed = Boolean(event.errorCode) || run?.status === 'failed'
  const { body } = projectSemanticTurnResponse(this.db, runId)
  const ingress = request.metadataJson?.['federationIngress']
  const ingressDelivery = isRecord(ingress) ? ingress['delivery'] : undefined
  const federatedSemanticTurn =
    isRecord(ingressDelivery) && isRecord(ingressDelivery['semanticTurnHandoff'])
  const signalMode =
    finalizer.mode === 'headless' ||
    finalizer.mode === 'interactive' ||
    finalizer.mode === 'nonInteractive'
      ? finalizer.mode
      : undefined
  const signalTransport =
    transport === 'sdk' || transport === 'tmux' || transport === 'headless' ? transport : undefined
  const semanticTurnSignal: FederationSemanticTurnSignal | undefined =
    federatedSemanticTurn &&
    runtimeId !== undefined &&
    signalMode !== undefined &&
    signalTransport !== undefined
      ? {
          version: 1,
          type: 'terminal',
          sourceHrcSeq: event.hrcSeq,
          identity: {
            sessionRef: finalizer.sessionRef,
            scopeRef: event.scopeRef,
            laneRef: event.laneRef,
            hostSessionId,
            runtimeId,
            runId,
            generation,
            mode: signalMode,
            transport: signalTransport,
          },
          outcome: failed ? 'failed' : 'completed',
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          ...(run?.errorMessage === undefined ? {} : { errorMessage: run.errorMessage }),
        }
      : undefined

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
      ...(transport === 'sdk' || transport === 'tmux' || transport === 'headless'
        ? { transport }
        : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(run?.errorMessage ? { errorMessage: run.errorMessage } : {}),
    },
    ...(semanticTurnSignal === undefined
      ? {}
      : { metadataJson: { federationSemanticTurnSignal: semanticTurnSignal } }),
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
  finalizeSemanticTurnResponse,
}

export type EventNotificationHandlersMethods = typeof eventNotificationHandlersMethods
