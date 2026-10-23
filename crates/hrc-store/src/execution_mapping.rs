use hrc_domain::store::json as serde_json;
// Generated typed mapping/patch plumbing; domain behavior remains in repositories.
use crate::{
    Result,
    sessions::{identity, optional_json},
};
use hrc_domain::store::{rows::*, *};
use rusqlite::{Connection, types::Value as SqlValue};

pub(crate) fn runtime_from_row(db: &Connection, r: RuntimesRow) -> Result<RuntimeRecord> {
    crate::validation::runtime_status(&r.status)?;
    Ok(RuntimeRecord {
        runtime_id: r.runtime_id,
        host_session_id: r.host_session_id,
        scope_ref: r.scope_ref.clone(),
        lane_ref: r.lane_ref.clone(),
        generation: r.generation,
        transport: r.transport,
        harness: r.harness,
        provider: r.provider,
        status: r.status,
        status_changed_at: r.status_changed_at.unwrap_or_else(|| "unknown".into()),
        tmux_json: optional_json(r.tmux_json, "tmux_json"),
        supports_inflight_input: r.supports_inflight_input != 0,
        active_run_id: r.active_run_id,
        last_activity_at: r.last_activity_at,
        controller_kind: r.controller_kind,
        active_operation_id: r.active_operation_id,
        active_invocation_id: r.active_invocation_id,
        plan_hash: r.plan_hash,
        selected_profile_hash: r.selected_profile_hash,
        runtime_state_json: optional_json(r.runtime_state_json, "runtime_state_json"),
        lifecycle_terminal_reason: r.lifecycle_terminal_reason,
        presentation: optional_json(r.presentation_json, "presentation_json"),
        created_at: r.created_at,
        updated_at: r.updated_at,
        identity: identity(db, &r.scope_ref, &r.lane_ref)?,
    })
}
pub(crate) fn runtime_to_row(r: &RuntimeRecord) -> Result<RuntimesRow> {
    Ok(RuntimesRow {
        runtime_id: r.runtime_id.clone(),
        host_session_id: r.host_session_id.clone(),
        scope_ref: r.scope_ref.clone(),
        lane_ref: r.lane_ref.clone(),
        generation: r.generation,
        transport: r.transport.clone(),
        harness: r.harness.clone(),
        provider: r.provider.clone(),
        status: r.status.clone(),
        status_changed_at: if r.status_changed_at == "unknown" || r.status_changed_at.is_empty() {
            None
        } else {
            Some(r.status_changed_at.clone())
        },
        tmux_json: r
            .tmux_json
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        supports_inflight_input: i64::from(r.supports_inflight_input),
        active_run_id: r.active_run_id.clone(),
        last_activity_at: r.last_activity_at.clone(),
        controller_kind: r.controller_kind.clone(),
        active_operation_id: r.active_operation_id.clone(),
        active_invocation_id: r.active_invocation_id.clone(),
        plan_hash: r.plan_hash.clone(),
        selected_profile_hash: r.selected_profile_hash.clone(),
        runtime_state_json: r
            .runtime_state_json
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        lifecycle_terminal_reason: r.lifecycle_terminal_reason.clone(),
        presentation_json: r
            .presentation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        created_at: r.created_at.clone(),
        updated_at: r.updated_at.clone(),
    })
}
pub(crate) fn runtime_patch_entries(p: &RuntimePatch) -> Result<Vec<(&'static str, SqlValue)>> {
    let mut values = Vec::new();
    match &p.host_session_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("host_session_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("host_session_id", v.clone().into())),
    }
    match &p.scope_ref {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("scope_ref", SqlValue::Null)),
        Patch::Set(v) => values.push(("scope_ref", v.clone().into())),
    }
    match &p.lane_ref {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("lane_ref", SqlValue::Null)),
        Patch::Set(v) => values.push(("lane_ref", v.clone().into())),
    }
    match &p.generation {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("generation", SqlValue::Null)),
        Patch::Set(v) => values.push(("generation", (*v).into())),
    }
    match &p.transport {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("transport", SqlValue::Null)),
        Patch::Set(v) => values.push(("transport", v.clone().into())),
    }
    match &p.harness {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("harness", SqlValue::Null)),
        Patch::Set(v) => values.push(("harness", v.clone().into())),
    }
    match &p.provider {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("provider", SqlValue::Null)),
        Patch::Set(v) => values.push(("provider", v.clone().into())),
    }
    match &p.status {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("status", SqlValue::Null)),
        Patch::Set(v) => values.push(("status", v.clone().into())),
    }
    match &p.status_changed_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("status_changed_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("status_changed_at", v.clone().into())),
    }
    match &p.tmux_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("tmux_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("tmux_json", serde_json::to_string(v)?.into())),
    }
    match &p.supports_inflight_input {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("supports_inflight_input", SqlValue::Null)),
        Patch::Set(v) => values.push(("supports_inflight_input", i64::from(*v).into())),
    }
    match &p.active_run_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("active_run_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("active_run_id", v.clone().into())),
    }
    match &p.last_activity_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("last_activity_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("last_activity_at", v.clone().into())),
    }
    match &p.controller_kind {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("controller_kind", SqlValue::Null)),
        Patch::Set(v) => values.push(("controller_kind", v.clone().into())),
    }
    match &p.active_operation_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("active_operation_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("active_operation_id", v.clone().into())),
    }
    match &p.active_invocation_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("active_invocation_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("active_invocation_id", v.clone().into())),
    }
    match &p.plan_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("plan_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("plan_hash", v.clone().into())),
    }
    match &p.selected_profile_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("selected_profile_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("selected_profile_hash", v.clone().into())),
    }
    match &p.runtime_state_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("runtime_state_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("runtime_state_json", serde_json::to_string(v)?.into())),
    }
    match &p.lifecycle_terminal_reason {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("lifecycle_terminal_reason", SqlValue::Null)),
        Patch::Set(v) => values.push(("lifecycle_terminal_reason", v.clone().into())),
    }
    match &p.presentation {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("presentation_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("presentation_json", serde_json::to_string(v)?.into())),
    }
    match &p.created_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("created_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("created_at", v.clone().into())),
    }
    match &p.updated_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("updated_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("updated_at", v.clone().into())),
    }
    Ok(values)
}

pub(crate) fn run_from_row(db: &Connection, r: RunsRow) -> Result<RunRecord> {
    let _ = db;
    crate::validation::run_status(&r.status)?;
    Ok(RunRecord {
        run_id: r.run_id,
        host_session_id: r.host_session_id,
        runtime_id: r.runtime_id,
        scope_ref: r.scope_ref,
        lane_ref: r.lane_ref,
        generation: r.generation,
        transport: r.transport,
        status: r.status,
        accepted_at: r.accepted_at,
        started_at: r.started_at,
        completed_at: r.completed_at,
        updated_at: r.updated_at,
        error_code: r.error_code,
        error_message: r.error_message,
        execution_format: (r.execution_format == "format2").then_some(r.execution_format),
        turn_key: r.turn_key,
        native_turn_id: r.native_turn_id,
        native_harness_generation: r.native_harness_generation,
        native_turn_attempt: r.native_turn_attempt,
        initiating_input_id: r.initiating_input_id,
        ownership_conflict_json: r.ownership_conflict_json,
        observation_state: r.observation_state,
        observed_start_hrc_seq: r.observed_start_hrc_seq,
        operation_id: r.operation_id,
        invocation_id: r.invocation_id,
        dispatched_input_id: r.dispatched_input_id,
        broker_submission_id: r.broker_submission_id,
        broker_input_fenced_at: r.broker_input_fenced_at,
        broker_input_fence_reason: r.broker_input_fence_reason,
        dispatch_idempotency_key: r.dispatch_idempotency_key,
        queue_snapshot_id: r.queue_snapshot_id,
        queued_input_seq: r.queued_input_seq,
        queue_snapshot_position: r.queue_snapshot_position,
        coalesced_into_run_id: r.coalesced_into_run_id,
        coalesced_position: r.coalesced_position,
        origin_actor: r.origin_actor,
        origin_kind: r
            .origin_kind
            .filter(|s| matches!(s.as_str(), "human" | "agent" | "system")),
        origin_causation_ref: r.origin_causation_ref,
    })
}
pub(crate) fn run_to_row(r: &RunRecord) -> Result<RunsRow> {
    Ok(RunsRow {
        run_id: r.run_id.clone(),
        host_session_id: r.host_session_id.clone(),
        runtime_id: r.runtime_id.clone(),
        scope_ref: r.scope_ref.clone(),
        lane_ref: r.lane_ref.clone(),
        generation: r.generation,
        transport: r.transport.clone(),
        status: r.status.clone(),
        accepted_at: r.accepted_at.clone(),
        started_at: r.started_at.clone(),
        completed_at: r.completed_at.clone(),
        updated_at: r.updated_at.clone(),
        error_code: r.error_code.clone(),
        error_message: r.error_message.clone(),
        execution_format: r
            .execution_format
            .clone()
            .unwrap_or_else(|| "format1".into()),
        turn_key: r.turn_key.clone(),
        native_turn_id: r.native_turn_id.clone(),
        native_harness_generation: r.native_harness_generation,
        native_turn_attempt: r.native_turn_attempt,
        initiating_input_id: r.initiating_input_id.clone(),
        ownership_conflict_json: r.ownership_conflict_json.clone(),
        observation_state: r.observation_state.clone(),
        observed_start_hrc_seq: r.observed_start_hrc_seq,
        operation_id: r.operation_id.clone(),
        invocation_id: r.invocation_id.clone(),
        dispatched_input_id: r.dispatched_input_id.clone(),
        broker_submission_id: r.broker_submission_id.clone(),
        broker_input_fenced_at: r.broker_input_fenced_at.clone(),
        broker_input_fence_reason: r.broker_input_fence_reason.clone(),
        dispatch_idempotency_key: r.dispatch_idempotency_key.clone(),
        queue_snapshot_id: r.queue_snapshot_id.clone(),
        queued_input_seq: r.queued_input_seq,
        queue_snapshot_position: r.queue_snapshot_position,
        coalesced_into_run_id: r.coalesced_into_run_id.clone(),
        coalesced_position: r.coalesced_position,
        origin_actor: r.origin_actor.clone(),
        origin_kind: r.origin_kind.clone(),
        origin_causation_ref: r.origin_causation_ref.clone(),
        ..Default::default()
    })
}
pub(crate) fn run_patch_entries(p: &RunPatch) -> Result<Vec<(&'static str, SqlValue)>> {
    let mut values = Vec::new();
    match &p.host_session_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("host_session_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("host_session_id", v.clone().into())),
    }
    match &p.runtime_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("runtime_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("runtime_id", v.clone().into())),
    }
    match &p.scope_ref {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("scope_ref", SqlValue::Null)),
        Patch::Set(v) => values.push(("scope_ref", v.clone().into())),
    }
    match &p.lane_ref {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("lane_ref", SqlValue::Null)),
        Patch::Set(v) => values.push(("lane_ref", v.clone().into())),
    }
    match &p.generation {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("generation", SqlValue::Null)),
        Patch::Set(v) => values.push(("generation", (*v).into())),
    }
    match &p.transport {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("transport", SqlValue::Null)),
        Patch::Set(v) => values.push(("transport", v.clone().into())),
    }
    match &p.status {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("status", SqlValue::Null)),
        Patch::Set(v) => values.push(("status", v.clone().into())),
    }
    match &p.accepted_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("accepted_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("accepted_at", v.clone().into())),
    }
    match &p.started_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("started_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("started_at", v.clone().into())),
    }
    match &p.completed_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("completed_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("completed_at", v.clone().into())),
    }
    match &p.updated_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("updated_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("updated_at", v.clone().into())),
    }
    match &p.error_code {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("error_code", SqlValue::Null)),
        Patch::Set(v) => values.push(("error_code", v.clone().into())),
    }
    match &p.error_message {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("error_message", SqlValue::Null)),
        Patch::Set(v) => values.push(("error_message", v.clone().into())),
    }
    match &p.execution_format {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("execution_format", SqlValue::Null)),
        Patch::Set(v) => values.push(("execution_format", v.clone().into())),
    }
    match &p.turn_key {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("turn_key", SqlValue::Null)),
        Patch::Set(v) => values.push(("turn_key", v.clone().into())),
    }
    match &p.native_turn_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("native_turn_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("native_turn_id", v.clone().into())),
    }
    match &p.native_harness_generation {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("native_harness_generation", SqlValue::Null)),
        Patch::Set(v) => values.push(("native_harness_generation", (*v).into())),
    }
    match &p.native_turn_attempt {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("native_turn_attempt", SqlValue::Null)),
        Patch::Set(v) => values.push(("native_turn_attempt", (*v).into())),
    }
    match &p.initiating_input_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("initiating_input_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("initiating_input_id", v.clone().into())),
    }
    match &p.ownership_conflict_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("ownership_conflict_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("ownership_conflict_json", v.clone().into())),
    }
    match &p.observation_state {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("observation_state", SqlValue::Null)),
        Patch::Set(v) => values.push(("observation_state", v.clone().into())),
    }
    match &p.observed_start_hrc_seq {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("observed_start_hrc_seq", SqlValue::Null)),
        Patch::Set(v) => values.push(("observed_start_hrc_seq", (*v).into())),
    }
    match &p.operation_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("operation_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("operation_id", v.clone().into())),
    }
    match &p.invocation_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("invocation_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("invocation_id", v.clone().into())),
    }
    match &p.dispatched_input_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("dispatched_input_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("dispatched_input_id", v.clone().into())),
    }
    match &p.broker_submission_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_submission_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_submission_id", v.clone().into())),
    }
    match &p.broker_input_fenced_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_input_fenced_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_input_fenced_at", v.clone().into())),
    }
    match &p.broker_input_fence_reason {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_input_fence_reason", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_input_fence_reason", v.clone().into())),
    }
    match &p.dispatch_idempotency_key {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("dispatch_idempotency_key", SqlValue::Null)),
        Patch::Set(v) => values.push(("dispatch_idempotency_key", v.clone().into())),
    }
    match &p.queue_snapshot_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("queue_snapshot_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("queue_snapshot_id", v.clone().into())),
    }
    match &p.queued_input_seq {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("queued_input_seq", SqlValue::Null)),
        Patch::Set(v) => values.push(("queued_input_seq", (*v).into())),
    }
    match &p.queue_snapshot_position {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("queue_snapshot_position", SqlValue::Null)),
        Patch::Set(v) => values.push(("queue_snapshot_position", (*v).into())),
    }
    match &p.coalesced_into_run_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("coalesced_into_run_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("coalesced_into_run_id", v.clone().into())),
    }
    match &p.coalesced_position {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("coalesced_position", SqlValue::Null)),
        Patch::Set(v) => values.push(("coalesced_position", (*v).into())),
    }
    match &p.origin_actor {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("origin_actor", SqlValue::Null)),
        Patch::Set(v) => values.push(("origin_actor", v.clone().into())),
    }
    match &p.origin_kind {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("origin_kind", SqlValue::Null)),
        Patch::Set(v) => values.push(("origin_kind", v.clone().into())),
    }
    match &p.origin_causation_ref {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("origin_causation_ref", SqlValue::Null)),
        Patch::Set(v) => values.push(("origin_causation_ref", v.clone().into())),
    }
    Ok(values)
}

pub(crate) fn operation_from_row(
    db: &Connection,
    r: RuntimeOperationsRow,
) -> Result<RuntimeOperation> {
    let _ = db;
    Ok(RuntimeOperation {
        operation_id: r.operation_id,
        runtime_id: r.runtime_id,
        run_id: r.run_id,
        host_session_id: r.host_session_id,
        generation: r.generation,
        operation_kind: r.operation_kind,
        controller: r.controller,
        compile_id: r.compile_id,
        plan_hash: r.plan_hash,
        selected_profile_id: r.selected_profile_id,
        selected_profile_hash: r.selected_profile_hash,
        startup_method: r.startup_method,
        turn_delivery: r.turn_delivery,
        status: r.status,
        route_decision_json: r.route_decision_json,
        capability_resolution_json: r.capability_resolution_json,
        created_at: r.created_at,
        started_at: r.started_at,
        completed_at: r.completed_at,
        updated_at: r.updated_at,
        error_code: r.error_code,
        error_message: r.error_message,
        preparation_json: r.preparation_json,
    })
}
pub(crate) fn operation_to_row(r: &RuntimeOperation) -> Result<RuntimeOperationsRow> {
    Ok(RuntimeOperationsRow {
        operation_id: r.operation_id.clone(),
        runtime_id: r.runtime_id.clone(),
        run_id: r.run_id.clone(),
        host_session_id: r.host_session_id.clone(),
        generation: r.generation,
        operation_kind: r.operation_kind.clone(),
        controller: r.controller.clone(),
        compile_id: r.compile_id.clone(),
        plan_hash: r.plan_hash.clone(),
        selected_profile_id: r.selected_profile_id.clone(),
        selected_profile_hash: r.selected_profile_hash.clone(),
        startup_method: r.startup_method.clone(),
        turn_delivery: r.turn_delivery.clone(),
        status: r.status.clone(),
        route_decision_json: r.route_decision_json.clone(),
        capability_resolution_json: r.capability_resolution_json.clone(),
        created_at: r.created_at.clone(),
        started_at: r.started_at.clone(),
        completed_at: r.completed_at.clone(),
        updated_at: r.updated_at.clone(),
        error_code: r.error_code.clone(),
        error_message: r.error_message.clone(),
        preparation_json: r.preparation_json.clone(),
    })
}
pub(crate) fn operation_patch_entries(
    p: &RuntimeOperationPatch,
) -> Result<Vec<(&'static str, SqlValue)>> {
    let mut values = Vec::new();
    match &p.runtime_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("runtime_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("runtime_id", v.clone().into())),
    }
    match &p.run_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("run_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("run_id", v.clone().into())),
    }
    match &p.host_session_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("host_session_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("host_session_id", v.clone().into())),
    }
    match &p.generation {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("generation", SqlValue::Null)),
        Patch::Set(v) => values.push(("generation", (*v).into())),
    }
    match &p.operation_kind {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("operation_kind", SqlValue::Null)),
        Patch::Set(v) => values.push(("operation_kind", v.clone().into())),
    }
    match &p.controller {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("controller", SqlValue::Null)),
        Patch::Set(v) => values.push(("controller", v.clone().into())),
    }
    match &p.compile_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("compile_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("compile_id", v.clone().into())),
    }
    match &p.plan_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("plan_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("plan_hash", v.clone().into())),
    }
    match &p.selected_profile_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("selected_profile_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("selected_profile_id", v.clone().into())),
    }
    match &p.selected_profile_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("selected_profile_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("selected_profile_hash", v.clone().into())),
    }
    match &p.startup_method {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("startup_method", SqlValue::Null)),
        Patch::Set(v) => values.push(("startup_method", v.clone().into())),
    }
    match &p.turn_delivery {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("turn_delivery", SqlValue::Null)),
        Patch::Set(v) => values.push(("turn_delivery", v.clone().into())),
    }
    match &p.status {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("status", SqlValue::Null)),
        Patch::Set(v) => values.push(("status", v.clone().into())),
    }
    match &p.route_decision_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("route_decision_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("route_decision_json", v.clone().into())),
    }
    match &p.capability_resolution_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("capability_resolution_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("capability_resolution_json", v.clone().into())),
    }
    match &p.started_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("started_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("started_at", v.clone().into())),
    }
    match &p.completed_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("completed_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("completed_at", v.clone().into())),
    }
    match &p.updated_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("updated_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("updated_at", v.clone().into())),
    }
    match &p.error_code {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("error_code", SqlValue::Null)),
        Patch::Set(v) => values.push(("error_code", v.clone().into())),
    }
    match &p.error_message {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("error_message", SqlValue::Null)),
        Patch::Set(v) => values.push(("error_message", v.clone().into())),
    }
    match &p.preparation_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("preparation_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("preparation_json", v.clone().into())),
    }
    Ok(values)
}

pub(crate) fn invocation_from_row(
    db: &Connection,
    r: BrokerInvocationsRow,
) -> Result<BrokerInvocation> {
    let _ = db;
    Ok(BrokerInvocation {
        invocation_id: r.invocation_id,
        operation_id: r.operation_id,
        runtime_id: r.runtime_id,
        run_id: r.run_id,
        execution_format: (r.execution_format == "format2").then_some(r.execution_format),
        broker_protocol: r.broker_protocol,
        broker_driver: r.broker_driver,
        broker_pid: r.broker_pid,
        child_pid: r.child_pid,
        invocation_state: r.invocation_state,
        capabilities_json: r.capabilities_json,
        continuation_json: r.continuation_json,
        broker_continuation_json: r.broker_continuation_json,
        spec_hash: r.spec_hash,
        start_request_hash: r.start_request_hash,
        selected_profile_hash: r.selected_profile_hash,
        spec_projection_json: r.spec_projection_json,
        start_request_projection_json: r.start_request_projection_json,
        last_event_seq: r.last_event_seq,
        last_projected_seq: r.last_projected_seq,
        retained_projected_through_seq: r.retained_projected_through_seq,
        owner_server_instance_id: r.owner_server_instance_id,
        lifecycle_policy_hash: r.lifecycle_policy_hash,
        current_harness_generation: r.current_harness_generation,
        current_turn_attempt: r.current_turn_attempt,
        lifecycle_terminal_reason: r.lifecycle_terminal_reason,
        last_lifecycle_escalation_json: r.last_lifecycle_escalation_json,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}
pub(crate) fn invocation_to_row(r: &BrokerInvocation) -> Result<BrokerInvocationsRow> {
    Ok(BrokerInvocationsRow {
        invocation_id: r.invocation_id.clone(),
        operation_id: r.operation_id.clone(),
        runtime_id: r.runtime_id.clone(),
        run_id: r.run_id.clone(),
        execution_format: r
            .execution_format
            .clone()
            .unwrap_or_else(|| "format1".into()),
        broker_protocol: r.broker_protocol.clone(),
        broker_driver: r.broker_driver.clone(),
        broker_pid: r.broker_pid,
        child_pid: r.child_pid,
        invocation_state: r.invocation_state.clone(),
        capabilities_json: r.capabilities_json.clone(),
        continuation_json: r.continuation_json.clone(),
        broker_continuation_json: r.broker_continuation_json.clone(),
        spec_hash: r.spec_hash.clone(),
        start_request_hash: r.start_request_hash.clone(),
        selected_profile_hash: r.selected_profile_hash.clone(),
        spec_projection_json: r.spec_projection_json.clone(),
        start_request_projection_json: r.start_request_projection_json.clone(),
        last_event_seq: r.last_event_seq,
        last_projected_seq: r.last_projected_seq,
        retained_projected_through_seq: r.retained_projected_through_seq,
        owner_server_instance_id: r.owner_server_instance_id.clone(),
        lifecycle_policy_hash: r.lifecycle_policy_hash.clone(),
        current_harness_generation: r.current_harness_generation,
        current_turn_attempt: r.current_turn_attempt,
        lifecycle_terminal_reason: r.lifecycle_terminal_reason.clone(),
        last_lifecycle_escalation_json: r.last_lifecycle_escalation_json.clone(),
        created_at: r.created_at.clone(),
        updated_at: r.updated_at.clone(),
    })
}
pub(crate) fn invocation_patch_entries(
    p: &BrokerInvocationPatch,
) -> Result<Vec<(&'static str, SqlValue)>> {
    let mut values = Vec::new();
    match &p.operation_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("operation_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("operation_id", v.clone().into())),
    }
    match &p.runtime_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("runtime_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("runtime_id", v.clone().into())),
    }
    match &p.run_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("run_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("run_id", v.clone().into())),
    }
    match &p.execution_format {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("execution_format", SqlValue::Null)),
        Patch::Set(v) => values.push(("execution_format", v.clone().into())),
    }
    match &p.broker_protocol {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_protocol", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_protocol", v.clone().into())),
    }
    match &p.broker_driver {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_driver", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_driver", v.clone().into())),
    }
    match &p.broker_pid {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_pid", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_pid", (*v).into())),
    }
    match &p.child_pid {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("child_pid", SqlValue::Null)),
        Patch::Set(v) => values.push(("child_pid", (*v).into())),
    }
    match &p.invocation_state {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("invocation_state", SqlValue::Null)),
        Patch::Set(v) => values.push(("invocation_state", v.clone().into())),
    }
    match &p.capabilities_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("capabilities_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("capabilities_json", v.clone().into())),
    }
    match &p.continuation_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("continuation_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("continuation_json", v.clone().into())),
    }
    match &p.broker_continuation_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("broker_continuation_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("broker_continuation_json", v.clone().into())),
    }
    match &p.spec_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("spec_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("spec_hash", v.clone().into())),
    }
    match &p.start_request_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("start_request_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("start_request_hash", v.clone().into())),
    }
    match &p.selected_profile_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("selected_profile_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("selected_profile_hash", v.clone().into())),
    }
    match &p.spec_projection_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("spec_projection_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("spec_projection_json", v.clone().into())),
    }
    match &p.start_request_projection_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("start_request_projection_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("start_request_projection_json", v.clone().into())),
    }
    match &p.last_event_seq {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("last_event_seq", SqlValue::Null)),
        Patch::Set(v) => values.push(("last_event_seq", (*v).into())),
    }
    match &p.last_projected_seq {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("last_projected_seq", SqlValue::Null)),
        Patch::Set(v) => values.push(("last_projected_seq", (*v).into())),
    }
    match &p.retained_projected_through_seq {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("retained_projected_through_seq", SqlValue::Null)),
        Patch::Set(v) => values.push(("retained_projected_through_seq", (*v).into())),
    }
    match &p.owner_server_instance_id {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("owner_server_instance_id", SqlValue::Null)),
        Patch::Set(v) => values.push(("owner_server_instance_id", v.clone().into())),
    }
    match &p.lifecycle_policy_hash {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("lifecycle_policy_hash", SqlValue::Null)),
        Patch::Set(v) => values.push(("lifecycle_policy_hash", v.clone().into())),
    }
    match &p.current_harness_generation {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("current_harness_generation", SqlValue::Null)),
        Patch::Set(v) => values.push(("current_harness_generation", (*v).into())),
    }
    match &p.current_turn_attempt {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("current_turn_attempt", SqlValue::Null)),
        Patch::Set(v) => values.push(("current_turn_attempt", (*v).into())),
    }
    match &p.lifecycle_terminal_reason {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("lifecycle_terminal_reason", SqlValue::Null)),
        Patch::Set(v) => values.push(("lifecycle_terminal_reason", v.clone().into())),
    }
    match &p.last_lifecycle_escalation_json {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("last_lifecycle_escalation_json", SqlValue::Null)),
        Patch::Set(v) => values.push(("last_lifecycle_escalation_json", v.clone().into())),
    }
    match &p.updated_at {
        Patch::Unchanged => {}
        Patch::Clear => values.push(("updated_at", SqlValue::Null)),
        Patch::Set(v) => values.push(("updated_at", v.clone().into())),
    }
    Ok(values)
}
