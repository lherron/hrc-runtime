import type { Database } from 'bun:sqlite'
import type {
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcCompiledRuntimePlanRecord,
  HrcLifecyclePolicyRecord,
  HrcPermissionDecisionRecord,
  HrcRuntimeArtifactRecord,
  HrcRuntimeOperationRecord,
} from 'hrc-core'
import {
  BROKER_INVOCATION_COLUMNS,
  BROKER_INVOCATION_EVENT_COLUMNS,
  type BrokerInvocationEventRow,
  type BrokerInvocationRow,
  COMPILED_RUNTIME_PLAN_COLUMNS,
  type CompiledRuntimePlanRow,
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
  nullableTransform,
  requireRecord,
} from './shared.js'

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
  { key: 'runId', column: 'run_id', transform: nullableTransform },
  { key: 'hostSessionId', column: 'host_session_id' },
  { key: 'generation', column: 'generation' },
  { key: 'operationKind', column: 'operation_kind' },
  { key: 'controller', column: 'controller' },
  { key: 'compileId', column: 'compile_id', transform: nullableTransform },
  { key: 'planHash', column: 'plan_hash', transform: nullableTransform },
  { key: 'selectedProfileId', column: 'selected_profile_id', transform: nullableTransform },
  { key: 'selectedProfileHash', column: 'selected_profile_hash', transform: nullableTransform },
  { key: 'startupMethod', column: 'startup_method' },
  { key: 'turnDelivery', column: 'turn_delivery', transform: nullableTransform },
  { key: 'status', column: 'status' },
  { key: 'routeDecisionJson', column: 'route_decision_json' },
  {
    key: 'capabilityResolutionJson',
    column: 'capability_resolution_json',
    transform: nullableTransform,
  },
  { key: 'startedAt', column: 'started_at', transform: nullableTransform },
  { key: 'completedAt', column: 'completed_at', transform: nullableTransform },
  { key: 'updatedAt', column: 'updated_at' },
  { key: 'errorCode', column: 'error_code', transform: nullableTransform },
  { key: 'errorMessage', column: 'error_message', transform: nullableTransform },
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
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.errorMessage ?? null
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
  { key: 'runId', column: 'run_id', transform: nullableTransform },
  { key: 'brokerProtocol', column: 'broker_protocol' },
  { key: 'brokerDriver', column: 'broker_driver' },
  { key: 'brokerPid', column: 'broker_pid', transform: nullableTransform },
  { key: 'childPid', column: 'child_pid', transform: nullableTransform },
  { key: 'invocationState', column: 'invocation_state' },
  { key: 'capabilitiesJson', column: 'capabilities_json' },
  { key: 'continuationJson', column: 'continuation_json', transform: nullableTransform },
  {
    key: 'brokerContinuationJson',
    column: 'broker_continuation_json',
    transform: nullableTransform,
  },
  { key: 'specHash', column: 'spec_hash' },
  { key: 'startRequestHash', column: 'start_request_hash' },
  { key: 'selectedProfileHash', column: 'selected_profile_hash' },
  { key: 'specProjectionJson', column: 'spec_projection_json', transform: nullableTransform },
  {
    key: 'startRequestProjectionJson',
    column: 'start_request_projection_json',
    transform: nullableTransform,
  },
  { key: 'lastEventSeq', column: 'last_event_seq', transform: nullableTransform },
  {
    key: 'ownerServerInstanceId',
    column: 'owner_server_instance_id',
    transform: nullableTransform,
  },
  { key: 'lifecyclePolicyHash', column: 'lifecycle_policy_hash', transform: nullableTransform },
  {
    key: 'currentHarnessGeneration',
    column: 'current_harness_generation',
    transform: nullableTransform,
  },
  { key: 'currentTurnAttempt', column: 'current_turn_attempt', transform: nullableTransform },
  {
    key: 'lifecycleTerminalReason',
    column: 'lifecycle_terminal_reason',
    transform: nullableTransform,
  },
  {
    key: 'lastLifecycleEscalationJson',
    column: 'last_lifecycle_escalation_json',
    transform: nullableTransform,
  },
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
          owner_server_instance_id,
          lifecycle_policy_hash,
          current_harness_generation,
          current_turn_attempt,
          lifecycle_terminal_reason,
          last_lifecycle_escalation_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  hrcEventSeq?: number | undefined
  projectionStatus?: HrcBrokerInvocationEventRecord['projectionStatus'] | undefined
  projectionError?: string | undefined
  createdAt?: string | undefined
}

export type BrokerInvocationEventAppendResult = {
  record: HrcBrokerInvocationEventRecord
  /** True when an identical event already existed and the append was a no-op. */
  idempotent: boolean
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
  { key: 'hrcEventSeq', column: 'hrc_event_seq', transform: nullableTransform },
  { key: 'projectionStatus', column: 'projection_status' },
  { key: 'projectionError', column: 'projection_error', transform: nullableTransform },
]

export class BrokerInvocationEventRepository {
  private readonly appendInTransaction: (
    input: BrokerInvocationEventAppendInput
  ) => BrokerInvocationEventAppendResult

  constructor(private readonly db: Database) {
    this.appendInTransaction = db.transaction(
      (input: BrokerInvocationEventAppendInput): BrokerInvocationEventAppendResult => {
        const brokerEventJson = JSON.stringify(input.payload ?? null)

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
            existing.broker_event_json === brokerEventJson &&
            (existing.run_id ?? null) === (input.runId ?? null) &&
            (existing.harness_generation ?? null) === (input.harnessGeneration ?? null) &&
            (existing.turn_attempt ?? null) === (input.turnAttempt ?? null)
          if (!sameIdentity) {
            throw new BrokerInvocationEventConflictError(input.invocationId, input.seq)
          }
          return { record: mapBrokerInvocationEventRow(existing), idempotent: true }
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
              hrc_event_seq,
              projection_status,
              projection_error,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          input.hrcEventSeq ?? null,
          input.projectionStatus ?? 'pending',
          input.projectionError ?? null,
          input.createdAt ?? input.time
        )

        const stored = requireRecord(
          this.getByInvocationAndSeq(input.invocationId, input.seq),
          `failed to reload broker invocation event ${input.invocationId}/${input.seq}`
        )
        return { record: stored, idempotent: false }
      }
    )
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

  getByInvocationAndSeq(invocationId: string, seq: number): HrcBrokerInvocationEventRecord | null {
    const row = this.db
      .query<BrokerInvocationEventRow, [string, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE invocation_id = ? AND seq = ?`
      )
      .get(invocationId, seq)

    return row ? mapBrokerInvocationEventRow(row) : null
  }

  listByInvocationId(invocationId: string): HrcBrokerInvocationEventRecord[] {
    const rows = this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE invocation_id = ?
          ORDER BY seq ASC`
      )
      .all(invocationId)

    return rows.map(mapBrokerInvocationEventRow)
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
