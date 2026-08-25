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

import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'

import { INVOCATION_ID, RUNTIME_ID, envelope } from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('conflict (divergent payload, same key)', () => {
  it('throws BrokerInvocationEventConflictError and projects nothing from the conflicting event', () => {
    const mapper = harness.makeMapper()

    const original = envelope('continuation.updated', 8, {
      provider: 'openai',
      key: 'key_ORIGINAL',
    })
    mapper.apply(original)
    expect(harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: 'key_ORIGINAL',
    })

    const eventsBefore = harness.fixture.db.events.count({ runtimeId: RUNTIME_ID })

    const divergent = envelope('continuation.updated', 8, {
      provider: 'openai',
      key: 'key_DIVERGENT',
    })

    expect(() => mapper.apply(divergent)).toThrow(BrokerInvocationEventConflictError)

    // No projection from the divergent event: continuation unchanged, no new
    // HRC events, stored broker payload still the original.
    expect(harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: 'key_ORIGINAL',
    })
    expect(harness.fixture.db.events.count({ runtimeId: RUNTIME_ID })).toBe(eventsBefore)

    const stored = harness.fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 8)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!.brokerEventJson)).toEqual({
      provider: 'openai',
      key: 'key_ORIGINAL',
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Transaction atomicity — projection failure rolls back the event row
// ---------------------------------------------------------------------------
