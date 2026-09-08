/**
 * T-08294 — the two projection transaction edges, in process.
 *
 * LABEL, because it matters for how this evidence is read: these are IN-PROCESS
 * fault-injection tests, not installed-pair evidence. They exist because neither
 * edge is reachable through the installed CLI, and Astra approved this lane on
 * condition that no production door is added to make them runnable. The
 * installed real-thread proof and the installed controlled-feed proof carry the
 * end-to-end claims; these carry only the crash edges.
 *
 * The two edges are DIFFERENT and were previously conflated — my error, which
 * Astra corrected:
 *
 *   AFTER COMMIT, BEFORE ACK — `testOnlyAfterBrokerProjectionCommitBeforeAck`
 *     fires after `ctx.mapper.apply(envelope)` and before `ackEvents`
 *     (controller/dispatch.ts:911). So the event is APPLIED and only the
 *     acknowledgement is lost. The broker then re-delivers from its last acked
 *     seq, and the requirement is duplicate-safe redelivery: exactly one
 *     projection survives.
 *
 *   BEFORE COMMIT — delivery withheld, or a crash before the transaction
 *     commits. Nothing is applied, and the requirement is the opposite: the
 *     event must still be applied later, exactly once.
 *
 * A test for one proves nothing about the other, which is precisely why the
 * post-commit hook must not be presented as pre-commit recovery evidence.
 */

import { describe, expect, it } from 'bun:test'

import { INVOCATION_ID, RUNTIME_ID, envelope, ts } from './broker-event-mapper-fixtures'
import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

/**
 * The contiguous projection cursor only advances over an unbroken run from seq
 * 1, so a test that applies seq 2 alone sees `lastProjectedSeq: 0` — correct
 * behaviour, and worth stating because it is easy to misread as a lost commit.
 */
function applyReady(mapper: ReturnType<typeof harness.makeMapper>): void {
  mapper.apply(envelope('invocation.started', 1, { state: 'starting' }))
  mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))
}

describe('edge A — APPLIED but the acknowledgement was lost (post-commit crash)', () => {
  it('commits before the seam fires, then survives redelivery with exactly one projection', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    applyReady(mapper)

    // Assert the ACTUAL committed status at the moment the seam would fire —
    // this is what makes it a post-commit edge rather than a pending one.
    expect(
      db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 2)?.projectionStatus
    ).toBe('applied')
    expect(db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 2)).not.toBeNull()
    // The durable acknowledgement authority, contiguous from seq 1.
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(2)
    const afterFirst = db.hrcEvents.maxHrcSeq()

    // The ack never reached the broker, so on reattach it re-delivers from its
    // last acked seq — the same envelopes again.
    const redelivered = mapper.apply(envelope('invocation.ready', 2, { state: 'ready' }))

    expect(redelivered.idempotent).toBe(true)
    expect(db.hrcEvents.maxHrcSeq()).toBe(afterFirst)
    expect(
      db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).filter((e) => e.seq === 2)
    ).toHaveLength(1)
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(2)
  })
})

describe('edge B — withheld BEFORE commit (nothing applied)', () => {
  it('a rolled-back projection leaves no row, and the later delivery applies exactly once', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db
    applyReady(mapper)
    // A kind that actually emits a canonical lifecycle row, so faulting the
    // emission faults the transaction. `invocation.ready` emits none.
    const completed = envelope(
      'turn.completed',
      3,
      { turnId: 'turn_edge' as never, status: 'completed', producedContent: true },
      { turnId: 'turn_edge' as never }
    )

    const original = db.hrcEvents.append.bind(db.hrcEvents)
    let armed = true
    ;(db.hrcEvents as { append: typeof db.hrcEvents.append }).append = ((input) => {
      if (armed) throw new Error('injected pre-commit failure')
      return original(input)
    }) as typeof db.hrcEvents.append

    try {
      expect(() => mapper.apply(completed)).toThrow()
    } finally {
      armed = false
      ;(db.hrcEvents as { append: typeof db.hrcEvents.append }).append = original
    }

    // NOTHING was committed — the opposite of edge A, and the reason the two
    // must not be conflated.
    expect(db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)).toBeNull()
    expect(db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 3)).toBeNull()
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(2)
    const before = db.hrcEvents.maxHrcSeq()

    // Recovery re-delivers it, and now it must apply — exactly once.
    const recovered = mapper.apply(completed)
    expect(recovered.idempotent).toBe(false)
    expect(
      db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 3)?.projectionStatus
    ).toBe('applied')
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(3)
    expect(db.hrcEvents.maxHrcSeq()).toBeGreaterThan(before)

    // A further redelivery after that does not double it.
    const after = db.hrcEvents.maxHrcSeq()
    expect(mapper.apply(completed).idempotent).toBe(true)
    expect(db.hrcEvents.maxHrcSeq()).toBe(after)
  })

  it('a PENDING row is not treated as committed, so it is re-delivered', () => {
    // The durable shape of "captured but never projected". Recovery must not
    // read it as accounted for; the suppression set deliberately excludes it.
    const db = harness.fixture.db
    db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 9,
      time: ts(9),
      type: 'invocation.ready',
      runtimeId: RUNTIME_ID,
      payload: { state: 'ready' },
      projectionStatus: 'pending',
    })
    expect(
      db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 9)?.projectionStatus
    ).toBe('pending')
    expect(db.brokerInvocationEvents.getProjectionDisposition(INVOCATION_ID, 9)).toBeNull()
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastProjectedSeq).toBe(0)
  })
})
