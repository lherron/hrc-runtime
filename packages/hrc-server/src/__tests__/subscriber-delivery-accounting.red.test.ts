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
})
