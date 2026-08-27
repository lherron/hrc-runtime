import type { Database } from 'bun:sqlite'

/**
 * The high-water mark of a wrkq event-ledger tail (T-07612 §10, T-07615).
 *
 * HRC wakes its kicker by tailing wrkq's event ledger for `envelope.created`.
 * The tail is ALWAYS read from an explicit cursor: a read with no cursor
 * replays the whole log, which is the leak T-07620 names. Persisting the mark
 * is what makes a daemon restart resume at the gap rather than either replaying
 * history or skipping the wakes that arrived while it was down.
 *
 * The cursor is a wake optimisation, never authority. The periodic sweep re-reads
 * the ledger's own pending view, so a lost or stale cursor costs latency and
 * nothing else.
 */
export const WRKQ_ENVELOPE_STREAM = 'envelope'

export class WrkqLedgerCursorRepository {
  constructor(private readonly db: Database) {}

  get(stream: string = WRKQ_ENVELOPE_STREAM): number | undefined {
    const row = this.db
      .query<{ high_water: number }, [string]>(
        'SELECT high_water FROM wrkq_ledger_cursors WHERE stream = ?'
      )
      .get(stream)
    return row === null ? undefined : row.high_water
  }

  /**
   * Advance the mark. Never moves backwards: two tails racing on one stream
   * must not rewind each other into a replay.
   */
  advance(highWater: number, stream: string = WRKQ_ENVELOPE_STREAM): number {
    if (!Number.isSafeInteger(highWater) || highWater < 0) {
      throw new Error('wrkq ledger high water must be a non-negative integer')
    }
    const now = new Date().toISOString()
    this.db
      .query(
        `INSERT INTO wrkq_ledger_cursors (stream, high_water, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(stream) DO UPDATE SET
           high_water = MAX(wrkq_ledger_cursors.high_water, excluded.high_water),
           updated_at = excluded.updated_at`
      )
      .run(stream, highWater, now)
    return this.get(stream) ?? highWater
  }
}
