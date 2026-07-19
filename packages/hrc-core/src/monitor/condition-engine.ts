import { HrcBadRequestError, HrcErrorCode, HrcInternalError } from '../errors.js'
import type { HrcSelector } from '../selectors.js'
import { isResolutionError, selectorMatchesMessageResponse } from './index.js'
import type {
  HrcMonitorCapture,
  HrcMonitorEvent,
  HrcMonitorResolutionResult,
  HrcMonitorSnapshot,
  HrcMonitorWatchRequest,
} from './index.js'

export type HrcMonitorCondition = 'turn-finished' | 'idle' | 'busy' | 'response' | 'runtime-dead'

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
  runId?: string | undefined
  reason?: HrcMonitorContextChangedReason | undefined
  failureKind?: HrcMonitorFailureKind | undefined
  eventStream?: MonitorOutputEvent[] | undefined
}

export type HrcMonitorConditionWaitRequest = {
  selector: HrcSelector
  condition: HrcMonitorCondition
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  /** Terminal evidence fence. Omitted means an exclusive arm-time high-water fence. */
  terminalFence?: { seq: number; inclusive: boolean } | undefined
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

const DEAD_RUNTIME_STATUSES = new Set([
  'dead',
  'stale',
  'terminated',
  'stopped',
  'failed',
  'disposed',
  'crashed',
  'exited',
])
const CONTEXT_CHANGED_REASONS = new Set(['session_rebound', 'generation_changed', 'cleared'])
const FAILURE_KINDS = new Set(['model', 'tool', 'process', 'runtime', 'cancelled', 'unknown'])
const IDLE_RUNTIME_STATUSES = new Set(['idle', 'ready'])

// Canonical enumeration of HrcMonitorConditionResult, used to derive the
// runtime guard from a single source (mirrors the DEAD_RUNTIME_STATUSES pattern).
const CONDITION_RESULTS = [
  'turn_succeeded',
  'turn_failed',
  'runtime_dead',
  'runtime_crashed',
  'response',
  'idle',
  'busy',
  'idle_no_response',
  'turn_finished_without_response',
  'already_idle',
  'already_busy',
  'already_dead',
  'no_active_turn',
  'context_changed',
  'timeout',
  'stalled',
  'monitor_error',
] as const satisfies readonly HrcMonitorConditionResult[]
const CONDITION_RESULT_SET = new Set<string>(CONDITION_RESULTS)

const EXIT_CODE = {
  ok: 0,
  alreadyTrue: 10,
  obstruction: 12,
  timeout: 20,
  stalled: 21,
  contextChanged: 22,
  monitorError: 23,
} as const

export function createMonitorConditionEngine(
  reader: HrcMonitorConditionEngineReader
): HrcMonitorConditionEngine {
  return {
    async wait(request) {
      assertConditionSelector(request)
      const condition = request.condition

      const capture = await reader.captureStart(request.selector)
      if (!isCapture(capture)) {
        throw resolutionError(capture)
      }

      const startSnapshot = reader.snapshot(request.selector)
      const context: EvaluationContext = {
        condition,
        selector: request.selector,
        capture,
      }
      const eventStream: MonitorOutputEvent[] = []

      const startOutcome = evaluateStartSnapshot(context, startSnapshot)
      if (startOutcome) {
        return withCompletedEvent(context, startOutcome, eventStream)
      }

      const watchController = new AbortController()
      const iterable = reader.watch({
        selector: request.selector,
        follow: true,
        fromSeq: capture.streamCursorSeq,
        includeCorrelatedMessageResponses: condition === 'response',
        signal: watchController.signal,
      })
      const iterator = iterable[Symbol.asyncIterator]()
      let stallDeadline = deadlineFromNow(request.stallAfterMs)
      const timeoutDeadline = deadlineFromNow(request.timeoutMs)

      try {
        while (true) {
          const next = await nextStreamResult(iterator, timeoutDeadline, stallDeadline)

          if (next.kind === 'timeout') {
            return withCompletedEvent(
              context,
              { result: 'timeout', exitCode: EXIT_CODE.timeout },
              eventStream
            )
          }
          if (next.kind === 'stalled') {
            return withCompletedEvent(
              context,
              { result: 'stalled', exitCode: EXIT_CODE.stalled },
              eventStream
            )
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
      } finally {
        watchController.abort()
      }
    },
  }
}

function assertConditionSelector(request: HrcMonitorConditionWaitRequest): void {
  if (
    request.condition === 'response' &&
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

type ConditionStrategy = {
  start: (
    context: EvaluationContext,
    snapshot: HrcMonitorSnapshot
  ) => HrcMonitorConditionOutcome | null
  event: (
    context: EvaluationContext,
    event: MonitorOutputEvent
  ) => HrcMonitorConditionOutcome | null
}

// Per-condition strategy table co-locating the start-snapshot and streaming-event
// halves for each HrcMonitorCondition (previously two parallel `switch (condition)`
// statements that had to be kept congruent by hand). `satisfies
// Record<HrcMonitorCondition, ConditionStrategy>` forces every condition to define
// BOTH halves at compile time — adding/removing a condition is a single compiler
// error here instead of two silently-divergent switches. Per-condition behavior
// and dispatch are byte-identical to the prior switches.
const CONDITION_STRATEGIES = {
  'turn-finished': {
    start: (context) =>
      context.capture.activeTurnId === null
        ? { result: 'no_active_turn', exitCode: EXIT_CODE.ok }
        : null,
    event: (context, event) => evaluateTurnFinished(context, event),
  },
  idle: {
    start: (_context, snapshot) =>
      isIdleRuntimeStatus(snapshot.runtime?.status)
        ? { result: 'already_idle', exitCode: EXIT_CODE.alreadyTrue }
        : null,
    event: (context, event) =>
      eventKind(event) === 'runtime.idle' && sameRuntime(context, event)
        ? { result: resultValue(event, 'idle'), exitCode: EXIT_CODE.ok }
        : null,
  },
  busy: {
    start: (_context, snapshot) =>
      snapshot.runtime?.status === 'busy'
        ? { result: 'already_busy', exitCode: EXIT_CODE.alreadyTrue }
        : null,
    event: (context, event) =>
      eventKind(event) === 'runtime.busy' && sameRuntime(context, event)
        ? { result: resultValue(event, 'busy'), exitCode: EXIT_CODE.ok }
        : null,
  },
  'runtime-dead': {
    start: (_context, snapshot) =>
      isDeadRuntimeStatus(snapshot.runtime?.status)
        ? { result: 'already_dead', exitCode: EXIT_CODE.alreadyTrue }
        : null,
    event: (context, event) => runtimeDeathOutcome(context, event),
  },
  response: {
    start: () => null,
    event: (context, event) => evaluateResponse(context, event),
  },
} satisfies Record<HrcMonitorCondition, ConditionStrategy>

function evaluateStartSnapshot(
  context: EvaluationContext,
  snapshot: HrcMonitorSnapshot
): HrcMonitorConditionOutcome | null {
  return CONDITION_STRATEGIES[context.condition].start(context, snapshot)
}

function evaluateEvent(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'monitor.snapshot') return null

  const contextChanged = evaluateContextChanged(context, event)
  if (contextChanged) return contextChanged

  // Named runtime death satisfies its strategy. For every other condition it
  // obstructs an exact wait.
  if (context.condition !== 'runtime-dead') {
    const runtimeFailure = runtimeDeathOutcome(context, event)
    if (runtimeFailure) return runtimeFailure
  }

  return CONDITION_STRATEGIES[context.condition].event(context, event)
}

function evaluateTurnFinished(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) !== 'turn.finished' || !sameCapturedTurn(context, event)) {
    return null
  }

  const result = resultValue(event, 'turn_succeeded')
  if (result === 'turn_failed' || result === 'runtime_dead' || result === 'runtime_crashed') {
    return { result, exitCode: EXIT_CODE.ok, failureKind: failureKindValue(event) }
  }
  return { result: 'turn_succeeded', exitCode: EXIT_CODE.ok }
}

function evaluateResponse(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'message.response' && messageResponseMatchesSelector(context, event)) {
    return { result: 'response', exitCode: EXIT_CODE.ok }
  }
  if (isCapturedTurnIdleOrFinished(context, event)) {
    return { result: 'turn_finished_without_response', exitCode: EXIT_CODE.contextChanged }
  }
  return null
}

function runtimeDeathOutcome(
  context: EvaluationContext,
  event: MonitorOutputEvent
): HrcMonitorConditionOutcome | null {
  if (eventKind(event) === 'runtime.dead' && sameRuntime(context, event)) {
    return {
      result: 'runtime_dead',
      exitCode: context.condition === 'runtime-dead' ? EXIT_CODE.ok : EXIT_CODE.obstruction,
      failureKind: failureKindValue(event),
    }
  }
  if (eventKind(event) === 'runtime.crashed' && sameRuntime(context, event)) {
    return {
      result: 'runtime_crashed',
      exitCode: context.condition === 'runtime-dead' ? EXIT_CODE.ok : EXIT_CODE.obstruction,
      failureKind: failureKindValue(event),
    }
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
    return { result: 'context_changed', reason: explicitReason, exitCode: EXIT_CODE.contextChanged }
  }

  const sameSession = unknownString(event, 'sessionRef') === context.capture.sessionRef

  if (sameSession) {
    const eventGeneration = unknownNumber(event, 'generation')
    if (eventGeneration !== undefined && eventGeneration !== context.capture.generation) {
      return {
        result: 'context_changed',
        reason: 'generation_changed',
        exitCode: EXIT_CODE.contextChanged,
      }
    }
  }

  if (
    sameSession &&
    unknownString(event, 'hostSessionId') !== undefined &&
    unknownString(event, 'hostSessionId') !== context.capture.hostSessionId
  ) {
    return {
      result: 'context_changed',
      reason: 'session_rebound',
      exitCode: EXIT_CODE.contextChanged,
    }
  }

  if (
    (eventKind(event) === 'context.cleared' || eventKind(event) === 'session.cleared') &&
    sameSession
  ) {
    return { result: 'context_changed', reason: 'cleared', exitCode: EXIT_CODE.contextChanged }
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
  return selectorMatchesMessageResponse(context.selector, {
    messageId: unknownString(event, 'messageId'),
    replyToMessageId: unknownString(event, 'replyToMessageId'),
    rootMessageId: unknownString(event, 'rootMessageId'),
    messageSeq: unknownNumber(event, 'messageSeq'),
  })
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
    scopeRef: context.capture.scopeRef,
    condition: context.condition,
    result: outcome.result,
    ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
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
    return withCompletedEvent(
      context,
      { result: 'monitor_error', exitCode: EXIT_CODE.monitorError },
      eventStream
    )
  }

  const waitMs = Math.max(0, nextTimer - Date.now())
  if (waitMs > 0) {
    await delay(waitMs)
  }

  if (timeoutDeadline !== null && timeoutDeadline <= (stallDeadline ?? Number.POSITIVE_INFINITY)) {
    return withCompletedEvent(
      context,
      { result: 'timeout', exitCode: EXIT_CODE.timeout },
      eventStream
    )
  }
  return withCompletedEvent(
    context,
    { result: 'stalled', exitCode: EXIT_CODE.stalled },
    eventStream
  )
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
  return !isResolutionError(result)
}

function resolutionError(result: HrcMonitorResolutionResult): Error {
  if (isResolutionError(result)) {
    return new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      result.error.message,
      result.error.detail
    )
  }
  return new HrcInternalError('monitor start capture failed')
}

function isConditionResult(value: string | undefined): value is HrcMonitorConditionResult {
  return value !== undefined && CONDITION_RESULT_SET.has(value)
}

function isContextChangedReason(
  value: string | undefined
): value is HrcMonitorContextChangedReason {
  return value !== undefined && CONTEXT_CHANGED_REASONS.has(value)
}

function isFailureKind(value: string | undefined): value is HrcMonitorFailureKind {
  return value !== undefined && FAILURE_KINDS.has(value)
}
