import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { type HrcErrorCode, type HrcRunRecord, isRunTerminal } from 'hrc-core'
import type { RunRow } from './rows.js'
import { RunIdOwnershipRegistry } from './runtime-run-id-ownership.js'
import {
  type PatchEntrySpec,
  RUN_COLUMNS,
  type RunListFilters,
  type RunUpdatePatch,
  buildRunWhere,
  buildSetClause,
  collectPatchEntries,
  execute,
  mapRunRow,
  requireRecord,
} from './shared.js'

export {
  RunIdOwnershipError,
  RunIdOwnershipRegistry,
  RunIdReservedError,
  type RunHandleWriter,
  type RunIdReservationOutcome,
} from './runtime-run-id-ownership.js'
export {
  RuntimeRepository,
  type LiveSeatRefRow,
  type RuntimeChangeObserver,
} from './runtime-repository.js'

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
  { key: 'executionFormat', column: 'execution_format' },
  { key: 'turnKey', column: 'turn_key' },
  { key: 'nativeTurnId', column: 'native_turn_id' },
  { key: 'nativeHarnessGeneration', column: 'native_harness_generation' },
  { key: 'nativeTurnAttempt', column: 'native_turn_attempt' },
  { key: 'initiatingInputId', column: 'initiating_input_id' },
  { key: 'ownershipConflictJson', column: 'ownership_conflict_json' },
  { key: 'observationState', column: 'observation_state' },
  { key: 'observedStartHrcSeq', column: 'observed_start_hrc_seq' },
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
          execution_format,
          turn_key,
          native_turn_id,
          native_harness_generation,
          native_turn_attempt,
          initiating_input_id,
          ownership_conflict_json,
          observation_state,
          observed_start_hrc_seq,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.executionFormat ?? 'format1',
      record.turnKey ?? null,
      record.nativeTurnId ?? null,
      record.nativeHarnessGeneration ?? null,
      record.nativeTurnAttempt ?? null,
      record.initiatingInputId ?? null,
      record.ownershipConflictJson ?? null,
      record.observationState ?? null,
      record.observedStartHrcSeq ?? null,
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

  getByTurnKey(turnKey: string): HrcRunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(`SELECT ${RUN_COLUMNS} FROM runs WHERE turn_key = ? LIMIT 1`)
      .get(turnKey)
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
   * The invocation's runs that carry a correlation annotation, in the same order
   * as `listByRuntimeId`. Few runs are annotated, while one long invocation can
   * own thousands of runs, so annotation checks start here (T-08781).
   */
  listCorrelatedByInvocationId(invocationId: string): HrcRunRecord[] {
    return this.db
      .query<RunRow, [string]>(
        `SELECT ${RUN_COLUMNS} FROM runs
          WHERE invocation_id = ? AND correlation_json IS NOT NULL
          ORDER BY accepted_at ASC, run_id ASC`
      )
      .all(invocationId)
      .map(mapRunRow)
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
      !isRunTerminal({ status: patch.status }) &&
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

  updateStatus(
    runId: string,
    status: HrcRunRecord['status'],
    updatedAt: string
  ): HrcRunRecord | null {
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
      status: HrcRunRecord['status']
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
