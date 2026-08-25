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
  HOST_SESSION_ID,
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  headlessSequence,
} from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('replay (end-to-end idempotency)', () => {
  it('produces no state change when the full sequence is replayed', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    const seq = headlessSequence()

    for (const env of seq) {
      mapper.apply(env)
    }

    const snapshot = {
      hrcEvents: db.events.count({ runtimeId: RUNTIME_ID }),
      brokerRows: db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length,
      bufferChunks: db.runtimeBuffers.listByRunId(RUN_ID).length,
      runStatus: db.runs.getByRunId(RUN_ID)!.status,
      runtimeContinuation: db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation,
      sessionContinuation: db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation,
      invocationState: db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.invocationState,
    }

    // Replay the identical sequence.
    for (const env of seq) {
      const replay = mapper.apply(env)
      expect(replay.idempotent).toBe(true)
      expect(replay.events.length).toBe(0)
    }

    expect(db.events.count({ runtimeId: RUNTIME_ID })).toBe(snapshot.hrcEvents)
    expect(db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).length).toBe(
      snapshot.brokerRows
    )
    expect(db.runtimeBuffers.listByRunId(RUN_ID).length).toBe(snapshot.bufferChunks)
    expect(db.runs.getByRunId(RUN_ID)!.status).toBe(snapshot.runStatus)
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)!.continuation).toEqual(
      snapshot.runtimeContinuation
    )
    expect(db.sessions.getByHostSessionId(HOST_SESSION_ID)!.continuation).toEqual(
      snapshot.sessionContinuation
    )
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)!.invocationState).toBe(
      snapshot.invocationState
    )
  })
})

// ---------------------------------------------------------------------------
// T-04836 — continuation kind must survive broker projection
// ---------------------------------------------------------------------------
