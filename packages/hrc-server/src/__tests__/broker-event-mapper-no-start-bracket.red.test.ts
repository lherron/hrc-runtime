/**
 * RED tests (T-04845) — no-`turn.started`-bracket ownership attribution.
 *
 * Live incident smokey@agent-spaces:T-04829 (rt-4f40d76c, run-1fd136bc): the
 * broker dispatched a turn to an IDLE runtime but emitted NO `turn.started`
 * (broker ledger inv-1faf9b85: input.accepted -> user.message -> tool/assistant
 * -> turn.completed). With no open turn bracket, `resolveRunIdForEvent` hits the
 * line-224 fallback and returns undefined, so the whole turn body + terminal
 * orphan to empty run_id and the run is never finalized.
 *
 * Daedalus ruling (DM #8234, option B — APPROVED WITH NARROWING): a run may be
 * attributed WITHOUT a turn.started bracket ONLY when durable broker order
 * proves it is ALREADY the runtime owner. The no-bracket branch may use a
 * candidate iff ALL hold:
 *   1. input.accepted(candidate.dispatchedInputId) at seq <= event.seq;
 *   2. runtime.activeRunId === run.runId (or invocation.runId initial-start);
 *   3. candidate accept seq is AFTER the previous terminal turn seq;
 *   4. no open turn bracket AND no open ask bracket;
 *   5. no other active nonterminal run for the invocation.
 * Else return undefined (keep line-224 default for ambiguity).
 *
 * Test #2 is RED today (returns undefined; should attribute to the owner).
 * Tests #3/#4 are regression guards: they must STAY undefined — proving the new
 * branch never steals events from a non-owner / ambiguous case (T-04238 stays
 * protected).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'

import type {
  InvocationEventEnvelope,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  O_INPUT_ID,
  O_INPUT_OTHER_ID,
  O_INVOCATION_ID,
  O_RUNTIME_ID,
  O_RUN_ID,
  O_RUN_OTHER_ID,
  Q_INPUT_A_ID,
  Q_INPUT_B_ID,
  Q_INVOCATION_ID,
  Q_RUN_A_ID,
  Q_RUN_B_ID,
  type SeededFixture,
  makeOwnedNoBracketFixture,
  makeQueuedFixture,
  ts,
} from './broker-event-mapper-fixtures'

function oEnv(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  invocationId = O_INVOCATION_ID,
  extra: Partial<Pick<InvocationEventEnvelope, 'turnId' | 'inputId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

const msg = (id: string, text: string) => ({
  messageId: id,
  content: [{ type: 'text', text }],
  final: true,
})

// ── Test #2: owner attribution when broker omits turn.started ───────────────
describe('[RED T-04845/2] no-start-bracket: single runtime-owned run gets the turn', () => {
  let fx: SeededFixture
  let mapper: BrokerEventMapper

  beforeEach(async () => {
    fx = await makeOwnedNoBracketFixture()
    mapper = new BrokerEventMapper({ db: fx.db, now: () => ts(100) })
  })
  afterEach(async () => {
    await fx.cleanup()
  })

  function applyIncidentSequence() {
    // input.accepted carries the inputId (links to run O_RUN_ID); NO turn.started.
    mapper.apply(
      oEnv('input.accepted', 1, { inputId: O_INPUT_ID }, O_INVOCATION_ID, { inputId: O_INPUT_ID })
    )
    const body = mapper.apply(
      oEnv('assistant.message.completed', 2, msg('m1', 'committed 2489bd6'))
    )
    const term = mapper.apply(oEnv('turn.completed', 3, { status: 'completed' }))
    return { body, term }
  }

  it('attributes the no-start turn.completed to the runtime-owned run', () => {
    const { term } = applyIncidentSequence()
    expect(term.lifecycleEvents[0]?.runId).toBe(O_RUN_ID)
  })

  it('attributes the no-start body event to the runtime-owned run', () => {
    const { body } = applyIncidentSequence()
    expect(body.lifecycleEvents[0]?.runId).toBe(O_RUN_ID)
  })

  it('finalizes the run completed and clears runtime ownership on terminal', () => {
    applyIncidentSequence()
    const run = fx.db.runs.getByRunId(O_RUN_ID)
    const runtime = fx.db.runtimes.getByRuntimeId(O_RUNTIME_ID)
    expect(run?.status).toBe('completed')
    expect(runtime?.activeRunId).toBeUndefined()
  })
})

// ── Test #3 + #4: regression / ambiguity guards (must STAY undefined) ────────
describe('[GUARD T-04845/3-4] no-start attribution never steals from non-owner/ambiguous', () => {
  let fx: SeededFixture
  let mapper: BrokerEventMapper

  beforeEach(async () => {
    fx = await makeQueuedFixture()
    mapper = new BrokerEventMapper({ db: fx.db, now: () => ts(100) })
  })
  afterEach(async () => {
    await fx.cleanup()
  })

  // The queued fixture: runtime owner = run A; runs B and C are also accepted
  // (active nonterminal). A queued input B that never claimed ownership must not
  // receive a stray post-terminal event just because it is the latest accepted
  // input (T-04238 post-terminal gap).
  it('#3 post-terminal stray event does NOT attribute to non-owner queued run B', () => {
    const TURN_A = 'turn_q_A' as TurnId
    mapper.apply(
      oEnv('input.accepted', 1, { inputId: Q_INPUT_A_ID }, Q_INVOCATION_ID, {
        inputId: Q_INPUT_A_ID,
      })
    )
    mapper.apply(oEnv('turn.started', 2, { turnId: TURN_A }, Q_INVOCATION_ID, { turnId: TURN_A }))
    mapper.apply(
      oEnv('input.accepted', 3, { inputId: Q_INPUT_B_ID }, Q_INVOCATION_ID, {
        inputId: Q_INPUT_B_ID,
      })
    )
    mapper.apply(
      oEnv('turn.completed', 7, { turnId: TURN_A, status: 'completed' }, Q_INVOCATION_ID, {
        turnId: TURN_A,
      })
    )
    // Stray body event at seq 8 — A's bracket closed, B is the latest accepted
    // input but is NOT the runtime owner. Must orphan, never attribute to B.
    const stray = mapper.apply(
      oEnv('assistant.message.completed', 8, msg('m_stray', 'stray'), Q_INVOCATION_ID)
    )
    expect(stray.lifecycleEvents[0]?.runId).toBeUndefined()
    expect(fx.db.runs.getByRunId(Q_RUN_B_ID)?.status).toBe('accepted')
  })

  // #4: more than one active nonterminal run for the invocation ⇒ ambiguous ⇒
  // undefined, even though run A IS the runtime owner (clause 5 fails: B/C are
  // active accepted runs).
  it('#4 ambiguous: owner present but other active runs exist ⇒ undefined', () => {
    mapper.apply(
      oEnv('input.accepted', 1, { inputId: Q_INPUT_A_ID }, Q_INVOCATION_ID, {
        inputId: Q_INPUT_A_ID,
      })
    )
    // No turn.started for A; A is the owner (activeRunId=A) but B and C are also
    // accepted ⇒ clause 5 must reject ⇒ undefined.
    const term = mapper.apply(oEnv('turn.completed', 2, { status: 'completed' }, Q_INVOCATION_ID))
    expect(term.lifecycleEvents[0]?.runId).toBeUndefined()
    expect(fx.db.runs.getByRunId(Q_RUN_A_ID)?.status).toBe('accepted')
  })
})

// ── Test #4 (owner-undefined guard) on the single-owner fixture ─────────────
describe('[GUARD T-04845/4b] owner undefined ⇒ undefined', () => {
  let fx: SeededFixture
  let mapper: BrokerEventMapper

  beforeEach(async () => {
    fx = await makeOwnedNoBracketFixture()
    mapper = new BrokerEventMapper({ db: fx.db, now: () => ts(100) })
  })
  afterEach(async () => {
    await fx.cleanup()
  })

  it('runtime with no activeRunId does not adopt the prior input.accepted run', () => {
    // Clear ownership: simulate a runtime that is NOT pinned to the run.
    fx.db.runtimes.updateRunId(O_RUNTIME_ID, undefined, ts(1))
    fx.db.runtimes.update(O_RUNTIME_ID, { status: 'ready', updatedAt: ts(1) })
    mapper.apply(
      oEnv('input.accepted', 1, { inputId: O_INPUT_ID }, O_INVOCATION_ID, { inputId: O_INPUT_ID })
    )
    const term = mapper.apply(oEnv('turn.completed', 3, { status: 'completed' }))
    expect(term.lifecycleEvents[0]?.runId).toBeUndefined()
  })

  it('owner mismatch: prior input belongs to a different run than the owner ⇒ undefined', () => {
    // Seed a second, non-owner run + its input.accepted at a higher seq.
    fx.db.runs.insert({
      runId: O_RUN_OTHER_ID,
      hostSessionId: fx.db.runtimes.getByRuntimeId(O_RUNTIME_ID)!.hostSessionId,
      runtimeId: O_RUNTIME_ID,
      scopeRef: fx.db.runtimes.getByRuntimeId(O_RUNTIME_ID)!.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(5),
      updatedAt: ts(5),
      operationId: 'op_owned_nobracket',
      dispatchedInputId: O_INPUT_OTHER_ID,
    })
    mapper.apply(
      oEnv('input.accepted', 1, { inputId: O_INPUT_ID }, O_INVOCATION_ID, { inputId: O_INPUT_ID })
    )
    // A later input.accepted for the NON-owner run; its turn.completed must not
    // attribute to the non-owner (owner is still O_RUN_ID) nor to the owner.
    mapper.apply(
      oEnv('input.accepted', 5, { inputId: O_INPUT_OTHER_ID }, O_INVOCATION_ID, {
        inputId: O_INPUT_OTHER_ID,
      })
    )
    const term = mapper.apply(oEnv('turn.completed', 6, { status: 'completed' }))
    // The nearest prior input.accepted is the non-owner (seq 5) ⇒ clause 2 + 5
    // reject ⇒ undefined.
    expect(term.lifecycleEvents[0]?.runId).toBeUndefined()
  })
})
