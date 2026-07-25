import { describe, expect, it } from 'bun:test'

import { createSubscriberAdmissionRegistry } from '../subscriber-admission-accounting'

describe('follow-stream subscriber admission accounting', () => {
  it('reports equal enqueue and stream-acceptance gauges when every event is admitted', () => {
    let now = '2026-07-18T12:00:00.000Z'
    const registry = createSubscriberAdmissionRegistry({
      recentlyClosedLimit: 2,
      now: () => now,
    })
    const subscription = registry.open({
      route: 'events',
      selector: { fromSeq: 1, scopeRef: 'agent:test:project:hrc-runtime' },
      remoteInfo: 'unix:hrc-test.sock',
      openedAt: now,
    })

    for (let seq = 1; seq <= 3; seq += 1) {
      subscription.recordEnqueued(seq, 1)
      now = `2026-07-18T12:00:0${seq}.000Z`
      subscription.recordStreamAccepted(seq, 1)
    }

    expect(registry.snapshot().active).toEqual([
      expect.objectContaining({
        route: 'events',
        selector: { fromSeq: 1, scopeRef: 'agent:test:project:hrc-runtime' },
        remoteInfo: 'unix:hrc-test.sock',
        openedAt: '2026-07-18T12:00:00.000Z',
        lastEnqueuedSeq: 3,
        lastStreamAcceptedSeq: 3,
        enqueuedCount: 3,
        streamAcceptedCount: 3,
        pendingCount: 0,
        desiredSize: 1,
        pendingSince: null,
        lastStreamAcceptedAt: '2026-07-18T12:00:03.000Z',
        keepaliveOnlySince: null,
      }),
    ])
  })

  it('counts one pending sparse event when only the first event is stream-accepted', () => {
    let now = '2026-07-18T12:01:00.000Z'
    const registry = createSubscriberAdmissionRegistry({
      recentlyClosedLimit: 2,
      now: () => now,
    })
    const subscription = registry.open({
      route: 'events',
      selector: { fromSeq: 1 },
      openedAt: now,
    })

    subscription.recordEnqueued(10, 1)
    now = '2026-07-18T12:01:01.000Z'
    subscription.recordStreamAccepted(10, 0)
    now = '2026-07-18T12:01:02.000Z'
    subscription.recordEnqueued(20, 0)

    // Admission telemetry is not a consumer-wedge oracle: an OS-stopped client may
    // remain at pendingCount=0 until Bun/kernel buffers saturate.
    expect(registry.snapshot().active[0]).toEqual(
      expect.objectContaining({
        lastEnqueuedSeq: 20,
        lastStreamAcceptedSeq: 10,
        enqueuedCount: 2,
        streamAcceptedCount: 1,
        pendingCount: 1,
        desiredSize: 0,
        pendingSince: '2026-07-18T12:01:02.000Z',
      })
    )
  })

  it('moves closed subscriptions into a bounded ring with their final admission gauges', () => {
    const registry = createSubscriberAdmissionRegistry({
      recentlyClosedLimit: 2,
      now: () => '2026-07-18T12:02:00.000Z',
    })

    for (let seq = 1; seq <= 3; seq += 1) {
      const subscription = registry.open({
        route: 'broker-events',
        selector: { invocationId: `inv-${seq}`, afterSeq: 0 },
        openedAt: '2026-07-18T12:02:00.000Z',
      })
      subscription.recordEnqueued(seq, 1)
      subscription.recordStreamAccepted(seq, 1)
      subscription.close()
    }

    const snapshot = registry.snapshot()
    expect(snapshot.active).toEqual([])
    expect(snapshot.recentlyClosed).toHaveLength(2)
    expect(snapshot.recentlyClosed.map((entry) => entry.lastStreamAcceptedSeq).sort()).toEqual([
      2, 3,
    ])
    expect(snapshot.recentlyClosed.every((entry) => entry.closedAt !== null)).toBe(true)
  })

  it('advances cumulative consumer receipts monotonically and rejects out-of-fence ACKs', () => {
    let now = '2026-07-18T12:03:00.000Z'
    const registry = createSubscriberAdmissionRegistry({ now: () => now })
    const subscription = registry.open({
      route: 'events',
      selector: { fromSeq: 1 },
      receiptMode: 'consumer-ack-v1',
    })
    if (!subscription.receiptToken) throw new Error('receipt token was not created')

    subscription.recordEnqueued(10, 1)
    subscription.recordStreamAccepted(10, 1)
    expect(registry.snapshot().active[0]).toEqual(
      expect.objectContaining({
        subscriberId: subscription.subscriberId,
        receiptMode: 'consumer-ack-v1',
        receiptState: 'awaiting-first-ack',
        lastConsumerAcknowledgedSeq: null,
        consumerReceiptBehindSince: '2026-07-18T12:03:00.000Z',
      })
    )

    now = '2026-07-18T12:03:01.000Z'
    expect(
      registry.acknowledge({
        subscriberId: subscription.subscriberId,
        receiptToken: subscription.receiptToken,
        seq: 10,
      })
    ).toEqual(
      expect.objectContaining({
        disposition: 'advanced',
        lastConsumerAcknowledgedSeq: 10,
        lastStreamAcceptedSeq: 10,
      })
    )
    expect(registry.snapshot().active[0]).toEqual(
      expect.objectContaining({
        receiptState: 'caught-up',
        lastConsumerAcknowledgedAt: '2026-07-18T12:03:01.000Z',
        consumerReceiptBehindSince: null,
        consumerReceiptAckCount: 1,
      })
    )

    expect(
      registry.acknowledge({
        subscriberId: subscription.subscriberId,
        receiptToken: subscription.receiptToken,
        seq: 10,
      }).disposition
    ).toBe('duplicate')

    now = '2026-07-18T12:03:02.000Z'
    subscription.recordEnqueued(20, 1)
    subscription.recordStreamAccepted(20, 1)
    expect(registry.snapshot().active[0]).toEqual(
      expect.objectContaining({
        receiptState: 'behind',
        lastStreamAcceptedSeq: 20,
        lastConsumerAcknowledgedSeq: 10,
        consumerReceiptBehindSince: '2026-07-18T12:03:02.000Z',
      })
    )
    expect(() =>
      registry.acknowledge({
        subscriberId: subscription.subscriberId,
        receiptToken: subscription.receiptToken ?? '',
        seq: 21,
      })
    ).toThrow('ahead of the stream-admission head')

    registry.acknowledge({
      subscriberId: subscription.subscriberId,
      receiptToken: subscription.receiptToken,
      seq: 20,
    })
    expect(
      registry.acknowledge({
        subscriberId: subscription.subscriberId,
        receiptToken: subscription.receiptToken,
        seq: 10,
      }).disposition
    ).toBe('stale')
    expect(registry.snapshot().active[0]?.lastConsumerAcknowledgedSeq).toBe(20)
  })

  it('accepts a final ACK while retained closed and expires it with the bounded ring', () => {
    const registry = createSubscriberAdmissionRegistry({ recentlyClosedLimit: 1 })
    const first = registry.open({
      route: 'events',
      selector: { fromSeq: 1 },
      receiptMode: 'consumer-ack-v1',
    })
    if (!first.receiptToken) throw new Error('receipt token was not created')
    first.recordEnqueued(1, 1)
    first.recordStreamAccepted(1, 1)
    first.close()

    expect(
      registry.acknowledge({
        subscriberId: first.subscriberId,
        receiptToken: first.receiptToken,
        seq: 1,
      }).disposition
    ).toBe('advanced')
    expect(registry.snapshot().recentlyClosed[0]?.receiptState).toBe('caught-up')

    registry
      .open({
        route: 'events',
        selector: { fromSeq: 2 },
      })
      .close()
    expect(() =>
      registry.acknowledge({
        subscriberId: first.subscriberId,
        receiptToken: first.receiptToken ?? '',
        seq: 1,
      })
    ).toThrow('unknown or expired')
  })
})
