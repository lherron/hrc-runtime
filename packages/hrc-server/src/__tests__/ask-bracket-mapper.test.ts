/**
 * Validation matrix for T-01946: ask-user bracket logic in the BROKER EVENT MAPPER.
 *
 * Matrix (daedalus): mapper open/close/fail/terminal/idempotent replay
 *
 * Tests the first-class "awaiting_input" state projected by BrokerEventMapper
 * when a turn is parked on AskUserQuestion (claude) or request_user_input (codex).
 *
 * Authority is the durable ask bracket in broker_invocation_events; the
 * hasOpenAskBracket predicate from ask-bracket.ts is the canonical check.
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
// 1. OPEN: AskUserQuestion parks the runtime as awaiting_input
// ---------------------------------------------------------------------------
describe('ask bracket: OPEN', () => {
  it('emits turn.awaiting_input lifecycle event when tool.call.started is an ask tool', () => {
    const mapper = makeMapper()

    const result = mapper.apply(
      envelope('tool.call.started', 5, { toolCallId: 'tc-1', name: 'AskUserQuestion', input: {} })
    )

    // Lifecycle event emitted
    const awaitingEvents = result.lifecycleEvents.filter(
      (e) => e.eventKind === 'turn.awaiting_input'
    )
    expect(awaitingEvents.length).toBe(1)

    // Runtime status
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('awaiting_input')

    // Invocation state
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
      'awaiting_input'
    )

    // Ask bracket is open
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)

    // Derived event payload includes toolUseId and toolName
    const payload = awaitingEvents[0]!.payload as Record<string, unknown>
    expect(payload['toolUseId']).toBe('tc-1')
    expect(payload['toolName']).toBe('AskUserQuestion')
  })
})

// ---------------------------------------------------------------------------
// 2. CLOSE via tool.call.completed: resumes the turn
// ---------------------------------------------------------------------------
describe('ask bracket: CLOSE via tool.call.completed', () => {
  it('emits turn.input_resumed and sets runtime busy when the ask bracket closes', () => {
    const mapper = makeMapper()

    // Open the bracket
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
        durationMs: 100,
      })
    )

    // Lifecycle event emitted
    const resumedEvents = result.lifecycleEvents.filter((e) => e.eventKind === 'turn.input_resumed')
    expect(resumedEvents.length).toBe(1)

    // Runtime status
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')

    // Invocation state
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
      'turn_active'
    )

    // Ask bracket is closed
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. CLOSE via tool.call.failed: also resumes the turn
// ---------------------------------------------------------------------------
describe('ask bracket: CLOSE via tool.call.failed', () => {
  it('emits turn.input_resumed and sets runtime busy when the ask bracket fails', () => {
    const mapper = makeMapper()

    // Open the bracket
    mapper.apply(
      envelope('tool.call.started', 10, {
        toolCallId: 'tc-fail',
        name: 'AskUserQuestion',
        input: {},
      })
    )

    // Fail-close the bracket
    const result = mapper.apply(
      envelope('tool.call.failed', 11, {
        toolCallId: 'tc-fail',
        name: 'AskUserQuestion',
        message: 'user cancelled',
      })
    )

    // Lifecycle event emitted
    const resumedEvents = result.lifecycleEvents.filter((e) => e.eventKind === 'turn.input_resumed')
    expect(resumedEvents.length).toBe(1)

    // Runtime status
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')

    // Invocation state
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
      'turn_active'
    )

    // Ask bracket is closed
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. CODEX: request_user_input parks and resumes the same way
// ---------------------------------------------------------------------------
describe('ask bracket: CODEX request_user_input', () => {
  it('parks on request_user_input and resumes on close', () => {
    const mapper = makeMapper()

    // Open
    const openResult = mapper.apply(
      envelope('tool.call.started', 20, {
        toolCallId: 'tc-codex-1',
        name: 'request_user_input',
        input: { prompt: 'What is your choice?' },
      })
    )

    expect(openResult.lifecycleEvents.map((e) => e.eventKind)).toContain('turn.awaiting_input')
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('awaiting_input')
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
      'awaiting_input'
    )
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)

    // Close
    const closeResult = mapper.apply(
      envelope('tool.call.completed', 21, {
        toolCallId: 'tc-codex-1',
        name: 'request_user_input',
        result: { content: [{ type: 'text', text: 'option A' }] },
        isError: false,
        durationMs: 50,
      })
    )

    expect(closeResult.lifecycleEvents.map((e) => e.eventKind)).toContain('turn.input_resumed')
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe(
      'turn_active'
    )
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. NON-ASK: a non-ask tool does NOT trigger awaiting_input
// ---------------------------------------------------------------------------
describe('ask bracket: NON-ASK tool', () => {
  it('does not emit turn.awaiting_input or set awaiting_input for a Bash tool call', () => {
    const mapper = makeMapper()

    const result = mapper.apply(
      envelope('tool.call.started', 30, {
        toolCallId: 'tc-bash-1',
        name: 'Bash',
        input: { command: 'ls /tmp' },
      })
    )

    // No awaiting event
    const awaitingEvents = result.lifecycleEvents.filter(
      (e) => e.eventKind === 'turn.awaiting_input'
    )
    expect(awaitingEvents.length).toBe(0)

    // Runtime NOT awaiting
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).not.toBe('awaiting_input')

    // No open ask bracket
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. RE-ASK: fresh toolUseId tracks the OPEN bracket, not a sticky flag
// ---------------------------------------------------------------------------
describe('ask bracket: RE-ASK tracks open bracket', () => {
  it('cycles through awaiting/busy/awaiting correctly on fresh toolCallId', () => {
    const mapper = makeMapper()

    // Open tc-1
    mapper.apply(
      envelope('tool.call.started', 40, {
        toolCallId: 'tc-seq-1',
        name: 'AskUserQuestion',
        input: {},
      })
    )
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('awaiting_input')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)

    // Close tc-1
    mapper.apply(
      envelope('tool.call.completed', 41, {
        toolCallId: 'tc-seq-1',
        name: 'AskUserQuestion',
        result: { content: [{ type: 'text', text: 'answer' }] },
        isError: false,
        durationMs: 10,
      })
    )
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)

    // Open tc-2 (re-ask)
    const reAskResult = mapper.apply(
      envelope('tool.call.started', 42, {
        toolCallId: 'tc-seq-2',
        name: 'AskUserQuestion',
        input: {},
      })
    )
    expect(reAskResult.lifecycleEvents.map((e) => e.eventKind)).toContain('turn.awaiting_input')
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('awaiting_input')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. TERMINAL CLEARS: open bracket is closed by a same-run turn.completed
// ---------------------------------------------------------------------------
describe('ask bracket: TERMINAL clears open bracket', () => {
  it('clears the open bracket and sets runtime ready when turn.completed follows an open ask', () => {
    const mapper = makeMapper()

    // Open bracket
    mapper.apply(
      envelope('tool.call.started', 50, {
        toolCallId: 'tc-term-1',
        name: 'AskUserQuestion',
        input: {},
      })
    )
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('awaiting_input')
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)

    // Set up runtime as interactive (activeRunId) so markRuntimeTurnTerminal can fire
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeRunId: RUN_ID,
      status: 'awaiting_input',
      runtimeStateJson: { status: 'awaiting_input', activeRunId: RUN_ID },
      updatedAt: ts(99),
    })

    // Apply turn.completed — same run, closes the bracket logically
    mapper.apply(
      envelope(
        'turn.completed',
        51,
        { turnId: 'turn_x', status: 'completed', producedContent: true },
        { turnId: 'turn_x' as never }
      )
    )

    // After terminal, the bracket is closed (turn.completed acts as same-run terminal)
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(false)

    // Runtime must NOT be left awaiting_input — it should be ready
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// 8. IDEMPOTENT REPLAY: same seq + same payload twice => single projection
// ---------------------------------------------------------------------------
describe('ask bracket: IDEMPOTENT replay', () => {
  it('second apply of same ask-open envelope returns idempotent:true with no double-emit', () => {
    const mapper = makeMapper()

    const askEnv = envelope('tool.call.started', 5, {
      toolCallId: 'tc-idem-1',
      name: 'AskUserQuestion',
      input: {},
    })

    // First apply
    const first = mapper.apply(askEnv)
    expect(first.idempotent).toBe(false)
    expect(first.lifecycleEvents.filter((e) => e.eventKind === 'turn.awaiting_input').length).toBe(
      1
    )

    const brokerRowsAfterFirst =
      fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length

    // Second apply — same envelope
    const second = mapper.apply(askEnv)
    expect(second.idempotent).toBe(true)
    expect(second.lifecycleEvents).toEqual([])

    // No new broker rows
    expect(fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length).toBe(
      brokerRowsAfterFirst
    )

    // Bracket still open (exactly one open ask, not doubled)
    expect(hasOpenAskBracket(fixture.db, INVOCATION_ID, RUN_ID)).toBe(true)
  })
})
