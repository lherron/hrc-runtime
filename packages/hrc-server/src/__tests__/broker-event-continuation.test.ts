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

import { HOST_SESSION_ID, RUNTIME_ID, envelope } from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('T-04836 continuation kind persistence', () => {
  it('persists continuation.updated kind on both runtime and session continuation refs', () => {
    const mapper = harness.makeMapper()
    const codexSessionUuid = '018fe9d5-992c-7cc8-a4bc-9c0c04c4f919'

    mapper.apply(
      envelope('continuation.updated', 8, {
        provider: 'openai',
        kind: 'session',
        key: codexSessionUuid,
      })
    )

    // T-04836: Codex tmux resume is safe only for explicit session UUID resume.
    // Dropping `kind` makes HRC unable to distinguish session ids from other
    // continuation keys, so both persisted refs must retain it.
    expect(harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      kind: 'session',
      key: codexSessionUuid,
    })
    expect(harness.fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toEqual({
      provider: 'openai',
      kind: 'session',
      key: codexSessionUuid,
    })
  })
})

// ---------------------------------------------------------------------------
// 8. T-04215 — broker user.message echo dedup
//
//    A broker `user.message` that is merely the TUI echo of an HRC-authored
//    prompt already recorded for the same dispatch must NOT project a second
//    canonical `turn.user_prompt`. Suppression at lifecycle-projection time in
//    BrokerEventMapper; raw `broker.user.message` provenance still appended.
//
//    CRITICAL: runId is EMPTY on real broker-tmux interactive runtimes.
//    Evidence: hrc_seq 376316/376317, runtime rt-64673c6d, generation 1,
//    run_id NULL. Dedup correlation must key on
//    (hostSessionId, generation, runtimeId, canonical content) scoped to the
//    current turn window — NOT runId.
//
//    Test 1 (T-02026 guard): preserved at ~line 241 above — bare user.message
//    with no prior synth → one turn.user_prompt.  Must stay GREEN.
//    Test 2 (RED): prior synth with same content → lifecycleEvents=[]  ← FAILS now
//    Test 3 (guard): different content → still projects.  Must stay GREEN.
// ---------------------------------------------------------------------------
