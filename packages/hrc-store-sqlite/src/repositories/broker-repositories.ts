import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
  type HrcBrokerInvocationEventRecord,
  type HrcBrokerInvocationRecord,
  type HrcCompiledRuntimePlanRecord,
  type HrcLifecyclePolicyRecord,
  type HrcPermissionDecisionRecord,
  type HrcRuntimeArtifactRecord,
  type HrcRuntimeOperationRecord,
  brokerToolResultBlobId,
  createToolResultSpillStub,
  readToolResultSpillDescriptor,
  toolResultExceedsSpillThreshold,
} from 'hrc-core'
import {
  BROKER_INVOCATION_COLUMNS,
  BROKER_INVOCATION_EVENT_COLUMNS,
  type BrokerInvocationEventRow,
  type BrokerInvocationRow,
  COMPILED_RUNTIME_PLAN_COLUMNS,
  type CompiledRuntimePlanRow,
  EFFECTIVE_TURN_ID_SQL,
  LIFECYCLE_POLICY_COLUMNS,
  type LifecyclePolicyRow,
  PERMISSION_DECISION_COLUMNS,
  type PermissionDecisionRow,
  RUNTIME_ARTIFACT_COLUMNS,
  RUNTIME_OPERATION_COLUMNS,
  type RuntimeArtifactRow,
  type RuntimeOperationRow,
  mapBrokerInvocationEventRow,
  mapBrokerInvocationRow,
  mapCompiledRuntimePlanRow,
  mapLifecyclePolicyRow,
  mapPermissionDecisionRow,
  mapRuntimeArtifactRow,
  mapRuntimeOperationRow,
} from './broker.js'
import {
  type PatchEntrySpec,
  buildSetClause,
  collectPatchEntries,
  execute,
  requireRecord,
} from './shared.js'
import { ToolResultBlobRepository } from './tool-result-blob-repository.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class LifecyclePolicyRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcLifecyclePolicyRecord): HrcLifecyclePolicyRecord {
    execute(
      this.db,
      `
        INSERT INTO lifecycle_policies (
          policy_id,
          lifecycle_policy_hash,
          canonical_policy_json,
          schema_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(lifecycle_policy_hash) DO NOTHING
      `,
      record.policyId,
      record.lifecyclePolicyHash,
      record.canonicalPolicyJson,
      record.schemaVersion,
      record.createdAt
    )

    return requireRecord(
      this.getByPolicyHash(record.lifecyclePolicyHash),
      `failed to reload lifecycle policy ${record.lifecyclePolicyHash}`
    )
  }

  getByPolicyHash(lifecyclePolicyHash: string): HrcLifecyclePolicyRecord | null {
    const row = this.db
      .query<LifecyclePolicyRow, [string]>(
        `SELECT ${LIFECYCLE_POLICY_COLUMNS} FROM lifecycle_policies
          WHERE lifecycle_policy_hash = ?`
      )
      .get(lifecyclePolicyHash)

    return row ? mapLifecyclePolicyRow(row) : null
  }
}

export class CompiledRuntimePlanRepository {
  constructor(private readonly db: Database) {}

  /**
   * Content-addressed insert. Plans are keyed by `planHash`; re-inserting the
   * same plan is a no-op (the first stored compile metadata is preserved).
   */
  insert(record: HrcCompiledRuntimePlanRecord): HrcCompiledRuntimePlanRecord {
    execute(
      this.db,
      `
        INSERT INTO compiled_runtime_plans (
          plan_hash,
          compile_id,
          schema_version,
          compiler_name,
          compiler_version,
          plan_projection_json,
          diagnostics_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_hash) DO NOTHING
      `,
      record.planHash,
      record.compileId,
      record.schemaVersion,
      record.compilerName,
      record.compilerVersion,
      record.planProjectionJson,
      record.diagnosticsJson ?? null,
      record.createdAt
    )

    return requireRecord(
      this.getByPlanHash(record.planHash),
      `failed to reload compiled runtime plan ${record.planHash}`
    )
  }

  getByPlanHash(planHash: string): HrcCompiledRuntimePlanRecord | null {
    const row = this.db
      .query<CompiledRuntimePlanRow, [string]>(
        `SELECT ${COMPILED_RUNTIME_PLAN_COLUMNS} FROM compiled_runtime_plans WHERE plan_hash = ?`
      )
      .get(planHash)

    return row ? mapCompiledRuntimePlanRow(row) : null
  }

  listByCompileId(compileId: string): HrcCompiledRuntimePlanRecord[] {
    const rows = this.db
      .query<CompiledRuntimePlanRow, [string]>(
        `SELECT ${COMPILED_RUNTIME_PLAN_COLUMNS} FROM compiled_runtime_plans
          WHERE compile_id = ?
          ORDER BY created_at ASC, plan_hash ASC`
      )
      .all(compileId)

    return rows.map(mapCompiledRuntimePlanRow)
  }
}

export type RuntimeOperationUpdatePatch = Partial<
  Omit<HrcRuntimeOperationRecord, 'operationId' | 'createdAt'>
>

const RUNTIME_OPERATION_UPDATE_SPEC: ReadonlyArray<PatchEntrySpec<RuntimeOperationUpdatePatch>> = [
  { key: 'runtimeId', column: 'runtime_id' },
  { key: 'runId', column: 'run_id' },
  { key: 'hostSessionId', column: 'host_session_id' },
  { key: 'generation', column: 'generation' },
  { key: 'operationKind', column: 'operation_kind' },
  { key: 'controller', column: 'controller' },
  { key: 'compileId', column: 'compile_id' },
  { key: 'planHash', column: 'plan_hash' },
  { key: 'selectedProfileId', column: 'selected_profile_id' },
  { key: 'selectedProfileHash', column: 'selected_profile_hash' },
  { key: 'startupMethod', column: 'startup_method' },
  { key: 'turnDelivery', column: 'turn_delivery' },
  { key: 'status', column: 'status' },
  { key: 'routeDecisionJson', column: 'route_decision_json' },
  { key: 'capabilityResolutionJson', column: 'capability_resolution_json' },
  { key: 'startedAt', column: 'started_at' },
  { key: 'completedAt', column: 'completed_at' },
  { key: 'updatedAt', column: 'updated_at' },
  { key: 'errorCode', column: 'error_code' },
  { key: 'errorMessage', column: 'error_message' },
  { key: 'preparationJson', column: 'preparation_json' },
]

export class RuntimeOperationRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcRuntimeOperationRecord): HrcRuntimeOperationRecord {
    execute(
      this.db,
      `
        INSERT INTO runtime_operations (
          operation_id,
          runtime_id,
          run_id,
          host_session_id,
          generation,
          operation_kind,
          controller,
          compile_id,
          plan_hash,
          selected_profile_id,
          selected_profile_hash,
          startup_method,
          turn_delivery,
          status,
          route_decision_json,
          capability_resolution_json,
          created_at,
          started_at,
          completed_at,
          updated_at,
          error_code,
          error_message,
          preparation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.operationId,
      record.runtimeId,
      record.runId ?? null,
      record.hostSessionId,
      record.generation,
      record.operationKind,
      record.controller,
      record.compileId ?? null,
      record.planHash ?? null,
      record.selectedProfileId ?? null,
      record.selectedProfileHash ?? null,
      record.startupMethod,
      record.turnDelivery ?? null,
      record.status,
      record.routeDecisionJson,
      record.capabilityResolutionJson ?? null,
      record.createdAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.updatedAt,
      record.errorCode ?? null,
      record.errorMessage ?? null,
      record.preparationJson ?? null
    )

    return requireRecord(
      this.getByOperationId(record.operationId),
      `failed to reload runtime operation ${record.operationId}`
    )
  }

  getByOperationId(operationId: string): HrcRuntimeOperationRecord | null {
    const row = this.db
      .query<RuntimeOperationRow, [string]>(
        `SELECT ${RUNTIME_OPERATION_COLUMNS} FROM runtime_operations WHERE operation_id = ?`
      )
      .get(operationId)

    return row ? mapRuntimeOperationRow(row) : null
  }

  /**
   * T-08542: never-submitted aspd preparations for one host session, newest
   * first. The dispatch idempotency key lives inside the frozen preparation.
   */
  listPreparedByHostSession(hostSessionId: string): HrcRuntimeOperationRecord[] {
    const rows = this.db
      .query<RuntimeOperationRow, [string]>(
        `SELECT ${RUNTIME_OPERATION_COLUMNS} FROM runtime_operations
          WHERE host_session_id = ? AND status = 'prepared' AND preparation_json IS NOT NULL
          ORDER BY created_at DESC, operation_id DESC`
      )
      .all(hostSessionId)

    return rows.map(mapRuntimeOperationRow)
  }

  listByRuntimeId(runtimeId: string): HrcRuntimeOperationRecord[] {
    const rows = this.db
      .query<RuntimeOperationRow, [string]>(
        `SELECT ${RUNTIME_OPERATION_COLUMNS} FROM runtime_operations
          WHERE runtime_id = ?
          ORDER BY created_at ASC, operation_id ASC`
      )
      .all(runtimeId)

    return rows.map(mapRuntimeOperationRow)
  }

  update(
    operationId: string,
    patch: RuntimeOperationUpdatePatch
  ): HrcRuntimeOperationRecord | null {
    const entries = collectPatchEntries(patch, RUNTIME_OPERATION_UPDATE_SPEC)

    if (entries.length === 0) {
      return this.getByOperationId(operationId)
    }

    const { clause, values } = buildSetClause(entries)
    execute(
      this.db,
      `UPDATE runtime_operations SET ${clause} WHERE operation_id = ?`,
      ...values,
      operationId
    )
    return this.getByOperationId(operationId)
  }
}

export type BrokerInvocationUpdatePatch = Partial<
  Omit<HrcBrokerInvocationRecord, 'invocationId' | 'createdAt'>
>

const BROKER_INVOCATION_UPDATE_SPEC: ReadonlyArray<PatchEntrySpec<BrokerInvocationUpdatePatch>> = [
  { key: 'operationId', column: 'operation_id' },
  { key: 'runtimeId', column: 'runtime_id' },
  { key: 'runId', column: 'run_id' },
  { key: 'brokerProtocol', column: 'broker_protocol' },
  { key: 'brokerDriver', column: 'broker_driver' },
  { key: 'brokerPid', column: 'broker_pid' },
  { key: 'childPid', column: 'child_pid' },
  { key: 'invocationState', column: 'invocation_state' },
  { key: 'capabilitiesJson', column: 'capabilities_json' },
  { key: 'continuationJson', column: 'continuation_json' },
  { key: 'brokerContinuationJson', column: 'broker_continuation_json' },
  { key: 'specHash', column: 'spec_hash' },
  { key: 'startRequestHash', column: 'start_request_hash' },
  { key: 'selectedProfileHash', column: 'selected_profile_hash' },
  { key: 'specProjectionJson', column: 'spec_projection_json' },
  { key: 'startRequestProjectionJson', column: 'start_request_projection_json' },
  { key: 'lastEventSeq', column: 'last_event_seq' },
  { key: 'lastProjectedSeq', column: 'last_projected_seq' },
  { key: 'retainedProjectedThroughSeq', column: 'retained_projected_through_seq' },
  { key: 'ownerServerInstanceId', column: 'owner_server_instance_id' },
  { key: 'lifecyclePolicyHash', column: 'lifecycle_policy_hash' },
  { key: 'currentHarnessGeneration', column: 'current_harness_generation' },
  { key: 'currentTurnAttempt', column: 'current_turn_attempt' },
  { key: 'lifecycleTerminalReason', column: 'lifecycle_terminal_reason' },
  { key: 'lastLifecycleEscalationJson', column: 'last_lifecycle_escalation_json' },
  { key: 'updatedAt', column: 'updated_at' },
]

export class BrokerInvocationRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcBrokerInvocationRecord): HrcBrokerInvocationRecord {
    execute(
      this.db,
      `
        INSERT INTO broker_invocations (
          invocation_id,
          operation_id,
          runtime_id,
          run_id,
          broker_protocol,
          broker_driver,
          broker_pid,
          child_pid,
          invocation_state,
          capabilities_json,
          continuation_json,
          broker_continuation_json,
          spec_hash,
          start_request_hash,
          selected_profile_hash,
          spec_projection_json,
          start_request_projection_json,
          last_event_seq,
          last_projected_seq,
          owner_server_instance_id,
          lifecycle_policy_hash,
          current_harness_generation,
          current_turn_attempt,
          lifecycle_terminal_reason,
          last_lifecycle_escalation_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.invocationId,
      record.operationId,
      record.runtimeId,
      record.runId ?? null,
      record.brokerProtocol,
      record.brokerDriver,
      record.brokerPid ?? null,
      record.childPid ?? null,
      record.invocationState,
      record.capabilitiesJson,
      record.continuationJson ?? null,
      record.brokerContinuationJson ?? null,
      record.specHash,
      record.startRequestHash,
      record.selectedProfileHash,
      record.specProjectionJson ?? null,
      record.startRequestProjectionJson ?? null,
      record.lastEventSeq ?? null,
      record.lastProjectedSeq ?? 0,
      record.ownerServerInstanceId ?? null,
      record.lifecyclePolicyHash ?? null,
      record.currentHarnessGeneration ?? null,
      record.currentTurnAttempt ?? null,
      record.lifecycleTerminalReason ?? null,
      record.lastLifecycleEscalationJson ?? null,
      record.createdAt,
      record.updatedAt
    )

    return requireRecord(
      this.getByInvocationId(record.invocationId),
      `failed to reload broker invocation ${record.invocationId}`
    )
  }

  getByInvocationId(invocationId: string): HrcBrokerInvocationRecord | null {
    const row = this.db
      .query<BrokerInvocationRow, [string]>(
        `SELECT ${BROKER_INVOCATION_COLUMNS} FROM broker_invocations WHERE invocation_id = ?`
      )
      .get(invocationId)

    return row ? mapBrokerInvocationRow(row) : null
  }

  listByRuntimeId(runtimeId: string): HrcBrokerInvocationRecord[] {
    const rows = this.db
      .query<BrokerInvocationRow, [string]>(
        `SELECT ${BROKER_INVOCATION_COLUMNS} FROM broker_invocations
          WHERE runtime_id = ?
          ORDER BY created_at ASC, invocation_id ASC`
      )
      .all(runtimeId)

    return rows.map(mapBrokerInvocationRow)
  }

  update(
    invocationId: string,
    patch: BrokerInvocationUpdatePatch
  ): HrcBrokerInvocationRecord | null {
    const entries = collectPatchEntries(patch, BROKER_INVOCATION_UPDATE_SPEC)

    if (entries.length === 0) {
      return this.getByInvocationId(invocationId)
    }

    const { clause, values } = buildSetClause(entries)
    execute(
      this.db,
      `UPDATE broker_invocations SET ${clause} WHERE invocation_id = ?`,
      ...values,
      invocationId
    )
    return this.getByInvocationId(invocationId)
  }
}

export type SubmissionAdmissionRecord = {
  submissionId: string
  runId?: string | undefined
  runtimeId?: string | undefined
  invocationId?: string | undefined
  door?: string | undefined
  envelopeId?: string | undefined
  admittedAt?: string | undefined
  disposition?: string | undefined
  disposedAt?: string | undefined
}

export type SubmissionDisposition =
  | 'executed'
  | 'absorbed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'lost'
  | 'withdrawn'

/**
 * T-08611 — durable per-submission admission ledger (`submission_admissions`).
 *
 * Both edges are order-independent upserts keyed on `submission_id`:
 * - the admission edge (dispatch attach) SETs the identity columns — run,
 *   runtime, invocation, admitted_at — but never the disposition;
 * - the landed edge (submission.executed/absorbed and the terminal
 *   dispositions) SETs only disposition/disposed_at, and may create a row
 *   carrying only the disposition when the landed event wins the race.
 *
 * Door and envelope_id come from the HRC dispatch request, which the event
 * mapper never sees: on conflict they keep the already-recorded value when
 * the upsert carries none (COALESCE), so a mapper-side attach can never
 * NULL-clobber what the dispatch attach recorded.
 */
export class SubmissionAdmissionRepository {
  constructor(private readonly db: Database) {}

  upsertAdmission(input: {
    submissionId: string
    runId?: string | undefined
    runtimeId?: string | undefined
    invocationId?: string | undefined
    door?: string | undefined
    envelopeId?: string | undefined
    admittedAt: string
  }): void {
    execute(
      this.db,
      `INSERT INTO submission_admissions (
         submission_id, run_id, runtime_id, invocation_id, door, envelope_id, admitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         run_id = excluded.run_id,
         runtime_id = excluded.runtime_id,
         invocation_id = excluded.invocation_id,
         door = COALESCE(excluded.door, submission_admissions.door),
         envelope_id = COALESCE(excluded.envelope_id, submission_admissions.envelope_id),
         admitted_at = excluded.admitted_at`,
      input.submissionId,
      input.runId ?? null,
      input.runtimeId ?? null,
      input.invocationId ?? null,
      input.door ?? null,
      input.envelopeId ?? null,
      input.admittedAt
    )
  }

  recordDisposition(input: {
    submissionId: string
    disposition: SubmissionDisposition
    disposedAt: string
    /**
     * Under the retained-evidence fence a replayed landed event must never
     * clobber a disposition the live path already committed: write only where
     * none exists.
     */
    onlyIfAbsent?: boolean | undefined
  }): void {
    execute(
      this.db,
      `INSERT INTO submission_admissions (submission_id, disposition, disposed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         disposition = excluded.disposition,
         disposed_at = excluded.disposed_at${
           input.onlyIfAbsent === true ? ' WHERE submission_admissions.disposition IS NULL' : ''
         }`,
      input.submissionId,
      input.disposition,
      input.disposedAt
    )
  }

  getBySubmissionId(submissionId: string): SubmissionAdmissionRecord | null {
    const row = this.db
      .query<
        {
          submission_id: string
          run_id: string | null
          runtime_id: string | null
          invocation_id: string | null
          door: string | null
          envelope_id: string | null
          admitted_at: string | null
          disposition: string | null
          disposed_at: string | null
        },
        [string]
      >(
        `SELECT submission_id, run_id, runtime_id, invocation_id, door,
                envelope_id, admitted_at, disposition, disposed_at
         FROM submission_admissions WHERE submission_id = ? LIMIT 1`
      )
      .get(submissionId)
    if (row === undefined || row === null) return null
    return {
      submissionId: row.submission_id,
      ...(row.run_id !== null ? { runId: row.run_id } : {}),
      ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
      ...(row.invocation_id !== null ? { invocationId: row.invocation_id } : {}),
      ...(row.door !== null ? { door: row.door } : {}),
      ...(row.envelope_id !== null ? { envelopeId: row.envelope_id } : {}),
      ...(row.admitted_at !== null ? { admittedAt: row.admitted_at } : {}),
      ...(row.disposition !== null ? { disposition: row.disposition } : {}),
      ...(row.disposed_at !== null ? { disposedAt: row.disposed_at } : {}),
    }
  }
}

export type BrokerInvocationEventAppendInput = {
  invocationId: string
  seq: number
  time: string
  type: string
  runtimeId: string
  runId?: string | undefined
  /**
   * Envelope-level identity persisted alongside the payload (T-01946) so the
   * durable ledger can reconstruct the full ask-bracket identity on restart.
   */
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  /**
   * Broker event content to persist. Serialized verbatim and compared on
   * re-append: the same `(invocationId, seq)` with the same payload is a no-op;
   * a different payload throws.
   */
  payload: unknown
  /**
   * Full serialized broker `InvocationEventEnvelope` (T-05078). Persisted verbatim
   * as the wire authority for the raw observer so it can reconstruct a true
   * envelope incl. optional `turnId`/`inputId`/`itemId`/`correlation`/`driver`.
   * Optional for back-compat; the broker event mapper always supplies it.
   */
  envelopeJson?: string | undefined
  hrcEventSeq?: number | undefined
  projectionStatus?: HrcBrokerInvocationEventRecord['projectionStatus'] | undefined
  projectionError?: string | undefined
  /** `'retained'` only for rows mirrored by retained (offline) projection (T-08566). */
  evidenceOrigin?: 'retained' | undefined
}

export type ImportedBrokerInvocationEventInput = {
  sourceRef: string
  originSeq: number
  event: HrcBrokerInvocationEventRecord
}

export type BrokerProjectionDisposition = {
  invocationId: string
  seq: number
  envelopeHash: string
  disposition: 'applied' | 'skipped_fenced' | 'skipped_duplicate'
  createdAt: string
}

export type BrokerInvocationEventAppendResult = {
  record: HrcBrokerInvocationEventRecord
  /** True when an identical event already existed and the append was a no-op. */
  idempotent: boolean
}

export type BrokerInvocationEventAfterSeqSelector = {
  invocationId: string
  runId?: string | undefined
  runtimeId: string
  afterSeq: number
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'reaped' ||
    status === 'coalesced'
  )
}

export class BrokerInvocationEventConflictError extends Error {
  constructor(
    readonly invocationId: string,
    readonly seq: number
  ) {
    super(
      `broker_invocation_events conflict: (invocation_id=${invocationId}, seq=${seq}) already exists with a different payload; refusing to overwrite`
    )
    this.name = 'BrokerInvocationEventConflictError'
  }
}

type BrokerInvocationEventProjectionUpdate = {
  hrcEventSeq?: number | undefined
  projectionStatus?: HrcBrokerInvocationEventRecord['projectionStatus'] | undefined
  projectionError?: string | undefined
}

const BROKER_INVOCATION_EVENT_PROJECTION_SPEC: ReadonlyArray<
  PatchEntrySpec<BrokerInvocationEventProjectionUpdate>
> = [
  { key: 'hrcEventSeq', column: 'hrc_event_seq' },
  { key: 'projectionStatus', column: 'projection_status' },
  { key: 'projectionError', column: 'projection_error' },
]

/**
 * Retained-evidence fence predicate fragment (T-08607). Offline-projected
 * rows carry `evidence_origin = 'retained'`; live rows carry NULL. The fence
 * is opt-OUT: only an explicit `includeRetained: true` reads retained rows.
 * Callers that pass no options keep the historical unfiltered read — the
 * socket routes always pass the request's flag explicitly.
 */
function retainedFencePredicate(includeRetained: boolean | undefined): string {
  return includeRetained === true
    ? ''
    : `AND (evidence_origin IS NULL OR evidence_origin != 'retained')`
}

export class BrokerInvocationEventRepository {
  private readonly appendInTransaction: (
    input: BrokerInvocationEventAppendInput
  ) => BrokerInvocationEventAppendResult

  constructor(
    private readonly db: Database,
    private readonly toolResultBlobs = new ToolResultBlobRepository(db)
  ) {
    this.appendInTransaction = db.transaction(
      (input: BrokerInvocationEventAppendInput): BrokerInvocationEventAppendResult => {
        const inputBrokerEventJson = JSON.stringify(input.payload ?? null)
        const brokerEventJson = this.persistedBrokerEventJson(
          input.type,
          input.runtimeId,
          input.payload
        )
        const brokerEnvelopeJson = this.enrichEnvelopeJsonWithRepairCorrelation(
          input.envelopeJson,
          input.runId
        )

        const existing = this.db
          .query<BrokerInvocationEventRow, [string, number]>(
            `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
              WHERE invocation_id = ? AND seq = ?`
          )
          .get(input.invocationId, input.seq)

        if (existing) {
          // T-01946: run_id / harness_generation / turn_attempt are all part of
          // the durable broker event identity (the authority SQL keys ask brackets
          // on (invocationId, runId, harnessGeneration, turnAttempt, toolCallId)),
          // so a re-append at the same (invocationId, seq) is idempotent ONLY when
          // the payload AND every identity field matches. A same-seq event carrying
          // a different run / generation / attempt is divergent and must conflict
          // (no silent idempotent return). Null-safe compare throughout.
          const sameIdentity =
            this.toolResultBlobs.hydrateBrokerEventJson(existing.broker_event_json) ===
              inputBrokerEventJson &&
            (existing.run_id ?? null) === (input.runId ?? null) &&
            (existing.harness_generation ?? null) === (input.harnessGeneration ?? null) &&
            (existing.turn_attempt ?? null) === (input.turnAttempt ?? null)
          if (!sameIdentity) {
            throw new BrokerInvocationEventConflictError(input.invocationId, input.seq)
          }
          return { record: this.mapRow(existing), idempotent: true }
        }

        execute(
          this.db,
          `
            INSERT INTO broker_invocation_events (
              invocation_id,
              seq,
              time,
              type,
              run_id,
              runtime_id,
              harness_generation,
              turn_attempt,
              broker_event_json,
              broker_envelope_json,
              hrc_event_seq,
              projection_status,
              projection_error,
              evidence_origin,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          `,
          input.invocationId,
          input.seq,
          input.time,
          input.type,
          input.runId ?? null,
          input.runtimeId,
          input.harnessGeneration ?? null,
          input.turnAttempt ?? null,
          brokerEventJson,
          brokerEnvelopeJson ?? null,
          input.hrcEventSeq ?? null,
          input.projectionStatus ?? 'pending',
          input.projectionError ?? null,
          input.evidenceOrigin ?? null
        )

        const stored = requireRecord(
          this.getByInvocationAndSeq(input.invocationId, input.seq),
          `failed to reload broker invocation event ${input.invocationId}/${input.seq}`
        )
        return { record: stored, idempotent: false }
      }
    )
  }

  private mapRow(
    row: BrokerInvocationEventRow,
    options: { hydrate?: boolean } = {}
  ): HrcBrokerInvocationEventRecord {
    return mapBrokerInvocationEventRow(
      row,
      options.hydrate === false
        ? (value) => value
        : (value) => this.toolResultBlobs.hydrateBrokerEventJson(value)
    )
  }

  private persistedBrokerEventJson(
    type: string,
    runtimeId: string,
    payload: unknown,
    createdAt?: string
  ): string {
    if (!isRecord(payload) || type !== 'tool.call.completed') return JSON.stringify(payload ?? null)
    const result = payload['result']
    if (readToolResultSpillDescriptor(result) || !toolResultExceedsSpillThreshold(result)) {
      return JSON.stringify(payload)
    }
    const toolCallId = payload['toolCallId']
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      throw new Error('large tool.call.completed result requires toolCallId')
    }
    const resultJson = JSON.stringify(result)
    const bytes = Buffer.byteLength(resultJson, 'utf8')
    const blobId = brokerToolResultBlobId(runtimeId, toolCallId)
    this.toolResultBlobs.insert({
      blobId,
      runtimeId,
      kind: 'broker_raw',
      bytes,
      resultJson,
      createdAt,
    })
    return JSON.stringify({
      ...payload,
      result: createToolResultSpillStub(result, { blobId, bytes, kind: 'broker_raw' }),
    })
  }

  private enrichEnvelopeJsonWithRepairCorrelation(
    envelopeJson: string | undefined,
    runId: string | undefined
  ): string | undefined {
    if (envelopeJson === undefined || runId === undefined) {
      return envelopeJson
    }

    const run = this.db
      .query<{ status: string; correlation_json: string | null }, [string]>(
        'SELECT status, correlation_json FROM runs WHERE run_id = ?'
      )
      .get(runId)
    if (!run?.correlation_json || isTerminalRunStatus(run.status)) {
      return envelopeJson
    }

    try {
      const envelope = JSON.parse(envelopeJson) as { correlation?: unknown }
      if (envelope.correlation !== undefined) {
        return envelopeJson
      }

      const correlation = JSON.parse(run.correlation_json) as {
        kind?: unknown
        repairRunId?: unknown
      }
      if (correlation.kind !== 'json_repair' || correlation.repairRunId !== runId) {
        return envelopeJson
      }

      return JSON.stringify({ ...envelope, correlation })
    } catch {
      return envelopeJson
    }
  }

  /**
   * Idempotent append keyed by `(invocationId, seq)`:
   * - inserts a new row for a new key;
   * - is a no-op (returns the stored row, `idempotent: true`) when the same key
   *   is re-appended with the same payload;
   * - throws `BrokerInvocationEventConflictError` when the same key arrives with
   *   a different payload — no silent overwrite, no double projection.
   */
  appendEvent(input: BrokerInvocationEventAppendInput): BrokerInvocationEventAppendResult {
    return this.appendInTransaction(input)
  }

  appendImported(input: ImportedBrokerInvocationEventInput): BrokerInvocationEventAppendResult {
    if (!input.sourceRef.trim() || !Number.isSafeInteger(input.originSeq) || input.originSeq < 1) {
      throw new Error('imported broker event requires non-empty sourceRef and positive originSeq')
    }
    const append = this.db.transaction(() => {
      const existing = this.db
        .query<BrokerInvocationEventRow, [string, number]>(
          `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
            WHERE source_ref = ? AND origin_seq = ?`
        )
        .get(input.sourceRef, input.originSeq)
      if (existing) {
        const stored = this.mapRow(existing, { hydrate: false })
        const comparable = ({
          id: _id,
          sourceRef: _sourceRef,
          originSeq: _originSeq,
          hrcEventSeq: _hrcEventSeq,
          projectionStatus: _projectionStatus,
          projectionError: _projectionError,
          ...rest
        }: HrcBrokerInvocationEventRecord) => rest
        if (JSON.stringify(comparable(stored)) !== JSON.stringify(comparable(input.event))) {
          throw new BrokerInvocationEventConflictError(input.sourceRef, input.originSeq)
        }
        return { record: stored, idempotent: true }
      }

      let persistedBrokerEventJson = input.event.brokerEventJson
      try {
        const payload = JSON.parse(input.event.brokerEventJson) as unknown
        persistedBrokerEventJson = this.persistedBrokerEventJson(
          input.event.type,
          input.event.runtimeId,
          payload,
          input.event.createdAt
        )
      } catch (error) {
        if (error instanceof SyntaxError) persistedBrokerEventJson = input.event.brokerEventJson
        else throw error
      }
      let persistedEnvelopeJson = input.event.brokerEnvelopeJson
      if (persistedEnvelopeJson !== undefined) {
        try {
          const envelope = JSON.parse(persistedEnvelopeJson) as unknown
          if (isRecord(envelope)) {
            const { payload: _payload, ...withoutPayload } = envelope
            persistedEnvelopeJson = JSON.stringify(withoutPayload)
          }
        } catch {
          // Preserve malformed historical envelope text.
        }
      }
      execute(
        this.db,
        `INSERT INTO broker_invocation_events (
          invocation_id, seq, time, type, run_id, runtime_id, harness_generation,
          turn_attempt, broker_event_json, broker_envelope_json, hrc_event_seq,
          projection_status, projection_error, source_ref, origin_seq, evidence_origin, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'imported', ?, ?, ?, ?, ?)`,
        input.event.invocationId,
        input.event.seq,
        input.event.time,
        input.event.type,
        input.event.runId ?? null,
        input.event.runtimeId,
        input.event.harnessGeneration ?? null,
        input.event.turnAttempt ?? null,
        persistedBrokerEventJson,
        persistedEnvelopeJson ?? null,
        input.event.projectionError ?? null,
        input.sourceRef,
        input.originSeq,
        input.event.evidenceOrigin ?? null,
        input.event.createdAt
      )
      const stored = this.getBySourceOrigin(input.sourceRef, input.originSeq)
      if (!stored) throw new Error(`failed to reload imported broker event ${input.sourceRef}`)
      return { record: stored, idempotent: false }
    })
    return append.immediate()
  }

  getBySourceOrigin(sourceRef: string, originSeq: number): HrcBrokerInvocationEventRecord | null {
    const row = this.db
      .query<BrokerInvocationEventRow, [string, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE source_ref = ? AND origin_seq = ?`
      )
      .get(sourceRef, originSeq)
    return row ? this.mapRow(row) : null
  }

  listBySourceRef(sourceRef: string): HrcBrokerInvocationEventRecord[] {
    return this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE source_ref = ? ORDER BY origin_seq ASC`
      )
      .all(sourceRef)
      .map((row) => this.mapRow(row))
  }

  listLocalFromId(
    afterId: number,
    limit: number,
    options: { hydrate?: boolean } = {}
  ): HrcBrokerInvocationEventRecord[] {
    return this.db
      .query<BrokerInvocationEventRow, [number, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE source_ref IS NULL AND id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(afterId, limit)
      .map((row) => this.mapRow(row, options))
  }

  /** Global insertion high-water mark, including event types the transcript projection ignores. */
  maxEventId(): number {
    return (
      this.db
        .query<{ max_id: number | null }, []>(
          'SELECT MAX(id) AS max_id FROM broker_invocation_events'
        )
        .get()?.max_id ?? 0
    )
  }

  /** Bounded global-id tail used only to detect transcript boundaries and late prose. */
  listTranscriptTail(
    afterId: number,
    throughId: number,
    types: readonly string[],
    limit: number
  ): HrcBrokerInvocationEventRecord[] {
    if (types.length === 0) return []
    const placeholders = types.map(() => '?').join(', ')
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
         WHERE id > ? AND id <= ? AND type IN (${placeholders})
         ORDER BY id ASC LIMIT ?`
      )
      .all(afterId, throughId, ...types, Math.max(1, Math.floor(limit)))
      .map((row) => this.mapRow(row))
  }

  /** Invocation-seq source read for one derived transcript segment. */
  listTranscriptRange(
    invocationId: string,
    afterSeq: number,
    throughSeq: number,
    types: readonly string[]
  ): HrcBrokerInvocationEventRecord[] {
    if (types.length === 0) return []
    const placeholders = types.map(() => '?').join(', ')
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
         WHERE invocation_id = ? AND seq > ? AND seq <= ? AND type IN (${placeholders})
         ORDER BY seq ASC`
      )
      .all(invocationId, afterSeq, throughSeq, ...types)
      .map((row) => this.mapRow(row))
  }

  listTranscriptTerminals(
    invocationId: string,
    terminalTypes: readonly string[]
  ): HrcBrokerInvocationEventRecord[] {
    if (terminalTypes.length === 0) return []
    const placeholders = terminalTypes.map(() => '?').join(', ')
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
         WHERE invocation_id = ? AND type IN (${placeholders}) ORDER BY seq ASC`
      )
      .all(invocationId, ...terminalTypes)
      .map((row) => this.mapRow(row))
  }

  listTranscriptInvocationIds(terminalTypes: readonly string[]): string[] {
    if (terminalTypes.length === 0) return []
    const placeholders = terminalTypes.map(() => '?').join(', ')
    return this.db
      .query<{ invocation_id: string }, SQLQueryBindings[]>(
        `SELECT DISTINCT invocation_id FROM broker_invocation_events
         WHERE type IN (${placeholders}) ORDER BY invocation_id ASC`
      )
      .all(...terminalTypes)
      .map((row) => row.invocation_id)
  }

  getByInvocationAndSeq(invocationId: string, seq: number): HrcBrokerInvocationEventRecord | null {
    const row = this.db
      .query<BrokerInvocationEventRow, [string, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE invocation_id = ? AND seq = ?`
      )
      .get(invocationId, seq)

    return row ? this.mapRow(row) : null
  }

  listByInvocationId(invocationId: string): HrcBrokerInvocationEventRecord[] {
    const rows = this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE invocation_id = ?
          ORDER BY seq ASC`
      )
      .all(invocationId)

    return rows.map((row) => this.mapRow(row))
  }

  /**
   * The invocation's rows of the given types, in seq order, for decisions that
   * read identity fields only (T-08781). Rows are NOT hydrated: a spilled tool
   * result stays a descriptor.
   *
   * `turnId` / `hasTurnId` filter on the row's effective turnId — the envelope's
   * string `turnId`, else the payload's string `turnId` — so a caller parsing the
   * returned rows sees exactly the rows it would have kept from the whole list.
   */
  listByInvocationIdAndTypes(input: {
    invocationId: string
    types: readonly string[]
    throughSeq?: number | undefined
    runtimeId?: string | undefined
    turnId?: string | undefined
    hasTurnId?: boolean | undefined
    limit?: number | undefined
  }): HrcBrokerInvocationEventRecord[] {
    if (input.types.length === 0) return []
    const where = ['invocation_id = ?', `type IN (${input.types.map(() => '?').join(', ')})`]
    const params: SQLQueryBindings[] = [input.invocationId, ...input.types]
    if (input.throughSeq !== undefined) {
      where.push('seq <= ?')
      params.push(input.throughSeq)
    }
    if (input.runtimeId !== undefined) {
      where.push('runtime_id = ?')
      params.push(input.runtimeId)
    }
    if (input.turnId !== undefined) {
      where.push(`${EFFECTIVE_TURN_ID_SQL} = ?`)
      params.push(input.turnId)
    } else if (input.hasTurnId === true) {
      where.push(`${EFFECTIVE_TURN_ID_SQL} IS NOT NULL`)
    }
    const limit = input.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(input.limit))}` : ''
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        // Pinned: to satisfy ORDER BY seq the planner otherwise picks the
        // (invocation_id, seq) index and walks every earlier row of the
        // invocation — the very growth this query exists to avoid.
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          INDEXED BY idx_broker_invocation_events_invocation_type_seq
          WHERE ${where.join(' AND ')}
          ORDER BY seq ASC${limit}`
      )
      .all(...params)
      .map((row) => this.mapRow(row, { hydrate: false }))
  }

  listByRuntimeId(runtimeId: string): HrcBrokerInvocationEventRecord[] {
    const rows = this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE runtime_id = ?
          ORDER BY time ASC, invocation_id ASC, seq ASC`
      )
      .all(runtimeId)

    return rows.map((row) => this.mapRow(row))
  }

  hasInputAccepted(
    runtimeId: string,
    inputId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string]>(
          `SELECT 1 AS found
             FROM broker_invocation_events
            WHERE runtime_id = ?
              AND type = 'input.accepted'
              AND json_extract(broker_event_json, '$.inputId') = ?
              ${retainedFencePredicate(options.includeRetained)}
            LIMIT 1`
        )
        .get(runtimeId, inputId) !== null
    )
  }

  hasQueueEnqueued(runtimeId: string, inputId: string): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string]>(
          `SELECT 1 AS found
             FROM broker_invocation_events
            WHERE runtime_id = ?
              AND type = 'queue.enqueued'
              AND json_extract(broker_event_json, '$.submissionId') = ?
            LIMIT 1`
        )
        .get(runtimeId, inputId) !== null
    )
  }

  /**
   * The committed broker disposition of one submission on a runtime (T-08094).
   *
   * This is the RECONCILE half of write-ahead delivery: an intent whose landing
   * HRC never observed live — a crash, a restart, a dropped observer — is
   * resolved by asking the mirrored stream what actually happened, rather than
   * by guessing from HRC memory that no longer exists.
   */
  findSubmissionDisposition(
    runtimeId: string,
    submissionId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): { type: string; turnId?: string | undefined; reason?: string | undefined } | undefined {
    const row = this.db
      .query<{ type: string; turnId: string | null; reason: string | null }, [string, string]>(
        `SELECT type,
                json_extract(broker_event_json, '$.turnId') AS turnId,
                json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
          WHERE runtime_id = ?
            AND type IN (
              'submission.absorbed', 'submission.executed', 'submission.rejected',
              'submission.expired', 'submission.withdrawn', 'submission.cancelled',
              'submission.lost'
            )
            AND json_extract(broker_event_json, '$.submissionId') = ?
            ${retainedFencePredicate(options.includeRetained)}
          ORDER BY time ASC, seq ASC
          LIMIT 1`
      )
      .get(runtimeId, submissionId)
    if (row === null) return undefined
    return {
      type: row.type,
      ...(row.turnId === null ? {} : { turnId: row.turnId }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }
  }

  /** Explicit producer proof that an input did not reach a native write. */
  findInputRejectionDeliveryEvidence(
    runtimeId: string,
    submissionId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): 'not_written' | 'possibly_written' | undefined {
    const row = this.db
      .query<{ deliveryEvidence: string | null }, [string, string, string]>(
        `SELECT json_extract(broker_event_json, '$.deliveryEvidence') AS deliveryEvidence
           FROM broker_invocation_events
          WHERE runtime_id = ?
            AND type = 'input.rejected'
            AND (
              json_extract(broker_event_json, '$.inputId') = ? OR
              json_extract(broker_event_json, '$.submissionId') = ?
            )
            ${retainedFencePredicate(options.includeRetained)}
          ORDER BY time ASC, seq ASC
          LIMIT 1`
      )
      .get(runtimeId, submissionId, submissionId)
    return row?.deliveryEvidence === 'not_written' || row?.deliveryEvidence === 'possibly_written'
      ? row.deliveryEvidence
      : undefined
  }

  /**
   * The ADMISSION LAYER a rejected submission was refused at (T-08094).
   *
   * `submission.rejected` carries only a reason string; the `admission.rejected`
   * the broker emits alongside it carries the layer, and the layer is the honest
   * discriminator between "this seat cannot do that" and "not at this instant".
   * `capability` is a fact about the driver; `state`, `policy` and `authority`
   * are facts about the moment — a pane the human is mid-word in, a guarded
   * turn, a seat between states — and every one of them is true again a second
   * later.
   *
   * Absent for a submission that was ADMITTED and then failed in execution: the
   * broker emits no `admission.rejected` for those, so the caller falls back to
   * reading the reason itself.
   */
  findAdmissionRejection(
    runtimeId: string,
    submissionId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): { layer: string; reason: string } | undefined {
    const row = this.db
      .query<{ layer: string | null; reason: string | null }, [string, string]>(
        `SELECT json_extract(broker_event_json, '$.layer') AS layer,
                json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
          WHERE runtime_id = ?
            AND type = 'admission.rejected'
            AND json_extract(broker_event_json, '$.submissionId') = ?
            ${retainedFencePredicate(options.includeRetained)}
          ORDER BY time DESC, seq DESC
          LIMIT 1`
      )
      .get(runtimeId, submissionId)
    if (row?.layer === null || row?.layer === undefined) return undefined
    return { layer: row.layer, reason: row.reason ?? '' }
  }

  /**
   * The submission a mail envelope's admission request minted on this runtime.
   *
   * `origin.envelopeId` is carried into the broker's own admission record by
   * every kicker door, so the envelope-to-submission join is reconstructable
   * from durable evidence and never from HRC memory (spec T-08092 D2 step 2).
   */
  findSubmissionIdForEnvelope(runtimeId: string, envelopeId: string): string | undefined {
    const row = this.db
      .query<{ submissionId: string | null }, [string, string]>(
        `SELECT json_extract(broker_event_json, '$.submissionId') AS submissionId
           FROM broker_invocation_events
          WHERE runtime_id = ?
            AND type = 'admission.requested'
            AND json_extract(broker_event_json, '$.origin.envelopeId') = ?
          ORDER BY time DESC, seq DESC
          LIMIT 1`
      )
      .get(runtimeId, envelopeId)
    return row?.submissionId ?? undefined
  }

  findUniqueSubmissionForEnvelopeAfter(input: {
    runtimeId: string
    invocationId: string
    envelopeId: string
    afterSeq: number
    includeRetained?: boolean | undefined
  }): string | undefined {
    const rows = this.db
      .query<{ submissionId: string | null }, [string, string, number, string]>(
        `SELECT DISTINCT json_extract(broker_event_json, '$.submissionId') AS submissionId
         FROM broker_invocation_events WHERE runtime_id = ? AND invocation_id = ?
           AND seq > ? AND type = 'admission.requested'
           AND json_extract(broker_event_json, '$.origin.envelopeId') = ?
           ${retainedFencePredicate(input.includeRetained)}`
      )
      .all(input.runtimeId, input.invocationId, input.afterSeq, input.envelopeId)
    const ids = rows
      .map((row) => row.submissionId)
      .filter((id): id is string => typeof id === 'string')
    return ids.length === 1 ? ids[0] : undefined
  }

  /**
   * Node-wide broker commit high-water (T-08607): `MAX(id)` over
   * broker_invocation_events. `id` is `INTEGER PRIMARY KEY AUTOINCREMENT` —
   * the commit ordinal (V5 decision: keep it; AUTOINCREMENT ids are never
   * reused, so retention pruning the old end cannot alias a cursor).
   */
  maxBrokerCommitId(): number {
    const row = this.db
      .query<{ max_id: number | null }, []>(
        'SELECT MAX(id) AS max_id FROM broker_invocation_events'
      )
      .get()
    return row?.max_id ?? 0
  }

  /**
   * Commit-ordered broker event page for the follow route (T-08607).
   * Newer-or-equal on the commit ordinal: `id >= afterCommit`, ascending, so a
   * retried follow re-observes the boundary row instead of skipping it
   * (at-least-once; the injector dedupes by ordinal). The retained fence is
   * explicit: callers that do not pass `includeRetained` keep the historical
   * unfiltered read; the socket routes always pass it through from the request.
   */
  listBrokerEventsAfterCommit(input: {
    afterCommit: number
    limit: number
    includeRetained?: boolean | undefined
  }): HrcBrokerInvocationEventRecord[] {
    const fence =
      input.includeRetained === true
        ? ''
        : `AND (evidence_origin IS NULL OR evidence_origin != 'retained')`
    return this.db
      .query<BrokerInvocationEventRow, [number, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE id >= ? ${fence}
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(input.afterCommit, input.limit)
      .map((row) => this.mapRow(row))
  }

  maxBrokerSeq(invocationId: string): number {
    const row = this.db
      .query<{ max_seq: number | null }, [string]>(
        'SELECT MAX(seq) AS max_seq FROM broker_invocation_events WHERE invocation_id = ?'
      )
      .get(invocationId)

    return row?.max_seq ?? 0
  }

  getProjectionDisposition(invocationId: string, seq: number): BrokerProjectionDisposition | null {
    const row = this.db
      .query<
        {
          invocation_id: string
          seq: number
          envelope_hash: string
          disposition: 'applied' | 'skipped_fenced' | 'skipped_duplicate'
          created_at: string
        },
        [string, number]
      >(
        `SELECT invocation_id, seq, envelope_hash, disposition, created_at
         FROM broker_projection_dispositions
         WHERE invocation_id = ? AND seq = ?`
      )
      .get(invocationId, seq)
    return row
      ? {
          invocationId: row.invocation_id,
          seq: row.seq,
          envelopeHash: row.envelope_hash,
          disposition: row.disposition,
          createdAt: row.created_at,
        }
      : null
  }

  hasProjectionDisposition(invocationId: string, seq: number): boolean {
    return this.getProjectionDisposition(invocationId, seq) !== null
  }

  /**
   * Resolve one broker sequence without storing a second envelope copy. A
   * replay with the same hash is idempotent; a divergent hash is the same
   * fail-closed conflict as the normalized-envelope mirror.
   */
  recordProjectionDisposition(input: BrokerProjectionDisposition): {
    disposition: BrokerProjectionDisposition
    idempotent: boolean
  } {
    const existing = this.getProjectionDisposition(input.invocationId, input.seq)
    if (existing) {
      if (
        existing.envelopeHash !== input.envelopeHash ||
        existing.disposition !== input.disposition
      ) {
        throw new BrokerInvocationEventConflictError(input.invocationId, input.seq)
      }
      return { disposition: existing, idempotent: true }
    }
    execute(
      this.db,
      `INSERT INTO broker_projection_dispositions (
         invocation_id, seq, envelope_hash, disposition, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      input.invocationId,
      input.seq,
      input.envelopeHash,
      input.disposition,
      input.createdAt
    )
    return { disposition: input, idempotent: false }
  }

  /**
   * Advance only across an unbroken run of committed dispositions. This is
   * independent of broker_invocation_events retention/mirroring, so raw deltas
   * cannot create false source gaps.
   */
  advanceContiguousProjectionCursor(invocationId: string, updatedAt: string): number {
    const invocation = this.db
      .query<{ last_projected_seq: number }, [string]>(
        'SELECT last_projected_seq FROM broker_invocations WHERE invocation_id = ?'
      )
      .get(invocationId)
    if (!invocation) throw new Error(`broker invocation not found: ${invocationId}`)

    let throughSeq = invocation.last_projected_seq
    const rows = this.db
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM broker_projection_dispositions
         WHERE invocation_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(invocationId, throughSeq)
    for (const row of rows) {
      if (row.seq !== throughSeq + 1) break
      throughSeq = row.seq
    }
    if (throughSeq !== invocation.last_projected_seq) {
      execute(
        this.db,
        `UPDATE broker_invocations
         SET last_projected_seq = ?, updated_at = ?
         WHERE invocation_id = ?`,
        throughSeq,
        updatedAt,
        invocationId
      )
    }
    return throughSeq
  }

  listFromAfterSeq(
    selector: BrokerInvocationEventAfterSeqSelector
  ): HrcBrokerInvocationEventRecord[] {
    const rows =
      selector.runId !== undefined
        ? this.db
            .query<BrokerInvocationEventRow, [string, string, string, number]>(
              `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
                WHERE invocation_id = ?
                  AND run_id = ?
                  AND runtime_id = ?
                  AND seq > ?
                ORDER BY seq ASC`
            )
            .all(selector.invocationId, selector.runId, selector.runtimeId, selector.afterSeq)
        : this.db
            .query<BrokerInvocationEventRow, [string, string, number]>(
              `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
                WHERE invocation_id = ?
                  AND runtime_id = ?
                  AND seq > ?
                ORDER BY seq ASC`
            )
            .all(selector.invocationId, selector.runtimeId, selector.afterSeq)

    return rows.map((row) => this.mapRow(row))
  }

  /** Record projection outcome (hrc event seq + status) after the mapper runs. */
  updateProjection(
    invocationId: string,
    seq: number,
    update: BrokerInvocationEventProjectionUpdate
  ): HrcBrokerInvocationEventRecord | null {
    const entries = collectPatchEntries(update, BROKER_INVOCATION_EVENT_PROJECTION_SPEC)

    if (entries.length === 0) {
      return this.getByInvocationAndSeq(invocationId, seq)
    }

    const { clause, values } = buildSetClause(entries)
    execute(
      this.db,
      `UPDATE broker_invocation_events SET ${clause} WHERE invocation_id = ? AND seq = ?`,
      ...values,
      invocationId,
      seq
    )
    return this.getByInvocationAndSeq(invocationId, seq)
  }
}

export class RuntimeArtifactRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcRuntimeArtifactRecord): HrcRuntimeArtifactRecord {
    execute(
      this.db,
      `
        INSERT INTO runtime_artifacts (
          artifact_id,
          operation_id,
          artifact_kind,
          media_type,
          storage_kind,
          content_hash,
          artifact_json,
          artifact_path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.artifactId,
      record.operationId,
      record.artifactKind,
      record.mediaType,
      record.storageKind,
      record.contentHash,
      record.artifactJson ?? null,
      record.artifactPath ?? null,
      record.createdAt
    )

    return requireRecord(
      this.getByArtifactId(record.artifactId),
      `failed to reload runtime artifact ${record.artifactId}`
    )
  }

  insertIdempotent(record: HrcRuntimeArtifactRecord): HrcRuntimeArtifactRecord {
    const existing = this.getByArtifactId(record.artifactId)
    if (existing) {
      if (!sameRuntimeArtifact(existing, record)) {
        throw new Error(
          `runtime_artifacts conflict: artifact_id=${record.artifactId} already exists with different content`
        )
      }
      return existing
    }
    return this.insert(record)
  }

  getByArtifactId(artifactId: string): HrcRuntimeArtifactRecord | null {
    const row = this.db
      .query<RuntimeArtifactRow, [string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts WHERE artifact_id = ?`
      )
      .get(artifactId)

    return row ? mapRuntimeArtifactRow(row) : null
  }

  listByOperationId(operationId: string): HrcRuntimeArtifactRecord[] {
    const rows = this.db
      .query<RuntimeArtifactRow, [string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE operation_id = ?
          ORDER BY created_at ASC, artifact_id ASC`
      )
      .all(operationId)

    return rows.map(mapRuntimeArtifactRow)
  }

  listByOperationIdAndKind(operationId: string, artifactKind: string): HrcRuntimeArtifactRecord[] {
    const rows = this.db
      .query<RuntimeArtifactRow, [string, string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE operation_id = ? AND artifact_kind = ?
          ORDER BY created_at ASC, artifact_id ASC`
      )
      .all(operationId, artifactKind)

    return rows.map(mapRuntimeArtifactRow)
  }

  getLatestByOperationIdAndKind(
    operationId: string,
    artifactKind: string
  ): HrcRuntimeArtifactRecord | null {
    const row = this.db
      .query<RuntimeArtifactRow, [string, string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE operation_id = ? AND artifact_kind = ?
          ORDER BY created_at DESC, artifact_id DESC
          LIMIT 1`
      )
      .get(operationId, artifactKind)

    return row ? mapRuntimeArtifactRow(row) : null
  }

  listByKind(artifactKind: string): HrcRuntimeArtifactRecord[] {
    const rows = this.db
      .query<RuntimeArtifactRow, [string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE artifact_kind = ?
          ORDER BY created_at ASC, artifact_id ASC`
      )
      .all(artifactKind)

    return rows.map(mapRuntimeArtifactRow)
  }

  /**
   * T-07235 — the repository's only deletion path. Artifact classes with a
   * declared retention policy (see docs/state-retention.md) prune their own
   * rows through this; nothing here deletes by age or by sweep on its own.
   * Returns true when a row was removed.
   */
  deleteByArtifactId(artifactId: string): boolean {
    const result = this.db
      .query('DELETE FROM runtime_artifacts WHERE artifact_id = ?')
      .run(artifactId) as { changes?: number }
    return (result.changes ?? 0) > 0
  }
}

function sameRuntimeArtifact(
  existing: HrcRuntimeArtifactRecord,
  next: HrcRuntimeArtifactRecord
): boolean {
  return (
    existing.operationId === next.operationId &&
    existing.artifactKind === next.artifactKind &&
    existing.mediaType === next.mediaType &&
    existing.storageKind === next.storageKind &&
    existing.contentHash === next.contentHash &&
    (existing.artifactJson ?? null) === (next.artifactJson ?? null) &&
    (existing.artifactPath ?? null) === (next.artifactPath ?? null) &&
    existing.createdAt === next.createdAt
  )
}

export function computePermissionIdentityKey(input: {
  invocationId: string
  harnessGeneration?: number | null | undefined
  turnAttempt?: number | null | undefined
  permissionRequestId: string
}): string {
  return JSON.stringify([
    input.invocationId,
    input.harnessGeneration ?? null,
    input.turnAttempt ?? null,
    input.permissionRequestId,
  ])
}

export class PermissionDecisionRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcPermissionDecisionRecord): HrcPermissionDecisionRecord {
    const permissionIdentityKey =
      record.permissionIdentityKey ??
      computePermissionIdentityKey({
        invocationId: record.invocationId,
        harnessGeneration: record.harnessGeneration,
        turnAttempt: record.turnAttempt,
        permissionRequestId: record.permissionRequestId,
      })

    execute(
      this.db,
      `
        INSERT INTO permission_decisions (
          permission_identity_key,
          permission_request_id,
          invocation_id,
          harness_generation,
          turn_attempt,
          runtime_id,
          run_id,
          kind,
          subject_display_json,
          default_decision,
          decision,
          decided_by,
          policy_json,
          requested_at,
          decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      permissionIdentityKey,
      record.permissionRequestId,
      record.invocationId,
      record.harnessGeneration ?? null,
      record.turnAttempt ?? null,
      record.runtimeId,
      record.runId ?? null,
      record.kind,
      record.subjectDisplayJson,
      record.defaultDecision,
      record.decision,
      record.decidedBy,
      record.policyJson,
      record.requestedAt,
      record.decidedAt
    )

    return requireRecord(
      this.getByPermissionIdentityKey(permissionIdentityKey),
      `failed to reload permission decision ${permissionIdentityKey}`
    )
  }

  getByPermissionIdentityKey(permissionIdentityKey: string): HrcPermissionDecisionRecord | null {
    const row = this.db
      .query<PermissionDecisionRow, [string]>(
        `SELECT ${PERMISSION_DECISION_COLUMNS} FROM permission_decisions
          WHERE permission_identity_key = ?`
      )
      .get(permissionIdentityKey)

    return row ? mapPermissionDecisionRow(row) : null
  }

  getByPermissionRequestId(permissionRequestId: string): HrcPermissionDecisionRecord | null {
    const row = this.db
      .query<PermissionDecisionRow, [string]>(
        `SELECT ${PERMISSION_DECISION_COLUMNS} FROM permission_decisions
          WHERE permission_request_id = ?
          ORDER BY requested_at ASC, permission_identity_key ASC
          LIMIT 1`
      )
      .get(permissionRequestId)

    return row ? mapPermissionDecisionRow(row) : null
  }

  listByInvocationId(invocationId: string): HrcPermissionDecisionRecord[] {
    const rows = this.db
      .query<PermissionDecisionRow, [string]>(
        `SELECT ${PERMISSION_DECISION_COLUMNS} FROM permission_decisions
          WHERE invocation_id = ?
          ORDER BY requested_at ASC, permission_identity_key ASC`
      )
      .all(invocationId)

    return rows.map(mapPermissionDecisionRow)
  }
}
