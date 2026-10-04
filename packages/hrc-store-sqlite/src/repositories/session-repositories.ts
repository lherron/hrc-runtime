import type { Database } from 'bun:sqlite'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { endianness } from 'node:os'
import type {
  HrcContinuationRef,
  HrcContinuityRecord,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import { deriveSessionIdentity, readSessionIdentity } from '../session-identity.js'
import type { ContinuityChainRow, ContinuityRow, SessionRow } from './rows.js'
import {
  type ContinuityUpsertInput,
  SESSION_COLUMNS,
  type SessionListFilters,
  execute,
  mapSessionRow,
  requireRecord,
  serializeJson,
} from './shared.js'

type SessionWriteTimingContext = {
  transport: 'headless' | 'interactive' | 'preview'
  runtimeId: string
  boundMs?: number | undefined
  logger: {
    info(message: string, fields: Record<string, unknown>): void
    warn(message: string, fields: Record<string, unknown>): void
  }
}

type WalObservation = {
  bytes: number
  checkpointSequence?: number | undefined
  maxFrame?: number | undefined
  backfilledFrames?: number | undefined
  backfillAttemptedFrames?: number | undefined
}

function readWalObservation(db: Database): WalObservation {
  const walPath = `${db.filename}-wal`
  const shmPath = `${db.filename}-shm`
  const observation: WalObservation = { bytes: 0 }
  let fd: number | undefined
  try {
    observation.bytes = statSync(walPath).size
    if (observation.bytes >= 16) {
      fd = openSync(walPath, 'r')
      const header = Buffer.alloc(16)
      if (readSync(fd, header, 0, header.length, 0) === header.length) {
        observation.checkpointSequence = header.readUInt32BE(12)
      }
      closeSync(fd)
      fd = undefined
    }

    fd = openSync(shmPath, 'r')
    const walIndex = Buffer.alloc(132)
    if (readSync(fd, walIndex, 0, walIndex.length, 0) === walIndex.length) {
      const readUint32 = (offset: number) =>
        endianness() === 'LE' ? walIndex.readUInt32LE(offset) : walIndex.readUInt32BE(offset)
      observation.maxFrame = readUint32(16)
      observation.backfilledFrames = readUint32(96)
      observation.backfillAttemptedFrames = readUint32(128)
    }
  } catch {
    // Sidecars can disappear between stat/open when another connection checkpoints.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return observation
}

function readSynchronous(db: Database): number {
  try {
    const row = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
    return row?.synchronous ?? -1
  } catch {
    return -1
  }
}

function readWalAutocheckpointPages(db: Database): number {
  try {
    const row = db.query<{ wal_autocheckpoint: number }, []>('PRAGMA wal_autocheckpoint').get()
    return row?.wal_autocheckpoint ?? 0
  } catch {
    return 0
  }
}

function emitSessionTiming(
  timing: SessionWriteTimingContext,
  level: 'info' | 'warn',
  fields: Record<string, unknown>
): void {
  try {
    timing.logger[level]('broker.timing', fields)
  } catch {
    // Timing diagnostics must never alter a session write outcome.
  }
}

export class ContinuityRepository {
  constructor(private readonly db: Database) {}

  /**
   * Remove every executable continuity selection for one scope while leaving
   * its historical session rows intact. Callers that require an atomic
   * lifecycle transition must own the surrounding transaction.
   */
  disassociateScope(scopeRef: string): HrcContinuityRecord[] {
    const rows = this.db
      .query<ContinuityRow, [string]>(
        `
          SELECT scope_ref, lane_ref, active_host_session_id, updated_at
          FROM continuities
          WHERE scope_ref = ?
        `
      )
      .all(scopeRef)
    const continuities = rows.flatMap((row) => {
      const continuity = this.getByKey(row.scope_ref, row.lane_ref)
      return continuity === null ? [] : [continuity]
    })
    if (continuities.length === 0) return continuities

    execute(this.db, 'DELETE FROM continuities WHERE scope_ref = ?', scopeRef)
    return continuities
  }

  upsert(record: ContinuityUpsertInput): HrcContinuityRecord {
    const identity =
      readSessionIdentity(this.db, record.scopeRef, record.laneRef) ??
      deriveSessionIdentity(record.scopeRef)
    execute(
      this.db,
      `
        INSERT INTO continuities (
          scope_ref,
          lane_ref,
          active_host_session_id,
          updated_at, scope_kind, agent_id, project_id, task_id, role_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          active_host_session_id = excluded.active_host_session_id,
          updated_at = excluded.updated_at
      `,
      record.scopeRef,
      record.laneRef,
      record.activeHostSessionId,
      record.updatedAt,
      identity.kind,
      identity.agentId,
      identity.projectId ?? null,
      identity.taskId ?? null,
      identity.roleName ?? null
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
      sessionRef: `${row.scope_ref}/lane:${row.lane_ref.replace(/^lane:/, '')}`,
      scopeRef: row.scope_ref,
      laneRef: row.lane_ref,
      identity: readSessionIdentity(this.db, row.scope_ref, row.lane_ref)!,
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

  private decorate(record: HrcSessionRecord): HrcSessionRecord {
    const identity = readSessionIdentity(this.db, record.scopeRef, record.laneRef)
    return { ...record, laneRef: record.laneRef, ...(identity ? { identity } : {}) }
  }

  count(): number {
    const row = this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM sessions').get()
    return row?.count ?? 0
  }

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
          last_applied_intent_json,
          continuation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.hostSessionId,
      record.scopeRef,
      record.laneRef,
      record.generation,
      record.status,
      record.priorHostSessionId ?? null,
      record.createdAt,
      record.updatedAt,
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

    return row ? this.decorate(mapSessionRow(row)) : null
  }

  listByScopeRef(scopeRef: string, laneRef?: string | undefined): HrcSessionRecord[] {
    return this.listByFilters({ scopeRef, laneRef })
  }

  updateStatus(
    hostSessionId: string,
    status: HrcSessionRecord['status'],
    updatedAt: string
  ): HrcSessionRecord | null {
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
    updatedAt: string,
    timing?: SessionWriteTimingContext | undefined
  ): HrcSessionRecord | null {
    const update = () => {
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

    if (!timing) return update()

    const phase = 'precompile-update-intent'
    const startedAt = performance.now()
    const walBefore = readWalObservation(this.db)
    const synchronous = readSynchronous(this.db)
    const walAutocheckpointPages = readWalAutocheckpointPages(this.db)
    let boundWarningEmitted = false
    let boundTimer: ReturnType<typeof setTimeout> | undefined
    if (timing.boundMs !== undefined) {
      boundTimer = setTimeout(() => {
        boundWarningEmitted = true
        emitSessionTiming(timing, 'warn', {
          phase,
          transport: timing.transport,
          runtimeId: timing.runtimeId,
          boundMs: timing.boundMs,
          durMs: performance.now() - startedAt,
        })
      }, timing.boundMs)
    }

    try {
      return update()
    } finally {
      if (boundTimer !== undefined) clearTimeout(boundTimer)
      const durMs = performance.now() - startedAt
      if (!boundWarningEmitted && timing.boundMs !== undefined && durMs >= timing.boundMs) {
        emitSessionTiming(timing, 'warn', {
          phase,
          transport: timing.transport,
          runtimeId: timing.runtimeId,
          boundMs: timing.boundMs,
          durMs,
        })
      }

      const walAfter = readWalObservation(this.db)
      const checkpointRestarted =
        walBefore.checkpointSequence !== undefined &&
        walAfter.checkpointSequence !== undefined &&
        walBefore.checkpointSequence !== walAfter.checkpointSequence
      const checkpointTruncated = walAfter.bytes < walBefore.bytes
      const walFramesChanged =
        walAfter.maxFrame !== undefined && walAfter.maxFrame !== walBefore.maxFrame
      const passiveAutocheckpointRan =
        walFramesChanged &&
        walAutocheckpointPages > 0 &&
        walAfter.maxFrame !== undefined &&
        walAfter.maxFrame >= walAutocheckpointPages
      const checkpointProgressed =
        (walAfter.backfilledFrames ?? 0) > (walBefore.backfilledFrames ?? 0) ||
        (walAfter.backfillAttemptedFrames ?? 0) > (walBefore.backfillAttemptedFrames ?? 0)
      const checkpointRan =
        passiveAutocheckpointRan ||
        checkpointProgressed ||
        checkpointRestarted ||
        checkpointTruncated
      const checkpointMode = passiveAutocheckpointRan
        ? 'passive'
        : checkpointTruncated
          ? 'truncate'
          : checkpointRestarted
            ? 'restart'
            : checkpointProgressed
              ? 'unknown'
              : 'none'
      emitSessionTiming(timing, 'info', {
        phase,
        transport: timing.transport,
        runtimeId: timing.runtimeId,
        durMs,
        walBytesBefore: walBefore.bytes,
        walBytesAfter: walAfter.bytes,
        checkpointRan,
        checkpointMode,
        synchronous,
      })
    }
  }

  updateContinuation(
    hostSessionId: string,
    continuation: HrcContinuationRef,
    updatedAt: string
  ): HrcSessionRecord | null {
    execute(
      this.db,
      `
        UPDATE sessions
        SET continuation_json = ?, continuation_reuse_disabled = 0, updated_at = ?
        WHERE host_session_id = ?
      `,
      serializeJson(continuation),
      updatedAt,
      hostSessionId
    )

    return this.getByHostSessionId(hostSessionId)
  }

  setContinuationReuseDisabled(
    hostSessionId: string,
    disabled: boolean,
    updatedAt: string
  ): HrcSessionRecord | null {
    execute(
      this.db,
      `
        UPDATE sessions
        SET continuation_reuse_disabled = ?, updated_at = ?
        WHERE host_session_id = ?
      `,
      disabled ? 1 : 0,
      updatedAt,
      hostSessionId
    )

    return this.getByHostSessionId(hostSessionId)
  }

  isContinuationReuseDisabled(hostSessionId: string): boolean {
    const row = this.db
      .query<{ continuation_reuse_disabled: number }, [string]>(
        `SELECT continuation_reuse_disabled
           FROM sessions
          WHERE host_session_id = ?`
      )
      .get(hostSessionId)

    return row?.continuation_reuse_disabled === 1
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

      return rows.map((row) => this.decorate(mapSessionRow(row)))
    }

    const rows = this.db
      .query<SessionRow, [string]>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE scope_ref = ?
          ORDER BY lane_ref ASC, generation ASC`
      )
      .all(filters.scopeRef)

    return rows.map((row) => this.decorate(mapSessionRow(row)))
  }
}
