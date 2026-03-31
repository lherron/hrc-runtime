import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
  type HrcContinuationRef,
  type HrcContinuityRecord,
  type HrcErrorCodeValue,
  type HrcEventEnvelope,
  type HrcLaunchRecord,
  type HrcRunRecord,
  type HrcRuntimeIntent,
  type HrcRuntimeSnapshot,
  type HrcSessionRecord,
  normalizeSessionRef,
} from 'hrc-core'

export type HrcRuntimeBufferRecord = {
  runtimeId: string
  chunkSeq: number
  text: string
  createdAt: string
}

export type ContinuityUpsertInput = Pick<
  HrcContinuityRecord,
  'scopeRef' | 'laneRef' | 'activeHostSessionId' | 'updatedAt'
>

export type EventQueryFilters = {
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  fromSeq?: number | undefined
  limit?: number | undefined
}

type SessionListFilters = {
  scopeRef: string
  laneRef?: string | undefined
}

type RuntimeUpdatePatch = Partial<Omit<HrcRuntimeSnapshot, 'runtimeId'>>
type RunUpdatePatch = Partial<Omit<HrcRunRecord, 'runId'>>
type LaunchUpdatePatch = Partial<Omit<HrcLaunchRecord, 'launchId'>>

type ContinuityRow = {
  scope_ref: string
  lane_ref: string
  active_host_session_id: string
  updated_at: string
}

type ContinuityChainRow = {
  host_session_id: string
  prior_host_session_id: string | null
  generation: number
}

type SessionRow = {
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  status: string
  prior_host_session_id: string | null
  created_at: string
  updated_at: string
  parsed_scope_json: string | null
  ancestor_scope_refs_json: string
  last_applied_intent_json: string | null
  continuation_json: string | null
}

type RuntimeRow = {
  runtime_id: string
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  launch_id: string | null
  transport: string
  harness: HrcRuntimeSnapshot['harness']
  provider: HrcRuntimeSnapshot['provider']
  status: string
  tmux_json: string | null
  wrapper_pid: number | null
  child_pid: number | null
  harness_session_json: string | null
  continuation_json: string | null
  supports_inflight_input: number
  adopted: number
  active_run_id: string | null
  last_activity_at: string | null
  created_at: string
  updated_at: string
}

type RunRow = {
  run_id: string
  host_session_id: string
  runtime_id: string | null
  scope_ref: string
  lane_ref: string
  generation: number
  transport: string
  status: string
  accepted_at: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string
  error_code: HrcErrorCodeValue | null
  error_message: string | null
}

type LaunchRow = {
  launch_id: string
  host_session_id: string
  generation: number
  runtime_id: string | null
  harness: HrcLaunchRecord['harness']
  provider: HrcLaunchRecord['provider']
  launch_artifact_path: string
  tmux_json: string | null
  wrapper_pid: number | null
  child_pid: number | null
  harness_session_json: string | null
  continuation_json: string | null
  wrapper_started_at: string | null
  child_started_at: string | null
  exited_at: string | null
  exit_code: number | null
  signal: string | null
  status: string
  created_at: string
  updated_at: string
}

type EventRow = {
  seq: number
  ts: string
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  run_id: string | null
  runtime_id: string | null
  source: HrcEventEnvelope['source']
  event_kind: string
  event_json: string
}

type RuntimeBufferRow = {
  runtime_id: string
  chunk_seq: number
  text: string
  created_at: string
}

function serializeJson(value: unknown): string | null {
  if (value === undefined) {
    return null
  }

  return JSON.stringify(value)
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined
  }

  return JSON.parse(value) as T
}

function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0
}

function fromSqliteBoolean(value: number): boolean {
  return value !== 0
}

function toSessionRef(scopeRef: string, laneRef: string): string {
  return normalizeSessionRef(`${scopeRef}/lane:${laneRef}`)
}

function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}

function requireRecord<T>(record: T | null, message: string): T {
  if (record === null) {
    throw new Error(message)
  }

  return record
}

function buildSetClause(entries: Array<[column: string, value: string | number | null]>): {
  clause: string
  values: Array<string | number | null>
} {
  return {
    clause: entries.map(([column]) => `${column} = ?`).join(', '),
    values: entries.map(([, value]) => value),
  }
}

function mapSessionRow(row: SessionRow): HrcSessionRecord {
  return {
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    status: row.status,
    priorHostSessionId: row.prior_host_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedScopeJson: parseJson<Record<string, unknown>>(row.parsed_scope_json),
    ancestorScopeRefs: parseJson<string[]>(row.ancestor_scope_refs_json) ?? [],
    lastAppliedIntentJson: parseJson<HrcRuntimeIntent>(row.last_applied_intent_json),
    continuation: parseJson<HrcContinuationRef>(row.continuation_json),
  }
}

function mapRuntimeRow(row: RuntimeRow): HrcRuntimeSnapshot {
  return {
    runtimeId: row.runtime_id,
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    launchId: row.launch_id ?? undefined,
    transport: row.transport,
    harness: row.harness,
    provider: row.provider,
    status: row.status,
    tmuxJson: parseJson<Record<string, unknown>>(row.tmux_json),
    wrapperPid: row.wrapper_pid ?? undefined,
    childPid: row.child_pid ?? undefined,
    harnessSessionJson: parseJson<Record<string, unknown>>(row.harness_session_json),
    continuation: parseJson<HrcContinuationRef>(row.continuation_json),
    supportsInflightInput: fromSqliteBoolean(row.supports_inflight_input),
    adopted: fromSqliteBoolean(row.adopted),
    activeRunId: row.active_run_id ?? undefined,
    lastActivityAt: row.last_activity_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRunRow(row: RunRow): HrcRunRecord {
  return {
    runId: row.run_id,
    hostSessionId: row.host_session_id,
    runtimeId: row.runtime_id ?? undefined,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    transport: row.transport,
    status: row.status,
    acceptedAt: row.accepted_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  }
}

function mapLaunchRow(row: LaunchRow): HrcLaunchRecord {
  return {
    launchId: row.launch_id,
    hostSessionId: row.host_session_id,
    generation: row.generation,
    runtimeId: row.runtime_id ?? undefined,
    harness: row.harness,
    provider: row.provider,
    launchArtifactPath: row.launch_artifact_path,
    tmuxJson: parseJson<Record<string, unknown>>(row.tmux_json),
    wrapperPid: row.wrapper_pid ?? undefined,
    childPid: row.child_pid ?? undefined,
    harnessSessionJson: parseJson<Record<string, unknown>>(row.harness_session_json),
    continuation: parseJson<HrcContinuationRef>(row.continuation_json),
    wrapperStartedAt: row.wrapper_started_at ?? undefined,
    childStartedAt: row.child_started_at ?? undefined,
    exitedAt: row.exited_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    signal: row.signal ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapEventRow(row: EventRow): HrcEventEnvelope {
  return {
    seq: row.seq,
    ts: row.ts,
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    runId: row.run_id ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    source: row.source,
    eventKind: row.event_kind,
    eventJson: parseJson<unknown>(row.event_json),
  }
}

function mapRuntimeBufferRow(row: RuntimeBufferRow): HrcRuntimeBufferRecord {
  return {
    runtimeId: row.runtime_id,
    chunkSeq: row.chunk_seq,
    text: row.text,
    createdAt: row.created_at,
  }
}

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

  findByRef(scopeRef: string, laneRef: string): HrcContinuityRecord | null {
    return this.getByKey(scopeRef, laneRef)
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

  create(record: HrcSessionRecord): HrcSessionRecord {
    return this.insert(record)
  }

  getByHostSessionId(hostSessionId: string): HrcSessionRecord | null {
    const row = this.db
      .query<SessionRow, [string]>(
        `
          SELECT
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
          FROM sessions
          WHERE host_session_id = ?
        `
      )
      .get(hostSessionId)

    return row ? mapSessionRow(row) : null
  }

  findByHostSessionId(hostSessionId: string): HrcSessionRecord | null {
    return this.getByHostSessionId(hostSessionId)
  }

  listByScopeRef(scopeRef: string, laneRef?: string | undefined): HrcSessionRecord[] {
    return this.listByFilters({ scopeRef, laneRef })
  }

  findByRef(scopeRef: string, laneRef: string): HrcSessionRecord[] {
    return this.listByScopeRef(scopeRef, laneRef)
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
          `
            SELECT
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
            FROM sessions
            WHERE scope_ref = ? AND lane_ref = ?
            ORDER BY generation ASC
          `
        )
        .all(filters.scopeRef, filters.laneRef)

      return rows.map(mapSessionRow)
    }

    const rows = this.db
      .query<SessionRow, [string]>(
        `
          SELECT
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
          FROM sessions
          WHERE scope_ref = ?
          ORDER BY lane_ref ASC, generation ASC
        `
      )
      .all(filters.scopeRef)

    return rows.map(mapSessionRow)
  }
}

export class RuntimeRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcRuntimeSnapshot): HrcRuntimeSnapshot {
    execute(
      this.db,
      `
        INSERT INTO runtimes (
          runtime_id,
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          launch_id,
          transport,
          harness,
          provider,
          status,
          tmux_json,
          wrapper_pid,
          child_pid,
          harness_session_json,
          continuation_json,
          supports_inflight_input,
          adopted,
          active_run_id,
          last_activity_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.runtimeId,
      record.hostSessionId,
      record.scopeRef,
      record.laneRef,
      record.generation,
      record.launchId ?? null,
      record.transport,
      record.harness,
      record.provider,
      record.status,
      serializeJson(record.tmuxJson),
      record.wrapperPid ?? null,
      record.childPid ?? null,
      serializeJson(record.harnessSessionJson),
      serializeJson(record.continuation),
      toSqliteBoolean(record.supportsInflightInput),
      toSqliteBoolean(record.adopted),
      record.activeRunId ?? null,
      record.lastActivityAt ?? null,
      record.createdAt,
      record.updatedAt
    )

    return requireRecord(
      this.getByRuntimeId(record.runtimeId),
      `failed to reload runtime ${record.runtimeId}`
    )
  }

  create(record: HrcRuntimeSnapshot): HrcRuntimeSnapshot {
    return this.insert(record)
  }

  getByRuntimeId(runtimeId: string): HrcRuntimeSnapshot | null {
    const row = this.db
      .query<RuntimeRow, [string]>(
        `
          SELECT
            runtime_id,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            launch_id,
            transport,
            harness,
            provider,
            status,
            tmux_json,
            wrapper_pid,
            child_pid,
            harness_session_json,
            continuation_json,
            supports_inflight_input,
            adopted,
            active_run_id,
            last_activity_at,
            created_at,
            updated_at
          FROM runtimes
          WHERE runtime_id = ?
        `
      )
      .get(runtimeId)

    return row ? mapRuntimeRow(row) : null
  }

  findById(runtimeId: string): HrcRuntimeSnapshot | null {
    return this.getByRuntimeId(runtimeId)
  }

  listByHostSessionId(hostSessionId: string): HrcRuntimeSnapshot[] {
    const rows = this.db
      .query<RuntimeRow, [string]>(
        `
          SELECT
            runtime_id,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            launch_id,
            transport,
            harness,
            provider,
            status,
            tmux_json,
            wrapper_pid,
            child_pid,
            harness_session_json,
            continuation_json,
            supports_inflight_input,
            adopted,
            active_run_id,
            last_activity_at,
            created_at,
            updated_at
          FROM runtimes
          WHERE host_session_id = ?
          ORDER BY created_at ASC, runtime_id ASC
        `
      )
      .all(hostSessionId)

    return rows.map(mapRuntimeRow)
  }

  findByHostSession(hostSessionId: string): HrcRuntimeSnapshot[] {
    return this.listByHostSessionId(hostSessionId)
  }

  update(runtimeId: string, patch: RuntimeUpdatePatch): HrcRuntimeSnapshot | null {
    const entries: Array<[column: string, value: string | number | null]> = []

    if (patch.hostSessionId !== undefined) {
      entries.push(['host_session_id', patch.hostSessionId])
    }
    if (patch.scopeRef !== undefined) {
      entries.push(['scope_ref', patch.scopeRef])
    }
    if (patch.laneRef !== undefined) {
      entries.push(['lane_ref', patch.laneRef])
    }
    if (patch.generation !== undefined) {
      entries.push(['generation', patch.generation])
    }
    if (patch.launchId !== undefined) {
      entries.push(['launch_id', patch.launchId])
    }
    if (patch.transport !== undefined) {
      entries.push(['transport', patch.transport])
    }
    if (patch.harness !== undefined) {
      entries.push(['harness', patch.harness])
    }
    if (patch.provider !== undefined) {
      entries.push(['provider', patch.provider])
    }
    if (patch.status !== undefined) {
      entries.push(['status', patch.status])
    }
    if (patch.tmuxJson !== undefined) {
      entries.push(['tmux_json', serializeJson(patch.tmuxJson)])
    }
    if (patch.wrapperPid !== undefined) {
      entries.push(['wrapper_pid', patch.wrapperPid])
    }
    if (patch.childPid !== undefined) {
      entries.push(['child_pid', patch.childPid])
    }
    if (patch.harnessSessionJson !== undefined) {
      entries.push(['harness_session_json', serializeJson(patch.harnessSessionJson)])
    }
    if (patch.continuation !== undefined) {
      entries.push(['continuation_json', serializeJson(patch.continuation)])
    }
    if (patch.supportsInflightInput !== undefined) {
      entries.push(['supports_inflight_input', toSqliteBoolean(patch.supportsInflightInput)])
    }
    if (patch.adopted !== undefined) {
      entries.push(['adopted', toSqliteBoolean(patch.adopted)])
    }
    if (patch.activeRunId !== undefined) {
      entries.push(['active_run_id', patch.activeRunId])
    }
    if (patch.lastActivityAt !== undefined) {
      entries.push(['last_activity_at', patch.lastActivityAt])
    }
    if (patch.createdAt !== undefined) {
      entries.push(['created_at', patch.createdAt])
    }
    if (patch.updatedAt !== undefined) {
      entries.push(['updated_at', patch.updatedAt])
    }

    if (entries.length === 0) {
      return this.getByRuntimeId(runtimeId)
    }

    const { clause, values } = buildSetClause(entries)
    execute(this.db, `UPDATE runtimes SET ${clause} WHERE runtime_id = ?`, ...values, runtimeId)
    return this.getByRuntimeId(runtimeId)
  }

  updateStatus(runtimeId: string, status: string, updatedAt: string): HrcRuntimeSnapshot | null {
    return this.update(runtimeId, { status, updatedAt })
  }

  updatePids(
    runtimeId: string,
    updates: {
      wrapperPid?: number | undefined
      childPid?: number | undefined
      updatedAt: string
    }
  ): HrcRuntimeSnapshot | null {
    return this.update(runtimeId, {
      ...(updates.wrapperPid !== undefined ? { wrapperPid: updates.wrapperPid } : {}),
      ...(updates.childPid !== undefined ? { childPid: updates.childPid } : {}),
      updatedAt: updates.updatedAt,
    })
  }

  updateRunId(
    runtimeId: string,
    activeRunId: string | undefined,
    updatedAt: string
  ): HrcRuntimeSnapshot | null {
    execute(
      this.db,
      `
        UPDATE runtimes
        SET active_run_id = ?, updated_at = ?
        WHERE runtime_id = ?
      `,
      activeRunId ?? null,
      updatedAt,
      runtimeId
    )

    return this.getByRuntimeId(runtimeId)
  }

  updateActivity(
    runtimeId: string,
    lastActivityAt: string,
    updatedAt: string
  ): HrcRuntimeSnapshot | null {
    execute(
      this.db,
      `
        UPDATE runtimes
        SET last_activity_at = ?, updated_at = ?
        WHERE runtime_id = ?
      `,
      lastActivityAt,
      updatedAt,
      runtimeId
    )

    return this.getByRuntimeId(runtimeId)
  }
}

export class RunRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcRunRecord): HrcRunRecord {
    execute(
      this.db,
      `
        INSERT INTO runs (
          run_id,
          host_session_id,
          runtime_id,
          scope_ref,
          lane_ref,
          generation,
          transport,
          status,
          accepted_at,
          started_at,
          completed_at,
          updated_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.runId,
      record.hostSessionId,
      record.runtimeId ?? null,
      record.scopeRef,
      record.laneRef,
      record.generation,
      record.transport,
      record.status,
      record.acceptedAt ?? null,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.updatedAt,
      record.errorCode ?? null,
      record.errorMessage ?? null
    )

    return requireRecord(this.getByRunId(record.runId), `failed to reload run ${record.runId}`)
  }

  create(record: HrcRunRecord): HrcRunRecord {
    return this.insert(record)
  }

  getByRunId(runId: string): HrcRunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(
        `
          SELECT
            run_id,
            host_session_id,
            runtime_id,
            scope_ref,
            lane_ref,
            generation,
            transport,
            status,
            accepted_at,
            started_at,
            completed_at,
            updated_at,
            error_code,
            error_message
          FROM runs
          WHERE run_id = ?
        `
      )
      .get(runId)

    return row ? mapRunRow(row) : null
  }

  findById(runId: string): HrcRunRecord | null {
    return this.getByRunId(runId)
  }

  listByRuntimeId(runtimeId: string): HrcRunRecord[] {
    const rows = this.db
      .query<RunRow, [string]>(
        `
          SELECT
            run_id,
            host_session_id,
            runtime_id,
            scope_ref,
            lane_ref,
            generation,
            transport,
            status,
            accepted_at,
            started_at,
            completed_at,
            updated_at,
            error_code,
            error_message
          FROM runs
          WHERE runtime_id = ?
          ORDER BY accepted_at ASC, run_id ASC
        `
      )
      .all(runtimeId)

    return rows.map(mapRunRow)
  }

  findByRuntime(runtimeId: string): HrcRunRecord[] {
    return this.listByRuntimeId(runtimeId)
  }

  update(runId: string, patch: RunUpdatePatch): HrcRunRecord | null {
    const entries: Array<[column: string, value: string | number | null]> = []

    if (patch.hostSessionId !== undefined) {
      entries.push(['host_session_id', patch.hostSessionId])
    }
    if (patch.runtimeId !== undefined) {
      entries.push(['runtime_id', patch.runtimeId])
    }
    if (patch.scopeRef !== undefined) {
      entries.push(['scope_ref', patch.scopeRef])
    }
    if (patch.laneRef !== undefined) {
      entries.push(['lane_ref', patch.laneRef])
    }
    if (patch.generation !== undefined) {
      entries.push(['generation', patch.generation])
    }
    if (patch.transport !== undefined) {
      entries.push(['transport', patch.transport])
    }
    if (patch.status !== undefined) {
      entries.push(['status', patch.status])
    }
    if (patch.acceptedAt !== undefined) {
      entries.push(['accepted_at', patch.acceptedAt])
    }
    if (patch.startedAt !== undefined) {
      entries.push(['started_at', patch.startedAt])
    }
    if (patch.completedAt !== undefined) {
      entries.push(['completed_at', patch.completedAt])
    }
    if (patch.updatedAt !== undefined) {
      entries.push(['updated_at', patch.updatedAt])
    }
    if (patch.errorCode !== undefined) {
      entries.push(['error_code', patch.errorCode])
    }
    if (patch.errorMessage !== undefined) {
      entries.push(['error_message', patch.errorMessage])
    }

    if (entries.length === 0) {
      return this.getByRunId(runId)
    }

    const { clause, values } = buildSetClause(entries)
    execute(this.db, `UPDATE runs SET ${clause} WHERE run_id = ?`, ...values, runId)
    return this.getByRunId(runId)
  }

  updateStatus(runId: string, status: string, updatedAt: string): HrcRunRecord | null {
    return this.update(runId, { status, updatedAt })
  }

  markCompleted(
    runId: string,
    updates: {
      status: string
      completedAt: string
      updatedAt: string
      errorCode?: HrcErrorCodeValue | undefined
      errorMessage?: string | undefined
    }
  ): HrcRunRecord | null {
    execute(
      this.db,
      `
        UPDATE runs
        SET
          status = ?,
          completed_at = ?,
          updated_at = ?,
          error_code = ?,
          error_message = ?
        WHERE run_id = ?
      `,
      updates.status,
      updates.completedAt,
      updates.updatedAt,
      updates.errorCode ?? null,
      updates.errorMessage ?? null,
      runId
    )

    return this.getByRunId(runId)
  }
}

export class LaunchRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcLaunchRecord): HrcLaunchRecord {
    execute(
      this.db,
      `
        INSERT INTO launches (
          launch_id,
          host_session_id,
          generation,
          runtime_id,
          harness,
          provider,
          launch_artifact_path,
          tmux_json,
          wrapper_pid,
          child_pid,
          harness_session_json,
          continuation_json,
          wrapper_started_at,
          child_started_at,
          exited_at,
          exit_code,
          signal,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.launchId,
      record.hostSessionId,
      record.generation,
      record.runtimeId ?? null,
      record.harness,
      record.provider,
      record.launchArtifactPath,
      serializeJson(record.tmuxJson),
      record.wrapperPid ?? null,
      record.childPid ?? null,
      serializeJson(record.harnessSessionJson),
      serializeJson(record.continuation),
      record.wrapperStartedAt ?? null,
      record.childStartedAt ?? null,
      record.exitedAt ?? null,
      record.exitCode ?? null,
      record.signal ?? null,
      record.status,
      record.createdAt,
      record.updatedAt
    )

    return requireRecord(
      this.getByLaunchId(record.launchId),
      `failed to reload launch ${record.launchId}`
    )
  }

  create(record: HrcLaunchRecord): HrcLaunchRecord {
    return this.insert(record)
  }

  getByLaunchId(launchId: string): HrcLaunchRecord | null {
    const row = this.db
      .query<LaunchRow, [string]>(
        `
          SELECT
            launch_id,
            host_session_id,
            generation,
            runtime_id,
            harness,
            provider,
            launch_artifact_path,
            tmux_json,
            wrapper_pid,
            child_pid,
            harness_session_json,
            continuation_json,
            wrapper_started_at,
            child_started_at,
            exited_at,
            exit_code,
            signal,
            status,
            created_at,
            updated_at
          FROM launches
          WHERE launch_id = ?
        `
      )
      .get(launchId)

    return row ? mapLaunchRow(row) : null
  }

  findById(launchId: string): HrcLaunchRecord | null {
    return this.getByLaunchId(launchId)
  }

  update(launchId: string, patch: LaunchUpdatePatch): HrcLaunchRecord | null {
    const entries: Array<[column: string, value: string | number | null]> = []

    if (patch.hostSessionId !== undefined) {
      entries.push(['host_session_id', patch.hostSessionId])
    }
    if (patch.generation !== undefined) {
      entries.push(['generation', patch.generation])
    }
    if (patch.runtimeId !== undefined) {
      entries.push(['runtime_id', patch.runtimeId])
    }
    if (patch.harness !== undefined) {
      entries.push(['harness', patch.harness])
    }
    if (patch.provider !== undefined) {
      entries.push(['provider', patch.provider])
    }
    if (patch.launchArtifactPath !== undefined) {
      entries.push(['launch_artifact_path', patch.launchArtifactPath])
    }
    if (patch.tmuxJson !== undefined) {
      entries.push(['tmux_json', serializeJson(patch.tmuxJson)])
    }
    if (patch.wrapperPid !== undefined) {
      entries.push(['wrapper_pid', patch.wrapperPid])
    }
    if (patch.childPid !== undefined) {
      entries.push(['child_pid', patch.childPid])
    }
    if (patch.harnessSessionJson !== undefined) {
      entries.push(['harness_session_json', serializeJson(patch.harnessSessionJson)])
    }
    if (patch.continuation !== undefined) {
      entries.push(['continuation_json', serializeJson(patch.continuation)])
    }
    if (patch.wrapperStartedAt !== undefined) {
      entries.push(['wrapper_started_at', patch.wrapperStartedAt])
    }
    if (patch.childStartedAt !== undefined) {
      entries.push(['child_started_at', patch.childStartedAt])
    }
    if (patch.exitedAt !== undefined) {
      entries.push(['exited_at', patch.exitedAt])
    }
    if (patch.exitCode !== undefined) {
      entries.push(['exit_code', patch.exitCode])
    }
    if (patch.signal !== undefined) {
      entries.push(['signal', patch.signal])
    }
    if (patch.status !== undefined) {
      entries.push(['status', patch.status])
    }
    if (patch.createdAt !== undefined) {
      entries.push(['created_at', patch.createdAt])
    }
    if (patch.updatedAt !== undefined) {
      entries.push(['updated_at', patch.updatedAt])
    }

    if (entries.length === 0) {
      return this.getByLaunchId(launchId)
    }

    const { clause, values } = buildSetClause(entries)
    execute(this.db, `UPDATE launches SET ${clause} WHERE launch_id = ?`, ...values, launchId)
    return this.getByLaunchId(launchId)
  }

  updateWrapperStarted(
    launchId: string,
    updates: {
      wrapperPid?: number | undefined
      wrapperStartedAt: string
      updatedAt: string
    }
  ): HrcLaunchRecord | null {
    return this.update(launchId, {
      ...(updates.wrapperPid !== undefined ? { wrapperPid: updates.wrapperPid } : {}),
      wrapperStartedAt: updates.wrapperStartedAt,
      updatedAt: updates.updatedAt,
    })
  }

  updateChildStarted(
    launchId: string,
    updates: {
      childPid?: number | undefined
      childStartedAt: string
      updatedAt: string
    }
  ): HrcLaunchRecord | null {
    return this.update(launchId, {
      ...(updates.childPid !== undefined ? { childPid: updates.childPid } : {}),
      childStartedAt: updates.childStartedAt,
      updatedAt: updates.updatedAt,
    })
  }

  updateExited(
    launchId: string,
    updates: {
      exitedAt: string
      updatedAt: string
      status: string
      exitCode?: number | undefined
      signal?: string | undefined
    }
  ): HrcLaunchRecord | null {
    execute(
      this.db,
      `
        UPDATE launches
        SET
          exited_at = ?,
          updated_at = ?,
          status = ?,
          exit_code = ?,
          signal = ?
        WHERE launch_id = ?
      `,
      updates.exitedAt,
      updates.updatedAt,
      updates.status,
      updates.exitCode ?? null,
      updates.signal ?? null,
      launchId
    )

    return this.getByLaunchId(launchId)
  }
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  append(event: Omit<HrcEventEnvelope, 'seq'>): HrcEventEnvelope {
    execute(
      this.db,
      `
        INSERT INTO events (
          ts,
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          run_id,
          runtime_id,
          source,
          event_kind,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      event.ts,
      event.hostSessionId,
      event.scopeRef,
      event.laneRef,
      event.generation,
      event.runId ?? null,
      event.runtimeId ?? null,
      event.source,
      event.eventKind,
      JSON.stringify(event.eventJson)
    )

    const inserted = this.db.query<{ seq: number }, []>('SELECT last_insert_rowid() AS seq').get()

    if (!inserted) {
      throw new Error('failed to read inserted event sequence')
    }

    const stored = this.db
      .query<EventRow, [number]>(
        `
          SELECT
            seq,
            ts,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            run_id,
            runtime_id,
            source,
            event_kind,
            event_json
          FROM events
          WHERE seq = ?
        `
      )
      .get(inserted.seq)

    if (!stored) {
      throw new Error(`failed to reload event ${inserted.seq}`)
    }

    return mapEventRow(stored)
  }

  listFromSeq(fromSeq = 1, filters: Omit<EventQueryFilters, 'fromSeq'> = {}): HrcEventEnvelope[] {
    const where: string[] = ['seq >= ?']
    const values: Array<string | number> = [fromSeq]

    if (filters.hostSessionId !== undefined) {
      where.push('host_session_id = ?')
      values.push(filters.hostSessionId)
    }
    if (filters.runtimeId !== undefined) {
      where.push('runtime_id = ?')
      values.push(filters.runtimeId)
    }
    if (filters.runId !== undefined) {
      where.push('run_id = ?')
      values.push(filters.runId)
    }

    const limitClause = filters.limit !== undefined ? ' LIMIT ?' : ''
    if (filters.limit !== undefined) {
      values.push(filters.limit)
    }

    const rows = this.db
      .query<EventRow, Array<string | number>>(
        `
          SELECT
            seq,
            ts,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            run_id,
            runtime_id,
            source,
            event_kind,
            event_json
          FROM events
          WHERE ${where.join(' AND ')}
          ORDER BY seq ASC${limitClause}
        `
      )
      .all(...values)

    return rows.map(mapEventRow)
  }

  query(filters: EventQueryFilters = {}): HrcEventEnvelope[] {
    return this.listFromSeq(filters.fromSeq ?? 1, filters)
  }

  count(filters: Omit<EventQueryFilters, 'limit'> = {}): number {
    const where: string[] = []
    const values: Array<string | number> = []

    if (filters.fromSeq !== undefined) {
      where.push('seq >= ?')
      values.push(filters.fromSeq)
    }
    if (filters.hostSessionId !== undefined) {
      where.push('host_session_id = ?')
      values.push(filters.hostSessionId)
    }
    if (filters.runtimeId !== undefined) {
      where.push('runtime_id = ?')
      values.push(filters.runtimeId)
    }
    if (filters.runId !== undefined) {
      where.push('run_id = ?')
      values.push(filters.runId)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const row = this.db
      .query<{ count: number }, Array<string | number>>(
        `SELECT COUNT(*) AS count FROM events ${whereClause}`
      )
      .get(...values)

    return row?.count ?? 0
  }
}

export class RuntimeBufferRepository {
  constructor(private readonly db: Database) {}

  append(entry: HrcRuntimeBufferRecord): HrcRuntimeBufferRecord {
    execute(
      this.db,
      `
        INSERT INTO runtime_buffers (
          runtime_id,
          chunk_seq,
          text,
          created_at
        ) VALUES (?, ?, ?, ?)
      `,
      entry.runtimeId,
      entry.chunkSeq,
      entry.text,
      entry.createdAt
    )

    const row = this.db
      .query<RuntimeBufferRow, [string, number]>(
        `
          SELECT runtime_id, chunk_seq, text, created_at
          FROM runtime_buffers
          WHERE runtime_id = ? AND chunk_seq = ?
        `
      )
      .get(entry.runtimeId, entry.chunkSeq)

    if (!row) {
      throw new Error(
        `failed to reload runtime buffer chunk ${entry.chunkSeq} for ${entry.runtimeId}`
      )
    }

    return mapRuntimeBufferRow(row)
  }

  listByRuntimeId(runtimeId: string): HrcRuntimeBufferRecord[] {
    const rows = this.db
      .query<RuntimeBufferRow, [string]>(
        `
          SELECT runtime_id, chunk_seq, text, created_at
          FROM runtime_buffers
          WHERE runtime_id = ?
          ORDER BY chunk_seq ASC
        `
      )
      .all(runtimeId)

    return rows.map(mapRuntimeBufferRow)
  }

  queryByRuntime(runtimeId: string): HrcRuntimeBufferRecord[] {
    return this.listByRuntimeId(runtimeId)
  }
}

export type { LaunchUpdatePatch, RunUpdatePatch, RuntimeUpdatePatch, SessionListFilters }
