import type { Database } from 'bun:sqlite'
import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
  REGISTERED_SESSION_METADATA,
  type SessionMetadataRejection,
  type SessionMetadataResponse,
  type SessionMetadataSource,
  type SessionMetadataValue,
  nestSessionMetadata,
  truncateMetadataUpdatedBy,
  validateSessionMetadata,
  validateSessionMetadataEntry,
} from 'hrc-core'
import { HrcLifecycleEventRepository } from './repositories/event-repositories.js'
import { canonicalLaneRef } from './session-identity.js'

type Row = {
  key: string
  source: SessionMetadataSource
  value_json: string
  updated_at: string
  updated_by: string
}
const precedence = { api: 3, launch: 2, hrc: 1 }
export class SessionMetadataRepository {
  constructor(private readonly db: Database) {}
  private rows(scopeRef: string, laneRef: string): Row[] {
    return this.db
      .query<Row, [string, string]>(
        'SELECT key,source,value_json,updated_at,updated_by FROM session_metadata WHERE scope_ref=? AND lane_ref=?'
      )
      .all(scopeRef, laneRef)
      .sort((a, b) => precedence[b.source] - precedence[a.source])
  }
  get(scopeRef: string, laneRef: string): SessionMetadataResponse {
    const values: Record<string, SessionMetadataValue> = {}
    const metadataSources: SessionMetadataResponse['metadataSources'] = {}
    for (const row of this.rows(scopeRef, laneRef)) {
      const value = JSON.parse(row.value_json) as SessionMetadataValue
      const sourceRecord = {
        source: row.source,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      }
      if (Object.hasOwn(values, row.key)) {
        const winner = metadataSources[row.key]!
        winner.shadowed ??= []
        winner.shadowed.push({ ...sourceRecord, value })
      } else {
        values[row.key] = value
        metadataSources[row.key] = {
          ...sourceRecord,
          ...(Object.hasOwn(REGISTERED_SESSION_METADATA, row.key) ? {} : { registered: false }),
        }
      }
    }
    return { metadata: nestSessionMetadata(values), metadataSources }
  }
  write(input: {
    scopeRef: string
    laneRef: string
    source: SessionMetadataSource
    set?: unknown
    clear?: string[] | undefined
    replace?: boolean | undefined
    updatedBy: string
    updatedAt?: string | undefined
  }): SessionMetadataResponse & { rejected: SessionMetadataRejection[] } {
    return this.db
      .transaction(() => {
        const { scopeRef, laneRef, source } = input
        const continuity = this.db
          .query<{ active_host_session_id: string }, [string, string]>(
            'SELECT active_host_session_id FROM continuities WHERE scope_ref=? AND lane_ref=?'
          )
          .get(scopeRef, laneRef)
        if (!continuity)
          throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_HOST_SESSION, 'unknown continuity', {
            scopeRef,
            laneRef,
          })
        const session = this.db
          .query<{ generation: number }, [string]>(
            'SELECT generation FROM sessions WHERE host_session_id=?'
          )
          .get(continuity.active_host_session_id)!
        const before = this.rows(scopeRef, laneRef)
        const clear = new Set(input.clear ?? [])
        const remaining = before.filter(
          (row) => row.source !== source || (!input.replace && !clear.has(row.key))
        )
        const validation = validateSessionMetadata(input.set === undefined ? {} : input.set, {
          existingKeys: [...new Set(remaining.map((row) => row.key))],
        })
        for (const key of clear) {
          const reason = validateSessionMetadataEntry(key, null, false).reason
          if (reason) validation.rejected.push({ key, reason })
        }
        if (source === 'api' && validation.rejected.length)
          throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'invalid session metadata', {
            rejected: validation.rejected,
          })
        const now = input.updatedAt ?? new Date().toISOString()
        const updatedBy = truncateMetadataUpdatedBy(input.updatedBy)
        const desired = new Map(
          before
            .filter((row) => row.source === source && !input.replace && !clear.has(row.key))
            .map((row) => [row.key, row.value_json])
        )
        for (const [key, value] of Object.entries(validation.values))
          desired.set(key, JSON.stringify(value))
        const changed: Array<{ key: string; op: 'set' | 'clear' }> = []
        for (const row of before.filter((row) => row.source === source))
          if (!desired.has(row.key)) {
            this.db
              .query(
                'DELETE FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND key=? AND source=?'
              )
              .run(scopeRef, laneRef, row.key, source)
            changed.push({ key: row.key, op: 'clear' })
          }
        for (const [key, value] of desired)
          if (
            before.find((row) => row.key === key && row.source === source)?.value_json !== value
          ) {
            this.db
              .query(
                'INSERT INTO session_metadata VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref,key,source) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by'
              )
              .run(scopeRef, laneRef, key, source, value, now, updatedBy)
            changed.push({ key, op: 'set' })
          }
        const resolved = this.get(scopeRef, laneRef)
        const after = this.rows(scopeRef, laneRef)
        const events = new HrcLifecycleEventRepository(this.db)
        const append = (eventKind: string, payload: unknown) =>
          events.appendWithinExistingTransaction({
            ts: now,
            hostSessionId: continuity.active_host_session_id,
            scopeRef,
            laneRef,
            generation: session.generation,
            category: 'session',
            eventKind,
            payload,
          })
        for (const item of changed) {
          const winning = after.find((row) => row.key === item.key)
          append('session.metadata.changed', {
            scopeRef,
            laneRef: canonicalLaneRef(laneRef),
            ...item,
            source,
            resolved: winning
              ? { value: JSON.parse(winning.value_json), source: winning.source }
              : null,
          })
        }
        for (const rejection of validation.rejected) append('session.metadata.rejected', rejection)
        return { ...resolved, rejected: validation.rejected }
      })
      .immediate()
  }
}
