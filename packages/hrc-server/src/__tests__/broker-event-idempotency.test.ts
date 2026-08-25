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

import {
  CONTINUATION_KEY,
  INVOCATION_ID,
  RUNTIME_ID,
  envelope,
} from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('idempotency', () => {
  it('applies SAME (invocationId, seq) + SAME payload exactly once', () => {
    const mapper = harness.makeMapper()
    const env = envelope('continuation.updated', 8, {
      provider: 'openai',
      key: CONTINUATION_KEY,
    })

    const first = mapper.apply(env)
    expect(first.idempotent).toBe(false)
    expect(first.events).toEqual([])

    const eventsAfterFirst = harness.fixture.db.events.count({ runtimeId: RUNTIME_ID })
    const brokerRowsAfterFirst =
      harness.fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length

    const second = mapper.apply(env)
    expect(second.idempotent).toBe(true)
    expect(second.events.length).toBe(0)

    // No double-apply: no new HRC events, no new broker event rows.
    expect(harness.fixture.db.events.count({ runtimeId: RUNTIME_ID })).toBe(eventsAfterFirst)
    expect(harness.fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length).toBe(
      brokerRowsAfterFirst
    )

    // The single projection is intact (not applied twice / not reverted).
    expect(harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual({
      provider: 'openai',
      key: CONTINUATION_KEY,
    })
  })

  it('does not throw on a duplicate apply', () => {
    const mapper = harness.makeMapper()
    const env = envelope('invocation.ready', 2, { state: 'ready' })
    mapper.apply(env)
    expect(() => mapper.apply(env)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. Conflict — same (invocationId, seq) + DIFFERENT payload
// ---------------------------------------------------------------------------
