/**
 * T-01946 follow-up — composite bracket identity + lifecycle ordering tests.
 *
 * Tests two review-blocking fixes:
 *   1. COMPOSITE BRACKET IDENTITY: broker_invocation_events persists
 *      harnessGeneration / turnAttempt (migration 0022) and the
 *      hasOpenAskBracket predicate closes an open ask bracket ONLY when the
 *      closing event shares the FULL composite identity
 *      (run_id IS, harness_generation IS, turn_attempt IS, toolCallId IS).
 *   2. LIFECYCLE ORDERING: BrokerEventMapper.apply() returns derived
 *      turn.awaiting_input / turn.input_resumed events AFTER their canonical
 *      turn.tool_call / turn.tool_result counterpart, with strictly ascending
 *      hrcSeq.
 *
 * Run: TMPDIR=/tmp bun test packages/hrc-server/src/__tests__/ask-bracket-identity.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { hasOpenAskBracket } from '../ask-bracket'
import { BrokerEventMapper } from '../broker/event-mapper'

import {
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

// ---------------------------------------------------------------------------
// Shared fixture lifecycle
// ---------------------------------------------------------------------------

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function makeMapper() {
  return new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
}

// ---------------------------------------------------------------------------
// A. PERSISTENCE round-trip
// ---------------------------------------------------------------------------

describe('A. PERSISTENCE round-trip — harnessGeneration / turnAttempt columns', () => {
  it('A1: appendEvent with harnessGeneration:2 / turnAttempt:3 round-trips correctly', () => {
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 10,
      time: ts(10),
      type: 'tool.call.started',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      harnessGeneration: 2,
      turnAttempt: 3,
      payload: { toolCallId: 'tc-persist-1', name: 'AskUserQuestion' },
    })

    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    const row = rows.find((r) => r.seq === 10)
    expect(row).toBeDefined()
    expect(row!.harnessGeneration).toBe(2)
    expect(row!.turnAttempt).toBe(3)
  })

  it('A2: appendEvent without harnessGeneration / turnAttempt yields undefined on those fields', () => {
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 11,
      time: ts(11),
      type: 'tool.call.started',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      payload: { toolCallId: 'tc-persist-2', name: 'Bash' },
    })

    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    const row = rows.find((r) => r.seq === 11)
    expect(row).toBeDefined()
    // Nullable columns map to undefined on the record (not 0 or null)
    expect(row!.harnessGeneration).toBeUndefined()
    expect(row!.turnAttempt).toBeUndefined()
  })

  it('A3: mapper.apply persists harnessGeneration / turnAttempt from the envelope', () => {
    const mapper = makeMapper()
    mapper.apply(
      envelope(
        'tool.call.started',
        5,
        { toolCallId: 'tc-1', name: 'Bash' },
        { harnessGeneration: 4, turnAttempt: 1 }
      )
    )

    const rows = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    const row = rows.find((r) => r.seq === 5)
    expect(row).toBeDefined()
    expect(row!.harnessGeneration).toBe(4)
    expect(row!.turnAttempt).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// B. COMPOSITE CLOSE — mismatched identity must NOT close the bracket
// ---------------------------------------------------------------------------

describe('B. COMPOSITE CLOSE — identity mismatch leaves bracket open', () => {
  /**
   * Seed the open bracket for each sub-test:
   * tool.call.started gen1/attempt1/RUN_ID/tc-1
   */
  function seedOpenBracket() {
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 1,
      time: ts(1),
      type: 'tool.call.started',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      harnessGeneration: 1,
      turnAttempt: 1,
      payload: { toolCallId: 'tc-1', name: 'AskUserQuestion' },
    })
  }

  function appendCompleted(overrides: {
    seq?: number
    runId?: string
    harnessGeneration?: number
    turnAttempt?: number
    toolCallId?: string
  }) {
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: overrides.seq ?? 2,
      time: ts(overrides.seq ?? 2),
      type: 'tool.call.completed',
      runtimeId: RUNTIME_ID,
      runId: overrides.runId ?? RUN_ID,
      ...(overrides.harnessGeneration !== undefined
        ? { harnessGeneration: overrides.harnessGeneration }
        : { harnessGeneration: 1 }),
      ...(overrides.turnAttempt !== undefined
        ? { turnAttempt: overrides.turnAttempt }
        : { turnAttempt: 1 }),
      payload: { toolCallId: overrides.toolCallId ?? 'tc-1', name: 'AskUserQuestion' },
    })
  }

  it('B1: completed with DIFFERENT run_id does NOT close the bracket (still open)', () => {
    seedOpenBracket()
    appendCompleted({ seq: 2, runId: 'run-other' })
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })

  it('B2: completed with DIFFERENT harness_generation does NOT close the bracket (still open)', () => {
    seedOpenBracket()
    appendCompleted({ seq: 2, harnessGeneration: 2 })
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })

  it('B3: completed with DIFFERENT turn_attempt does NOT close the bracket (still open)', () => {
    seedOpenBracket()
    appendCompleted({ seq: 2, turnAttempt: 2 })
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })

  it('B4 REGRESSION: completed with IDENTICAL composite identity CLOSES the bracket', () => {
    seedOpenBracket()
    appendCompleted({ seq: 2, harnessGeneration: 1, turnAttempt: 1 })
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })

  it('B5 NULL-BOTH: started (null gen/attempt) + completed (null gen/attempt) CLOSES via IS null pairing', () => {
    // Seed with no generation/attempt (null columns)
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 1,
      time: ts(1),
      type: 'tool.call.started',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      payload: { toolCallId: 'tc-null', name: 'AskUserQuestion' },
    })

    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 2,
      time: ts(2),
      type: 'tool.call.completed',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      payload: { toolCallId: 'tc-null', name: 'AskUserQuestion' },
    })

    // NULL IS NULL => true, so it closes correctly
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })

  it('B6 TERMINAL run-scoped: turn.completed for same run clears open bracket regardless of gen', () => {
    // Open bracket with gen:1 / attempt:1
    seedOpenBracket()

    // Append a same-run turn.completed (no gen/attempt on the terminal row — run-scoped)
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 2,
      time: ts(2),
      type: 'turn.completed',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      payload: { turnId: 't', status: 'completed' },
    })

    // Terminal is run-scoped => clears even without matching gen/attempt
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. ORDERING — derived events come AFTER the canonical event, ascending hrcSeq
// ---------------------------------------------------------------------------

describe('C. ORDERING — derived lifecycle events follow canonical event, hrcSeq ascending', () => {
  it('C1: tool.call.started (AskUserQuestion) → turn.tool_call before turn.awaiting_input', () => {
    const mapper = makeMapper()

    const result = mapper.apply(
      envelope('tool.call.started', 5, { toolCallId: 'tc-1', name: 'AskUserQuestion', input: {} })
    )

    const { lifecycleEvents } = result
    const kinds = lifecycleEvents.map((e) => e.eventKind)

    // Both events present
    expect(kinds).toContain('turn.tool_call')
    expect(kinds).toContain('turn.awaiting_input')

    // Canonical comes before derived
    const toolCallIdx = kinds.indexOf('turn.tool_call')
    const awaitingIdx = kinds.indexOf('turn.awaiting_input')
    expect(toolCallIdx).toBeLessThan(awaitingIdx)

    // hrcSeq is strictly ascending across the returned array
    const seqs = lifecycleEvents.map((e) => e.hrcSeq)
    const sortedSeqs = [...seqs].sort((a, b) => a - b)
    expect(seqs).toEqual(sortedSeqs)

    // Specifically, tool_call hrcSeq < awaiting_input hrcSeq
    expect(lifecycleEvents[toolCallIdx]!.hrcSeq).toBeLessThan(lifecycleEvents[awaitingIdx]!.hrcSeq)
  })

  it('C2: tool.call.completed (AskUserQuestion close) → turn.tool_result before turn.input_resumed', () => {
    const mapper = makeMapper()

    // Open the bracket first
    mapper.apply(
      envelope('tool.call.started', 5, { toolCallId: 'tc-1', name: 'AskUserQuestion', input: {} })
    )

    // Close the bracket
    const result = mapper.apply(
      envelope('tool.call.completed', 6, {
        toolCallId: 'tc-1',
        name: 'AskUserQuestion',
        result: { content: [{ type: 'text', text: 'yes' }] },
        isError: false,
        durationMs: 50,
      })
    )

    const { lifecycleEvents } = result
    const kinds = lifecycleEvents.map((e) => e.eventKind)

    // Both events present
    expect(kinds).toContain('turn.tool_result')
    expect(kinds).toContain('turn.input_resumed')

    // Canonical before derived
    const toolResultIdx = kinds.indexOf('turn.tool_result')
    const resumedIdx = kinds.indexOf('turn.input_resumed')
    expect(toolResultIdx).toBeLessThan(resumedIdx)

    // hrcSeq strictly ascending
    const seqs = lifecycleEvents.map((e) => e.hrcSeq)
    const sortedSeqs = [...seqs].sort((a, b) => a - b)
    expect(seqs).toEqual(sortedSeqs)

    // Specifically, tool_result hrcSeq < input_resumed hrcSeq
    expect(lifecycleEvents[toolResultIdx]!.hrcSeq).toBeLessThan(lifecycleEvents[resumedIdx]!.hrcSeq)
  })
})
