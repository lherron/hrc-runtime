import type { Database } from 'bun:sqlite'

/**
 * Durable producer-side rate bound for the HRC→ACP event bridge (T-07236).
 *
 * This is a BOUND, not a delivery log. One row is written per ADMITTED emission
 * — before the POST is attempted — so a crash mid-delivery still consumes the
 * slot it claimed, and a runaway mint loop stays bounded across the restarts it
 * would otherwise ride. The row is keyed by the canonical event id, so retrying
 * the same fact is idempotent and cannot consume a second slot.
 *
 * Nothing here decides whether delivery succeeded; that stays best-effort by
 * design (the durable fact is HRC's own ledger row).
 */
export class AcpBridgeEmissionRepository {
  constructor(private readonly db: Database) {}

  /** Emissions of `event` for `scopeRef` at or after `sinceIso`. */
  countSince(scopeRef: string, event: string, sinceIso: string): number {
    const row = this.db
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) AS count
           FROM acp_bridge_emissions
          WHERE scope_ref = ?
            AND event = ?
            AND emitted_at >= ?`
      )
      .get(scopeRef, event, sinceIso)
    return row?.count ?? 0
  }

  /**
   * Claim a slot. Returns false when this exact event id already claimed one —
   * a re-emission of the same fact, which must not be double-counted.
   */
  claim(input: { eventId: string; scopeRef: string; event: string; emittedAt: string }): boolean {
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO acp_bridge_emissions (event_id, scope_ref, event, emitted_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.eventId, input.scopeRef, input.event, input.emittedAt) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  /** Drop rows older than the retention horizon; the window only ever reads back one hour. */
  pruneBefore(beforeIso: string): number {
    const result = this.db
      .query('DELETE FROM acp_bridge_emissions WHERE emitted_at < ?')
      .run(beforeIso) as { changes?: number }
    return result.changes ?? 0
  }
}
