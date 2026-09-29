import type { Database } from 'bun:sqlite'
import type {
  HrcBrokerInvocationRecord,
  HrcCompiledRuntimePlanRecord,
  HrcLifecyclePolicyRecord,
  HrcRuntimeOperationRecord,
} from 'hrc-core'
import {
  BROKER_INVOCATION_COLUMNS,
  type BrokerInvocationRow,
  COMPILED_RUNTIME_PLAN_COLUMNS,
  type CompiledRuntimePlanRow,
  LIFECYCLE_POLICY_COLUMNS,
  type LifecyclePolicyRow,
  RUNTIME_OPERATION_COLUMNS,
  type RuntimeOperationRow,
  mapBrokerInvocationRow,
  mapCompiledRuntimePlanRow,
  mapLifecyclePolicyRow,
  mapRuntimeOperationRow,
} from './broker.js'
import {
  type PatchEntrySpec,
  buildSetClause,
  collectPatchEntries,
  execute,
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
  { key: 'executionFormat', column: 'execution_format' },
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
          execution_format,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.invocationId,
      record.operationId,
      record.runtimeId,
      record.runId ?? null,
      record.executionFormat ?? 'format1',
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
