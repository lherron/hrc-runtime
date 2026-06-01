import { randomUUID } from 'node:crypto'

import type { HrcDomainError } from 'hrc-core'
import type {
  HrcEventEnvelope,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { appendHrcEvent } from './hrc-event-helper.js'
import { extractTextFromTurnMessagePayload } from './messages.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
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
  if (response.phase !== 'response' || response.replyToMessageId === undefined) {
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

export function finalizeSemanticTurnResponse(
  this: HrcServerInstanceForHandlers,
  event: HrcLifecycleEvent
): void {
  const runId = event.runId
  if (!runId) return

  const finalizer = this.turnResponseFinalizers.get(runId)
  if (!finalizer) return
  this.turnResponseFinalizers.delete(runId)

  const request = this.db.messages.getById(finalizer.requestMessageId)
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
