/**
 * `first_turn_missing` provision-liveness watchdog — arm / clear / disarm
 * (T-07235).
 *
 * Invariant: a runtime generation that has had a prompt dispatched and has
 * never produced `turn.started` must do so within X seconds, or HRC records a
 * durable, reason-coded liveness failure. This module owns the STATE
 * transitions; `first-turn-eval.ts` owns detection and the trip.
 *
 * Everything here is a durable row write. There are no in-memory timers, so
 * the watchdog is restart-safe by construction and a generation's deadline
 * cannot drift across a daemon restart.
 */
import {
  HRC_FIRST_TURN_MISSING_LATE_START_EVENT,
  type HrcLifecycleEvent,
  type HrcLifecycleTransport,
  type HrcRunRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from './hrc-event-helper.js'
import { writeServerLog } from './server-log.js'

export const HRC_FIRST_TURN_TIMEOUT_MS_ENV = 'HRC_FIRST_TURN_TIMEOUT_MS'
export const HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS_ENV = 'HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS'
export const HRC_FIRST_TURN_BUNDLE_KEEP_ENV = 'HRC_FIRST_TURN_BUNDLE_KEEP'
export const HRC_FIRST_TURN_BUNDLE_TTL_DAYS_ENV = 'HRC_FIRST_TURN_BUNDLE_TTL_DAYS'

export const DEFAULT_FIRST_TURN_TIMEOUT_MS = 120_000
/**
 * The watchdog gets its OWN cadence. It deliberately does not ride
 * `HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS` (300s), which cannot honor a 120s
 * deadline. Detection contract: a trip is recorded no earlier than the
 * deadline and no later than deadline + this interval.
 */
export const DEFAULT_FIRST_TURN_EVAL_INTERVAL_SECONDS = 30
/** Hard wall-clock budget for the whole best-effort diagnostic bundle. */
export const FIRST_TURN_BUNDLE_BUDGET_MS = 5_000
export const DEFAULT_FIRST_TURN_BUNDLE_KEEP = 3
export const DEFAULT_FIRST_TURN_BUNDLE_TTL_DAYS = 14

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * X_effective: the per-request override when supplied, else the global
 * default. Consumed ONLY at arm time — the accepted deadline is itself the
 * durable fact, so no request-policy value ever needs recovery later.
 */
export function resolveFirstTurnTimeoutMs(override?: number | undefined): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  return readPositiveIntEnv(HRC_FIRST_TURN_TIMEOUT_MS_ENV, DEFAULT_FIRST_TURN_TIMEOUT_MS)
}

export function resolveFirstTurnEvalIntervalSeconds(): number {
  return readPositiveIntEnv(
    HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS_ENV,
    DEFAULT_FIRST_TURN_EVAL_INTERVAL_SECONDS
  )
}

export function resolveFirstTurnBundleKeep(): number {
  return readNonNegativeIntEnv(HRC_FIRST_TURN_BUNDLE_KEEP_ENV, DEFAULT_FIRST_TURN_BUNDLE_KEEP)
}

export function resolveFirstTurnBundleTtlDays(): number {
  return readNonNegativeIntEnv(
    HRC_FIRST_TURN_BUNDLE_TTL_DAYS_ENV,
    DEFAULT_FIRST_TURN_BUNDLE_TTL_DAYS
  )
}

/**
 * Has this (runtimeId, generation) ALREADY produced a turn?
 *
 * The watch row alone cannot answer this. A generation that ran turns before
 * this watchdog existed has no row at all, and "no row" is indistinguishable
 * from "armed but never started" if you only look at `firstTurnAt`. Reading the
 * durable run history instead makes the spec's "never armed: subsequent prompts
 * to a generation already past its first turn" hold for the pre-existing fleet
 * too — without it, the first DM to any long-lived runtime would arm a fresh
 * window, and a DM that queues behind an active turn would blow that window
 * through no fault of the harness.
 *
 * Indexed on `idx_runs_runtime_id` and bounded by one runtime's run history.
 */
export function generationHasStartedTurn(
  db: HrcDatabase,
  runtimeId: string,
  generation: number
): boolean {
  const row = db.sqlite
    .query<{ one: number }, [string, number]>(
      `SELECT 1 AS one
         FROM runs
        WHERE runtime_id = ?
          AND generation = ?
          AND started_at IS NOT NULL
        LIMIT 1`
    )
    .get(runtimeId, generation)
  return row !== null
}

export type ArmFirstTurnWatchInput = {
  runtimeId: string
  generation: number
  hostSessionId: string
  scopeRef: string
  laneRef: string
  runId?: string | undefined
  invocationId?: string | undefined
  transport?: string | undefined
  /** Per-request override in ms; consumed here and nowhere else. */
  timeoutMsOverride?: number | undefined
  primingDispatchedAt: string
}

/**
 * Stamp `primingDispatchedAt` + the ABSOLUTE `firstTurnDeadlineAt` at the FIRST
 * prompt dispatch to a generation.
 *
 * Safe to call from every dispatch origin (provision `-p`, ACP/iOS pending run,
 * DM to a fresh runtime): the repository's conditional write means a generation
 * that is already armed, already past its first turn, already tripped, or
 * explicitly disarmed is left untouched. Never throws — a watchdog must not be
 * able to fail a dispatch.
 */
export function armFirstTurnWatch(db: HrcDatabase, input: ArmFirstTurnWatchInput): void {
  try {
    // Spec exclusion, enforced here rather than at each call site so a future
    // dispatch origin cannot reintroduce it: a generation already past its
    // first turn is never armed.
    if (generationHasStartedTurn(db, input.runtimeId, input.generation)) return
    const timeoutMs = resolveFirstTurnTimeoutMs(input.timeoutMsOverride)
    const dispatchedMs = Date.parse(input.primingDispatchedAt)
    if (!Number.isFinite(dispatchedMs)) return
    const deadline = new Date(dispatchedMs + timeoutMs).toISOString()
    const armed = db.firstTurnWatch.arm({
      runtimeId: input.runtimeId,
      generation: input.generation,
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: input.laneRef,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      primingDispatchedAt: input.primingDispatchedAt,
      firstTurnDeadlineAt: deadline,
    })
    if (armed !== null) {
      writeServerLog('INFO', 'runtime.first_turn_watch_armed', {
        runtimeId: input.runtimeId,
        generation: input.generation,
        scopeRef: input.scopeRef,
        runId: input.runId,
        timeoutMs,
        firstTurnDeadlineAt: deadline,
      })
    }
  } catch (error) {
    writeServerLog('WARN', 'runtime.first_turn_watch_arm_failed', {
      runtimeId: input.runtimeId,
      generation: input.generation,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** `turn.started` for the generation: the invariant is satisfied. */
export function noteFirstTurnStarted(
  db: HrcDatabase,
  runtimeId: string,
  generation: number,
  occurredAt: string
): void {
  try {
    db.firstTurnWatch.markFirstTurn(runtimeId, generation, occurredAt)
  } catch (error) {
    writeServerLog('WARN', 'runtime.first_turn_watch_clear_failed', {
      runtimeId,
      generation,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Disarm without recording a liveness failure. Exit failures carry their own
 * reason codes and must never be reclassified as a liveness trip.
 */
export function disarmFirstTurnWatch(
  db: HrcDatabase,
  runtimeId: string,
  generation: number,
  reason: string,
  occurredAt: string
): void {
  try {
    const disarmed = db.firstTurnWatch.disarm(runtimeId, generation, reason, occurredAt)
    if (disarmed !== null) {
      writeServerLog('INFO', 'runtime.first_turn_watch_disarmed', {
        runtimeId,
        generation,
        reason,
      })
    }
  } catch (error) {
    writeServerLog('WARN', 'runtime.first_turn_watch_disarm_failed', {
      runtimeId,
      generation,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * A `turn.started` arrived for a run that is ALREADY terminal. The run's
 * terminal answer to its caller never changes — no surface can observe a
 * resurrected run — but the turn itself is real and proceeds normally on the
 * still-live runtime, so it is recorded as a linked informational row rather
 * than dropped. Emitted by the event-mapper's terminality guard.
 */
export function emitFirstTurnLateStart(
  db: HrcDatabase,
  ctx: {
    runtimeId: string
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    transport?: HrcLifecycleTransport | undefined
  },
  run: HrcRunRecord,
  input: { invocationId: string; seq: number; occurredAt: string; now: string }
): HrcLifecycleEvent {
  const watch = db.firstTurnWatch.get(ctx.runtimeId, ctx.generation)
  writeServerLog('WARN', 'runtime.first_turn_missing_late_start', {
    runtimeId: ctx.runtimeId,
    generation: ctx.generation,
    runId: run.runId,
    terminalStatus: run.status,
    terminalErrorCode: run.errorCode,
    tripEventSeq: watch?.tripEventSeq,
  })
  return appendHrcEvent(db, HRC_FIRST_TURN_MISSING_LATE_START_EVENT, {
    ts: input.now,
    hostSessionId: ctx.hostSessionId,
    scopeRef: ctx.scopeRef,
    laneRef: ctx.laneRef,
    generation: ctx.generation,
    runtimeId: ctx.runtimeId,
    runId: run.runId,
    ...(ctx.transport !== undefined ? { transport: ctx.transport } : {}),
    payload: {
      runId: run.runId,
      invocationId: input.invocationId,
      seq: input.seq,
      startedAt: input.occurredAt,
      terminalStatus: run.status,
      ...(run.errorCode !== undefined ? { terminalErrorCode: run.errorCode } : {}),
      ...(run.completedAt !== undefined ? { terminalCompletedAt: run.completedAt } : {}),
      ...(watch?.tripEventSeq !== undefined ? { tripEventSeq: watch.tripEventSeq } : {}),
    },
  })
}

const LIVE_INVOCATION_STATES = new Set([
  'starting',
  'ready',
  'turn_active',
  'awaiting_input',
  'stopping',
])

/**
 * `continuation.cleared` disarms ONLY when the generation's invocation is also
 * gone. A clear that leaves the harness process running (`reason=clear` —
 * ordinary broker-controller behavior) must NOT disarm, or a wedged TUI could
 * escape the watchdog with a pre-first-turn clear.
 */
export function disarmFirstTurnWatchOnContinuationCleared(
  db: HrcDatabase,
  input: { runtimeId: string; generation: number; invocationId: string },
  occurredAt: string
): void {
  const invocation = db.brokerInvocations.getByInvocationId(input.invocationId)
  if (invocation === null) return
  if (LIVE_INVOCATION_STATES.has(invocation.invocationState)) return
  disarmFirstTurnWatch(
    db,
    input.runtimeId,
    input.generation,
    `continuation_cleared:${invocation.invocationState}`,
    occurredAt
  )
}
