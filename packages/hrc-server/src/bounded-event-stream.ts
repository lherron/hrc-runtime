import type { HrcBoundedEventStreamRecord, HrcLifecycleEvent } from 'hrc-core'

import { HRC_BOUNDED_EVENTS_MAX_BYTES, HRC_BOUNDED_EVENTS_MAX_RECORDS } from './server-constants.js'
import { encodeNdjson } from './server-util.js'

export type EncodedBoundedEventRecord = {
  record: HrcBoundedEventStreamRecord
  bytes: Uint8Array
}

function positionOf(record: HrcBoundedEventStreamRecord): number | undefined {
  if (record.type === 'event') return record.event.hrcSeq
  if (record.type === 'gap') return record.beforeHrcSeq
  return undefined
}

function droppedBy(record: HrcBoundedEventStreamRecord): number | null {
  if (record.type === 'event') return 1
  if (record.type === 'gap') return record.dropped
  return 0
}

function addDropped(current: number | null, next: number | null): number | null {
  if (current === null || next === null) return null
  return current + next
}

export function encodeBoundedEventRecord(
  record: HrcBoundedEventStreamRecord
): EncodedBoundedEventRecord {
  return { record, bytes: encodeNdjson(record) }
}

export function eventOrOversizeGap(
  ledgerIncarnationId: string,
  event: HrcLifecycleEvent,
  maxBytes = HRC_BOUNDED_EVENTS_MAX_BYTES
): EncodedBoundedEventRecord {
  const encoded = encodeBoundedEventRecord({
    type: 'event',
    ledgerIncarnationId,
    event,
  })
  if (encoded.bytes.byteLength <= maxBytes) return encoded
  return encodeBoundedEventRecord({
    type: 'gap',
    ledgerIncarnationId,
    reason: 'event_oversize',
    afterHrcSeq: event.hrcSeq - 1,
    beforeHrcSeq: event.hrcSeq,
    dropped: 1,
  })
}

/**
 * Count-and-byte bounded FIFO used for both the admission seam and live
 * delivery. Overflow replaces the oldest retained interval with one ordered
 * gap, so a slow reader consumes O(1) queued work per loss interval.
 */
export class BoundedEventRecordQueue {
  private entries: EncodedBoundedEventRecord[] = []
  private byteSize = 0
  private deliveredHrcSeq: number

  constructor(
    readonly ledgerIncarnationId: string,
    afterHrcSeq: number,
    private readonly maxRecords = HRC_BOUNDED_EVENTS_MAX_RECORDS,
    private readonly maxBytes = HRC_BOUNDED_EVENTS_MAX_BYTES
  ) {
    this.deliveredHrcSeq = afterHrcSeq
  }

  get size(): number {
    return this.entries.length
  }

  get bytes(): number {
    return this.byteSize
  }

  appendEvent(event: HrcLifecycleEvent): void {
    this.appendEncoded(eventOrOversizeGap(this.ledgerIncarnationId, event, this.maxBytes))
  }

  append(record: HrcBoundedEventStreamRecord): void {
    this.appendEncoded(encodeBoundedEventRecord(record))
  }

  appendEncoded(incoming: EncodedBoundedEventRecord): void {
    if (incoming.bytes.byteLength > this.maxBytes) {
      throw new Error('bounded event control record exceeds the stream byte ceiling')
    }
    if (this.fits(incoming, 1)) {
      this.push(incoming)
      return
    }

    let dropped: number | null = 0
    let beforeHrcSeq = this.deliveredHrcSeq
    while (this.entries.length > 0) {
      const removed = this.shiftRaw()
      if (!removed) break
      dropped = addDropped(dropped, droppedBy(removed.record))
      beforeHrcSeq = Math.max(beforeHrcSeq, positionOf(removed.record) ?? beforeHrcSeq)
      const gap = this.liveQueueGap(beforeHrcSeq, dropped)
      if (this.fitsPair(gap, incoming)) {
        this.prepend(gap)
        this.push(incoming)
        return
      }
    }

    // The incoming record can fit alone, but not alongside the gap needed to
    // account for earlier eviction. Account for it in that gap as well.
    dropped = addDropped(dropped, droppedBy(incoming.record))
    beforeHrcSeq = Math.max(beforeHrcSeq, positionOf(incoming.record) ?? beforeHrcSeq)
    const gap = this.liveQueueGap(beforeHrcSeq, dropped)
    this.entries = [gap]
    this.byteSize = gap.bytes.byteLength
  }

  /** Remove replay-covered seam records without reporting them as loss. */
  discardThrough(hrcSeq: number): void {
    const retained: EncodedBoundedEventRecord[] = []
    let bytes = 0
    for (const entry of this.entries) {
      const position = positionOf(entry.record)
      if (position === undefined || position <= hrcSeq) continue
      if (entry.record.type === 'gap' && entry.record.afterHrcSeq < hrcSeq) {
        const adjusted = encodeBoundedEventRecord({
          ...entry.record,
          afterHrcSeq: hrcSeq,
          dropped: null,
        })
        retained.push(adjusted)
        bytes += adjusted.bytes.byteLength
      } else {
        retained.push(entry)
        bytes += entry.bytes.byteLength
      }
    }
    this.entries = retained
    this.byteSize = bytes
    this.deliveredHrcSeq = Math.max(this.deliveredHrcSeq, hrcSeq)
  }

  drain(): EncodedBoundedEventRecord[] {
    const entries = this.entries
    this.entries = []
    this.byteSize = 0
    return entries
  }

  take(): EncodedBoundedEventRecord | undefined {
    const entry = this.shiftRaw()
    if (!entry) return undefined
    const position = positionOf(entry.record)
    if (position !== undefined) this.deliveredHrcSeq = Math.max(this.deliveredHrcSeq, position)
    return entry
  }

  clear(): void {
    this.entries = []
    this.byteSize = 0
  }

  private liveQueueGap(beforeHrcSeq: number, dropped: number | null): EncodedBoundedEventRecord {
    return encodeBoundedEventRecord({
      type: 'gap',
      ledgerIncarnationId: this.ledgerIncarnationId,
      reason: 'live_queue',
      afterHrcSeq: this.deliveredHrcSeq,
      beforeHrcSeq,
      dropped,
    })
  }

  private fits(entry: EncodedBoundedEventRecord, additionalRecords: number): boolean {
    return (
      this.entries.length + additionalRecords <= this.maxRecords &&
      this.byteSize + entry.bytes.byteLength <= this.maxBytes
    )
  }

  private fitsPair(first: EncodedBoundedEventRecord, second: EncodedBoundedEventRecord): boolean {
    return (
      this.entries.length + 2 <= this.maxRecords &&
      this.byteSize + first.bytes.byteLength + second.bytes.byteLength <= this.maxBytes
    )
  }

  private push(entry: EncodedBoundedEventRecord): void {
    this.entries.push(entry)
    this.byteSize += entry.bytes.byteLength
  }

  private prepend(entry: EncodedBoundedEventRecord): void {
    this.entries.unshift(entry)
    this.byteSize += entry.bytes.byteLength
  }

  private shiftRaw(): EncodedBoundedEventRecord | undefined {
    const entry = this.entries.shift()
    if (entry) this.byteSize -= entry.bytes.byteLength
    return entry
  }
}

export class BoundedEventStreamDelivery {
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private ready: EncodedBoundedEventRecord | undefined
  private terminal: EncodedBoundedEventRecord | undefined
  private keepaliveBytes: Uint8Array | undefined
  private wakePendingPull: (() => void) | undefined
  private closed = false

  constructor(
    ready: HrcBoundedEventStreamRecord & { type: 'ready' },
    readonly queue: BoundedEventRecordQueue,
    private readonly onClosed: () => void
  ) {
    this.ready = encodeBoundedEventRecord(ready)
  }

  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.closed) {
      try {
        controller.close()
      } catch {
        // Transport already closed.
      }
      return
    }
    this.controller = controller
    if (!this.hasRecord()) {
      await new Promise<void>((resolve) => {
        this.wakePendingPull = resolve
      })
    }
    if (this.closed) {
      try {
        controller.close()
      } catch {
        // Transport already closed.
      }
      return
    }
    this.deliverOneFromPull(controller)
  }

  appendEvent(event: HrcLifecycleEvent): void {
    if (this.closed || this.terminal) return
    this.queue.appendEvent(event)
    this.wakePull()
  }

  appendEncoded(entry: EncodedBoundedEventRecord): void {
    if (this.closed || this.terminal) return
    this.queue.appendEncoded(entry)
    this.wakePull()
  }

  ledgerReplaced(currentLedgerIncarnationId: string): void {
    if (this.closed || this.terminal) return
    this.queue.clear()
    this.terminal = encodeBoundedEventRecord({
      type: 'ledger_replaced',
      expectedLedgerIncarnationId: this.queue.ledgerIncarnationId,
      currentLedgerIncarnationId,
    })
    this.wakePull()
  }

  keepalive(bytes: Uint8Array): void {
    if (this.closed || this.ready || this.terminal || this.queue.size > 0 || this.keepaliveBytes) {
      return
    }
    this.keepaliveBytes = bytes
    this.wakePull()
  }

  close(): void {
    if (this.closed) return
    const controller = this.controller
    this.finish()
    try {
      controller?.close()
    } catch {
      // Transport already closed.
    }
  }

  private deliverOneFromPull(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const ready = this.ready
    if (ready) {
      this.ready = undefined
      controller.enqueue(ready.bytes)
      return
    }
    const entry = this.queue.take()
    if (entry) {
      controller.enqueue(entry.bytes)
      return
    }
    const terminal = this.terminal
    if (terminal) {
      this.terminal = undefined
      controller.enqueue(terminal.bytes)
      try {
        controller.close()
      } finally {
        this.finish()
      }
      return
    }
    const keepalive = this.keepaliveBytes
    if (keepalive) {
      this.keepaliveBytes = undefined
      controller.enqueue(keepalive)
    }
  }

  private hasRecord(): boolean {
    return Boolean(this.ready || this.queue.size > 0 || this.terminal || this.keepaliveBytes)
  }

  private wakePull(): void {
    const wake = this.wakePendingPull
    this.wakePendingPull = undefined
    wake?.()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.ready = undefined
    this.terminal = undefined
    this.keepaliveBytes = undefined
    this.queue.clear()
    this.controller = undefined
    this.wakePull()
    this.onClosed()
  }
}

export type BoundedReplayCollector = {
  visitNewestFirst(event: HrcLifecycleEvent): boolean
  finish(complete: boolean): EncodedBoundedEventRecord[]
}

/** Build the newest serialized replay suffix without retaining older rows. */
export function createBoundedReplayCollector(
  ledgerIncarnationId: string,
  afterHrcSeq: number,
  maxRecords = HRC_BOUNDED_EVENTS_MAX_RECORDS,
  maxBytes = HRC_BOUNDED_EVENTS_MAX_BYTES
): BoundedReplayCollector {
  const newestFirst: EncodedBoundedEventRecord[] = []
  let bytes = 0
  let stoppedAtHrcSeq: number | undefined

  return {
    visitNewestFirst(event) {
      const encoded = eventOrOversizeGap(ledgerIncarnationId, event, maxBytes)
      if (newestFirst.length + 1 > maxRecords || bytes + encoded.bytes.byteLength > maxBytes) {
        stoppedAtHrcSeq = event.hrcSeq
        return false
      }
      newestFirst.push(encoded)
      bytes += encoded.bytes.byteLength
      return true
    },
    finish(complete) {
      if (complete) return newestFirst.reverse()

      const oldestRetained = newestFirst.at(-1)
      const oldestRetainedPosition = oldestRetained ? positionOf(oldestRetained.record) : undefined
      let beforeHrcSeq =
        oldestRetainedPosition === undefined
          ? (stoppedAtHrcSeq ?? afterHrcSeq)
          : oldestRetainedPosition - 1
      let gap = encodeBoundedEventRecord({
        type: 'gap',
        ledgerIncarnationId,
        reason: 'replay_window',
        afterHrcSeq,
        beforeHrcSeq,
        dropped: null,
      })
      while (
        newestFirst.length > 0 &&
        (newestFirst.length + 1 > maxRecords || bytes + gap.bytes.byteLength > maxBytes)
      ) {
        const removed = newestFirst.pop()
        if (!removed) break
        bytes -= removed.bytes.byteLength
        beforeHrcSeq = Math.max(beforeHrcSeq, positionOf(removed.record) ?? beforeHrcSeq)
        gap = encodeBoundedEventRecord({
          type: 'gap',
          ledgerIncarnationId,
          reason: 'replay_window',
          afterHrcSeq,
          beforeHrcSeq,
          dropped: null,
        })
      }
      return [gap, ...newestFirst.reverse()]
    },
  }
}
