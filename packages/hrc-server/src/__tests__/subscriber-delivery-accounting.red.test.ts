import { describe, expect, it } from 'bun:test'

import { createSubscriberDeliveryRegistry } from '../subscriber-delivery-accounting'

describe('follow-stream subscriber delivery accounting', () => {
  it('advances delivery gauges only when enqueued events drain', () => {
    let now = '2026-07-18T12:00:00.000Z'
    const registry = createSubscriberDeliveryRegistry({
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
      subscription.recordEnqueued(seq)
      now = `2026-07-18T12:00:0${seq}.000Z`
      subscription.recordDrained()
    }

    expect(registry.snapshot().active).toEqual([
      expect.objectContaining({
        route: 'events',
        selector: { fromSeq: 1, scopeRef: 'agent:test:project:hrc-runtime' },
        remoteInfo: 'unix:hrc-test.sock',
        openedAt: '2026-07-18T12:00:00.000Z',
        lastDeliveredSeq: 3,
        deliveredCount: 3,
        lastWriteAt: '2026-07-18T12:00:03.000Z',
        keepaliveOnlySince: null,
      }),
    ])
  })

  it('keeps lastDeliveredSeq behind ledger head while the sink is wedged', () => {
    const registry = createSubscriberDeliveryRegistry({
      recentlyClosedLimit: 2,
      now: () => '2026-07-18T12:01:00.000Z',
    })
    const subscription = registry.open({
      route: 'events',
      selector: { fromSeq: 1 },
      openedAt: '2026-07-18T12:01:00.000Z',
    })

    subscription.recordEnqueued(1)
    subscription.recordDrained()
    for (let seq = 2; seq <= 5; seq += 1) subscription.recordEnqueued(seq)

    const ledgerHead = 5
    const active = registry.snapshot().active[0]
    expect(active?.lastDeliveredSeq).toBe(1)
    expect(active?.lastDeliveredSeq).toBeLessThan(ledgerHead)
    expect(active?.deliveredCount).toBe(1)
  })

  it('moves closed subscriptions into a bounded recently-closed ring with final seq', () => {
    const registry = createSubscriberDeliveryRegistry({
      recentlyClosedLimit: 2,
      now: () => '2026-07-18T12:02:00.000Z',
    })

    for (let seq = 1; seq <= 3; seq += 1) {
      const subscription = registry.open({
        route: 'broker-events',
        selector: { invocationId: `inv-${seq}`, afterSeq: 0 },
        openedAt: '2026-07-18T12:02:00.000Z',
      })
      subscription.recordEnqueued(seq)
      subscription.recordDrained()
      subscription.close()
    }

    const snapshot = registry.snapshot()
    expect(snapshot.active).toEqual([])
    expect(snapshot.recentlyClosed).toHaveLength(2)
    expect(snapshot.recentlyClosed.map((entry) => entry.lastDeliveredSeq).sort()).toEqual([2, 3])
    expect(snapshot.recentlyClosed.every((entry) => entry.closedAt !== null)).toBe(true)
  })
})
