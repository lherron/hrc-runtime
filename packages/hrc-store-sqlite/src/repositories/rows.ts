import type {
  HrcErrorCode,
  HrcEventEnvelope,
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcManagedSessionRecord,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcActiveInputDeliveryRecord, LocalBridgeStatus } from './shared.js'

export type ContinuityRow = {
  scope_ref: string
  lane_ref: string
  active_host_session_id: string
  updated_at: string
}

export type ContinuityChainRow = {
  host_session_id: string
  prior_host_session_id: string | null
  generation: number
}

export type SessionRow = {
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

export type RuntimeRow = {
  runtime_id: string
  runtime_kind: HrcRuntimeSnapshot['runtimeKind'] | null
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
  surface_json: string | null
  wrapper_pid: number | null
  child_pid: number | null
  harness_session_json: string | null
  command_spec_json: string | null
  continuation_json: string | null
  supports_inflight_input: number
  adopted: number
  active_run_id: string | null
  last_activity_at: string | null
  controller_kind: string | null
  active_operation_id: string | null
  active_invocation_id: string | null
  compile_id: string | null
  plan_hash: string | null
  selected_profile_hash: string | null
  runtime_state_json: string | null
  lifecycle_policy_hash: string | null
  current_harness_generation: number | null
  current_turn_attempt: number | null
  lifecycle_terminal_reason: string | null
  last_lifecycle_escalation_json: string | null
  created_at: string
  updated_at: string
}

export type RunRow = {
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
  error_code: HrcErrorCode | null
  error_message: string | null
  operation_id: string | null
  invocation_id: string | null
  dispatched_input_id: string | null
}

export type LaunchRow = {
  launch_id: string
  host_session_id: string
  generation: number
  runtime_id: string | null
  harness: HrcLaunchRecord['harness']
  provider: HrcLaunchRecord['provider']
  launch_artifact_path: string
  tmux_json: string | null
  surface_json: string | null
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

export type EventRow = {
  seq: number
  stream_seq: number
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

export type HrcEventRow = {
  hrc_seq: number
  stream_seq: number
  ts: string
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  runtime_id: string | null
  run_id: string | null
  launch_id: string | null
  app_id: string | null
  app_session_key: string | null
  category: HrcLifecycleEvent['category']
  event_kind: string
  transport: HrcLifecycleEvent['transport'] | null
  error_code: string | null
  replayed: number
  payload_json: string
}

export type RuntimeBufferRow = {
  runtime_id: string
  run_id: string
  chunk_seq: number
  text: string
  created_at: string
}

export type ActiveInputDeliveryRow = {
  input_application_id: string
  input_attempt_id: string
  idempotency_key: string | null
  host_session_id: string | null
  generation: number | null
  runtime_id: string | null
  run_id: string | null
  status: HrcActiveInputDeliveryRecord['status']
  request_json: string
  response_json: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export type SurfaceBindingRow = {
  surface_kind: string
  surface_id: string
  host_session_id: string
  runtime_id: string
  generation: number
  window_id: string | null
  tab_id: string | null
  pane_id: string | null
  bound_at: string
  unbound_at: string | null
  reason: string | null
}

export type AppSessionRow = {
  app_id: string
  app_session_key: string
  host_session_id: string
  label: string | null
  metadata_json: string | null
  created_at: string
  updated_at: string
  removed_at: string | null
}

export type AppManagedSessionRow = {
  app_id: string
  app_session_key: string
  kind: HrcManagedSessionRecord['kind']
  label: string | null
  metadata_json: string | null
  active_host_session_id: string
  generation: number
  status: HrcManagedSessionRecord['status']
  last_applied_spec_json: string | null
  created_at: string
  updated_at: string
  removed_at: string | null
}

export type LocalBridgeRow = {
  bridge_id: string
  host_session_id: string
  runtime_id: string | null
  transport: string
  target: string
  expected_host_session_id: string | null
  expected_generation: number | null
  status: LocalBridgeStatus
  created_at: string
  closed_at: string | null
}
