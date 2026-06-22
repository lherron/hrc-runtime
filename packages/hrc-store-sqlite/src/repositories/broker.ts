import type {
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcCompiledRuntimePlanRecord,
  HrcLifecyclePolicyRecord,
  HrcPermissionDecisionRecord,
  HrcRuntimeArtifactRecord,
  HrcRuntimeOperationRecord,
} from 'hrc-core'

// ── Harness Broker persistence repositories (T-01690 W1B) ──────────────────
// Repositories for the six broker tables added in migration 0016. They are
// additive and inert: nothing here is wired into any live dispatch path. The
// harness-broker controller (W4) and event mapper (W3A) are the only callers,
// and they are unreachable unless HRC_HEADLESS_CODEX_BROKER_ENABLED is set.

export type LifecyclePolicyRow = {
  policy_id: string
  lifecycle_policy_hash: string
  canonical_policy_json: string
  schema_version: string
  created_at: string
}

export type CompiledRuntimePlanRow = {
  plan_hash: string
  compile_id: string
  schema_version: string
  compiler_name: string
  compiler_version: string
  plan_projection_json: string
  diagnostics_json: string | null
  created_at: string
}

export type RuntimeOperationRow = {
  operation_id: string
  runtime_id: string
  run_id: string | null
  host_session_id: string
  generation: number
  operation_kind: string
  controller: string
  compile_id: string | null
  plan_hash: string | null
  selected_profile_id: string | null
  selected_profile_hash: string | null
  startup_method: string
  turn_delivery: string | null
  status: string
  route_decision_json: string
  capability_resolution_json: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
  error_code: string | null
  error_message: string | null
}

export type BrokerInvocationRow = {
  invocation_id: string
  operation_id: string
  runtime_id: string
  run_id: string | null
  broker_protocol: string
  broker_driver: string
  broker_pid: number | null
  child_pid: number | null
  invocation_state: string
  capabilities_json: string
  continuation_json: string | null
  broker_continuation_json: string | null
  spec_hash: string
  start_request_hash: string
  selected_profile_hash: string
  spec_projection_json: string | null
  start_request_projection_json: string | null
  last_event_seq: number | null
  owner_server_instance_id: string | null
  lifecycle_policy_hash: string | null
  current_harness_generation: number | null
  current_turn_attempt: number | null
  lifecycle_terminal_reason: string | null
  last_lifecycle_escalation_json: string | null
  created_at: string
  updated_at: string
}

export type BrokerInvocationEventRow = {
  invocation_id: string
  seq: number
  time: string
  type: string
  run_id: string | null
  runtime_id: string
  harness_generation: number | null
  turn_attempt: number | null
  broker_event_json: string
  broker_envelope_json: string | null
  hrc_event_seq: number | null
  projection_status: string
  projection_error: string | null
  created_at: string
}

export type RuntimeArtifactRow = {
  artifact_id: string
  operation_id: string
  artifact_kind: string
  media_type: string
  storage_kind: string
  content_hash: string
  artifact_json: string | null
  artifact_path: string | null
  created_at: string
}

export type PermissionDecisionRow = {
  permission_identity_key: string
  permission_request_id: string
  invocation_id: string
  harness_generation: number | null
  turn_attempt: number | null
  runtime_id: string
  run_id: string | null
  kind: string
  subject_display_json: string
  default_decision: string
  decision: string
  decided_by: string
  policy_json: string
  requested_at: string
  decided_at: string
}

export const LIFECYCLE_POLICY_COLUMNS = `
  policy_id,
  lifecycle_policy_hash,
  canonical_policy_json,
  schema_version,
  created_at`

export const COMPILED_RUNTIME_PLAN_COLUMNS = `
  plan_hash,
  compile_id,
  schema_version,
  compiler_name,
  compiler_version,
  plan_projection_json,
  diagnostics_json,
  created_at`

export const RUNTIME_OPERATION_COLUMNS = `
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
  error_message`

export const BROKER_INVOCATION_COLUMNS = `
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
  updated_at`

export const BROKER_INVOCATION_EVENT_COLUMNS = `
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
  created_at`

export const RUNTIME_ARTIFACT_COLUMNS = `
  artifact_id,
  operation_id,
  artifact_kind,
  media_type,
  storage_kind,
  content_hash,
  artifact_json,
  artifact_path,
  created_at`

export const PERMISSION_DECISION_COLUMNS = `
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
  decided_at`

export function mapLifecyclePolicyRow(row: LifecyclePolicyRow): HrcLifecyclePolicyRecord {
  return {
    policyId: row.policy_id,
    lifecyclePolicyHash: row.lifecycle_policy_hash,
    canonicalPolicyJson: row.canonical_policy_json,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  }
}

export function mapCompiledRuntimePlanRow(
  row: CompiledRuntimePlanRow
): HrcCompiledRuntimePlanRecord {
  return {
    planHash: row.plan_hash,
    compileId: row.compile_id,
    schemaVersion: row.schema_version,
    compilerName: row.compiler_name,
    compilerVersion: row.compiler_version,
    planProjectionJson: row.plan_projection_json,
    ...(row.diagnostics_json !== null ? { diagnosticsJson: row.diagnostics_json } : {}),
    createdAt: row.created_at,
  }
}

export function mapRuntimeOperationRow(row: RuntimeOperationRow): HrcRuntimeOperationRecord {
  return {
    operationId: row.operation_id,
    runtimeId: row.runtime_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    hostSessionId: row.host_session_id,
    generation: row.generation,
    operationKind: row.operation_kind,
    controller: row.controller,
    ...(row.compile_id !== null ? { compileId: row.compile_id } : {}),
    ...(row.plan_hash !== null ? { planHash: row.plan_hash } : {}),
    ...(row.selected_profile_id !== null ? { selectedProfileId: row.selected_profile_id } : {}),
    ...(row.selected_profile_hash !== null
      ? { selectedProfileHash: row.selected_profile_hash }
      : {}),
    startupMethod: row.startup_method,
    ...(row.turn_delivery !== null ? { turnDelivery: row.turn_delivery } : {}),
    status: row.status,
    routeDecisionJson: row.route_decision_json,
    ...(row.capability_resolution_json !== null
      ? { capabilityResolutionJson: row.capability_resolution_json }
      : {}),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    updatedAt: row.updated_at,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  }
}

export function mapBrokerInvocationRow(row: BrokerInvocationRow): HrcBrokerInvocationRecord {
  return {
    invocationId: row.invocation_id,
    operationId: row.operation_id,
    runtimeId: row.runtime_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    brokerProtocol: row.broker_protocol,
    brokerDriver: row.broker_driver,
    ...(row.broker_pid !== null ? { brokerPid: row.broker_pid } : {}),
    ...(row.child_pid !== null ? { childPid: row.child_pid } : {}),
    invocationState: row.invocation_state,
    capabilitiesJson: row.capabilities_json,
    ...(row.continuation_json !== null ? { continuationJson: row.continuation_json } : {}),
    ...(row.broker_continuation_json !== null
      ? { brokerContinuationJson: row.broker_continuation_json }
      : {}),
    specHash: row.spec_hash,
    startRequestHash: row.start_request_hash,
    selectedProfileHash: row.selected_profile_hash,
    ...(row.spec_projection_json !== null ? { specProjectionJson: row.spec_projection_json } : {}),
    ...(row.start_request_projection_json !== null
      ? { startRequestProjectionJson: row.start_request_projection_json }
      : {}),
    ...(row.last_event_seq !== null ? { lastEventSeq: row.last_event_seq } : {}),
    ...(row.owner_server_instance_id !== null
      ? { ownerServerInstanceId: row.owner_server_instance_id }
      : {}),
    ...(row.lifecycle_policy_hash !== null
      ? { lifecyclePolicyHash: row.lifecycle_policy_hash }
      : {}),
    ...(row.current_harness_generation !== null
      ? { currentHarnessGeneration: row.current_harness_generation }
      : {}),
    ...(row.current_turn_attempt !== null ? { currentTurnAttempt: row.current_turn_attempt } : {}),
    ...(row.lifecycle_terminal_reason !== null
      ? { lifecycleTerminalReason: row.lifecycle_terminal_reason }
      : {}),
    ...(row.last_lifecycle_escalation_json !== null
      ? { lastLifecycleEscalationJson: row.last_lifecycle_escalation_json }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapBrokerInvocationEventRow(
  row: BrokerInvocationEventRow
): HrcBrokerInvocationEventRecord {
  return {
    invocationId: row.invocation_id,
    seq: row.seq,
    time: row.time,
    type: row.type,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    runtimeId: row.runtime_id,
    ...(row.harness_generation !== null ? { harnessGeneration: row.harness_generation } : {}),
    ...(row.turn_attempt !== null ? { turnAttempt: row.turn_attempt } : {}),
    brokerEventJson: row.broker_event_json,
    ...(row.broker_envelope_json !== null
      ? { brokerEnvelopeJson: row.broker_envelope_json }
      : {}),
    ...(row.hrc_event_seq !== null ? { hrcEventSeq: row.hrc_event_seq } : {}),
    projectionStatus: row.projection_status,
    ...(row.projection_error !== null ? { projectionError: row.projection_error } : {}),
    createdAt: row.created_at,
  }
}

export function mapRuntimeArtifactRow(row: RuntimeArtifactRow): HrcRuntimeArtifactRecord {
  return {
    artifactId: row.artifact_id,
    operationId: row.operation_id,
    artifactKind: row.artifact_kind,
    mediaType: row.media_type,
    storageKind: row.storage_kind,
    contentHash: row.content_hash,
    ...(row.artifact_json !== null ? { artifactJson: row.artifact_json } : {}),
    ...(row.artifact_path !== null ? { artifactPath: row.artifact_path } : {}),
    createdAt: row.created_at,
  }
}

export function mapPermissionDecisionRow(row: PermissionDecisionRow): HrcPermissionDecisionRecord {
  return {
    permissionIdentityKey: row.permission_identity_key,
    permissionRequestId: row.permission_request_id,
    invocationId: row.invocation_id,
    ...(row.harness_generation !== null ? { harnessGeneration: row.harness_generation } : {}),
    ...(row.turn_attempt !== null ? { turnAttempt: row.turn_attempt } : {}),
    runtimeId: row.runtime_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    kind: row.kind,
    subjectDisplayJson: row.subject_display_json,
    defaultDecision: row.default_decision,
    decision: row.decision,
    decidedBy: row.decided_by,
    policyJson: row.policy_json,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  }
}
