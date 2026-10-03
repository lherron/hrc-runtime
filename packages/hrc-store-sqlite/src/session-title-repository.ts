import type { Database } from 'bun:sqlite'
import { SessionMetadataRepository } from './session-metadata-repository.js'

export type SessionTitleSource = 'generated' | 'manual'
export type SessionTitleRecord = {
  hostSessionId: string
  title: string
  source: SessionTitleSource
  model?: string | undefined
  createdAt: string
  updatedAt: string
}
/** Compatibility facade; titles now belong to the continuity metadata set. */
export class SessionTitleRepository {
  private readonly metadata: SessionMetadataRepository
  constructor(private readonly db: Database) {
    this.metadata = new SessionMetadataRepository(db)
  }
  private target(hostSessionId: string) {
    return this.db
      .query<{ scope_ref: string; lane_ref: string }, [string]>(
        'SELECT s.scope_ref,s.lane_ref FROM sessions s JOIN continuities c ON c.scope_ref=s.scope_ref AND c.lane_ref=s.lane_ref WHERE s.host_session_id=?'
      )
      .get(hostSessionId)
  }
  listAll(): SessionTitleRecord[] {
    return this.db
      .query<{ host_session_id: string; title: string; updated_at: string }, []>(`
      WITH resolved AS (
        SELECT scope_ref,lane_ref,value_json,updated_at,
          row_number() OVER (PARTITION BY scope_ref,lane_ref ORDER BY
            CASE source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC) AS rank
        FROM session_metadata WHERE key='title'
      )
      SELECT s.host_session_id,json_extract(m.value_json,'$') AS title,m.updated_at
      FROM resolved m JOIN sessions s ON s.scope_ref=m.scope_ref AND s.lane_ref=m.lane_ref
      JOIN continuities c ON c.scope_ref=s.scope_ref AND c.lane_ref=s.lane_ref
      WHERE m.rank=1 ORDER BY s.host_session_id
    `)
      .all()
      .map((row) => ({
        hostSessionId: row.host_session_id,
        title: row.title,
        source: 'manual',
        createdAt: row.updated_at,
        updatedAt: row.updated_at,
      }))
  }
  getByHostSessionId(hostSessionId: string): SessionTitleRecord | null {
    const t = this.target(hostSessionId)
    if (!t) return null
    const r = this.metadata.get(t.scope_ref, t.lane_ref)
    if (typeof r.metadata.title !== 'string') return null
    const src = r.metadataSources['title']!
    return {
      hostSessionId,
      title: r.metadata.title,
      source: 'manual',
      createdAt: src.updatedAt,
      updatedAt: src.updatedAt,
    }
  }
  upsert(record: SessionTitleRecord): SessionTitleRecord {
    const t = this.target(record.hostSessionId)
    if (!t) throw new Error(`unknown continuity for ${record.hostSessionId}`)
    this.metadata.write({
      scopeRef: t.scope_ref,
      laneRef: t.lane_ref,
      source: 'api',
      set: { title: record.title },
      updatedBy: 'unknown',
      updatedAt: record.updatedAt,
    })
    return this.getByHostSessionId(record.hostSessionId)!
  }
  delete(hostSessionId: string): boolean {
    const t = this.target(hostSessionId)
    if (!t) return false
    const exists =
      this.db
        .query(
          "SELECT 1 FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND key='title' AND source='api'"
        )
        .get(t.scope_ref, t.lane_ref) !== null
    this.metadata.write({
      scopeRef: t.scope_ref,
      laneRef: t.lane_ref,
      source: 'api',
      clear: ['title'],
      updatedBy: 'unknown',
    })
    return exists
  }
}
