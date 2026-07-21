import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

/** Daemon-private wrkq authority carried by one HRC session generation. */
export type SessionTaskClaimAuthority = {
  hostSessionId: string
  taskId: string
  claimedBy: string
  claimedScope: string
  claimedNode: string
  claimedAt: string
  claimGeneration: number
  claimToken: string
  createdAt: string
}

type SessionTaskClaimAuthorityRow = {
  host_session_id: string
  task_id: string
  claimed_by: string
  claimed_scope: string
  claimed_node: string
  claimed_at: string
  claim_generation: number
  claim_token: string
  created_at: string
}

const COLUMNS = `
  host_session_id,
  task_id,
  claimed_by,
  claimed_scope,
  claimed_node,
  claimed_at,
  claim_generation,
  claim_token,
  created_at`

function mapRow(row: SessionTaskClaimAuthorityRow): SessionTaskClaimAuthority {
  return {
    hostSessionId: row.host_session_id,
    taskId: row.task_id,
    claimedBy: row.claimed_by,
    claimedScope: row.claimed_scope,
    claimedNode: row.claimed_node,
    claimedAt: row.claimed_at,
    claimGeneration: row.claim_generation,
    claimToken: row.claim_token,
    createdAt: row.created_at,
  }
}

export class SessionTaskClaimAuthorityRepository {
  constructor(private readonly db: Database) {}

  insert(record: SessionTaskClaimAuthority): SessionTaskClaimAuthority {
    execute(
      this.db,
      `
        INSERT INTO session_task_claim_authorities (
          host_session_id,
          task_id,
          claimed_by,
          claimed_scope,
          claimed_node,
          claimed_at,
          claim_generation,
          claim_token,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.hostSessionId,
      record.taskId,
      record.claimedBy,
      record.claimedScope,
      record.claimedNode,
      record.claimedAt,
      record.claimGeneration,
      record.claimToken,
      record.createdAt
    )
    const inserted = this.getByHostSessionId(record.hostSessionId)
    if (inserted === null) {
      throw new Error(`failed to reload task claim authority for ${record.hostSessionId}`)
    }
    return inserted
  }

  getByHostSessionId(hostSessionId: string): SessionTaskClaimAuthority | null {
    const row = this.db
      .query<SessionTaskClaimAuthorityRow, [string]>(
        `SELECT ${COLUMNS} FROM session_task_claim_authorities WHERE host_session_id = ?`
      )
      .get(hostSessionId)
    return row === null ? null : mapRow(row)
  }

  copy(
    fromHostSessionId: string,
    toHostSessionId: string,
    createdAt: string
  ): SessionTaskClaimAuthority | null {
    const source = this.getByHostSessionId(fromHostSessionId)
    if (source === null) return null
    return this.insert({ ...source, hostSessionId: toHostSessionId, createdAt })
  }
}
