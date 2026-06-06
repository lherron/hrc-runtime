/**
 * T-01946 admission-path behavior tests for the ask-user "awaiting_input" state.
 *
 * Covers:
 *  1. assertRuntimeNotBusy — throws RUNTIME_BUSY for a corrupt awaiting_input runtime
 *     (status set, no activeRunId).
 *  2. assertRuntimeNotBusy — throws RUNTIME_BUSY when an active run is in-flight.
 *  3. assertRuntimeNotBusy — returns cleanly for a healthy idle runtime.
 *  4. assertRuntimeNotBusy — returns cleanly when activeRunId points to a completed run.
 *  5. isPendingAskUserQuestionRun — TRUE for an open `request_user_input` bracket.
 *  6. isPendingAskUserQuestionRun — TRUE for an open `AskUserQuestion` bracket; FALSE
 *     once a matching tool_result closes it; FALSE after turn.completed clears all.
 *  7. isBrokerRuntimeQueueCapable — FALSE for {turns:'single'} caps; TRUE after
 *     updating the invocation to {input:{queue:true}}.
 *
 * Run with: TMPDIR=/tmp bun test packages/hrc-server/src/__tests__/ask-bracket-admission.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { HrcLifecycleEvent } from 'hrc-core'

import {
  assertRuntimeNotBusy,
  isBrokerRuntimeQueueCapable,
  isPendingAskUserQuestionRun,
} from '../require-helpers'
import {
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'
import type { SeededFixture } from './broker-event-mapper-fixtures'

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the current runtime snapshot from the DB. */
function getRuntime() {
  const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!runtime) throw new Error(`runtime ${RUNTIME_ID} not found`)
  return runtime
}

/** Build a minimal HrcLifecycleEvent-shaped object for isPendingAskUserQuestionRun. */
function mkEvent(eventKind: string, payload: Record<string, unknown>): HrcLifecycleEvent {
  return {
    hrcSeq: 0,
    streamSeq: 0,
    ts: ts(0),
    hostSessionId: 'hsid_test',
    scopeRef: 'agent:test',
    laneRef: 'default',
    generation: 1,
    category: 'runtime' as const,
    eventKind,
    replayed: false,
    payload,
  } as unknown as HrcLifecycleEvent
}

// ---------------------------------------------------------------------------
// 1. assertRuntimeNotBusy — THROWS for corrupt awaiting_input (no activeRunId)
// ---------------------------------------------------------------------------

describe('assertRuntimeNotBusy', () => {
  it('throws RUNTIME_BUSY for a corrupt awaiting_input runtime (status set, no activeRunId)', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'awaiting_input',
      activeRunId: undefined,
      updatedAt: ts(1),
    })
    const runtime = getRuntime()

    let caught: unknown
    try {
      assertRuntimeNotBusy(fixture.db, runtime)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(HrcConflictError)
    expect((caught as HrcConflictError).code).toBe(HrcErrorCode.RUNTIME_BUSY)
  })

  // -------------------------------------------------------------------------
  // 2. assertRuntimeNotBusy — THROWS when active run is in-flight
  // -------------------------------------------------------------------------

  it('throws RUNTIME_BUSY when there is an active run (status: running)', () => {
    fixture.db.runs.update(RUN_ID, { status: 'running', updatedAt: ts(2) })
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'busy',
      activeRunId: RUN_ID,
      updatedAt: ts(2),
    })
    const runtime = getRuntime()

    let caught: unknown
    try {
      assertRuntimeNotBusy(fixture.db, runtime)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(HrcConflictError)
    expect((caught as HrcConflictError).code).toBe(HrcErrorCode.RUNTIME_BUSY)
  })

  // -------------------------------------------------------------------------
  // 3. assertRuntimeNotBusy — RETURNS cleanly for a healthy idle runtime
  // -------------------------------------------------------------------------

  it('returns without throwing for a healthy idle runtime (status: ready, no activeRunId)', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'ready',
      activeRunId: undefined,
      updatedAt: ts(3),
    })
    const runtime = getRuntime()

    expect(() => assertRuntimeNotBusy(fixture.db, runtime)).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // 4. assertRuntimeNotBusy — RETURNS when active run is completed
  // -------------------------------------------------------------------------

  it('returns without throwing when activeRunId points to a completed run', () => {
    fixture.db.runs.update(RUN_ID, { status: 'completed', updatedAt: ts(4) })
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'ready',
      activeRunId: RUN_ID,
      updatedAt: ts(4),
    })
    const runtime = getRuntime()

    expect(() => assertRuntimeNotBusy(fixture.db, runtime)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5. isPendingAskUserQuestionRun — open `request_user_input` bracket
// ---------------------------------------------------------------------------

describe('isPendingAskUserQuestionRun', () => {
  it('returns true for an open request_user_input tool call with no matching tool_result', () => {
    const events: HrcLifecycleEvent[] = [
      mkEvent('turn.tool_call', { toolName: 'request_user_input', toolUseId: 'tuid_rui_1' }),
    ]
    expect(isPendingAskUserQuestionRun(events)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 6. isPendingAskUserQuestionRun — AskUserQuestion open/close/clear
  // -------------------------------------------------------------------------

  it('returns true for an open AskUserQuestion bracket', () => {
    const events: HrcLifecycleEvent[] = [
      mkEvent('turn.tool_call', { toolName: 'AskUserQuestion', toolUseId: 'tuid_auq_1' }),
    ]
    expect(isPendingAskUserQuestionRun(events)).toBe(true)
  })

  it('returns false once a matching turn.tool_result closes the AskUserQuestion bracket', () => {
    const events: HrcLifecycleEvent[] = [
      mkEvent('turn.tool_call', { toolName: 'AskUserQuestion', toolUseId: 'tuid_auq_2' }),
      mkEvent('turn.tool_result', { toolUseId: 'tuid_auq_2' }),
    ]
    expect(isPendingAskUserQuestionRun(events)).toBe(false)
  })

  it('returns false after turn.completed clears all open brackets', () => {
    const events: HrcLifecycleEvent[] = [
      mkEvent('turn.tool_call', { toolName: 'AskUserQuestion', toolUseId: 'tuid_auq_3' }),
      mkEvent('turn.completed', {}),
    ]
    expect(isPendingAskUserQuestionRun(events)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. isBrokerRuntimeQueueCapable — queue flag true/false
// ---------------------------------------------------------------------------

describe('isBrokerRuntimeQueueCapable', () => {
  it('returns false when capabilities lack input.queue (seeded {turns:"single"})', () => {
    // The seeded fixture has capabilitiesJson = JSON.stringify({ turns: 'single' }).
    // The runtime needs activeInvocationId pointing at the broker invocation.
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: String(INVOCATION_ID),
      updatedAt: ts(10),
    })
    const runtime = getRuntime()

    expect(isBrokerRuntimeQueueCapable(fixture.db, runtime)).toBe(false)
  })

  it('returns true after updating the invocation capabilitiesJson to {input:{queue:true}}', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: String(INVOCATION_ID),
      updatedAt: ts(11),
    })
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      capabilitiesJson: JSON.stringify({ input: { queue: true } }),
      updatedAt: ts(11),
    })
    const runtime = getRuntime()

    expect(isBrokerRuntimeQueueCapable(fixture.db, runtime)).toBe(true)
  })
})
