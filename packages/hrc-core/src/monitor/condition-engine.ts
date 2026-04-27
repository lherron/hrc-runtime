import { HrcBadRequestError, HrcErrorCode, HrcInternalError } from '../errors.js'
import type { HrcSelector } from '../selectors.js'
import type {
  HrcMonitorCapture,
  HrcMonitorEvent,
  HrcMonitorResolutionResult,
  HrcMonitorSnapshot,
  HrcMonitorWatchRequest,
} from './index.js'

export type HrcMonitorCondition =
  | 'turn-finished'
  | 'idle'
  | 'busy'
  | 'response'
  | 'response-or-idle'
  | 'runtime-dead'

export type HrcMonitorConditionResult =
  | 'turn_succeeded'
  | 'turn_failed'
  | 'runtime_dead'
  | 'runtime_crashed'
  | 'response'
  | 'idle'
  | 'busy'
  | 'idle_no_response'
  | 'turn_finished_without_response'
  | 'already_idle'
  | 'already_busy'
  | 'already_dead'
  | 'no_active_turn'
  | 'context_changed'
  | 'timeout'
  | 'stalled'
  | 'monitor_error'

export type HrcMonitorContextChangedReason = 'session_rebound' | 'generation_changed' | 'cleared'

export type HrcMonitorFailureKind =
  | 'model'
  | 'tool'
  | 'process'
  | 'runtime'
  | 'cancelled'
  | 'unknown'

export type HrcMonitorConditionOutcome = {
  result: HrcMonitorConditionResult
  exitCode: number
  reason?: HrcMonitorContextChangedReason | undefined
  failureKind?: HrcMonitorFailureKind | undefined
  eventStream?: MonitorOutputEvent[] | undefined
}

export type HrcMonitorConditionWaitRequest = {
  selector: HrcSelector
  condition: HrcMonitorCondition
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
}

export type HrcMonitorConditionEngineReader = {
  snapshot: (selector?: HrcSelector | undefined) => HrcMonitorSnapshot
  watch: (
    request: HrcMonitorWatchRequest
  ) => AsyncIterable<HrcMonitorEvent | Record<string, unknown>>
  captureStart: (
    selector: HrcSelector,
    options?: { afterSnapshot?: (() => void) | undefined }
  ) => Promise<HrcMonitorCapture | HrcMonitorResolutionResult>
}

export type HrcMonitorConditionEngine = {
  wait: (request: HrcMonitorConditionWaitRequest) => Promise<HrcMonitorConditionOutcome>
}

type MonitorOutputEvent = HrcMonitorEvent | Record<string, unknown>

type TimedStreamResult =
  | { kind: 'event'; value: MonitorOutputEvent }
  | { kind: 'done' }
  | { kind: 'timeout' }
  | { kind: 'stalled' }

type EvaluationContext = {
  condition: HrcMonitorCondition
  selector: HrcSelector
  capture: HrcMonitorCapture
}

const DEAD_RUNTIME_STATUSES = new Set(['dead', 'stopped', 'crashed', 'exited', 'terminated'])
const CONTEXT_CHANGED_REASONS = new Set(['session_rebound', 'generation_changed', 'cleared'])
const FAILURE_KINDS = new Set(['model', 'tool', 'process', 'runtime', 'cancelled', 'unknown'])
const IDLE_RUNTIME_STATUSES = new Set(['idle', 'ready'])

export function createMonitorConditionEngine(
  reader: HrcMonitorConditionEngineReader
): HrcMonitorConditionEngine {
  return {
    async wait(request) {
      assertConditionSelector(request)

      const capture = await reader.captureStart(request.selector)
      if (!isCapture(capture)) {
        throw resolutionError(capture)
      }

      const startSnapshot = reader.snapshot(request.selector)
      const context: EvaluationContext = {
        condition: request.condition,
        selector: request.selector,
        capture,
      }
      const eventStream: MonitorOutputEvent[] = []

      const startOutcome = evaluateStartSnapshot(context, startSnapshot)
      if (startOutcome) {
        return withCompletedEvent(context, startOutcome, eventStream)
      }

      const iterable = reader.watch({
        selector: request.selector,
        follow: true,
        fromSeq: capture.streamCursorSeq,
        includeCorrelatedMessageResponses:
          request.condition === 'response' || request.condition === 'response-or-idle',
      })
      const iterator = iterable[Symbol.asyncIterator]()
      let stallDeadline = deadlineFromNow(request.stallAfterMs)
      const timeoutDeadline = deadlineFromNow(request.timeoutMs)

      while (true) {
        const next = await nextStreamResult(iterator, timeoutDeadline, stallDeadline)

        if (next.kind === 'timeout') {
          return withCompletedEvent(context, { result: 'timeout', exitCode: 1 }, eventStream)
        }
        if (next.kind === 'stalled') {
          return withCompletedEvent(context, { result: 'stalled', exitCode: 1 }, eventStream)
        }
        if (next.kind === 'done') {
          return await waitForEndTimer(context, eventStream, timeoutDeadline, stallDeadline)
        }

        eventStream.push(next.value)
        stallDeadline = deadlineFromNow(request.stallAfterMs)

        const outcome = evaluateEvent(context, next.value)
        if (outcome) {
          return withCompletedEvent(context, outcome, eventStream)
        }
      }
    },
  }
}

function assertConditionSelector(request: HrcMonitorConditionWaitRequest): void {
  if (
    (request.condition === 'response' || request.condition === 'response-or-idle') &&
    request.selector.kind !== 'message' &&
    request.selector.kind !== 'message-seq'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      `${request.condition} requires a msg: selector`,
      {
        condition: request.condition,
        selectorKind: request.selector.kind,
      }
    )
  }
}

function evaluateStartSnapshot(
  context: EvaluationContext,
  snapshot: HrcMonitorSnapshot
): HrcMonitorConditionOutcome | null {
  const runtimeStatus = snapshot.runtime?.status

  switch (context.condition) {
    case 'turn-finished':
      return context.capture.activeTurnId === null
        ? { result: 'no_active_turn', exitCode: 0 }
        : null
    case 'idle':
      return isIdleRuntimeStatus(runtimeStatus) ? { result: 'already_idle', exitCode: 0 } : null
    case 'busy':
      return runtimeStatus === 'busy' ? { result: 'already_busy', exitCode: 0 } : null
    case 'runtime-dead':
      return isDeadRuntimeStatus(runtimeStatus) ? { result: 'already_dead', exitCode: 0 } : null
    case 'response':
    case 'response-or-idle':
      return null
  }
}

function evaluateEvent(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'monitor.snapshot') return null

  const contextChanged = evaluateContextChanged(context, event)
  if (contextChanged) return contextChanged

  const runtimeFailure = evaluateRuntimeFailure(context, event)
  if (runtimeFailure) return runtimeFailure

  switch (context.condition) {
    case 'turn-finished':
      return evaluateTurnFinished(context, event)
    case 'idle':
      return eventKind(event) === 'runtime.idle' && sameRuntime(context, event)
        ? { result: resultValue(event, 'idle'), exitCode: 0 }
        : null
    case 'busy':
      return eventKind(event) === 'runtime.busy' && sameRuntime(context, event)
        ? { result: resultValue(event, 'busy'), exitCode: 0 }
        : null
    case 'response':
      return evaluateResponse(context, event)
    case 'response-or-idle':
      return evaluateResponseOrIdle(context, event)
    case 'runtime-dead':
      return evaluateRuntimeDead(context, event)
  }
}

function evaluateTurnFinished(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) !== 'turn.finished' || !sameCapturedTurn(context, event)) {
    return null
  }

  const result = resultValue(event, 'turn_succeeded')
  if (result === 'turn_failed') {
    return { result, exitCode: 2, failureKind: failureKindValue(event) }
  }
  if (result === 'runtime_dead' || result === 'runtime_crashed') {
    return { result, exitCode: 2, failureKind: failureKindValue(event) }
  }
  return { result: result === 'turn_succeeded' ? result : 'turn_succeeded', exitCode: 0 }
}

function evaluateResponse(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'message.response' && messageResponseMatchesSelector(context, event)) {
    return { result: 'response', exitCode: 0 }
  }
  if (isCapturedTurnIdleOrFinished(context, event)) {
    return { result: 'turn_finished_without_response', exitCode: 4 }
  }
  return null
}

function evaluateResponseOrIdle(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'message.response' && messageResponseMatchesSelector(context, event)) {
    return { result: 'response', exitCode: 0 }
  }
  if (isCapturedTurnIdleOrFinished(context, event)) {
    return { result: 'idle_no_response', exitCode: 0 }
  }
  return null
}

function evaluateRuntimeDead(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'runtime.dead' && sameRuntime(context, event)) {
    return { result: 'runtime_dead', exitCode: 2, failureKind: failureKindValue(event) }
  }
  if (eventKind(event) === 'runtime.crashed' && sameRuntime(context, event)) {
    return { result: 'runtime_crashed', exitCode: 2, failureKind: failureKindValue(event) }
  }
  return null
}

function evaluateRuntimeFailure(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (context.condition === 'runtime-dead') return null

  if (eventKind(event) === 'runtime.dead' && sameRuntime(context, event)) {
    return { result: 'runtime_dead', exitCode: 2, failureKind: failureKindValue(event) }
  }
  if (eventKind(event) === 'runtime.crashed' && sameRuntime(context, event)) {
    return { result: 'runtime_crashed', exitCode: 2, failureKind: failureKindValue(event) }
  }
  return null
}

function evaluateContextChanged(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  const explicitResult = unknownString(event, 'result')
  const explicitReason = unknownString(event, 'reason')
  if (explicitResult === 'context_changed' && isContextChangedReason(explicitReason)) {
    return { result: 'context_changed', reason: explicitReason, exitCode: 4 }
  }

  if (unknownString(event, 'sessionRef') === context.capture.sessionRef) {
    const eventGeneration = unknownNumber(event, 'generation')
    if (eventGeneration !== undefined && eventGeneration !== context.capture.generation) {
      return { result: 'context_changed', reason: 'generation_changed', exitCode: 4 }
    }
  }

  if (
    unknownString(event, 'sessionRef') === context.capture.sessionRef &&
    unknownString(event, 'hostSessionId') !== undefined &&
    unknownString(event, 'hostSessionId') !== context.capture.hostSessionId
  ) {
    return { result: 'context_changed', reason: 'session_rebound', exitCode: 4 }
  }

  if (
    (eventKind(event) === 'context.cleared' || eventKind(event) === 'session.cleared') &&
    unknownString(event, 'sessionRef') === context.capture.sessionRef
  ) {
    return { result: 'context_changed', reason: 'cleared', exitCode: 4 }
  }

  return null
}

function isCapturedTurnIdleOrFinished(
  context: EvaluationContext,
  event: MonitorOutputEvent
): boolean {
  return (
    (eventKind(event) === 'turn.finished' && sameCapturedTurn(context, event)) ||
    (eventKind(event) === 'runtime.idle' &&
      sameRuntime(context, event) &&
      (unknownString(event, 'turnId') === undefined || sameCapturedTurn(context, event)))
  )
}

function sameCapturedTurn(context: EvaluationContext, event: MonitorOutputEvent): boolean {
  return (
    context.capture.activeTurnId !== null &&
    unknownString(event, 'turnId') === context.capture.activeTurnId
  )
}

function sameRuntime(context: EvaluationContext, event: MonitorOutputEvent): boolean {
  const runtimeId = unknownString(event, 'runtimeId')
  return runtimeId === undefined || runtimeId === context.capture.runtimeId
}

function messageResponseMatchesSelector(
  context: EvaluationContext,
  event: MonitorOutputEvent
): boolean {
  switch (context.selector.kind) {
    case 'message': {
      const messageId = context.selector.messageId
      return (
        unknownString(event, 'messageId') === messageId ||
        unknownString(event, 'replyToMessageId') === messageId ||
        unknownString(event, 'rootMessageId') === messageId
      )
    }
    case 'message-seq':
      return unknownNumber(event, 'messageSeq') === context.selector.messageSeq
    default:
      return false
  }
}

function resultValue(
  event: MonitorOutputEvent,
  fallback: HrcMonitorConditionResult
): HrcMonitorConditionResult {
  const result = unknownString(event, 'result')
  return isConditionResult(result) ? result : fallback
}

function failureKindValue(event: MonitorOutputEvent): HrcMonitorFailureKind {
  const failureKind = unknownString(event, 'failureKind')
  return isFailureKind(failureKind) ? failureKind : 'unknown'
}

function withCompletedEvent(
  context: EvaluationContext,
  outcome: HrcMonitorConditionOutcome,
  eventStream: MonitorOutputEvent[]
): HrcMonitorConditionOutcome {
  eventStream.push({
    event: outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
    selector: context.capture.selector.canonical,
    condition: context.condition,
    result: outcome.result,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.failureKind !== undefined ? { failureKind: outcome.failureKind } : {}),
    exitCode: outcome.exitCode,
    replayed: false,
    ts: new Date().toISOString(),
  })

  return {
    ...outcome,
    eventStream,
  }
}

async function waitForEndTimer(
  context: EvaluationContext,
  eventStream: MonitorOutputEvent[],
  timeoutDeadline: number | null,
  stallDeadline: number | null
): Promise<HrcMonitorConditionOutcome> {
  const nextTimer = earliestDeadline(timeoutDeadline, stallDeadline)
  if (nextTimer === null) {
    return withCompletedEvent(context, { result: 'monitor_error', exitCode: 3 }, eventStream)
  }

  const waitMs = Math.max(0, nextTimer - Date.now())
  if (waitMs > 0) {
    await delay(waitMs)
  }

  if (timeoutDeadline !== null && timeoutDeadline <= (stallDeadline ?? Number.POSITIVE_INFINITY)) {
    return withCompletedEvent(context, { result: 'timeout', exitCode: 1 }, eventStream)
  }
  return withCompletedEvent(context, { result: 'stalled', exitCode: 1 }, eventStream)
}

async function nextStreamResult(
  iterator: AsyncIterator<MonitorOutputEvent>,
  timeoutDeadline: number | null,
  stallDeadline: number | null
): Promise<TimedStreamResult> {
  const races: Array<Promise<TimedStreamResult>> = [
    iterator
      .next()
      .then((result) =>
        result.done === true ? { kind: 'done' } : { kind: 'event', value: result.value }
      ),
  ]

  const timeoutMs = remainingMs(timeoutDeadline)
  if (timeoutMs !== null) {
    races.push(delay(timeoutMs).then(() => ({ kind: 'timeout' })))
  }

  const stallMs = remainingMs(stallDeadline)
  if (stallMs !== null) {
    races.push(delay(stallMs).then(() => ({ kind: 'stalled' })))
  }

  return Promise.race(races)
}

function deadlineFromNow(ms: number | undefined): number | null {
  return ms === undefined ? null : Date.now() + Math.max(0, ms)
}

function remainingMs(deadline: number | null): number | null {
  return deadline === null ? null : Math.max(0, deadline - Date.now())
}

function earliestDeadline(first: number | null, second: number | null): number | null {
  if (first === null) return second
  if (second === null) return first
  return Math.min(first, second)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function eventKind(event: MonitorOutputEvent): string | undefined {
  return unknownString(event, 'event')
}

function unknownString(event: MonitorOutputEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

function unknownNumber(event: MonitorOutputEvent, key: string): number | undefined {
  const value = event[key]
  return typeof value === 'number' ? value : undefined
}

function isDeadRuntimeStatus(status: string | undefined): boolean {
  return status !== undefined && DEAD_RUNTIME_STATUSES.has(status)
}

function isIdleRuntimeStatus(status: string | undefined): boolean {
  return status !== undefined && IDLE_RUNTIME_STATUSES.has(status)
}

function isCapture(
  result: HrcMonitorCapture | HrcMonitorResolutionResult
): result is HrcMonitorCapture {
  return !('ok' in result && result.ok === false)
}

function resolutionError(result: HrcMonitorResolutionResult): Error {
  if ('ok' in result && result.ok === false) {
    return new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      result.error.message,
      result.error.detail
    )
  }
  return new HrcInternalError('monitor start capture failed')
}

function isConditionResult(value: string | undefined): value is HrcMonitorConditionResult {
  return (
    value === 'turn_succeeded' ||
    value === 'turn_failed' ||
    value === 'runtime_dead' ||
    value === 'runtime_crashed' ||
    value === 'response' ||
    value === 'idle' ||
    value === 'busy' ||
    value === 'idle_no_response' ||
    value === 'turn_finished_without_response' ||
    value === 'already_idle' ||
    value === 'already_busy' ||
    value === 'already_dead' ||
    value === 'no_active_turn' ||
    value === 'context_changed' ||
    value === 'timeout' ||
    value === 'stalled' ||
    value === 'monitor_error'
  )
}

function isContextChangedReason(
  value: string | undefined
): value is HrcMonitorContextChangedReason {
  return value !== undefined && CONTEXT_CHANGED_REASONS.has(value)
}

function isFailureKind(value: string | undefined): value is HrcMonitorFailureKind {
  return value !== undefined && FAILURE_KINDS.has(value)
}
