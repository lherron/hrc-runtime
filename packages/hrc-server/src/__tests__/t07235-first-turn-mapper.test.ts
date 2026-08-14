/**
 * T-07235 — event-mapper side of the provision-liveness watchdog.
 *
 * Three invariants:
 *   1. `turn.started` clears the generation's watch (the invariant is met);
 *   2. `invocation.exited` disarms, and `continuation.cleared` disarms ONLY
 *      when the invocation is also gone — a clear that leaves the harness
 *      running must not let a wedged TUI escape;
 *   3. run-terminal monotonicity: a LATE `turn.started` can never resurrect a
 *      run already answered as terminal. It emits
 *      `first_turn_missing.late_start` instead, and the turn proceeds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HRC_FIRST_TURN_MISSING_LATE_START_EVENT, HrcErrorCode } from 'hrc-core'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { armFirstTurnWatch } from '../first-turn-watch'

import {
  GENERATION,
  HOST_SESSION_ID,
  INVOCATION_ID,
  LANE_REF,
  RUNTIME_ID,
  RUN_ID,
  SCOPE_REF,
  type SeededFixture,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

function env(
  type: InvocationEventType,
  seq: number,
  payload: unknown = {}
): InvocationEventEnvelope {
  return {
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
  }
}

function arm(fixture: SeededFixture): void {
  armFirstTurnWatch(fixture.db, {
    runtimeId: RUNTIME_ID,
    generation: GENERATION,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    transport: 'headless',
    timeoutMsOverride: 120_000,
    primingDispatchedAt: ts(0),
  })
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeSeededFixture()
  mapper = new BrokerEventMapper({ db: fixture.db })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('clear on turn.started', () => {
  it('stamps firstTurnAt for the generation', () => {
    arm(fixture)
    mapper.apply(env('turn.started', 1, { turnId: 'turn-1' }))
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, GENERATION)
    expect(watch?.firstTurnAt).toBe(ts(1))
  })
})

describe('disarm', () => {
  it('invocation.exited disarms so an exit reason is never reclassified', () => {
    arm(fixture)
    mapper.apply(env('invocation.exited', 1, { reason: 'process-exit', exitCode: 1 }))
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, GENERATION)
    expect(watch?.disarmedAt).toBeDefined()
    expect(watch?.disarmReason).toBe('invocation_exited:process-exit')
  })

  it('continuation.cleared does NOT disarm while the invocation is still live', () => {
    arm(fixture)
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      invocationState: 'ready',
      updatedAt: ts(1),
    })
    mapper.apply(env('continuation.cleared', 1, { reason: 'clear' }))
    // A wedged TUI must not escape the watchdog with a pre-first-turn clear.
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, GENERATION)?.disarmedAt).toBeUndefined()
  })

  it('continuation.cleared disarms once the invocation is also gone', () => {
    arm(fixture)
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      invocationState: 'exited',
      updatedAt: ts(1),
    })
    mapper.apply(env('continuation.cleared', 2, { reason: 'clear' }))
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, GENERATION)
    expect(watch?.disarmedAt).toBeDefined()
    expect(watch?.disarmReason).toBe('continuation_cleared:exited')
  })
})

describe('run-terminal monotonicity under a late start', () => {
  function markRunTripped(): void {
    fixture.db.runs.markCompleted(RUN_ID, {
      status: 'failed',
      completedAt: ts(5),
      updatedAt: ts(5),
      errorCode: HrcErrorCode.FIRST_TURN_MISSING,
      errorMessage: 'no turn.started; diagnostics: hrc runtime diagnostics 7',
    })
  }

  it('never rewrites a terminal run back to running', () => {
    arm(fixture)
    markRunTripped()
    mapper.apply(env('turn.started', 10, { turnId: 'turn-late' }))

    const run = fixture.db.runs.getByRunId(RUN_ID)
    expect(run?.status).toBe('failed')
    expect(run?.completedAt).toBe(ts(5))
    expect(run?.errorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)
  })

  it('records the late start as a linked informational event', () => {
    arm(fixture)
    markRunTripped()
    const result = mapper.apply(env('turn.started', 10, { turnId: 'turn-late' }))

    const lateStart = fixture.db.hrcEvents.listByKind(HRC_FIRST_TURN_MISSING_LATE_START_EVENT)
    expect(lateStart).toHaveLength(1)
    const payload = lateStart[0]?.payload as { runId: string; terminalErrorCode: string }
    expect(payload.runId).toBe(RUN_ID)
    expect(payload.terminalErrorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)
    // Live followers see it too, not just replay.
    expect(
      result.lifecycleEvents.some(
        (event) => event.eventKind === HRC_FIRST_TURN_MISSING_LATE_START_EVENT
      )
    ).toBe(true)
  })

  it('lets the real turn proceed on the still-live runtime (observe-only policy)', () => {
    arm(fixture)
    markRunTripped()
    mapper.apply(env('turn.started', 10, { turnId: 'turn-late' }))

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
      'turn_active'
    )
  })

  it('does not classify the run a second time when the late turn completes', () => {
    arm(fixture)
    markRunTripped()
    mapper.apply(env('turn.started', 10, { turnId: 'turn-late' }))
    mapper.apply(env('turn.completed', 11, { turnId: 'turn-late' }))

    const run = fixture.db.runs.getByRunId(RUN_ID)
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)
    // Ownership still clears, so the runtime is reusable.
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.activeRunId).toBeUndefined()
  })

  it('a healthy first turn is unaffected by the guard', () => {
    arm(fixture)
    mapper.apply(env('turn.started', 1, { turnId: 'turn-1' }))
    const run = fixture.db.runs.getByRunId(RUN_ID)
    expect(run?.status).toBe('running')
    expect(run?.startedAt).toBe(ts(1))
    expect(fixture.db.hrcEvents.listByKind(HRC_FIRST_TURN_MISSING_LATE_START_EVENT)).toHaveLength(0)
  })
})
