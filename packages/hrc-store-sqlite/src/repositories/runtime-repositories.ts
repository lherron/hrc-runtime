import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { HrcConflictError } from 'hrc-core'
import type {
  HrcErrorCode,
  HrcLaunchRecord,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  RuntimePruneDeleteCounts,
} from 'hrc-core'
import type { LaunchRow, RunRow, RuntimeRow } from './rows.js'
import {
  LAUNCH_COLUMNS,
  type LaunchUpdatePatch,
  type PatchEntrySpec,
  RUNTIME_COLUMNS,
  RUN_COLUMNS,
  type RunListFilters,
  type RunUpdatePatch,
  type RuntimeUpdatePatch,
  buildRunWhere,
  buildSetClause,
  collectPatchEntries,
  execute,
  mapLaunchRow,
  mapRunRow,
  mapRuntimeRow,
  requireRecord,
  serializeJson,
  toSqliteBoolean,
} from './shared.js'

const RUNTIME_UPDATE_SPEC: ReadonlyArray<PatchEntrySpec<RuntimeUpdatePatch>> = [
  { key: 'hostSessionId', column: 'host_session_id' },
  { key: 'runtimeKind', column: 'runtime_kind' },
  { key: 'scopeRef', column: 'scope_ref' },
  { key: 'laneRef', column: 'lane_ref' },
  { key: 'generation', column: 'generation' },
  { key: 'launchId', column: 'launch_id' },
  { key: 'transport', column: 'transport' },
  { key: 'harness', column: 'harness' },
  { key: 'provider', column: 'provider' },
  { key: 'status', column: 'status' },
  { key: 'statusChangedAt', column: 'status_changed_at' },
  { key: 'tmuxJson', column: 'tmux_json', transform: (v) => serializeJson(v) },
  { key: 'surfaceJson', column: 'surface_json', transform: (v) => serializeJson(v) },
  { key: 'wrapperPid', column: 'wrapper_pid' },
  { key: 'childPid', column: 'child_pid' },
  {
    key: 'harnessSessionJson',
    column: 'harness_session_json',
    transform: (v) => serializeJson(v),
  },
  { key: 'commandSpec', column: 'command_spec_json', transform: (v) => serializeJson(v) },
  { key: 'continuation', column: 'continuation_json', transform: (v) => serializeJson(v) },
  {
    key: 'supportsInflightInput',
    column: 'supports_inflight_input',
    transform: (v) => toSqliteBoolean(v as boolean),
  },
  { key: 'adopted', column: 'adopted', transform: (v) => toSqliteBoolean(v as boolean) },
  { key: 'activeRunId', column: 'active_run_id' },
  { key: 'lastActivityAt', column: 'last_activity_at' },
  { key: 'controllerKind', column: 'controller_kind' },
  { key: 'activeOperationId', column: 'active_operation_id' },
  { key: 'activeInvocationId', column: 'active_invocation_id' },
  { key: 'compileId', column: 'compile_id' },
  { key: 'planHash', column: 'plan_hash' },
  { key: 'selectedProfileHash', column: 'selected_profile_hash' },
  { key: 'runtimeStateJson', column: 'runtime_state_json', transform: (v) => serializeJson(v) },
  { key: 'lifecyclePolicyHash', column: 'lifecycle_policy_hash' },
  { key: 'currentHarnessGeneration', column: 'current_harness_generation' },
  { key: 'currentTurnAttempt', column: 'current_turn_attempt' },
  { key: 'lifecycleTerminalReason', column: 'lifecycle_terminal_reason' },
  { key: 'lastLifecycleEscalationJson', column: 'last_lifecycle_escalation_json' },
  { key: 'presentation', column: 'presentation_json', transform: (v) => serializeJson(v) },
  { key: 'createdAt', column: 'created_at' },
  { key: 'updatedAt', column: 'updated_at' },
]

/**
 * T-08576 D5 (rev 8): run ids are one database-wide namespace, and a runtime or
 * steer contribution that names a run as active is a mutation handle every
 * finalizer trusts. An app birth reserves its run id; the run's authority is
 * then the exact tuple {runId, runtimeId, operationId, hostSessionId,
 * generation}. Before the run is sealed (its row bound to a runtime) only the
 * reservation token may establish that tuple; afterwards the persisted row is
 * the authority. Host-session equality alone is never authority.
 */
export class RunIdReservedError extends HrcConflictError {
  constructor(runId: string) {
    super('run_mismatch', `run id "${runId}" is reserved by another app session birth`, {
      reason: 'run-id-reserved',
      runId,
    })
    this.name = 'RunIdReservedError'
  }
}

export class RunIdOwnershipError extends HrcConflictError {
  constructor(runId: string, refusal: string) {
    super('run_mismatch', `run id "${runId}" is not owned by this writer`, {
      reason: 'run-id-not-owned',
      runId,
      refusal,
    })
    this.name = 'RunIdOwnershipError'
  }
}

export type RunIdReservationOutcome = 'reserved' | 'exists' | 'reserved-by-other'

/** The writer tuple a run-id handle write would establish. */
export type RunHandleWriter = {
  runtimeId?: string | undefined
  operationId?: string | undefined
  hostSessionId: string
  generation: number
}

type RunIdReservation = {
  token: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  operationId?: string | undefined
}

type RunTupleRow = {
  host_session_id: string
  generation: number
  runtime_id: string | null
  operation_id: string | null
  scope_ref: string
}

export class RunIdOwnershipRegistry {
  readonly #reservations = new Map<string, RunIdReservation>()
  #tokenReader: (runId: string) => string | undefined = () => undefined

  constructor(private readonly db: Database) {}

  /**
   * Installs the carrier of the holder's reservation token. The daemon supplies
   * one that answers only inside the owner context holding a grant for exactly
   * that run id; the tuple checks below still bind whatever it returns.
   */
  setReservationTokenReader(reader: (runId: string) => string | undefined): void {
    this.#tokenReader = reader
  }

  reserveRunId(
    runId: string,
    token: string,
    hostSessionId: string,
    generation: number
  ): RunIdReservationOutcome {
    const held = this.#reservations.get(runId)
    if (held !== undefined) return held.token === token ? 'reserved' : 'reserved-by-other'
    if (this.#handleExists(runId)) return 'exists'
    this.#reservations.set(runId, { token, hostSessionId, generation })
    return 'reserved'
  }

  releaseRunId(runId: string, token: string): void {
    if (this.#reservations.get(runId)?.token === token) this.#reservations.delete(runId)
  }

  reservationFor(runId: string): string | undefined {
    return this.#reservations.get(runId)?.token
  }

  /** True when a reservation, run row or run-id handle already names the id. */
  isNamed(runId: string): boolean {
    return this.#reservations.has(runId) || this.#handleExists(runId)
  }

  /** Guard for creating a run row; unreserved ids insert exactly as before. */
  assertCanCreateRun(runId: string, writer: RunHandleWriter): void {
    const reservation = this.#reservations.get(runId)
    if (reservation === undefined) return
    const refusal = this.#tokenRefusal(reservation, writer, this.#tokenReader(runId))
    if (refusal === 'no-token') throw new RunIdReservedError(runId)
    if (refusal !== undefined) throw new RunIdOwnershipError(runId, refusal)
    this.#bind(reservation, writer)
  }

  /** Guard for a runtime or contribution naming `runId` as its active run. */
  assertCanNameActiveRun(runId: string | undefined, writer: RunHandleWriter): void {
    if (runId === undefined) return
    const refusal = this.#handleRefusal(runId, writer, this.#tokenReader(runId))
    if (refusal === 'no-token') throw new RunIdReservedError(runId)
    if (refusal !== undefined) throw new RunIdOwnershipError(runId, refusal)
  }

  /** Steer contributions carry no runtime or operation tuple: never for app runs. */
  assertContributionMayNameRun(runId: string): void {
    if (this.#reservations.has(runId)) throw new RunIdReservedError(runId)
    if (this.#row(runId)?.scope_ref.startsWith('app:') === true) {
      throw new RunIdOwnershipError(runId, 'contribution-cannot-name-app-run')
    }
  }

  /**
   * Token-free projection predicate (clauses B/C). Broker event projection is
   * never inside the issuing context, so it may only follow the persisted row.
   */
  mayNameActiveRun(runId: string, writer: RunHandleWriter): boolean {
    return this.#handleRefusal(runId, writer, undefined) === undefined
  }

  /** Write-once binding columns of a reserved or app run (runs.update, claimQueued). */
  assertRunBindingUpdate(
    runId: string,
    patch: {
      runtimeId?: string | undefined
      operationId?: string | undefined
      hostSessionId?: string | undefined
      generation?: number | undefined
    }
  ): void {
    if (
      patch.runtimeId === undefined &&
      patch.operationId === undefined &&
      patch.hostSessionId === undefined &&
      patch.generation === undefined
    ) {
      return
    }
    const reservation = this.#reservations.get(runId)
    const row = this.#row(runId)
    if (row === null) return
    if (reservation === undefined && !row.scope_ref.startsWith('app:')) return
    if (patch.hostSessionId !== undefined && patch.hostSessionId !== row.host_session_id) {
      throw new RunIdOwnershipError(runId, 'host-session-immutable')
    }
    if (patch.generation !== undefined && patch.generation !== row.generation) {
      throw new RunIdOwnershipError(runId, 'generation-immutable')
    }
    if (
      patch.operationId !== undefined &&
      row.operation_id !== null &&
      patch.operationId !== row.operation_id
    ) {
      throw new RunIdOwnershipError(runId, 'operation-immutable')
    }
    if (
      patch.runtimeId !== undefined &&
      row.runtime_id !== null &&
      patch.runtimeId !== row.runtime_id
    ) {
      throw new RunIdOwnershipError(runId, 'runtime-immutable')
    }
    const runtimeFill = patch.runtimeId !== undefined && row.runtime_id === null
    const operationFill = patch.operationId !== undefined && row.operation_id === null
    if (!runtimeFill && !operationFill) return
    // Every first binding of a tuple column is clause (A): only the holder's
    // live token, for the reserved tuple. Once sealed the token is unobtainable,
    // so a late first binding is refused too.
    if (reservation === undefined) {
      throw new RunIdOwnershipError(runId, 'unbound-without-reservation')
    }
    const writer: RunHandleWriter = {
      runtimeId: patch.runtimeId ?? row.runtime_id ?? undefined,
      operationId: patch.operationId ?? row.operation_id ?? undefined,
      hostSessionId: row.host_session_id,
      generation: row.generation,
    }
    const refusal = this.#tokenRefusal(reservation, writer, this.#tokenReader(runId))
    if (refusal === 'no-token') throw new RunIdReservedError(runId)
    if (refusal !== undefined) throw new RunIdOwnershipError(runId, refusal)
    this.#bind(reservation, writer)
  }

  #handleRefusal(
    runId: string,
    writer: RunHandleWriter,
    token: string | undefined
  ): string | undefined {
    const reservation = this.#reservations.get(runId)
    const row = this.#row(runId)
    // (C) neither reserved nor an app run: unchanged.
    if (reservation === undefined && (row === null || !row.scope_ref.startsWith('app:'))) {
      return undefined
    }
    const sealed = row !== null && row.runtime_id !== null
    if (!sealed) {
      // (A) token, unsealed only.
      if (reservation === undefined) return 'unbound-without-reservation'
      const refusal = this.#tokenRefusal(reservation, writer, token)
      if (refusal === undefined) this.#bind(reservation, writer)
      return refusal
    }
    // (B) exact persisted tuple.
    if (writer.runtimeId !== row.runtime_id) return 'runtime-mismatch'
    if (writer.hostSessionId !== row.host_session_id) return 'host-session-mismatch'
    if (writer.generation !== row.generation) return 'generation-mismatch'
    if (row.operation_id !== null && writer.operationId !== row.operation_id) {
      return 'operation-mismatch'
    }
    return undefined
  }

  #tokenRefusal(
    reservation: RunIdReservation,
    writer: RunHandleWriter,
    token: string | undefined
  ): string | undefined {
    if (token !== reservation.token) return 'no-token'
    if (writer.hostSessionId !== reservation.hostSessionId) return 'host-session-mismatch'
    if (writer.generation !== reservation.generation) return 'generation-mismatch'
    if (reservation.runtimeId !== undefined && writer.runtimeId !== reservation.runtimeId) {
      return 'runtime-mismatch'
    }
    if (
      reservation.operationId !== undefined &&
      writer.operationId !== undefined &&
      writer.operationId !== reservation.operationId
    ) {
      return 'operation-mismatch'
    }
    return undefined
  }

  #bind(reservation: RunIdReservation, writer: RunHandleWriter): void {
    if (reservation.runtimeId === undefined && writer.runtimeId !== undefined) {
      reservation.runtimeId = writer.runtimeId
    }
    if (reservation.operationId === undefined && writer.operationId !== undefined) {
      reservation.operationId = writer.operationId
    }
  }

  #row(runId: string): RunTupleRow | null {
    return this.db
      .query<RunTupleRow, [string]>(
        'SELECT host_session_id, generation, runtime_id, operation_id, scope_ref FROM runs WHERE run_id = ?'
      )
      .get(runId)
  }

  #handleExists(runId: string): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string, string]>(
          `SELECT EXISTS (SELECT 1 FROM runs WHERE run_id = ?)
               OR EXISTS (SELECT 1 FROM runtimes WHERE active_run_id = ?)
               OR EXISTS (SELECT 1 FROM steer_contributions WHERE active_run_id = ?) AS found`
        )
        .get(runId, runId, runId)?.found === 1
    )
  }
}

export class RuntimeRepository {
  constructor(
    private readonly db: Database,
    private readonly runIdOwnership: RunIdOwnershipRegistry = new RunIdOwnershipRegistry(db)
  ) {}

  count(): number {
    const row = this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtimes').get()
    return row?.count ?? 0
  }

  insert(record: HrcRuntimeSnapshot): HrcRuntimeSnapshot {
    this.runIdOwnership.assertCanNameActiveRun(record.activeRunId, {
      runtimeId: record.runtimeId,
      operationId: record.activeOperationId,
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    })
    execute(
      this.db,
      `
        INSERT INTO runtimes (
          runtime_id,
          runtime_kind,
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          launch_id,
          transport,
          harness,
          provider,
          status,
          status_changed_at,
          tmux_json,
          surface_json,
          wrapper_pid,
          child_pid,
          harness_session_json,
          command_spec_json,
          continuation_json,
          supports_inflight_input,
          adopted,
          active_run_id,
          last_activity_at,
          controller_kind,
          active_operation_id,
          active_invocation_id,
          compile_id,
          plan_hash,
          selected_profile_hash,
          runtime_state_json,
          lifecycle_policy_hash,
          current_harness_generation,
          current_turn_attempt,
          lifecycle_terminal_reason,
          last_lifecycle_escalation_json,
          presentation_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.runtimeId,
      record.runtimeKind ?? 'harness',
      record.hostSessionId,
      record.scopeRef,
      record.laneRef,
      record.generation,
      record.launchId ?? null,
      record.transport,
      record.harness,
      record.provider,
      record.status,
      record.statusChangedAt && record.statusChangedAt !== 'unknown'
        ? record.statusChangedAt
        : null,
      serializeJson(record.tmuxJson),
      serializeJson(record.surfaceJson),
      record.wrapperPid ?? null,
      record.childPid ?? null,
      serializeJson(record.harnessSessionJson),
      serializeJson(record.commandSpec),
      serializeJson(record.continuation),
      toSqliteBoolean(record.supportsInflightInput),
      toSqliteBoolean(record.adopted),
      record.activeRunId ?? null,
      record.lastActivityAt ?? null,
      record.controllerKind ?? null,
      record.activeOperationId ?? null,
      record.activeInvocationId ?? null,
      record.compileId ?? null,
      record.planHash ?? null,
      record.selectedProfileHash ?? null,
      serializeJson(record.runtimeStateJson),
      record.lifecyclePolicyHash ?? null,
      record.currentHarnessGeneration ?? null,
      record.currentTurnAttempt ?? null,
      record.lifecycleTerminalReason ?? null,
      record.lastLifecycleEscalationJson ?? null,
      serializeJson(record.presentation),
      record.createdAt,
      record.updatedAt
    )

    return requireRecord(
      this.getByRuntimeId(record.runtimeId),
      `failed to reload runtime ${record.runtimeId}`
    )
  }

  getByRuntimeId(runtimeId: string): HrcRuntimeSnapshot | null {
    const row = this.db
      .query<RuntimeRow, [string]>(`SELECT ${RUNTIME_COLUMNS} FROM runtimes WHERE runtime_id = ?`)
      .get(runtimeId)

    return row ? mapRuntimeRow(row) : null
  }

  getLatestByHostSessionId(hostSessionId: string): HrcRuntimeSnapshot | null {
    const row = this.db
      .query<RuntimeRow, [string]>(
        `SELECT ${RUNTIME_COLUMNS} FROM runtimes
          WHERE host_session_id = ?
          ORDER BY created_at DESC, runtime_id DESC
          LIMIT 1`
      )
      .get(hostSessionId)

    return row ? mapRuntimeRow(row) : null
  }

  listByHostSessionId(hostSessionId: string): HrcRuntimeSnapshot[] {
    const rows = this.db
      .query<RuntimeRow, [string]>(
        `SELECT ${RUNTIME_COLUMNS} FROM runtimes
          WHERE host_session_id = ?
          ORDER BY created_at ASC, runtime_id ASC`
      )
      .all(hostSessionId)

    return rows.map(mapRuntimeRow)
  }

  /**
   * The scopes this node is currently seating, as `<scopeRef>/lane:<laneRef>`.
   *
   * "Live" is deliberately the narrow set — a stale or terminated runtime is a
   * historical row, not a seat. This bounds the wrkq kicker's periodic sweep to
   * scopes something can actually be presented into; the ledger tail, which
   * resumes from a persisted cursor, is what discovers the rest.
   */
  listLiveSessionRefs(): string[] {
    return this.db
      .query<{ session_ref: string }, []>(
        `SELECT DISTINCT scope_ref || '/lane:' || lane_ref AS session_ref
           FROM runtimes
          WHERE status IN ('starting', 'ready', 'busy', 'awaiting_input', 'stopping')
            AND scope_ref LIKE 'agent:%'
          ORDER BY session_ref ASC`
      )
      .all()
      .map((row) => row.session_ref)
  }

  /**
   * T-08363 — the runtimes table is a ledger, not a live set: on a long-lived
   * host it is >99% terminal rows (13,741 rows for 58 live seats when this was
   * written, 2.7MB of `*_json` columns per full read). Recurring timers that
   * only care about live seats used to call `listAll()` and drop the rest in JS,
   * paying the full row materialization every tick. These push the predicate
   * into SQL instead.
   *
   * `listAvailable` is an EXCLUSION, deliberately mirroring
   * `isRuntimeUnavailableStatus` (+ `exited`) rather than listing live statuses:
   * a status added later must default to "still shown", which is what the JS
   * filter it replaces did. An inclusion list would silently start hiding seats.
   */
  listAvailable(): HrcRuntimeSnapshot[] {
    return this.db
      .query<RuntimeRow, []>(
        `SELECT ${RUNTIME_COLUMNS} FROM runtimes
          WHERE status NOT IN ('terminated', 'dead', 'stale', 'crashed', 'detached', 'exited')
          ORDER BY created_at ASC, runtime_id ASC`
      )
      .all()
      .map(mapRuntimeRow)
  }

  listByStatus(statuses: readonly string[]): HrcRuntimeSnapshot[] {
    if (statuses.length === 0) return []
    const placeholders = statuses.map(() => '?').join(', ')
    return this.db
      .query<RuntimeRow, string[]>(
        `SELECT ${RUNTIME_COLUMNS} FROM runtimes
          WHERE status IN (${placeholders})
          ORDER BY created_at ASC, runtime_id ASC`
      )
      .all(...(statuses as string[]))
      .map(mapRuntimeRow)
  }

  /**
   * The whole ledger, terminal rows included. Correct for the sweep/prune paths,
   * whose entire job is stale and terminated rows. Recurring liveness timers
   * want `listAvailable()` / `listByStatus()`.
   */
  listAll(): HrcRuntimeSnapshot[] {
    const rows = this.db
      .query<RuntimeRow, []>(
        `SELECT ${RUNTIME_COLUMNS} FROM runtimes
          ORDER BY created_at ASC, runtime_id ASC`
      )
      .all()

    return rows.map(mapRuntimeRow)
  }

  update(runtimeId: string, patch: RuntimeUpdatePatch): HrcRuntimeSnapshot | null {
    const current = this.getByRuntimeId(runtimeId)
    if (current !== null && typeof patch.activeRunId === 'string') {
      this.runIdOwnership.assertCanNameActiveRun(patch.activeRunId, {
        runtimeId,
        operationId: patch.activeOperationId ?? current.activeOperationId,
        hostSessionId: patch.hostSessionId ?? current.hostSessionId,
        generation: patch.generation ?? current.generation,
      })
    }
    const statusChanged = patch.status !== undefined && current?.status !== patch.status
    const guardedPatch = statusChanged
      ? patch
      : ({ ...patch, statusChangedAt: undefined } satisfies RuntimeUpdatePatch)
    const entries = collectPatchEntries(guardedPatch, RUNTIME_UPDATE_SPEC)

    if (entries.length === 0) {
      return this.getByRuntimeId(runtimeId)
    }

    const { clause, values } = buildSetClause(entries)
    execute(this.db, `UPDATE runtimes SET ${clause} WHERE runtime_id = ?`, ...values, runtimeId)
    return this.getByRuntimeId(runtimeId)
  }

  updateStatus(runtimeId: string, status: string, updatedAt: string): HrcRuntimeSnapshot | null {
    return this.update(runtimeId, { status, statusChangedAt: updatedAt, updatedAt })
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
    const current = activeRunId === undefined ? null : this.getByRuntimeId(runtimeId)
    if (current !== null) {
      this.runIdOwnership.assertCanNameActiveRun(activeRunId, {
        runtimeId,
        operationId: current.activeOperationId,
        hostSessionId: current.hostSessionId,
        generation: current.generation,
      })
    }
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

  /**
   * Hard-delete an orphaned runtime store row plus its runtime-scoped satellite
   * rows (T-05441). `runtimes(runtime_id)` is FK-referenced (no ON DELETE
   * CASCADE, `foreign_keys = ON`) by runs, launches, events, runtime_buffers,
   * surface_bindings and local_bridges, so a plain `DELETE FROM runtimes` throws
   * FK_CONSTRAINT whenever any dependent row exists — essentially always for a
   * real runtime. We clear the dependents inside a single transaction before
   * removing the runtime itself.
   *
   * Delete ORDER matters: `events` and `runtime_buffers` ALSO FK-reference
   * `runs(run_id)`, so every table that points at this runtime's runs must be
   * cleared BEFORE the runs themselves — otherwise deleting a run whose buffer
   * or event still exists trips the run-level FK. We therefore purge the
   * run-referencing tables by (runtime_id OR run_id-of-this-runtime), then the
   * remaining runtime-only tables, then runs, then the runtime.
   *
   * This mutates real rows and is NOT reversible — callers MUST enforce the
   * orphan safety gate (unavailable status, no active run, no live
   * process/tmux) before invoking it. Returns true when the runtime row was
   * removed, false when it was already absent.
   */
  countPruneRows(
    runtimeIds: readonly string[],
    options: { includeLedgers?: boolean | undefined } = {}
  ): RuntimePruneDeleteCounts {
    const selectedJson = JSON.stringify(runtimeIds)
    const count = (sql: string): number =>
      this.db.query<{ count: number }, [string]>(sql).get(selectedJson)?.count ?? 0
    const tableExists = (table: string): boolean =>
      this.db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(table)?.present === 1
    const selected = 'SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)'
    const counts: RuntimePruneDeleteCounts = {
      broker_invocation_events: 0,
      hrc_events: 0,
      broker_invocations: 0,
      runtime_operations: 0,
      runtime_first_turn_watch: 0,
      runtime_artifacts: 0,
      tool_result_blob_parts: 0,
      tool_result_blobs: 0,
      compiled_runtime_plans: 0,
      events: count(
        `WITH selected AS (${selected})
         SELECT COUNT(*) AS count FROM events
         WHERE runtime_id IN (SELECT runtime_id FROM selected)
            OR run_id IN (
              SELECT run_id FROM runs WHERE runtime_id IN (SELECT runtime_id FROM selected)
            )`
      ),
      runtime_buffers: count(
        `WITH selected AS (${selected})
         SELECT COUNT(*) AS count FROM runtime_buffers
         WHERE runtime_id IN (SELECT runtime_id FROM selected)
            OR run_id IN (
              SELECT run_id FROM runs WHERE runtime_id IN (SELECT runtime_id FROM selected)
            )`
      ),
      surface_bindings: count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM surface_bindings
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      ),
      local_bridges: count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM local_bridges
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      ),
      launches: count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM launches
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      ),
      runs: count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM runs
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      ),
      runtimes: count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM runtimes
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      ),
    }

    if (!options.includeLedgers) return counts

    counts.broker_invocation_events = count(
      `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM broker_invocation_events
       WHERE runtime_id IN (SELECT runtime_id FROM selected)`
    )
    counts.hrc_events = count(
      `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM hrc_events
       WHERE runtime_id IN (SELECT runtime_id FROM selected)`
    )
    counts.broker_invocations = count(
      `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM broker_invocations
       WHERE runtime_id IN (SELECT runtime_id FROM selected)`
    )
    counts.runtime_operations = count(
      `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM runtime_operations
       WHERE runtime_id IN (SELECT runtime_id FROM selected)`
    )
    counts.runtime_first_turn_watch = count(
      `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM runtime_first_turn_watch
       WHERE runtime_id IN (SELECT runtime_id FROM selected)`
    )
    counts.runtime_artifacts = count(
      `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM runtime_artifacts
       WHERE operation_id IN (
         SELECT operation_id FROM runtime_operations
         WHERE runtime_id IN (SELECT runtime_id FROM selected)
       )`
    )
    if (tableExists('tool_result_blob_parts')) {
      counts.tool_result_blob_parts = count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM tool_result_blob_parts
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      )
    }
    if (tableExists('tool_result_blobs')) {
      counts.tool_result_blobs = count(
        `WITH selected AS (${selected}) SELECT COUNT(*) AS count FROM tool_result_blobs
         WHERE runtime_id IN (SELECT runtime_id FROM selected)`
      )
    }
    counts.compiled_runtime_plans = count(
      `WITH selected AS MATERIALIZED (${selected}),
            candidates AS MATERIALIZED (
              SELECT plan_hash FROM runtimes
              WHERE runtime_id IN (SELECT runtime_id FROM selected) AND plan_hash IS NOT NULL
              UNION
              SELECT plan_hash FROM runtime_operations
              WHERE runtime_id IN (SELECT runtime_id FROM selected) AND plan_hash IS NOT NULL
            ),
            referenced_elsewhere AS MATERIALIZED (
              SELECT runtime.plan_hash
              FROM runtimes AS runtime
              JOIN candidates ON candidates.plan_hash = runtime.plan_hash
              LEFT JOIN selected ON selected.runtime_id = runtime.runtime_id
              WHERE selected.runtime_id IS NULL
              UNION
              SELECT operation.plan_hash
              FROM runtime_operations AS operation
              JOIN candidates ON candidates.plan_hash = operation.plan_hash
              LEFT JOIN selected ON selected.runtime_id = operation.runtime_id
              WHERE selected.runtime_id IS NULL
              UNION
              SELECT operation.plan_hash
              FROM broker_invocations AS invocation
              JOIN runtime_operations AS operation
                ON operation.operation_id = invocation.operation_id
              JOIN candidates ON candidates.plan_hash = operation.plan_hash
              LEFT JOIN selected ON selected.runtime_id = invocation.runtime_id
              WHERE selected.runtime_id IS NULL
            )
       SELECT COUNT(*) AS count
       FROM compiled_runtime_plans AS plan
       JOIN candidates ON candidates.plan_hash = plan.plan_hash
       LEFT JOIN referenced_elsewhere AS reference
         ON reference.plan_hash = plan.plan_hash
       WHERE reference.plan_hash IS NULL`
    )

    return counts
  }

  pruneRuntime(runtimeId: string, options: { includeLedgers?: boolean | undefined } = {}): boolean {
    if (options.includeLedgers) {
      return this.pruneRuntimes([runtimeId], options) === 1
    }

    const prune = this.db.transaction((id: string): boolean => {
      // Tables that FK-reference runs(run_id): clear by either edge (a row may
      // pin to this runtime's run while carrying a null/foreign runtime_id) so
      // no run-level FK survives the DELETE FROM runs below.
      const runScoped = 'runtime_id = ? OR run_id IN (SELECT run_id FROM runs WHERE runtime_id = ?)'
      execute(this.db, `DELETE FROM events WHERE ${runScoped}`, id, id)
      execute(this.db, `DELETE FROM runtime_buffers WHERE ${runScoped}`, id, id)
      // Runtime-only satellite tables.
      execute(this.db, 'DELETE FROM surface_bindings WHERE runtime_id = ?', id)
      execute(this.db, 'DELETE FROM local_bridges WHERE runtime_id = ?', id)
      execute(this.db, 'DELETE FROM launches WHERE runtime_id = ?', id)
      // Runs last among the dependents (their referencing rows are now gone).
      execute(this.db, 'DELETE FROM runs WHERE runtime_id = ?', id)
      const result = this.db.query('DELETE FROM runtimes WHERE runtime_id = ?').run(id) as {
        changes?: number
      }
      return (result.changes ?? 0) > 0
    })
    return prune(runtimeId)
  }

  /**
   * Set-based ledger-inclusive cascade for an already safety-gated manifest.
   * The JSON manifest is materialized independently by each statement so the
   * entire operation remains pure SQL inside one SQLite transaction without
   * constructing an unbounded placeholder list.
   */
  pruneRuntimes(
    runtimeIds: readonly string[],
    options: { includeLedgers?: boolean | undefined } = {}
  ): number {
    if (!options.includeLedgers) {
      let removed = 0
      const pruneAll = this.db.transaction(() => {
        for (const runtimeId of runtimeIds) {
          if (this.pruneRuntime(runtimeId)) removed += 1
        }
      })
      pruneAll()
      return removed
    }

    const selectedJson = JSON.stringify(runtimeIds)
    const selected =
      'WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?))'
    const executeSelected = (sql: string): void =>
      execute(this.db, `${selected} ${sql}`, selectedJson)
    const tableExists = (table: string): boolean =>
      this.db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(table)?.present === 1

    const pruneAll = this.db.transaction((): number => {
      const present = this.db
        .query<{ count: number }, [string]>(
          `${selected} SELECT COUNT(*) AS count FROM runtimes
           WHERE runtime_id IN (SELECT runtime_id FROM selected)`
        )
        .get(selectedJson)?.count
      if (present !== runtimeIds.length) {
        throw new Error(
          `runtime prune manifest changed before apply: expected ${runtimeIds.length}, found ${present ?? 0}`
        )
      }

      // Store invariant (T-08015): any deletion of broker_invocation_events
      // must delete its transcript projection by the same runtime key in the
      // same transaction. The FTS external-content delete trigger follows.
      executeSelected(
        'DELETE FROM transcript_turns WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )
      executeSelected(
        'DELETE FROM transcript_index_invocations WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )

      executeSelected(
        'DELETE FROM broker_invocation_events WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )
      executeSelected(
        'DELETE FROM hrc_events WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )
      executeSelected(
        `DELETE FROM runtime_artifacts
         WHERE operation_id IN (
           SELECT operation_id FROM runtime_operations
           WHERE runtime_id IN (SELECT runtime_id FROM selected)
         )`
      )
      executeSelected(
        'DELETE FROM broker_invocations WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )
      executeSelected(
        'DELETE FROM runtime_first_turn_watch WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )

      // Phase 4 creates these tables. Phase 3 must be deployable before that
      // migration, so each delete is guarded by sqlite_master existence.
      if (tableExists('tool_result_blob_parts')) {
        executeSelected(
          'DELETE FROM tool_result_blob_parts WHERE runtime_id IN (SELECT runtime_id FROM selected)'
        )
      }
      if (tableExists('tool_result_blobs')) {
        executeSelected(
          'DELETE FROM tool_result_blobs WHERE runtime_id IN (SELECT runtime_id FROM selected)'
        )
      }

      execute(
        this.db,
        `WITH selected AS MATERIALIZED (
               SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)
             ),
             candidates AS MATERIALIZED (
               SELECT plan_hash FROM runtimes
               WHERE runtime_id IN (SELECT runtime_id FROM selected) AND plan_hash IS NOT NULL
               UNION
               SELECT plan_hash FROM runtime_operations
               WHERE runtime_id IN (SELECT runtime_id FROM selected) AND plan_hash IS NOT NULL
             ),
             referenced_elsewhere AS MATERIALIZED (
               SELECT runtime.plan_hash
               FROM runtimes AS runtime
               JOIN candidates ON candidates.plan_hash = runtime.plan_hash
               LEFT JOIN selected ON selected.runtime_id = runtime.runtime_id
               WHERE selected.runtime_id IS NULL
               UNION
               SELECT operation.plan_hash
               FROM runtime_operations AS operation
               JOIN candidates ON candidates.plan_hash = operation.plan_hash
               LEFT JOIN selected ON selected.runtime_id = operation.runtime_id
               WHERE selected.runtime_id IS NULL
               UNION
               SELECT operation.plan_hash
               FROM broker_invocations AS invocation
               JOIN runtime_operations AS operation
                 ON operation.operation_id = invocation.operation_id
               JOIN candidates ON candidates.plan_hash = operation.plan_hash
               LEFT JOIN selected ON selected.runtime_id = invocation.runtime_id
               WHERE selected.runtime_id IS NULL
             )
         DELETE FROM compiled_runtime_plans AS plan
         WHERE plan.plan_hash IN (SELECT plan_hash FROM candidates)
           AND plan.plan_hash NOT IN (SELECT plan_hash FROM referenced_elsewhere)`,
        selectedJson
      )
      executeSelected(
        'DELETE FROM runtime_operations WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )

      const runScoped = `runtime_id IN (SELECT runtime_id FROM selected)
        OR run_id IN (
          SELECT run_id FROM runs WHERE runtime_id IN (SELECT runtime_id FROM selected)
        )`
      executeSelected(`DELETE FROM events WHERE ${runScoped}`)
      executeSelected(`DELETE FROM runtime_buffers WHERE ${runScoped}`)
      executeSelected(
        'DELETE FROM surface_bindings WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )
      executeSelected(
        'DELETE FROM local_bridges WHERE runtime_id IN (SELECT runtime_id FROM selected)'
      )
      executeSelected('DELETE FROM launches WHERE runtime_id IN (SELECT runtime_id FROM selected)')
      executeSelected('DELETE FROM runs WHERE runtime_id IN (SELECT runtime_id FROM selected)')
      const result = this.db
        .query(
          `${selected} DELETE FROM runtimes WHERE runtime_id IN (SELECT runtime_id FROM selected)`
        )
        .run(selectedJson) as { changes?: number }
      return result.changes ?? 0
    })

    return pruneAll()
  }
}

/** Statuses that may never overwrite a run that already carries completed_at (T-07656). */
const NON_TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'accepted',
  'started',
  'running',
])

const RUN_UPDATE_SPEC: ReadonlyArray<PatchEntrySpec<RunUpdatePatch>> = [
  { key: 'hostSessionId', column: 'host_session_id' },
  { key: 'runtimeId', column: 'runtime_id' },
  { key: 'scopeRef', column: 'scope_ref' },
  { key: 'laneRef', column: 'lane_ref' },
  { key: 'generation', column: 'generation' },
  { key: 'transport', column: 'transport' },
  { key: 'status', column: 'status' },
  { key: 'acceptedAt', column: 'accepted_at' },
  { key: 'startedAt', column: 'started_at' },
  { key: 'completedAt', column: 'completed_at' },
  { key: 'updatedAt', column: 'updated_at' },
  { key: 'errorCode', column: 'error_code' },
  { key: 'errorMessage', column: 'error_message' },
  { key: 'operationId', column: 'operation_id' },
  { key: 'invocationId', column: 'invocation_id' },
  { key: 'dispatchedInputId', column: 'dispatched_input_id' },
  { key: 'brokerSubmissionId', column: 'broker_submission_id' },
  { key: 'brokerInputFencedAt', column: 'broker_input_fenced_at' },
  { key: 'brokerInputFenceReason', column: 'broker_input_fence_reason' },
  { key: 'dispatchIdempotencyKey', column: 'dispatch_idempotency_key' },
  { key: 'queueSnapshotId', column: 'queue_snapshot_id' },
  { key: 'queuedInputSeq', column: 'queued_input_seq' },
  { key: 'queueSnapshotPosition', column: 'queue_snapshot_position' },
  { key: 'coalescedIntoRunId', column: 'coalesced_into_run_id' },
  { key: 'coalescedPosition', column: 'coalesced_position' },
  { key: 'originActor', column: 'origin_actor' },
  { key: 'originKind', column: 'origin_kind' },
  { key: 'originCausationRef', column: 'origin_causation_ref' },
]

export class RunRepository {
  constructor(
    private readonly db: Database,
    private readonly runIdOwnership: RunIdOwnershipRegistry = new RunIdOwnershipRegistry(db)
  ) {}

  insert(record: HrcRunRecord): HrcRunRecord {
    this.runIdOwnership.assertCanCreateRun(record.runId, {
      runtimeId: record.runtimeId,
      operationId: record.operationId,
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    })
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
          error_message,
          operation_id,
          invocation_id,
          dispatched_input_id,
          broker_submission_id,
          broker_input_fenced_at,
          broker_input_fence_reason,
          dispatch_idempotency_key,
          queue_snapshot_id,
          queued_input_seq,
          queue_snapshot_position,
          coalesced_into_run_id,
          coalesced_position,
          origin_actor,
          origin_kind,
          origin_causation_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.errorMessage ?? null,
      record.operationId ?? null,
      record.invocationId ?? null,
      record.dispatchedInputId ?? null,
      record.brokerSubmissionId ?? null,
      record.brokerInputFencedAt ?? null,
      record.brokerInputFenceReason ?? null,
      record.dispatchIdempotencyKey ?? null,
      record.queueSnapshotId ?? null,
      record.queuedInputSeq ?? null,
      record.queueSnapshotPosition ?? null,
      record.coalescedIntoRunId ?? null,
      record.coalescedPosition ?? null,
      record.originActor ?? null,
      record.originKind ?? null,
      record.originCausationRef ?? null
    )

    return requireRecord(this.getByRunId(record.runId), `failed to reload run ${record.runId}`)
  }

  // H-00104 Node C (C-0004): raw opaque correlation metadata stamped on a run by
  // `hrc run annotate`. Stored and echoed verbatim — HRC never interprets it, so
  // these accessors deliberately do not parse or validate the JSON shape. They
  // live off the run record proper (`HrcRunRecord`) to keep the run projection
  // free of operator-convenience metadata. `getCorrelationJson` returns null
  // both when the run is missing and when no correlation was annotated; callers
  // that must distinguish use `getByRunId` first.
  getCorrelationJson(runId: string): string | null {
    const row = this.db
      .query<{ correlation_json: string | null }, [string]>(
        'SELECT correlation_json FROM runs WHERE run_id = ?'
      )
      .get(runId)
    return row?.correlation_json ?? null
  }

  setCorrelationJson(runId: string, json: string | null): void {
    execute(this.db, 'UPDATE runs SET correlation_json = ? WHERE run_id = ?', json, runId)
  }

  getByRunId(runId: string): HrcRunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
      .get(runId)

    return row ? mapRunRow(row) : null
  }

  getByDispatchIdempotencyKey(hostSessionId: string, idempotencyKey: string): HrcRunRecord | null {
    const row = this.db
      .query<RunRow, [string, string]>(
        `SELECT ${RUN_COLUMNS} FROM runs
          WHERE host_session_id = ? AND dispatch_idempotency_key = ?
          LIMIT 1`
      )
      .get(hostSessionId, idempotencyKey)

    return row ? mapRunRow(row) : null
  }

  // Broker FIFO queue correlation: lookup by HRC-assigned inputId so the broker
  // event-mapper can flip invocation.runId on input.accepted for a drained turn.
  // inputId is unique per dispatched input (HRC mints it via randomUUID), so at
  // most one matching active run exists. The migration's index makes this O(1).
  getByDispatchedInputId(inputId: string): HrcRunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE dispatched_input_id = ? LIMIT 1`
      )
      .get(inputId)

    return row ? mapRunRow(row) : null
  }

  getByBrokerSubmissionId(submissionId: string): HrcRunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE broker_submission_id = ? LIMIT 1`
      )
      .get(submissionId)

    return row ? mapRunRow(row) : null
  }

  listByRuntimeId(runtimeId: string): HrcRunRecord[] {
    const rows = this.db
      .query<RunRow, [string]>(
        `SELECT ${RUN_COLUMNS} FROM runs
          WHERE runtime_id = ?
          ORDER BY accepted_at ASC, run_id ASC`
      )
      .all(runtimeId)

    return rows.map(mapRunRow)
  }

  /**
   * FIFO turn inputs accepted by HRC but not yet handed to a runtime.
   *
   * A queued row is deliberately separate from runtime.activeRunId: the
   * currently executing turn keeps ownership until its terminal event, while
   * this row durably survives the accepting client (and daemon) exiting.
   */
  listQueuedByHostSessionId(hostSessionId: string): HrcRunRecord[] {
    const rows = this.db
      .query<RunRow, [string]>(
        `SELECT ${RUN_COLUMNS} FROM runs
          WHERE host_session_id = ? AND status = 'queued'
          ORDER BY queued_input_seq ASC, rowid ASC`
      )
      .all(hostSessionId)

    return rows.map(mapRunRow)
  }

  /**
   * Return the oldest durable drain snapshot, creating one from every currently
   * pending row when no prior snapshot remains. New arrivals retain a NULL
   * snapshot id, so they cannot splice into a partition already in flight.
   */
  snapshotQueuedByHostSessionId(
    hostSessionId: string,
    snapshotId: string,
    updatedAt: string
  ): HrcRunRecord[] {
    return this.db.transaction(() => {
      const existing = this.db
        .query<{ queue_snapshot_id: string }, [string]>(
          `SELECT queue_snapshot_id FROM runs
            WHERE host_session_id = ?
              AND status = 'queued'
              AND queue_snapshot_id IS NOT NULL
            ORDER BY queued_input_seq ASC, rowid ASC
            LIMIT 1`
        )
        .get(hostSessionId)

      const selectedSnapshotId = existing?.queue_snapshot_id ?? snapshotId
      if (existing === null || existing === undefined) {
        const pending = this.db
          .query<{ run_id: string }, [string]>(
            `SELECT run_id FROM runs
              WHERE host_session_id = ?
                AND status = 'queued'
                AND queue_snapshot_id IS NULL
              ORDER BY queued_input_seq ASC, rowid ASC`
          )
          .all(hostSessionId)
        const assign = this.db.query(
          `UPDATE runs
              SET queue_snapshot_id = ?,
                  queue_snapshot_position = ?,
                  updated_at = ?
            WHERE run_id = ?
              AND status = 'queued'
              AND queue_snapshot_id IS NULL`
        )
        pending.forEach((row, position) => {
          const result = assign.run(selectedSnapshotId, position, updatedAt, row.run_id) as {
            changes?: number
          }
          if ((result.changes ?? 0) !== 1) {
            throw new Error(`failed to snapshot queued run ${row.run_id}`)
          }
        })
      }

      const rows = this.db
        .query<RunRow, [string, string]>(
          `SELECT ${RUN_COLUMNS} FROM runs
            WHERE host_session_id = ?
              AND status = 'queued'
              AND queue_snapshot_id = ?
            ORDER BY queue_snapshot_position ASC`
        )
        .all(hostSessionId, selectedSnapshotId)
      return rows.map(mapRunRow)
    })()
  }

  /** Terminalize one queued run into the carrying owner run. */
  markQueuedCoalesced(
    runId: string,
    updates: { ownerRunId: string; position: number; completedAt: string; updatedAt: string }
  ): boolean {
    const result = this.db
      .query(
        `UPDATE runs
            SET status = 'coalesced',
                completed_at = ?,
                updated_at = ?,
                coalesced_into_run_id = ?,
                coalesced_position = ?
          WHERE run_id = ? AND status = 'queued'`
      )
      .run(updates.completedAt, updates.updatedAt, updates.ownerRunId, updates.position, runId) as {
      changes?: number
    }
    return (result.changes ?? 0) === 1
  }

  /** Atomically claim one queued input for broker dispatch. */
  claimQueued(
    runId: string,
    patch: Pick<
      HrcRunRecord,
      'runtimeId' | 'invocationId' | 'operationId' | 'dispatchedInputId' | 'updatedAt'
    >
  ): boolean {
    this.runIdOwnership.assertRunBindingUpdate(runId, {
      runtimeId: patch.runtimeId,
      operationId: patch.operationId,
    })
    const result = this.db
      .query(
        `UPDATE runs
            SET status = 'accepted',
                runtime_id = ?,
                invocation_id = ?,
                operation_id = ?,
                dispatched_input_id = ?,
                updated_at = ?
          WHERE run_id = ? AND status = 'queued'`
      )
      .run(
        patch.runtimeId ?? null,
        patch.invocationId ?? null,
        patch.operationId ?? null,
        patch.dispatchedInputId ?? null,
        patch.updatedAt,
        runId
      ) as { changes?: number }

    return (result.changes ?? 0) === 1
  }

  listRuns(filters: RunListFilters = {}): HrcRunRecord[] {
    const predicates: string[] = []
    const values: Array<string | number> = []

    buildRunWhere(filters, predicates, values)

    const limit = filters.limit ?? 100
    const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : ''
    const rows = this.db
      .query<RunRow, SQLQueryBindings[]>(
        `SELECT ${RUN_COLUMNS} FROM runs
          ${where}
          ORDER BY updated_at DESC,
            COALESCE(completed_at, started_at, accepted_at, updated_at) DESC,
            run_id DESC
          LIMIT ?`
      )
      .all(...values, Math.max(0, Math.floor(limit)))

    return rows.map(mapRunRow)
  }

  getLatestForSession(input: {
    hostSessionId: string
    generation?: number | undefined
  }): HrcRunRecord | null {
    return (
      this.listRuns({
        hostSessionId: input.hostSessionId,
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
        limit: 1,
      })[0] ?? null
    )
  }

  update(runId: string, patch: RunUpdatePatch): HrcRunRecord | null {
    this.runIdOwnership.assertRunBindingUpdate(runId, patch)
    // T-07656 run-terminal monotonicity at the store boundary. A run that
    // carries `completed_at` has answered its caller; a later start/accept
    // stamp (a dispatch path racing the zombie sweep or the reconciler) must not
    // move `status` back off terminal, or the row reads "running" with a
    // completed_at older than its started_at and every reconcile pass — which
    // defines non-terminal as `completed_at IS NULL` — skips it forever (346 such
    // rows on max3, 18 on svc, 2026-08-28). The event-mapper already guards its
    // own turn.started rewrite (T-07235); this makes every writer honour it.
    // A patch that explicitly clears completed_at (`completedAt: null`) is a
    // deliberate resurrection and is honoured as written.
    let effective: RunUpdatePatch = patch
    if (
      patch.status !== undefined &&
      NON_TERMINAL_RUN_STATUSES.has(patch.status) &&
      patch.completedAt !== null
    ) {
      const current = this.getByRunId(runId)
      if (current?.completedAt !== undefined) {
        const { status: _status, startedAt: _startedAt, acceptedAt: _acceptedAt, ...rest } = patch
        effective = rest
      }
    }
    const entries = collectPatchEntries(effective, RUN_UPDATE_SPEC)

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

  fenceBrokerInput(
    runId: string,
    updates: { fencedAt: string; reason: string }
  ): HrcRunRecord | null {
    return this.update(runId, {
      brokerInputFencedAt: updates.fencedAt,
      brokerInputFenceReason: updates.reason,
      updatedAt: updates.fencedAt,
    })
  }

  markCompleted(
    runId: string,
    updates: {
      status: string
      completedAt: string
      updatedAt: string
      errorCode?: HrcErrorCode | undefined
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

const LAUNCH_UPDATE_SPEC: ReadonlyArray<PatchEntrySpec<LaunchUpdatePatch>> = [
  { key: 'hostSessionId', column: 'host_session_id' },
  { key: 'generation', column: 'generation' },
  { key: 'runtimeId', column: 'runtime_id' },
  { key: 'harness', column: 'harness' },
  { key: 'provider', column: 'provider' },
  { key: 'launchArtifactPath', column: 'launch_artifact_path' },
  { key: 'tmuxJson', column: 'tmux_json', transform: (v) => serializeJson(v) },
  { key: 'surfaceJson', column: 'surface_json', transform: (v) => serializeJson(v) },
  { key: 'wrapperPid', column: 'wrapper_pid' },
  { key: 'childPid', column: 'child_pid' },
  {
    key: 'harnessSessionJson',
    column: 'harness_session_json',
    transform: (v) => serializeJson(v),
  },
  { key: 'continuation', column: 'continuation_json', transform: (v) => serializeJson(v) },
  { key: 'wrapperStartedAt', column: 'wrapper_started_at' },
  { key: 'childStartedAt', column: 'child_started_at' },
  { key: 'exitedAt', column: 'exited_at' },
  { key: 'exitCode', column: 'exit_code' },
  { key: 'signal', column: 'signal' },
  { key: 'status', column: 'status' },
  { key: 'createdAt', column: 'created_at' },
  { key: 'updatedAt', column: 'updated_at' },
]

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
          surface_json,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.launchId,
      record.hostSessionId,
      record.generation,
      record.runtimeId ?? null,
      record.harness,
      record.provider,
      record.launchArtifactPath,
      serializeJson(record.tmuxJson),
      serializeJson(record.surfaceJson),
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

  getByLaunchId(launchId: string): HrcLaunchRecord | null {
    const row = this.db
      .query<LaunchRow, [string]>(`SELECT ${LAUNCH_COLUMNS} FROM launches WHERE launch_id = ?`)
      .get(launchId)

    return row ? mapLaunchRow(row) : null
  }

  update(launchId: string, patch: LaunchUpdatePatch): HrcLaunchRecord | null {
    const entries = collectPatchEntries(patch, LAUNCH_UPDATE_SPEC)

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

  listAll(): HrcLaunchRecord[] {
    const rows = this.db
      .query<LaunchRow, []>(
        `SELECT ${LAUNCH_COLUMNS} FROM launches
          ORDER BY created_at ASC, launch_id ASC`
      )
      .all()

    return rows.map(mapLaunchRow)
  }

  listByHostSessionId(hostSessionId: string): HrcLaunchRecord[] {
    const rows = this.db
      .query<LaunchRow, [string]>(
        `SELECT ${LAUNCH_COLUMNS} FROM launches
          WHERE host_session_id = ?
          ORDER BY created_at ASC, launch_id ASC`
      )
      .all(hostSessionId)

    return rows.map(mapLaunchRow)
  }

  listByRuntimeId(runtimeId: string): HrcLaunchRecord[] {
    const rows = this.db
      .query<LaunchRow, [string]>(
        `SELECT ${LAUNCH_COLUMNS} FROM launches
          WHERE runtime_id = ?
          ORDER BY created_at ASC, launch_id ASC`
      )
      .all(runtimeId)

    return rows.map(mapLaunchRow)
  }
}
