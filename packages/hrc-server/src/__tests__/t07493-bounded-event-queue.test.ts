import { describe, expect, test } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'

import {
  BoundedEventRecordQueue,
  BoundedEventStreamDelivery,
  createBoundedReplayCollector,
} from '../bounded-event-stream.js'

function event(hrcSeq: number, payload = 'x'): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: '2026-08-23T00:00:00.000Z',
    hostSessionId: 'hsid-bounded',
    scopeRef: 'agent:test:bounded',
    laneRef: 'default',
    generation: 1,
    category: 'turn',
    eventKind: `turn.${hrcSeq}`,
    replayed: false,
    payload: { payload },
  }
}

describe('T-07493 bounded event record admission', () => {
  test('replay retains the newest suffix and orders an explicit gap first', () => {
    const collector = createBoundedReplayCollector('ledger-a', 0, 3, 100_000)
    let complete = true
    for (const value of [event(5), event(4), event(3), event(2), event(1)]) {
      if (!collector.visitNewestFirst(value)) {
        complete = false
        break
      }
    }
    const records = collector.finish(complete).map((entry) => entry.record)
    expect(records).toHaveLength(3)
    expect(records[0]).toEqual({
      type: 'gap',
      ledgerIncarnationId: 'ledger-a',
      reason: 'replay_window',
      afterHrcSeq: 0,
      beforeHrcSeq: 3,
      dropped: null,
    })
    expect(
      records.slice(1).map((record) => (record.type === 'event' ? record.event.hrcSeq : -1))
    ).toEqual([4, 5])
  })

  test('slow-reader overflow stays bounded and coalesces exact loss before later events', () => {
    const queue = new BoundedEventRecordQueue('ledger-a', 0, 3, 100_000)
    for (let hrcSeq = 1; hrcSeq <= 8; hrcSeq += 1) queue.appendEvent(event(hrcSeq))
    expect(queue.size).toBeLessThanOrEqual(3)
    expect(queue.bytes).toBeLessThanOrEqual(100_000)
    const records = queue.drain().map((entry) => entry.record)
    expect(records[0]).toMatchObject({
      type: 'gap',
      reason: 'live_queue',
      afterHrcSeq: 0,
      beforeHrcSeq: 6,
      dropped: 6,
    })
    expect(
      records.slice(1).map((record) => (record.type === 'event' ? record.event.hrcSeq : -1))
    ).toEqual([7, 8])
  })

  test('one event over the byte ceiling becomes a complete event_oversize gap', () => {
    const queue = new BoundedEventRecordQueue('ledger-a', 9, 8, 300)
    queue.appendEvent(event(10, 'x'.repeat(2_000)))
    expect(queue.take()?.record).toEqual({
      type: 'gap',
      ledgerIncarnationId: 'ledger-a',
      reason: 'event_oversize',
      afterHrcSeq: 9,
      beforeHrcSeq: 10,
      dropped: 1,
    })
  })

  test('replay-covered seam events are discarded without a false gap', () => {
    const queue = new BoundedEventRecordQueue('ledger-a', 0, 8, 100_000)
    queue.appendEvent(event(2))
    queue.appendEvent(event(3))
    queue.appendEvent(event(4))
    queue.discardThrough(3)
    expect(queue.drain().map((entry) => entry.record)).toEqual([
      { type: 'event', ledgerIncarnationId: 'ledger-a', event: event(4) },
    ])
  })

  test('delivery enqueues one record per pull while a stalled transport leaves the queue bounded', async () => {
    const queue = new BoundedEventRecordQueue('ledger-a', 0, 3, 100_000)
    const delivered: Uint8Array[] = []
    let desiredSize = 1
    const controller = {
      get desiredSize() {
        return desiredSize
      },
      enqueue(bytes: Uint8Array) {
        delivered.push(bytes)
        desiredSize = 0
      },
      close() {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>
    const delivery = new BoundedEventStreamDelivery(
      {
        type: 'ready',
        ledgerIncarnationId: 'ledger-a',
        acceptedAfterHrcSeq: 0,
        replayHeadHrcSeq: 0,
      },
      queue,
      () => undefined
    )
    await delivery.pull(controller)
    expect(delivered).toHaveLength(1)
    for (let hrcSeq = 1; hrcSeq <= 8; hrcSeq += 1) delivery.appendEvent(event(hrcSeq))
    expect(delivered).toHaveLength(1)
    expect(queue.size).toBeLessThanOrEqual(3)

    desiredSize = 1
    await delivery.pull(controller)
    expect(delivered).toHaveLength(2)
    expect(JSON.parse(new TextDecoder().decode(delivered[1]).trim())).toMatchObject({
      type: 'gap',
      reason: 'live_queue',
      beforeHrcSeq: 6,
      dropped: 6,
    })
  })
})
