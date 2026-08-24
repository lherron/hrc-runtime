import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

export type SessionTitleSource = 'generated' | 'manual'

export type SessionTitleRecord = {
  hostSessionId: string
  title: string
  source: SessionTitleSource
  model?: string | undefined
  createdAt: string
  updatedAt: string
}

type SessionTitleRow = {
  host_session_id: string
  title: string
  source: SessionTitleSource
  model: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = 'host_session_id, title, source, model, created_at, updated_at'

function mapRow(row: SessionTitleRow): SessionTitleRecord {
  return {
    hostSessionId: row.host_session_id,
    title: row.title,
    source: row.source,
    ...(row.model === null ? {} : { model: row.model }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SessionTitleRepository {
  constructor(private readonly db: Database) {}

  listAll(): SessionTitleRecord[] {
    return this.db
      .query<SessionTitleRow, []>(`SELECT ${COLUMNS} FROM session_titles ORDER BY host_session_id`)
      .all()
      .map(mapRow)
  }

  getByHostSessionId(hostSessionId: string): SessionTitleRecord | null {
    const row = this.db
      .query<SessionTitleRow, [string]>(
        `SELECT ${COLUMNS} FROM session_titles WHERE host_session_id = ?`
      )
      .get(hostSessionId)
    return row === null ? null : mapRow(row)
  }

  upsert(record: SessionTitleRecord): SessionTitleRecord {
    execute(
      this.db,
      `
        INSERT INTO session_titles (
          host_session_id, title, source, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_session_id) DO UPDATE SET
          title = excluded.title,
          source = excluded.source,
          model = excluded.model,
          updated_at = excluded.updated_at
      `,
      record.hostSessionId,
      record.title,
      record.source,
      record.model ?? null,
      record.createdAt,
      record.updatedAt
    )
    const stored = this.getByHostSessionId(record.hostSessionId)
    if (stored === null) {
      throw new Error(`failed to reload session title for ${record.hostSessionId}`)
    }
    return stored
  }

  delete(hostSessionId: string): boolean {
    const result = this.db
      .query('DELETE FROM session_titles WHERE host_session_id = ?')
      .run(hostSessionId)
    return result.changes > 0
  }
}
