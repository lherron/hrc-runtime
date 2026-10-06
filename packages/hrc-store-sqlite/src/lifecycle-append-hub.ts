/**
 * T-10420 — the one place every committed lifecycle row is announced.
 *
 * Live followers used to learn about a row only when the code that appended
 * it remembered to call the server's notifyEvent. Rows written by durable
 * diagnostics (`broker.*`) and by the session-metadata repository never were,
 * so a bounded follow skipped them with no gap record and its cursor moved
 * past them for good. The hub sits under every HrcLifecycleEventRepository
 * instance on a Database, so no append path can bypass it.
 *
 * Commit discipline: a row is announced only after its transaction commits.
 * An append in its own transaction flushes right after commit; an append
 * inside a caller's transaction is held and flushed once the connection is
 * no longer in a transaction. Before announcing, the hub confirms the row is
 * in the ledger, so a rolled-back append is never seen. Rows are announced
 * in ascending hrcSeq order.
 */
import type { Database } from 'bun:sqlite'

import type { HrcLifecycleEvent } from 'hrc-core'

export type LifecycleAppendObserver = (event: HrcLifecycleEvent) => void

class LifecycleAppendHub {
  private readonly observers = new Set<LifecycleAppendObserver>()
  /** Persisted but not yet announced, keyed by hrcSeq (last write wins). */
  private readonly pending = new Map<number, HrcLifecycleEvent>()
  private flushScheduled = false

  constructor(private readonly db: Database) {}

  get observed(): boolean {
    return this.observers.size > 0
  }

  observe(observer: LifecycleAppendObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
      if (this.observers.size === 0) this.pending.clear()
    }
  }

  record(event: HrcLifecycleEvent): void {
    if (!this.observed) return
    this.pending.set(event.hrcSeq, event)
    this.scheduleFlush()
  }

  flush(): void {
    if (this.pending.size === 0 || this.db.inTransaction) return
    const held = [...this.pending.values()].sort((left, right) => left.hrcSeq - right.hrcSeq)
    this.pending.clear()
    const committed = this.committedStreamSeqs(held.map((event) => event.hrcSeq))
    for (const event of held) {
      // A rolled-back append left no row, or its seq now names another row.
      if (committed.get(event.hrcSeq) !== event.streamSeq) continue
      for (const observer of this.observers) {
        try {
          observer(event)
        } catch {
          // An observer failure must never fail, or reach, the write it observes.
        }
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flushWhenCommitted())
  }

  private flushWhenCommitted(): void {
    if (this.db.inTransaction) {
      setTimeout(() => this.flushWhenCommitted(), 0)
      return
    }
    this.flushScheduled = false
    this.flush()
  }

  private committedStreamSeqs(hrcSeqs: readonly number[]): Map<number, number> {
    const rows = this.db
      .query<{ hrc_seq: number; stream_seq: number }, number[]>(
        `SELECT hrc_seq, stream_seq FROM hrc_events WHERE hrc_seq IN (${hrcSeqs.map(() => '?').join(',')})`
      )
      .all(...hrcSeqs)
    return new Map(rows.map((row) => [row.hrc_seq, row.stream_seq]))
  }
}

const hubs = new WeakMap<Database, LifecycleAppendHub>()

export function lifecycleAppendHub(db: Database): LifecycleAppendHub {
  let hub = hubs.get(db)
  if (hub === undefined) {
    hub = new LifecycleAppendHub(db)
    hubs.set(db, hub)
  }
  return hub
}

/** Announce every committed lifecycle row on this database to `observer`. */
export function observeLifecycleAppends(
  db: Database,
  observer: LifecycleAppendObserver
): () => void {
  return lifecycleAppendHub(db).observe(observer)
}

/** Announce held rows now if their transaction has committed (keeps announce order). */
export function flushLifecycleAppends(db: Database): void {
  hubs.get(db)?.flush()
}
