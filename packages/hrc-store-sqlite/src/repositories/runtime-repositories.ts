import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { HrcErrorCode, HrcLaunchRecord, HrcRunRecord, HrcRuntimeSnapshot } from 'hrc-core'
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
  { key: 'createdAt', column: 'created_at' },
  { key: 'updatedAt', column: 'updated_at' },
]

export class RuntimeRepository {
  constructor(private readonly db: Database) {}

  count(): number {
    const row = this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtimes').get()
    return row?.count ?? 0
  }

  insert(record: HrcRuntimeSnapshot): HrcRuntimeSnapshot {
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
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const entries = collectPatchEntries(patch, RUNTIME_UPDATE_SPEC)

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

  clearContinuation(runtimeId: string, updatedAt: string): HrcRuntimeSnapshot | null {
    execute(
      this.db,
      `
        UPDATE runtimes
        SET continuation_json = NULL, updated_at = ?
        WHERE runtime_id = ?
      `,
      updatedAt,
      runtimeId
    )
    return this.getByRuntimeId(runtimeId)
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
  pruneRuntime(runtimeId: string): boolean {
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
}

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
  { key: 'brokerInputFencedAt', column: 'broker_input_fenced_at' },
  { key: 'brokerInputFenceReason', column: 'broker_input_fence_reason' },
]

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
          error_message,
          operation_id,
          invocation_id,
          dispatched_input_id,
          broker_input_fenced_at,
          broker_input_fence_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.brokerInputFencedAt ?? null,
      record.brokerInputFenceReason ?? null
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
          ORDER BY accepted_at ASC, run_id ASC`
      )
      .all(hostSessionId)

    return rows.map(mapRunRow)
  }

  /** Atomically claim one queued input for broker dispatch. */
  claimQueued(
    runId: string,
    patch: Pick<
      HrcRunRecord,
      'runtimeId' | 'invocationId' | 'operationId' | 'dispatchedInputId' | 'updatedAt'
    >
  ): boolean {
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
    const entries = collectPatchEntries(patch, RUN_UPDATE_SPEC)

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
