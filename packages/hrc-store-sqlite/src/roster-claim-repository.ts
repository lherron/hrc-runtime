import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

/**
 * Durable record of one suffix-roster claim (T-07118).
 *
 * Written inside the SAME transaction as the successor session it claims, so a
 * daemon death either loses both or keeps both. `requestHash` is the canonical
 * semantic hash of the whole suffix-start request; a replay of the key whose
 * hash differs is rejected BEFORE the start path runs.
 */
export type RosterClaim = {
  idempotencyKey: string
  requestHash: string
  /** Base scope ref the roster was derived from (the mutex key's subject). */
  baseScope: string
  /** Scope ref of the claimed slot (e.g. `agent:...:task:primary-nova`). */
  claimedScope: string
  successorHostSessionId: string
  createdAt: string
}

type RosterClaimRow = {
  idempotency_key: string
  request_hash: string
  base_scope: string
  claimed_scope: string
  successor_host_session_id: string
  created_at: string
}

const COLUMNS = `
  idempotency_key,
  request_hash,
  base_scope,
  claimed_scope,
  successor_host_session_id,
  created_at`

function mapRow(row: RosterClaimRow): RosterClaim {
  return {
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    baseScope: row.base_scope,
    claimedScope: row.claimed_scope,
    successorHostSessionId: row.successor_host_session_id,
    createdAt: row.created_at,
  }
}

export class RosterClaimRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert a claim. Callers MUST run this inside the same transaction as the
   * successor-session insert — the claim and the session it names are one
   * atomic fact.
   */
  insert(record: RosterClaim): RosterClaim {
    execute(
      this.db,
      `
        INSERT INTO roster_claims (
          idempotency_key,
          request_hash,
          base_scope,
          claimed_scope,
          successor_host_session_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      record.idempotencyKey,
      record.requestHash,
      record.baseScope,
      record.claimedScope,
      record.successorHostSessionId,
      record.createdAt
    )
    return record
  }

  getByIdempotencyKey(idempotencyKey: string): RosterClaim | null {
    const row = this.db
      .query<RosterClaimRow, [string]>(
        `SELECT ${COLUMNS} FROM roster_claims WHERE idempotency_key = ?`
      )
      .get(idempotencyKey)
    return row ? mapRow(row) : null
  }

  listByBaseScope(baseScope: string): RosterClaim[] {
    return this.db
      .query<RosterClaimRow, [string]>(
        `SELECT ${COLUMNS} FROM roster_claims WHERE base_scope = ? ORDER BY created_at ASC`
      )
      .all(baseScope)
      .map(mapRow)
  }

  /** Age-based pruning hook for the existing guarded historical purge. */
  deleteOlderThan(cutoffIso: string): number {
    const before = this.db
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM roster_claims')
      .get()
    execute(this.db, 'DELETE FROM roster_claims WHERE created_at < ?', cutoffIso)
    const after = this.db
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM roster_claims')
      .get()
    return (before?.count ?? 0) - (after?.count ?? 0)
  }
}
