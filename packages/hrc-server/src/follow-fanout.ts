import type { Database } from 'bun:sqlite'
/**
 * T-10420 — the single delivery door for live follow subscribers.
 *
 * Two producers reach followers: the store's lifecycle append hub, which
 * announces every committed row whatever wrote it, and notifyEvent, which
 * callers invoke after their own appends (and for non-ledger envelopes). A row
 * is delivered once, by whichever arrives first. Before delivering a ledger
 * row, held rows are flushed so followers see ascending hrcSeq.
 */
import type { HrcEventEnvelope, HrcLifecycleEvent } from 'hrc-core'
import { flushLifecycleAppends } from 'hrc-store-sqlite'

type FollowEvent = HrcEventEnvelope | HrcLifecycleEvent

/** Bounded memory of delivered hrcSeqs; a re-delivery older than this is far past any live race. */
const DELIVERED_SEQ_MEMORY = 16_384

export class FollowFanOut {
  private readonly delivered = new Set<number>()
  private readonly deliveredOrder: number[] = []

  constructor(
    private readonly sqlite: Database,
    private readonly subscribers: ReadonlySet<(event: FollowEvent) => void>
  ) {}

  deliver(event: FollowEvent): void {
    if ('hrcSeq' in event) {
      flushLifecycleAppends(this.sqlite)
      if (!this.claim(event.hrcSeq)) return
    }
    for (const subscriber of this.subscribers) subscriber(event)
  }

  private claim(hrcSeq: number): boolean {
    if (this.delivered.has(hrcSeq)) return false
    this.delivered.add(hrcSeq)
    this.deliveredOrder.push(hrcSeq)
    if (this.deliveredOrder.length > DELIVERED_SEQ_MEMORY) {
      const evicted = this.deliveredOrder.splice(
        0,
        this.deliveredOrder.length - DELIVERED_SEQ_MEMORY
      )
      for (const seq of evicted) this.delivered.delete(seq)
    }
    return true
  }
}
