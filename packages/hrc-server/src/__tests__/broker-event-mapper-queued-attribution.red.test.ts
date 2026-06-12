/**
 * RED tests (T-04239) — queued-input turn attribution bug (T-04238)
 *
 * These 7 tests FAIL against current HEAD because `resolveRunIdForEvent` →
 * `findPriorInputAccepted` picks the MOST-RECENT input.accepted at seq ≤
 * event.seq.  When run B's input queues while run A's turn is still open,
 * B's input.accepted lands at a HIGHER seq than A's turn.started; all
 * subsequent turn-scoped events (assistant.*, tool.*, user.message,
 * turn.completed) resolve to run B instead of run A.
 *
 * Cascading effects:
 *  - turn.completed attributed to run B → `markRuntimeTurnTerminal` early-exits
 *    (activeRunId=A ≠ runId=B) → runtime stuck 'busy' forever
 *  - run A never completes; run B incorrectly marked completed
 *  - B's actual turn: `hasTerminalTurnAfter` sees A's spurious "terminal" and
 *    suppresses all of B's events (runId=undefined)
 *
 * The fix (T-04238 / larry): replace `findPriorInputAccepted` oracle with an
 * open-turn-bracket lookup (input.accepted.seq ≤ turn.started.seq ≤ event.seq,
 * no terminal closing that bracket before event.seq); turn.started claims
 * runtime.activeRunId for drained queued runs; markRuntimeTurnTerminal gains
 * defense-in-depth un-wedge path.
 *
 * Interleave sequence used by tests 1-3 and 5-6:
 *   seq=1  input.accepted(inputId=input_A)        run A dispatched
 *   seq=2  turn.started(turnId_A)                  A's turn opens
 *   seq=3  input.accepted(inputId=input_B)         B queued mid-turn
 *   seq=4  assistant.message                        A's assistant output
 *   seq=5  tool.call.started                        A's tool call
 *   seq=6  user.message                             A's interactive prompt
 *   seq=7  turn.completed(turnId_A)                A's turn terminal
 *   seq=8  (stray diagnostic — no open turn)
 *   seq=9  turn.started(turnId_B)                  B's turn opens
 *   seq=10 user.message                             B's interactive prompt
 *   seq=11 assistant.message                        B's assistant output
 *   seq=12 turn.completed(turnId_B)                B's turn terminal
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'

import {
  GENERATION,
  LANE_REF,
  Q_HOST_SESSION_ID,
  Q_INPUT_A_ID,
  Q_INPUT_B_ID,
  Q_INVOCATION_ID,
  Q_OPERATION_ID,
  Q_RUNTIME_ID,
  Q_RUN_A_ID,
  Q_RUN_B_ID,
  Q_SCOPE_REF,
  type SeededFixture,
  makeQueuedFixture,
  ts,
} from './broker-event-mapper-fixtures'
import type { InvocationEventEnvelope, InvocationEventType, TurnId } from 'spaces-harness-broker-protocol'

// ── Envelope builder scoped to the queued fixture's invocationId ──────────────
function qEnv(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: Partial<Pick<InvocationEventEnvelope, 'turnId' | 'inputId' | 'harnessGeneration' | 'turnAttempt'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId: Q_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

const TURN_A = 'turn_queued_A' as TurnId
const TURN_B = 'turn_queued_B' as TurnId

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeQueuedFixture()
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
})

afterEach(async () => {
  await fixture.cleanup()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Apply the A-side interleave sequence: A accepted → A started → B queued → A mid-turn events */
function applyAMidTurnSequence() {
  mapper.apply(qEnv('input.accepted', 1, { inputId: Q_INPUT_A_ID }, { inputId: Q_INPUT_A_ID }))
  mapper.apply(qEnv('turn.started', 2, { turnId: TURN_A }, { turnId: TURN_A }))
  mapper.apply(qEnv('input.accepted', 3, { inputId: Q_INPUT_B_ID }, { inputId: Q_INPUT_B_ID }))
}

/** Apply A's terminal turn.completed (seq=7) and return the result. */
function applyATerminal() {
  return mapper.apply(
    qEnv('turn.completed', 7, { turnId: TURN_A, status: 'completed', producedContent: true }, { turnId: TURN_A })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Interleave A
//
// Events during A's open turn (after B's input.accepted arrives at seq=3) must
// ALL attribute to run A. A's turn.completed must complete run A and flip the
// runtime to 'ready'.
//
// FAILS: findPriorInputAccepted(seq≥4) returns {inputId=input_B, seq=3}
//        → resolvedRunId=run_B for all of A's remaining events.
//        markRuntimeTurnTerminal(run_B) early-exits (activeRunId=A≠B)
//        → runtime stays 'busy', run A never completes, run B wrongly completes.
// ─────────────────────────────────────────────────────────────────────────────
describe('[RED T-04239/1] interleave A: events during A turn attribute to run A', () => {
  it('assistant.message during A turn resolves to run A (not the queued run B)', () => {
    applyAMidTurnSequence()
    const result = mapper.apply(
      qEnv('assistant.message.completed', 4, {
        messageId: 'msg_A_1',
        content: [{ type: 'text', text: 'A response' }],
        final: true,
      }, { turnId: TURN_A })
    )
    // FAILS: current code returns Q_RUN_B_ID (queued input at seq=3 is newest)
    expect(result.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)
  })

  it('tool.call.started during A turn resolves to run A', () => {
    applyAMidTurnSequence()
    const result = mapper.apply(
      qEnv('tool.call.started', 5, {
        toolCallId: 'tool_A_1',
        name: 'Bash',
        input: { command: 'echo hi' },
      }, { turnId: TURN_A })
    )
    // FAILS: current code returns Q_RUN_B_ID
    expect(result.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)
  })

  it('user.message during A turn resolves to run A', () => {
    applyAMidTurnSequence()
    const result = mapper.apply(
      qEnv('user.message', 6, { content: 'follow-up from A' }, { turnId: TURN_A })
    )
    // FAILS: current code returns Q_RUN_B_ID
    expect(result.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)
  })

  it("A's turn.completed resolves to run A, completing run A and flipping runtime ready", () => {
    applyAMidTurnSequence()
    const terminalResult = applyATerminal()

    // FAILS: turn.completed is attributed to run_B; run_A is never completed;
    //        markRuntimeTurnTerminal early-exits; runtime stays 'busy'
    expect(terminalResult.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)

    const runA = fixture.db.runs.getByRunId(Q_RUN_A_ID)!
    const runB = fixture.db.runs.getByRunId(Q_RUN_B_ID)!
    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!

    expect(runA.status).toBe('completed')        // FAILS: stays 'running'
    expect(runB.status).toBe('accepted')          // FAILS: gets 'completed'
    expect(runtime.status).toBe('ready')          // FAILS: stays 'busy'
    expect(runtime.activeRunId).toBeUndefined()   // FAILS: stays Q_RUN_A_ID
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Then B
//
// After A's full turn (including its terminal), B's own turn events should ALL
// attribute to run B. Runtime should acquire activeRunId=B at turn.started(B)
// and flip 'ready' at B's terminal.
//
// FAILS (attribution): hasTerminalTurnAfter(input_B.seq=3, event.seq=9+)
//        finds A's spurious terminal (seq=7, attributed to B) → resolvedRunId=undefined.
// FAILS (runtime): turn.started(B) does not currently set runtime.activeRunId=B.
// ─────────────────────────────────────────────────────────────────────────────
describe('[RED T-04239/2] then B: after A terminal, B turn events attribute to run B', () => {
  it("B's turn.started resolves to run B", () => {
    applyAMidTurnSequence()
    applyATerminal()

    const result = mapper.apply(
      qEnv('turn.started', 9, { turnId: TURN_B }, { turnId: TURN_B })
    )
    // FAILS: hasTerminalTurnAfter(3, 9) finds turn.completed at seq=7 → runId=undefined
    expect(result.lifecycleEvents[0]?.runId).toBe(Q_RUN_B_ID)
  })

  it("turn.started(B) claims runtime.activeRunId=B so the runtime is not orphaned", () => {
    applyAMidTurnSequence()
    applyATerminal()
    mapper.apply(qEnv('turn.started', 9, { turnId: TURN_B }, { turnId: TURN_B }))

    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    // FAILS: current code does not set activeRunId on turn.started for queued runs
    expect(runtime.activeRunId).toBe(Q_RUN_B_ID)
    expect(runtime.status).toBe('busy')
  })

  it("B's mid-turn events resolve to run B", () => {
    applyAMidTurnSequence()
    applyATerminal()
    mapper.apply(qEnv('turn.started', 9, { turnId: TURN_B }, { turnId: TURN_B }))

    const userResult = mapper.apply(
      qEnv('user.message', 10, { content: 'prompt for B' }, { turnId: TURN_B })
    )
    const assistResult = mapper.apply(
      qEnv('assistant.message.completed', 11, {
        messageId: 'msg_B_1',
        content: [{ type: 'text', text: 'B response' }],
        final: true,
      }, { turnId: TURN_B })
    )
    // FAILS: runId=undefined for both (hasTerminalTurnAfter suppresses B's attribution)
    expect(userResult.lifecycleEvents[0]?.runId).toBe(Q_RUN_B_ID)
    expect(assistResult.lifecycleEvents[0]?.runId).toBe(Q_RUN_B_ID)
  })

  it("B's turn.completed completes run B and flips runtime ready", () => {
    applyAMidTurnSequence()
    applyATerminal()
    mapper.apply(qEnv('turn.started', 9, { turnId: TURN_B }, { turnId: TURN_B }))

    const terminalB = mapper.apply(
      qEnv('turn.completed', 12, { turnId: TURN_B, status: 'completed', producedContent: true }, { turnId: TURN_B })
    )

    // FAILS: runId=undefined → run_B never completed; runtime stays wedged
    expect(terminalB.lifecycleEvents[0]?.runId).toBe(Q_RUN_B_ID)

    const runB = fixture.db.runs.getByRunId(Q_RUN_B_ID)!
    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runB.status).toBe('completed')   // FAILS: stays 'accepted'
    expect(runtime.status).toBe('ready')    // FAILS: stays 'busy'
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Post-terminal guard
//
// After A's terminal and before B's turn.started, a stray diagnostic/tool event
// (no open turn bracket) must get runId=undefined AND the runtime must be in a
// 'ready' state (A's terminal should have cleared it).
//
// Attribution (runId) correctly returns undefined with current code (the
// hasTerminalTurnAfter guard fires). BUT runtime.status stays 'busy' because
// markRuntimeTurnTerminal early-exits due to misattribution — so the combined
// state is wrong.
//
// FAILS: runtime.status stays 'busy' after A's terminal (wrong attribution
//        short-circuits markRuntimeTurnTerminal before it clears activeRunId).
// ─────────────────────────────────────────────────────────────────────────────
describe('[RED T-04239/3] post-terminal guard: stray event gets undefined + runtime is ready', () => {
  it('stray tool event after A terminal gets runId=undefined AND runtime is ready', () => {
    applyAMidTurnSequence()
    applyATerminal()

    // Stray event between A's terminal (seq=7) and B's turn.started (seq=9)
    const stray = mapper.apply(
      qEnv('tool.call.started', 8, {
        toolCallId: 'tool_stray_1',
        name: 'Bash',
        input: { command: 'date' },
      })
    )

    // Attribution correctly guards (runId=undefined) — this assertion passes.
    // Guard preserved: stray event must not be attributed to either run.
    expect(stray.lifecycleEvents[0]?.runId).toBeUndefined()
    expect(stray.events[0]?.runId).toBeUndefined()

    // Runtime MUST be ready after A's terminal. FAILS: stuck 'busy' because
    // markRuntimeTurnTerminal never ran (attribution gave run_B ≠ activeRunId=run_A).
    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runtime.status).toBe('ready')           // FAILS
    expect(runtime.activeRunId).toBeUndefined()     // FAILS
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Non-queued regression guard
//
// The standard single-input headless sequence (no queuing) must continue to
// attribute correctly and have correct runtime transitions after the fix.
// Uses the makeSeededFixture baseline (run has invocation.runId fallback).
//
// Currently GREEN. Included as a regression guard to ensure the fix does not
// break the non-queued attribution path.
// ─────────────────────────────────────────────────────────────────────────────
describe('[guard T-04239/4] non-queued regression: single-input sequence attributes correctly', () => {
  it('standard single input.accepted → turn.started → turn.completed cycle works', () => {
    // Uses the queued fixture (two runs) but only dispatches input A — no queued B.
    // Mirrors the non-queued scenario where dispatchedInputId linkage resolves normally.

    // Seed run A's dispatchedInputId (already set in makeQueuedFixture)
    mapper.apply(qEnv('input.accepted', 1, { inputId: Q_INPUT_A_ID }, { inputId: Q_INPUT_A_ID }))
    mapper.apply(qEnv('turn.started', 2, { turnId: TURN_A }, { turnId: TURN_A }))

    // NO input.accepted(B) — only A's turn events
    const assistResult = mapper.apply(
      qEnv('assistant.message.completed', 4, {
        messageId: 'msg_A_nr',
        content: [{ type: 'text', text: 'non-queued response' }],
        final: true,
      }, { turnId: TURN_A })
    )

    const terminalResult = applyATerminal()

    // All events should attribute to run A
    expect(assistResult.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)
    expect(terminalResult.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)

    // run A correctly completed, runtime ready
    expect(fixture.db.runs.getByRunId(Q_RUN_A_ID)!.status).toBe('completed')
    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runtime.status).toBe('ready')
    expect(runtime.activeRunId).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: Out-of-order guard
//
// When input.accepted(B) at seq=3 is projected BEFORE turn.started(A) at seq=2
// (unusual but possible under broker delivery races), the terminal at seq=7 must
// still resolve to run A (the open-turn-bracket oracle must be seq-based, not
// arrival-order-based).
//
// FAILS: even after applying seq=3 before seq=2, findPriorInputAccepted(7)
//        returns input_B (seq=3) because it's the most-recent seq ≤ 7.
// ─────────────────────────────────────────────────────────────────────────────
describe('[RED T-04239/5] out-of-order: input.accepted(B) before turn.started(A) still does not steal A terminal', () => {
  it('A terminal correctly resolves to run A even when input.accepted(B) arrived earlier', () => {
    // Apply in out-of-order arrival: B's input.accepted arrives before A's turn.started
    mapper.apply(qEnv('input.accepted', 1, { inputId: Q_INPUT_A_ID }, { inputId: Q_INPUT_A_ID }))
    // input.accepted(B) arrives at seq=3 but is processed BEFORE turn.started(A) at seq=2
    mapper.apply(qEnv('input.accepted', 3, { inputId: Q_INPUT_B_ID }, { inputId: Q_INPUT_B_ID }))
    mapper.apply(qEnv('turn.started', 2, { turnId: TURN_A }, { turnId: TURN_A }))

    const terminalResult = applyATerminal()

    // FAILS: findPriorInputAccepted(7) returns input_B at seq=3 (regardless of insertion order)
    expect(terminalResult.lifecycleEvents[0]?.runId).toBe(Q_RUN_A_ID)

    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runtime.status).toBe('ready')         // FAILS: stuck 'busy'
    expect(runtime.activeRunId).toBeUndefined()   // FAILS: stays Q_RUN_A_ID
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Ask-bracket guard (T-01946 invariant preserved under queued input)
//
// Scenario: run A opens an AskUserQuestion (ask bracket), the operator answers
// (bracket CLOSES), then A's turn.completed arrives.  With a closed bracket and
// a correct terminal attribution to run A, the runtime must flip to 'ready'.
//
// FAILS: with current code, turn.completed is attributed to run_B (misattribution),
//        markRuntimeTurnTerminal early-exits (activeRunId=A≠B). The runtime stays
//        'busy' instead of 'ready', even though the ask bracket is already closed
//        and there is no T-01946 reason to block the ready transition.
// ─────────────────────────────────────────────────────────────────────────────
describe('[RED T-04239/6] ask-bracket guard: closed ask bracket + correct terminal → runtime ready', () => {
  it('runtime flips to ready after terminal when ask bracket was opened and then closed', () => {
    applyAMidTurnSequence()

    // Open ask bracket (seq=5) — will misattribute to run_B with current code
    mapper.apply(
      qEnv('tool.call.started', 5, {
        toolCallId: 'tc_ask_A',
        name: 'AskUserQuestion',
        input: { prompt: 'Are you sure?' },
      }, { turnId: TURN_A })
    )
    // Runtime enters awaiting_input (ask bracket open, attributed to run_B in buggy code)
    expect(fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!.status).toBe('awaiting_input')

    // Close ask bracket (seq=6) — operator answered; runtime resumes as 'busy'
    mapper.apply(
      qEnv('tool.call.completed', 6, {
        toolCallId: 'tc_ask_A',
        name: 'AskUserQuestion',
        result: { output: 'yes' },
        isError: false,
        durationMs: 50,
      }, { turnId: TURN_A })
    )
    // Ask bracket now closed — runtime should be back to 'busy'
    expect(fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!.status).toBe('busy')

    // A's turn.completed arrives. Ask bracket is CLOSED, so T-01946 must NOT block.
    // With fixed code: attributed to run_A → markRuntimeTurnTerminal → no open ask
    //   bracket → clears activeRunId → runtime 'ready'.
    // With current code: attributed to run_B → early-exit (activeRunId=A≠B) →
    //   runtime stays 'busy'. FAILS.
    applyATerminal()

    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    // FAILS: runtime stays 'busy'; correct behavior is 'ready' (ask bracket closed,
    // terminal correctly attributed to run_A should clear the runtime).
    expect(runtime.status).toBe('ready')
    expect(runtime.activeRunId).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7: Defense-in-depth red
//
// When a turn.completed arrives whose resolved runId differs from the runtime's
// activeRunId, but: (a) the invocation is this runtime's active invocation,
// (b) no later open turn bracket exists, and (c) no ask bracket is open —
// markRuntimeTurnTerminal MUST clear the runtime 'busy' state (un-wedge) while
// NOT marking the mismatched active run as completed.
//
// This is the defense-in-depth path: attribution may be wrong, but the runtime
// must not be frozen busy forever.
//
// FAILS: current code does an early-return at
//   `if (runtime.activeRunId !== undefined && runtime.activeRunId !== runId) return`
// so the runtime stays 'busy' and the active run stays wedged.
// ─────────────────────────────────────────────────────────────────────────────
describe('[RED T-04239/7] defense-in-depth: runId mismatch un-wedges runtime without completing wrong run', () => {
  it('clears runtime busy when terminal belongs to active invocation but runId mismatches', () => {
    const db = fixture.db

    // Seed only A's input.accepted and turn.started (run A is now 'running')
    mapper.apply(qEnv('input.accepted', 1, { inputId: Q_INPUT_A_ID }, { inputId: Q_INPUT_A_ID }))
    mapper.apply(qEnv('turn.started', 2, { turnId: TURN_A }, { turnId: TURN_A }))

    // Also seed B's input.accepted (queued) — this causes the misattribution
    mapper.apply(qEnv('input.accepted', 3, { inputId: Q_INPUT_B_ID }, { inputId: Q_INPUT_B_ID }))

    // Now apply turn.completed — will resolve to run_B (misattribution)
    // The fix's defense-in-depth: detect that this invocation IS the active
    // one, no open turn, no ask bracket → clear busy even though runId≠activeRunId.
    applyATerminal()

    const runtime = db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    const runA = db.runs.getByRunId(Q_RUN_A_ID)!
    const runB = db.runs.getByRunId(Q_RUN_B_ID)!

    // FAILS: current code early-returns; runtime stays 'busy', activeRunId still set
    expect(runtime.status).toBe('ready')
    expect(runtime.activeRunId).toBeUndefined()

    // Run A must NOT be marked completed (attribution was wrong — we don't know
    // if A actually finished; only un-wedge the runtime).
    // This assertion PASSES with current code (A stays 'running'), but the
    // combined test fails on the runtime.status assertion above.
    expect(runA.status).not.toBe('completed')

    // Run B: in the buggy code it gets completed (wrong); after fix it should
    // NOT be completed by a turn it never ran. FAILS in current code: run_B.status='completed'.
    expect(runB.status).not.toBe('completed')
  })
})
