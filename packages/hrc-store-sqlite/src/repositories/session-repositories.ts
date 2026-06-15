import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type {
  HrcAppSessionRecord,
  HrcAppSessionSpec,
  HrcContinuationRef,
  HrcContinuityRecord,
  HrcManagedSessionRecord,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import type {
  AppManagedSessionRow,
  AppSessionRow,
  ContinuityChainRow,
  ContinuityRow,
  SessionRow,
} from './rows.js'
import {
  APP_MANAGED_SESSION_COLUMNS,
  APP_SESSION_COLUMNS,
  type AppManagedSessionFindOptions,
  type AppManagedSessionRecord,
  type AppSessionApplyInput,
  type AppSessionBulkApplyResult,
  type ContinuityUpsertInput,
  SESSION_COLUMNS,
  type SessionListFilters,
  buildSetClause,
  execute,
  mapAppManagedSessionRow,
  mapAppSessionRow,
  mapSessionRow,
  requireRecord,
  serializeJson,
  toSessionRef,
} from './shared.js'

export class ContinuityRepository {
  constructor(private readonly db: Database) {}

  upsert(record: ContinuityUpsertInput): HrcContinuityRecord {
    execute(
      this.db,
      `
        INSERT INTO continuities (
          scope_ref,
          lane_ref,
          active_host_session_id,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          active_host_session_id = excluded.active_host_session_id,
          updated_at = excluded.updated_at
      `,
      record.scopeRef,
      record.laneRef,
      record.activeHostSessionId,
      record.updatedAt
    )

    return requireRecord(
      this.getByKey(record.scopeRef, record.laneRef),
      `failed to reload continuity ${record.scopeRef}/${record.laneRef}`
    )
  }

  getByKey(scopeRef: string, laneRef: string): HrcContinuityRecord | null {
    const row = this.db
      .query<ContinuityRow, [string, string]>(
        `
          SELECT scope_ref, lane_ref, active_host_session_id, updated_at
          FROM continuities
          WHERE scope_ref = ? AND lane_ref = ?
        `
      )
      .get(scopeRef, laneRef)

    if (!row) {
      return null
    }

    return {
      sessionRef: toSessionRef(row.scope_ref, row.lane_ref),
      scopeRef: row.scope_ref,
      laneRef: row.lane_ref,
      activeHostSessionId: row.active_host_session_id,
      updatedAt: row.updated_at,
      priorHostSessionIds: this.derivePriorHostSessionIds(
        row.scope_ref,
        row.lane_ref,
        row.active_host_session_id
      ),
    }
  }

  private derivePriorHostSessionIds(
    scopeRef: string,
    laneRef: string,
    activeHostSessionId: string
  ): string[] {
    // The continuity chain is derived from session ancestry rather than stored
    // directly in the continuity row so it stays consistent with rotations.
    const rows = this.db
      .query<ContinuityChainRow, [string, string]>(
        `
          SELECT host_session_id, prior_host_session_id, generation
          FROM sessions
          WHERE scope_ref = ? AND lane_ref = ?
          ORDER BY generation ASC
        `
      )
      .all(scopeRef, laneRef)

    const byHostSessionId = new Map(rows.map((row) => [row.host_session_id, row] as const))
    const priorHostSessionIds: string[] = []
    const seen = new Set<string>()

    let currentHostSessionId = activeHostSessionId
    while (true) {
      const current = byHostSessionId.get(currentHostSessionId)
      const priorHostSessionId = current?.prior_host_session_id
      if (!priorHostSessionId || seen.has(priorHostSessionId)) {
        break
      }

      priorHostSessionIds.push(priorHostSessionId)
      seen.add(priorHostSessionId)
      currentHostSessionId = priorHostSessionId
    }

    priorHostSessionIds.reverse()
    return priorHostSessionIds
  }
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcSessionRecord): HrcSessionRecord {
    execute(
      this.db,
      `
        INSERT INTO sessions (
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.hostSessionId,
      record.scopeRef,
      record.laneRef,
      record.generation,
      record.status,
      record.priorHostSessionId ?? null,
      record.createdAt,
      record.updatedAt,
      serializeJson(record.parsedScopeJson),
      JSON.stringify(record.ancestorScopeRefs),
      serializeJson(record.lastAppliedIntentJson),
      serializeJson(record.continuation)
    )

    return requireRecord(
      this.getByHostSessionId(record.hostSessionId),
      `failed to reload session ${record.hostSessionId}`
    )
  }

  getByHostSessionId(hostSessionId: string): HrcSessionRecord | null {
    const row = this.db
      .query<SessionRow, [string]>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE host_session_id = ?`
      )
      .get(hostSessionId)

    return row ? mapSessionRow(row) : null
  }

  listByScopeRef(scopeRef: string, laneRef?: string | undefined): HrcSessionRecord[] {
    return this.listByFilters({ scopeRef, laneRef })
  }

  updateStatus(hostSessionId: string, status: string, updatedAt: string): HrcSessionRecord | null {
    execute(
      this.db,
      'UPDATE sessions SET status = ?, updated_at = ? WHERE host_session_id = ?',
      status,
      updatedAt,
      hostSessionId
    )

    return this.getByHostSessionId(hostSessionId)
  }

  updateIntent(
    hostSessionId: string,
    lastAppliedIntentJson: HrcRuntimeIntent | undefined,
    updatedAt: string
  ): HrcSessionRecord | null {
    execute(
      this.db,
      `
        UPDATE sessions
        SET last_applied_intent_json = ?, updated_at = ?
        WHERE host_session_id = ?
      `,
      serializeJson(lastAppliedIntentJson),
      updatedAt,
      hostSessionId
    )

    return this.getByHostSessionId(hostSessionId)
  }

  updateParsedScope(
    hostSessionId: string,
    parsedScopeJson: Record<string, unknown> | undefined,
    updatedAt: string
  ): HrcSessionRecord | null {
    execute(
      this.db,
      `
        UPDATE sessions
        SET parsed_scope_json = ?, updated_at = ?
        WHERE host_session_id = ?
      `,
      serializeJson(parsedScopeJson),
      updatedAt,
      hostSessionId
    )

    return this.getByHostSessionId(hostSessionId)
  }

  updateContinuation(
    hostSessionId: string,
    continuation: HrcContinuationRef | undefined,
    updatedAt: string
  ): HrcSessionRecord | null {
    execute(
      this.db,
      `
        UPDATE sessions
        SET continuation_json = ?, updated_at = ?
        WHERE host_session_id = ?
      `,
      serializeJson(continuation),
      updatedAt,
      hostSessionId
    )

    return this.getByHostSessionId(hostSessionId)
  }

  private listByFilters(filters: SessionListFilters): HrcSessionRecord[] {
    if (filters.laneRef) {
      const rows = this.db
        .query<SessionRow, [string, string]>(
          `SELECT ${SESSION_COLUMNS} FROM sessions
            WHERE scope_ref = ? AND lane_ref = ?
            ORDER BY generation ASC`
        )
        .all(filters.scopeRef, filters.laneRef)

      return rows.map(mapSessionRow)
    }

    const rows = this.db
      .query<SessionRow, [string]>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE scope_ref = ?
          ORDER BY lane_ref ASC, generation ASC`
      )
      .all(filters.scopeRef)

    return rows.map(mapSessionRow)
  }
}

export class AppSessionRepository {
  constructor(private readonly db: Database) {}

  create(record: HrcAppSessionRecord): HrcAppSessionRecord {
    execute(
      this.db,
      `
        INSERT INTO app_sessions (
          app_id,
          app_session_key,
          host_session_id,
          label,
          metadata_json,
          created_at,
          updated_at,
          removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.appId,
      record.appSessionKey,
      record.hostSessionId,
      record.label ?? null,
      serializeJson(record.metadata),
      record.createdAt,
      record.updatedAt,
      record.removedAt ?? null
    )

    return requireRecord(
      this.findByKey(record.appId, record.appSessionKey),
      `failed to reload app session ${record.appId}/${record.appSessionKey}`
    )
  }

  findByKey(appId: string, appSessionKey: string): HrcAppSessionRecord | null {
    const row = this.db
      .query<AppSessionRow, [string, string]>(
        `SELECT ${APP_SESSION_COLUMNS} FROM app_sessions
          WHERE app_id = ? AND app_session_key = ?`
      )
      .get(appId, appSessionKey)

    return row ? mapAppSessionRow(row) : null
  }

  findByApp(appId: string): HrcAppSessionRecord[] {
    const rows = this.db
      .query<AppSessionRow, [string]>(
        `SELECT ${APP_SESSION_COLUMNS} FROM app_sessions
          WHERE app_id = ?
          ORDER BY app_session_key ASC`
      )
      .all(appId)

    return rows.map(mapAppSessionRow)
  }

  findByHostSession(hostSessionId: string): HrcAppSessionRecord[] {
    const rows = this.db
      .query<AppSessionRow, [string]>(
        `SELECT ${APP_SESSION_COLUMNS} FROM app_sessions
          WHERE host_session_id = ?
          ORDER BY app_id ASC, app_session_key ASC`
      )
      .all(hostSessionId)

    return rows.map(mapAppSessionRow)
  }

  update(
    appId: string,
    appSessionKey: string,
    patch: {
      hostSessionId?: string | undefined
      label?: string | undefined
      metadata?: Record<string, unknown> | undefined
      removedAt?: string | null | undefined
      updatedAt: string
    }
  ): HrcAppSessionRecord | null {
    const entries: Array<[column: string, value: string | number | null]> = []

    if (patch.hostSessionId !== undefined) {
      entries.push(['host_session_id', patch.hostSessionId])
    }
    if (patch.label !== undefined) {
      entries.push(['label', patch.label])
    }
    if (patch.metadata !== undefined) {
      entries.push(['metadata_json', serializeJson(patch.metadata)])
    }
    if (Object.hasOwn(patch, 'removedAt')) {
      entries.push(['removed_at', patch.removedAt ?? null])
    }
    entries.push(['updated_at', patch.updatedAt])

    const { clause, values } = buildSetClause(entries)
    execute(
      this.db,
      `UPDATE app_sessions SET ${clause} WHERE app_id = ? AND app_session_key = ?`,
      ...values,
      appId,
      appSessionKey
    )

    return this.findByKey(appId, appSessionKey)
  }

  bulkApply(
    appId: string,
    hostSessionId: string,
    sessions: AppSessionApplyInput[]
  ): AppSessionBulkApplyResult {
    const applyBulk = this.db.transaction(
      (
        requestedAppId: string,
        requestedHostSessionId: string,
        requestedSessions: AppSessionApplyInput[]
      ) => {
        const now = new Date().toISOString()
        let inserted = 0
        let updated = 0
        let removed = 0

        for (const session of requestedSessions) {
          const existing = this.findByKey(requestedAppId, session.appSessionKey)

          if (existing) {
            this.update(requestedAppId, session.appSessionKey, {
              hostSessionId: requestedHostSessionId,
              ...(session.label !== undefined ? { label: session.label } : {}),
              ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
              removedAt: null,
              updatedAt: now,
            })
            updated += 1
          } else {
            this.create({
              appId: requestedAppId,
              appSessionKey: session.appSessionKey,
              hostSessionId: requestedHostSessionId,
              ...(session.label !== undefined ? { label: session.label } : {}),
              ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
              createdAt: now,
              updatedAt: now,
            })
            inserted += 1
          }
        }

        const incomingKeys = new Set(requestedSessions.map((session) => session.appSessionKey))
        const existingForAppHost = this.findByHostSession(requestedHostSessionId).filter(
          (record) => record.appId === requestedAppId && record.removedAt === undefined
        )

        for (const record of existingForAppHost) {
          if (incomingKeys.has(record.appSessionKey)) {
            continue
          }

          this.update(requestedAppId, record.appSessionKey, {
            removedAt: now,
            updatedAt: now,
          })
          removed += 1
        }

        return {
          inserted,
          updated,
          removed,
        } satisfies AppSessionBulkApplyResult
      }
    )

    return applyBulk.immediate(appId, hostSessionId, sessions)
  }
}

export class AppManagedSessionRepository {
  constructor(private readonly db: Database) {}

  create(record: AppManagedSessionRecord): AppManagedSessionRecord {
    execute(
      this.db,
      `
        INSERT INTO app_managed_sessions (
          app_id,
          app_session_key,
          kind,
          label,
          metadata_json,
          active_host_session_id,
          generation,
          status,
          last_applied_spec_json,
          created_at,
          updated_at,
          removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.appId,
      record.appSessionKey,
      record.kind,
      record.label ?? null,
      serializeJson(record.metadata),
      record.activeHostSessionId,
      record.generation,
      record.status,
      serializeJson(record.lastAppliedSpec),
      record.createdAt,
      record.updatedAt,
      record.removedAt ?? null
    )

    return requireRecord(
      this.findByKey(record.appId, record.appSessionKey),
      `failed to reload app managed session ${record.appId}/${record.appSessionKey}`
    )
  }

  findByKey(appId: string, appSessionKey: string): AppManagedSessionRecord | null {
    const row = this.db
      .query<AppManagedSessionRow, [string, string]>(
        `SELECT ${APP_MANAGED_SESSION_COLUMNS} FROM app_managed_sessions
          WHERE app_id = ? AND app_session_key = ?`
      )
      .get(appId, appSessionKey)

    return row ? mapAppManagedSessionRow(row) : null
  }

  findByApp(appId: string, options: AppManagedSessionFindOptions = {}): AppManagedSessionRecord[] {
    const clauses = ['app_id = ?']
    const values: Array<string | number | null> = [appId]

    if (options.kind !== undefined) {
      clauses.push('kind = ?')
      values.push(options.kind)
    }
    if (options.includeRemoved !== true) {
      clauses.push("status != 'removed'")
    }

    const rows = this.db
      .query<AppManagedSessionRow, SQLQueryBindings[]>(
        `SELECT ${APP_MANAGED_SESSION_COLUMNS} FROM app_managed_sessions
          WHERE ${clauses.join(' AND ')}
          ORDER BY app_session_key ASC`
      )
      .all(...values)

    return rows.map(mapAppManagedSessionRow)
  }

  findByActiveHostSessionId(hostSessionId: string): AppManagedSessionRecord[] {
    const rows = this.db
      .query<AppManagedSessionRow, [string]>(
        `SELECT ${APP_MANAGED_SESSION_COLUMNS} FROM app_managed_sessions
          WHERE active_host_session_id = ?
          ORDER BY app_id ASC, app_session_key ASC`
      )
      .all(hostSessionId)

    return rows.map(mapAppManagedSessionRow)
  }

  update(
    appId: string,
    appSessionKey: string,
    patch: {
      activeHostSessionId?: string | undefined
      generation?: number | undefined
      status?: HrcManagedSessionRecord['status'] | undefined
      label?: string | null | undefined
      metadata?: Record<string, unknown> | null | undefined
      removedAt?: string | null | undefined
      lastAppliedSpec?: HrcAppSessionSpec | null | undefined
      updatedAt: string
    }
  ): AppManagedSessionRecord | null {
    const entries: Array<[column: string, value: string | number | null]> = []

    if (patch.activeHostSessionId !== undefined) {
      entries.push(['active_host_session_id', patch.activeHostSessionId])
    }
    if (patch.generation !== undefined) {
      entries.push(['generation', patch.generation])
    }
    if (patch.status !== undefined) {
      entries.push(['status', patch.status])
    }
    if (Object.hasOwn(patch, 'label')) {
      entries.push(['label', patch.label ?? null])
    }
    if (Object.hasOwn(patch, 'metadata')) {
      entries.push(['metadata_json', serializeJson(patch.metadata ?? undefined)])
    }
    if (Object.hasOwn(patch, 'removedAt')) {
      entries.push(['removed_at', patch.removedAt ?? null])
    }
    if (Object.hasOwn(patch, 'lastAppliedSpec')) {
      entries.push(['last_applied_spec_json', serializeJson(patch.lastAppliedSpec ?? undefined)])
    }
    entries.push(['updated_at', patch.updatedAt])

    const { clause, values } = buildSetClause(entries)
    execute(
      this.db,
      `UPDATE app_managed_sessions SET ${clause} WHERE app_id = ? AND app_session_key = ?`,
      ...values,
      appId,
      appSessionKey
    )

    return this.findByKey(appId, appSessionKey)
  }
}
