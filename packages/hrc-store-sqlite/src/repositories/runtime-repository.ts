import type { Database } from 'bun:sqlite'
import type { HrcRuntimeSnapshot, RuntimePruneDeleteCounts } from 'hrc-core'
import type { RuntimeRow } from './rows.js'
import { RunIdOwnershipRegistry } from './runtime-run-id-ownership.js'
import {
  type PatchEntrySpec,
  RUNTIME_COLUMNS,
  type RuntimeUpdatePatch,
  buildSetClause,
  collectPatchEntries,
  execute,
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

/** Narrow live-seat projection row (T-08609): identity columns only, no `*_json`. */
export type LiveSeatRefRow = {
  scopeRef: string
  laneRef: string
  runtimeId: string
  hostSessionId: string
}

/**
 * T-09861: told of every inserted runtime and every repository status change,
 * so the daemon can mint and revoke per-runtime lifecycle credentials at the
 * launch/teardown boundary. Raw-SQL status writes bypass it; the daemon's
 * periodic reconcile and request-time liveness check cover those.
 */
export type RuntimeChangeObserver = (runtime: HrcRuntimeSnapshot) => void

export class RuntimeRepository {
  private changeObserver: RuntimeChangeObserver | undefined

  constructor(
    private readonly db: Database,
    private readonly runIdOwnership: RunIdOwnershipRegistry = new RunIdOwnershipRegistry(db)
  ) {}

  setChangeObserver(observer: RuntimeChangeObserver | undefined): void {
    this.changeObserver = observer
  }

  private notifyChange(runtime: HrcRuntimeSnapshot | null): void {
    if (runtime === null || this.changeObserver === undefined) return
    try {
      this.changeObserver(runtime)
    } catch {
      // An observer failure must never fail the store write it observes.
    }
  }

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
      record.harness ?? null,
      record.provider ?? null,
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

    const inserted = requireRecord(
      this.getByRuntimeId(record.runtimeId),
      `failed to reload runtime ${record.runtimeId}`
    )
    this.notifyChange(inserted)
    return inserted
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
   * One row per live runtime seat, narrow columns only (T-08609). The same
   * live predicate as `listLiveSessionRefs` pushed into SQL — never a full
   * ledger page with its `*_json` columns (T-08363). Backs
   * `GET /v1/runtimes/live-refs`, the socket form of the kicker's per-tick
   * sweep membership read.
   */
  listLiveSessionRefRows(): LiveSeatRefRow[] {
    return this.db
      .query<LiveSeatRefRow, []>(
        `SELECT scope_ref AS scopeRef, lane_ref AS laneRef, runtime_id AS runtimeId,
                host_session_id AS hostSessionId
           FROM runtimes
          WHERE status IN ('starting', 'ready', 'busy', 'awaiting_input', 'stopping')
            AND scope_ref LIKE 'agent:%'
          ORDER BY scope_ref ASC, lane_ref ASC, runtime_id ASC`
      )
      .all()
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
   * Scope-local runtime history for placement reads. Locate is called once per
   * addressed mail target, so materializing the entire runtime ledger here
   * turns routine injector reconciliation into an O(all historical runtimes)
   * hot loop.
   */
  listByScopeRef(scopeRef: string): HrcRuntimeSnapshot[] {
    return this.db
      .query<RuntimeRow, [string]>(
        `SELECT ${RUNTIME_COLUMNS} FROM runtimes
          WHERE scope_ref = ?
          ORDER BY created_at ASC, runtime_id ASC`
      )
      .all(scopeRef)
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
    const updated = this.getByRuntimeId(runtimeId)
    if (statusChanged) this.notifyChange(updated)
    return updated
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
