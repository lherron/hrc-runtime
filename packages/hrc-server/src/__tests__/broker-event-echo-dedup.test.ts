/**
 * RED tests (T-01696 / T-01690 Wave W3A) for the idempotent BROKER EVENT MAPPER.
 *
 * These tests are EXPECTED TO FAIL until curly implements
 *   packages/hrc-server/src/broker/event-mapper.ts
 * (red signal = module-not-found on the import below).
 *
 * The mapper is the SOLE interpreter of broker `InvocationEventEnvelope`
 * payloads. It resolves projection context from the persisted broker invocation
 * and, in ONE SQLite transaction:
 *   1. appends the broker event by (invocationId, seq) via the W1B idempotent
 *      append repo (`BrokerInvocationEventRepository.appendEvent`);
 *   2. projects the event into HRC state (runtime / run / buffer / continuation
 *      / surface / permission audit / diagnostics);
 *   3. emits canonical lifecycle rows through `HrcEventRepository`;
 *   4. marks the broker event row projection_status = 'applied'.
 *
 * Contract invariants under test:
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     BrokerInvocationEventConflictError, NO projection;
 *   - the retired raw `events` mirror remains empty;
 *   - full ordered sequence projects runtime/run/message/tool/continuation;
 *   - replay of the whole sequence is a no-op.
 *
 * Public API under test (documented for curly in the final reply):
 *   class BrokerEventMapper {
 *     constructor(deps: { db: HrcDatabase; now?: () => string })
 *     apply(envelope: InvocationEventEnvelope): {
 *       idempotent: boolean
 *       events: HrcEventEnvelope[]   // retired compatibility surface; always empty
 *     }
 *   }
 */
import { describe, expect, it } from 'bun:test'
import type { TurnId } from 'spaces-harness-broker-protocol'

// RED gate: this module does not exist yet (curly creates it under src/broker/).
import { BrokerEventMapper } from '../broker/event-mapper'

import {
  GENERATION,
  HOST_SESSION_ID,
  LANE_REF,
  RUNTIME_ID,
  SCOPE_REF,
  TMUX_INVOCATION_ID,
  TMUX_RUNTIME_ID,
  envelope,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('broker.user.message echo dedup (T-04215)', () => {
  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Seed a prior synthetic turn.user_prompt into the standard harness.fixture's hrc_events,
   * simulating what broker-interactive-handlers.ts emits at injection time
   * (before the TUI echoes the same prompt back via broker user.message).
   */
  function seedPriorSynthUserPrompt(content: string): void {
    harness.fixture.db.hrcEvents.append({
      ts: ts(1),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION,
      runtimeId: RUNTIME_ID,
      category: 'turn',
      eventKind: 'turn.user_prompt',
      transport: 'headless',
      payload: { type: 'message_end', message: { role: 'user', content } },
    })
  }

  // ── Test 2a (RED) — tmux harness.fixture, runId absent ────────────────────────────
  //
  // The canonical RED test: mirrors the REAL broker-tmux interactive shape
  // where the broker invocation carries no runId.  A prior synthetic
  // turn.user_prompt already exists in hrc_events (same runtimeId, same
  // content, same generation).  Applying the broker user.message echo must NOT
  // produce a second lifecycle turn.user_prompt.
  //
  // Current code: emitLifecycle always projects 'user.message' → 'turn.user_prompt'
  // → this test FAILS RED until the suppression is implemented.
  it('[RED] does NOT project a second turn.user_prompt when prior synth exists — runId-absent (real tmux shape)', async () => {
    // makeTmuxSeededFixture pre-seeds the prior synthetic turn.user_prompt.
    const tmuxFixture = await makeTmuxSeededFixture('ship the fix')
    try {
      const mapper = new BrokerEventMapper({ db: tmuxFixture.db, now: () => ts(100) })

      const result = mapper.apply({
        invocationId: TMUX_INVOCATION_ID,
        seq: 9,
        time: ts(9),
        type: 'user.message',
        payload: { content: 'ship the fix' },
        // turnId set; no runId — mirrors real tmux lifecycle event shape
        turnId: 'turn_dedup_1' as TurnId,
      })

      expect(result.events).toEqual([])

      // Echo is suppressed — no second canonical turn.user_prompt.
      // FAILS RED against current code: current code always emits the lifecycle event.
      expect(result.lifecycleEvents).toEqual([])

      // Database has exactly ONE turn.user_prompt for this runtime (the synth).
      const allPrompts = tmuxFixture.db.hrcEvents.listByKind('turn.user_prompt', {
        runtimeId: TMUX_RUNTIME_ID,
      })
      expect(allPrompts).toHaveLength(1)
    } finally {
      await tmuxFixture.cleanup()
    }
  })

  // ── Test 2b (RED) — standard harness.fixture, runId present ──────────────────────
  //
  // Same dedup invariant, standard headless harness.fixture (runId present).  Proves
  // the suppression is not special-cased on tmux-only — it applies whenever
  // a prior synth turn.user_prompt exists for the same (runtimeId, generation,
  // hostSessionId, content) in the current turn window.
  //
  // FAILS RED against current code for the same reason as Test 2a.
  it('[RED] does NOT project a second turn.user_prompt when prior synth exists — runId-present (standard harness.fixture)', () => {
    seedPriorSynthUserPrompt('ship the fix')

    const mapper = harness.makeMapper()
    const result = mapper.apply(
      envelope('user.message', 9, { content: 'ship the fix' }, { turnId: 'turn_x' as never })
    )

    expect(result.events).toEqual([])
    // Echo suppressed — no second canonical turn.user_prompt.
    // FAILS RED: current code → lifecycleEvents=['turn.user_prompt']
    expect(result.lifecycleEvents).toEqual([])
    // Exactly one turn.user_prompt in hrc_events for this runtime.
    const allPrompts = harness.fixture.db.hrcEvents.listByKind('turn.user_prompt', {
      runtimeId: RUNTIME_ID,
    })
    expect(allPrompts).toHaveLength(1)
  })

  // ── Test 3 (guard — different content still projects) ─────────────────────
  //
  // A broker user.message whose content DIFFERS from the prior synthetic
  // turn.user_prompt must NOT be suppressed — it is a genuinely new user
  // message (e.g. a follow-up message in the same turn window).
  //
  // GREEN against current code (always projects) and must remain GREEN after fix.
  it('[guard] still projects turn.user_prompt when user.message content differs from prior synth', () => {
    // Seed a prior synth with DIFFERENT content.
    seedPriorSynthUserPrompt('deploy the fix')

    const mapper = harness.makeMapper()
    const result = mapper.apply(
      envelope('user.message', 9, { content: 'ship the fix' }, { turnId: 'turn_x' as never })
    )

    // Content differs → NOT suppressed → lifecycle event still emitted.
    expect(result.lifecycleEvents.map((e) => e.eventKind)).toContain('turn.user_prompt')
    // DB now has two turn.user_prompt events: the seeded synth + the new one.
    const allPrompts = harness.fixture.db.hrcEvents.listByKind('turn.user_prompt', {
      runtimeId: RUNTIME_ID,
    })
    expect(allPrompts).toHaveLength(2)
  })

  it('finds the current prompt window without scanning lifecycle history from sequence one', () => {
    for (let index = 0; index < 128; index += 1) {
      harness.fixture.db.hrcEvents.append({
        ts: ts(index + 10),
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE_REF,
        laneRef: LANE_REF,
        generation: GENERATION,
        runtimeId: RUNTIME_ID,
        category: 'diagnostic',
        eventKind: 'diagnostic',
        transport: 'headless',
        payload: { index },
      })
    }
    harness.fixture.db.hrcEvents.append({
      ts: ts(200),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION,
      runtimeId: RUNTIME_ID,
      category: 'turn',
      eventKind: 'turn.completed',
      transport: 'headless',
      payload: { status: 'completed' },
    })
    seedPriorSynthUserPrompt('bounded prompt echo')

    const listFromHrcSeq = harness.fixture.db.hrcEvents.listFromHrcSeq.bind(
      harness.fixture.db.hrcEvents
    )
    harness.fixture.db.hrcEvents.listFromHrcSeq = () => {
      throw new Error('full lifecycle scan from sequence one is forbidden')
    }
    try {
      const result = harness
        .makeMapper()
        .apply(
          envelope(
            'user.message',
            201,
            { content: 'bounded prompt echo' },
            { turnId: 'turn_bounded_prompt' as never }
          )
        )
      expect(result.lifecycleEvents).toEqual([])
    } finally {
      harness.fixture.db.hrcEvents.listFromHrcSeq = listFromHrcSeq
    }
  })
})
