/**
 * T-01946 — ask-bracket AUTHORITY predicate and RESTART re-derivation unit tests.
 *
 * Tests the pure predicates in ask-bracket.ts directly against a seeded
 * broker_invocation_events ledger — no server, no mapper, no live broker.
 *
 * Run: TMPDIR=/tmp bun test packages/hrc-server/src/__tests__/ask-bracket-predicate.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  ASK_USER_TOOL_NAMES,
  askBracketIdentityKey,
  deriveRuntimeStatusWithAwaiting,
  hasOpenAskBracket,
  isAskUserTool,
  isCorruptAwaitingRuntime,
  latestBrokerSeq,
  listOpenAskBrackets,
  runtimeHasAnyOpenAskBracket,
  runtimeHasOpenAskBracket,
} from '../ask-bracket'

import {
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  type SeededFixture,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

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

let nextSeq = 100

function resetSeq() {
  nextSeq = 100
}

function seq(): number {
  return nextSeq++
}

function appendStarted(toolCallId: string, name: string, runId = RUN_ID) {
  const s = seq()
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq: s,
    time: ts(s),
    type: 'tool.call.started',
    runtimeId: RUNTIME_ID,
    runId,
    payload: { toolCallId, name },
  })
  return s
}

function appendCompleted(toolCallId: string, name: string, runId = RUN_ID) {
  const s = seq()
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq: s,
    time: ts(s),
    type: 'tool.call.completed',
    runtimeId: RUNTIME_ID,
    runId,
    payload: { toolCallId, name },
  })
  return s
}

function appendFailed(toolCallId: string, name: string, runId = RUN_ID) {
  const s = seq()
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq: s,
    time: ts(s),
    type: 'tool.call.failed',
    runtimeId: RUNTIME_ID,
    runId,
    payload: { toolCallId, name },
  })
  return s
}

function appendTurnCompleted(turnId: string, runId = RUN_ID) {
  const s = seq()
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq: s,
    time: ts(s),
    type: 'turn.completed',
    runtimeId: RUNTIME_ID,
    runId,
    payload: { turnId, status: 'completed' },
  })
  return s
}

function setRuntimeActive() {
  fixture.db.runtimes.update(RUNTIME_ID, {
    activeInvocationId: INVOCATION_ID,
    activeRunId: RUN_ID,
    updatedAt: ts(0),
  })
}

// ---------------------------------------------------------------------------
// 1. OPEN: tool.call.started for AskUserQuestion → hasOpenAskBracket true
// ---------------------------------------------------------------------------
describe('1. OPEN: tool.call.started parks the bracket', () => {
  it('returns true when an ask tool.call.started has no matching close', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. CLOSED by tool.call.completed → hasOpenAskBracket false
// ---------------------------------------------------------------------------
describe('2. CLOSED by tool.call.completed', () => {
  it('returns false after a matching completed event closes the bracket', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    appendCompleted('tc-1', 'AskUserQuestion')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. CLOSED by tool.call.failed → hasOpenAskBracket false
// ---------------------------------------------------------------------------
describe('3. CLOSED by tool.call.failed', () => {
  it('returns false after a matching failed event closes the bracket', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    appendFailed('tc-1', 'AskUserQuestion')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. CLEARED by same-run terminal: turn.completed clears without explicit close
// ---------------------------------------------------------------------------
describe('4. CLEARED by same-run terminal event', () => {
  it('returns false when a same-run turn.completed appears after the open start', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    appendTurnCompleted('turn-x')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. CROSS-TOOLCALLID: completed for a different toolCallId does NOT close tc-1
// ---------------------------------------------------------------------------
describe('5. CROSS-TOOLCALLID: mismatched close does not close the open bracket', () => {
  it('returns true when a completed event has a different toolCallId', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    appendCompleted('tc-2', 'AskUserQuestion')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. NON-ASK tool: a non-ask tool.call.started does not open an ask bracket
// ---------------------------------------------------------------------------
describe('6. NON-ASK tool is ignored', () => {
  it('returns false for a Bash tool.call.started', () => {
    resetSeq()
    appendStarted('tc-b', 'Bash')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. CODEX request_user_input open → true; closed → false
// ---------------------------------------------------------------------------
describe('7. CODEX request_user_input', () => {
  it('is open after started', () => {
    resetSeq()
    appendStarted('tc-codex-1', 'request_user_input')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })

  it('is closed after completed', () => {
    resetSeq()
    appendStarted('tc-codex-1', 'request_user_input')
    appendCompleted('tc-codex-1', 'request_user_input')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. MULTIPLE brackets: closing only one still leaves the other open
// ---------------------------------------------------------------------------
describe('8. MULTIPLE open brackets', () => {
  it('still open when only the first of two is closed', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    appendStarted('tc-2', 'AskUserQuestion')
    appendCompleted('tc-1', 'AskUserQuestion')
    // tc-2 still open
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })

  it('false once both brackets are closed', () => {
    resetSeq()
    appendStarted('tc-1', 'AskUserQuestion')
    appendStarted('tc-2', 'AskUserQuestion')
    appendCompleted('tc-1', 'AskUserQuestion')
    appendCompleted('tc-2', 'AskUserQuestion')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. runtimeHas* and listOpenAskBrackets reflect the same predicate
// ---------------------------------------------------------------------------
describe('9. runtimeHasOpenAskBracket / runtimeHasAnyOpenAskBracket / listOpenAskBrackets', () => {
  beforeEach(() => {
    resetSeq()
    setRuntimeActive()
  })

  it('runtimeHasOpenAskBracket reflects hasOpenAskBracket when bracket is open', () => {
    appendStarted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtimeHasOpenAskBracket(fixture.db, runtime, RUN_ID)).toBe(true)
  })

  it('runtimeHasOpenAskBracket is false after close', () => {
    appendStarted('tc-1', 'AskUserQuestion')
    appendCompleted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtimeHasOpenAskBracket(fixture.db, runtime, RUN_ID)).toBe(false)
  })

  it('runtimeHasAnyOpenAskBracket is true with one open bracket', () => {
    const s1 = appendStarted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtimeHasAnyOpenAskBracket(fixture.db, runtime)).toBe(true)

    const open = listOpenAskBrackets(fixture.db, runtime)
    expect(open).toHaveLength(1)
    expect(open[0]!.toolCallId).toBe('tc-1')
    expect(open[0]!.seq).toBe(s1)
  })

  it('runtimeHasAnyOpenAskBracket returns false with no activeInvocationId', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: null as unknown as string,
      updatedAt: ts(0),
    })
    appendStarted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtimeHasAnyOpenAskBracket(fixture.db, runtime)).toBe(false)
  })

  it('listOpenAskBrackets returns both open brackets in seq order', () => {
    const s1 = appendStarted('tc-1', 'AskUserQuestion')
    const s2 = appendStarted('tc-2', 'request_user_input')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    const open = listOpenAskBrackets(fixture.db, runtime)
    expect(open).toHaveLength(2)
    expect(open[0]!.toolCallId).toBe('tc-1')
    expect(open[0]!.seq).toBe(s1)
    expect(open[1]!.toolCallId).toBe('tc-2')
    expect(open[1]!.seq).toBe(s2)
  })

  it('listOpenAskBrackets drops the bracket once completed', () => {
    appendStarted('tc-1', 'AskUserQuestion')
    appendCompleted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(listOpenAskBrackets(fixture.db, runtime)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 10. latestBrokerSeq returns the max seq for the invocation
// ---------------------------------------------------------------------------
describe('10. latestBrokerSeq', () => {
  it('returns undefined when no events exist', () => {
    expect(latestBrokerSeq(fixture.db, INVOCATION_ID)).toBeUndefined()
  })

  it('returns the maximum seq appended', () => {
    resetSeq()
    const s1 = appendStarted('tc-1', 'AskUserQuestion')
    const s2 = appendCompleted('tc-1', 'AskUserQuestion')
    const s3 = appendTurnCompleted('turn-x')
    expect(latestBrokerSeq(fixture.db, INVOCATION_ID)).toBe(Math.max(s1, s2, s3))
  })

  it('returns undefined for an unknown invocationId', () => {
    expect(latestBrokerSeq(fixture.db, 'no-such-invocation')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 11. isAskUserTool + ASK_USER_TOOL_NAMES + askBracketIdentityKey
// ---------------------------------------------------------------------------
describe('11. isAskUserTool and askBracketIdentityKey', () => {
  it('ASK_USER_TOOL_NAMES contains both ask tool names', () => {
    expect(ASK_USER_TOOL_NAMES).toContain('AskUserQuestion')
    expect(ASK_USER_TOOL_NAMES).toContain('request_user_input')
    expect(ASK_USER_TOOL_NAMES).toHaveLength(2)
  })

  it('isAskUserTool returns true for AskUserQuestion', () => {
    expect(isAskUserTool('AskUserQuestion')).toBe(true)
  })

  it('isAskUserTool returns true for request_user_input', () => {
    expect(isAskUserTool('request_user_input')).toBe(true)
  })

  it('isAskUserTool returns false for Bash', () => {
    expect(isAskUserTool('Bash')).toBe(false)
  })

  it('isAskUserTool returns false for undefined', () => {
    expect(isAskUserTool(undefined)).toBe(false)
  })

  it('askBracketIdentityKey is stable for the same inputs', () => {
    const key1 = askBracketIdentityKey({
      invocationId: INVOCATION_ID,
      runId: RUN_ID,
      harnessGeneration: 1,
      turnAttempt: 1,
      toolCallId: 'tc-1',
    })
    const key2 = askBracketIdentityKey({
      invocationId: INVOCATION_ID,
      runId: RUN_ID,
      harnessGeneration: 1,
      turnAttempt: 1,
      toolCallId: 'tc-1',
    })
    expect(key1).toBe(key2)
  })

  it('askBracketIdentityKey differs when toolCallId differs (re-ask)', () => {
    const key1 = askBracketIdentityKey({
      invocationId: INVOCATION_ID,
      runId: RUN_ID,
      toolCallId: 'tc-1',
    })
    const key2 = askBracketIdentityKey({
      invocationId: INVOCATION_ID,
      runId: RUN_ID,
      toolCallId: 'tc-2',
    })
    expect(key1).not.toBe(key2)
  })

  it('askBracketIdentityKey is a valid JSON string', () => {
    const key = askBracketIdentityKey({
      invocationId: INVOCATION_ID,
      toolCallId: 'tc-1',
    })
    expect(() => JSON.parse(key)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 12. isCorruptAwaitingRuntime
// ---------------------------------------------------------------------------
describe('12. isCorruptAwaitingRuntime', () => {
  it('returns true for status awaiting_input with no activeRunId', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'awaiting_input',
      activeRunId: null as unknown as string,
      updatedAt: ts(0),
    })
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(runtime.activeRunId).toBeUndefined()
    expect(isCorruptAwaitingRuntime(runtime)).toBe(true)
  })

  it('returns false when awaiting_input but activeRunId is set', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'awaiting_input',
      activeRunId: RUN_ID,
      updatedAt: ts(0),
    })
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(isCorruptAwaitingRuntime(runtime)).toBe(false)
  })

  it('returns false for status busy even with no activeRunId', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'busy',
      activeRunId: null as unknown as string,
      updatedAt: ts(0),
    })
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(isCorruptAwaitingRuntime(runtime)).toBe(false)
  })

  it('returns false for status ready even with no activeRunId', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'ready',
      activeRunId: null as unknown as string,
      updatedAt: ts(0),
    })
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(isCorruptAwaitingRuntime(runtime)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 13. deriveRuntimeStatusWithAwaiting — RESTART re-derivation
// ---------------------------------------------------------------------------
describe('13. deriveRuntimeStatusWithAwaiting (restart re-derivation)', () => {
  beforeEach(() => {
    resetSeq()
    setRuntimeActive()
  })

  it('promotes "busy" to "awaiting_input" when an open bracket exists', () => {
    appendStarted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtime, 'busy')).toBe('awaiting_input')
  })

  it('leaves "busy" unchanged when no open bracket exists', () => {
    appendStarted('tc-1', 'AskUserQuestion')
    appendCompleted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtime, 'busy')).toBe('busy')
  })

  it('leaves "ready" unchanged when no open bracket exists', () => {
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtime, 'ready')).toBe('ready')
  })

  it('promotes "ready" to "awaiting_input" when an open bracket exists', () => {
    appendStarted('tc-1', 'request_user_input')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtime, 'ready')).toBe('awaiting_input')
  })

  it('returns baseStatus unchanged when no activeInvocationId is set', () => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: null as unknown as string,
      updatedAt: ts(0),
    })
    // Append a bracket under the invocation, but runtime has no link
    appendStarted('tc-1', 'AskUserQuestion')
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtime, 'busy')).toBe('busy')
  })

  it('reverts to base status after terminal clears the bracket', () => {
    appendStarted('tc-1', 'AskUserQuestion')
    const runtimeBefore = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtimeBefore, 'busy')).toBe(
      'awaiting_input'
    )

    appendTurnCompleted('turn-x')
    const runtimeAfter = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(deriveRuntimeStatusWithAwaiting(fixture.db, runtimeAfter, 'busy')).toBe('busy')
  })
})
