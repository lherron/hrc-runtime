use hrc_domain::store::*;
pub(crate) fn registration_from_row(
    r: rows::ParticipantRegistrationsRow,
) -> ParticipantRegistration {
    ParticipantRegistration {
        registration_id: r.registration_id,
        class_id: r.class_id,
        join: r.join_direction,
        participant_key: r.participant_key,
        scope_ref: r.scope_ref,
        lane_ref: r.lane_ref,
        host_session_id: r.host_session_id,
        generation: r.generation,
        workspace_cwd: r.workspace_cwd,
        socket_path: r.serving_socket_path,
        host_incarnation_id: r.host_incarnation_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
        policy: match (
            r.address_policy,
            r.continuity_policy,
            r.lifecycle_owner,
            r.replay_semantics,
        ) {
            (
                Some(address_policy),
                Some(continuity_policy),
                Some(lifecycle_owner),
                Some(replay_semantics),
            ) => Some(ParticipantRegistrationPolicy {
                address_policy,
                continuity_policy,
                lifecycle_owner,
                replay_semantics,
            }),
            _ => None,
        },
    }
}
pub(crate) fn registration_to_row(
    r: &ParticipantRegistration,
) -> rows::ParticipantRegistrationsRow {
    rows::ParticipantRegistrationsRow {
        registration_id: r.registration_id.clone(),
        class_id: r.class_id.clone(),
        join_direction: r.join.clone(),
        participant_key: r.participant_key.clone(),
        scope_ref: r.scope_ref.clone(),
        lane_ref: r.lane_ref.clone(),
        host_session_id: r.host_session_id.clone(),
        generation: r.generation,
        workspace_cwd: r.workspace_cwd.clone(),
        serving_socket_path: r.socket_path.clone(),
        host_incarnation_id: r.host_incarnation_id.clone(),
        created_at: r.created_at.clone(),
        updated_at: r.updated_at.clone(),
        address_policy: r.policy.as_ref().map(|p| p.address_policy.clone()),
        continuity_policy: r.policy.as_ref().map(|p| p.continuity_policy.clone()),
        lifecycle_owner: r.policy.as_ref().map(|p| p.lifecycle_owner.clone()),
        replay_semantics: r.policy.as_ref().map(|p| p.replay_semantics.clone()),
    }
}
pub(crate) fn attempt_from_row(r: rows::ParticipantRegistrationAttemptsRow) -> ParticipantAttempt {
    ParticipantAttempt {
        attempt_id: r.attempt_id,
        registration_id: r.registration_id,
        attach_epoch: r.attach_epoch,
        request_id: r.request_id,
        operation_id: r.operation_id,
        invocation_id: r.invocation_id,
        runtime_id: r.runtime_id,
        host_binding_id: r.host_binding_id,
        state: r.state,
        prepared_descriptor_json: r.prepared_profile_json,
        adapter_dispatch_env_json: r.adapter_dispatch_env_json,
        hosting_intent_json: r.hosting_intent_json,
        realized_hosting_json: r.realized_hosting_json,
        dispatch_json: r.dispatch_json,
        broker_identity_json: r.broker_identity_json,
        initial_activation_confirmed_at: r.initial_activation_confirmed_at,
        activation_classification: r.activation_classification,
        writer_evidence_json: r.writer_evidence_json,
        recovery_disposition: r.recovery_disposition,
        recovery_reason: r.recovery_reason,
        establishment_work_state: r.establishment_work_state,
        establishment_attempt_count: r.establishment_attempt_count,
        establishment_next_attempt_at: r.establishment_next_attempt_at,
        establishment_last_error: r.establishment_last_error,
        attach_socket_path: r.attach_socket_path,
        resume_state: r.continuation_resume_state,
        resume_reason: r.continuation_resume_reason,
        replacement_intent_json: r.replacement_intent_json,
        disposition_reason: r.disposition_reason,
        created_at: r.created_at,
        updated_at: r.updated_at,
        continuation: match (r.continuation_carried, r.continuation_reason) {
            (Some(c), Some(reason)) => Some(ParticipantContinuationSelection {
                carried: c == 1,
                reason,
                selected_json: r.continuation_selected_json,
            }),
            _ => None,
        },
    }
}
pub(crate) fn attempt_to_row(r: &ParticipantAttempt) -> rows::ParticipantRegistrationAttemptsRow {
    rows::ParticipantRegistrationAttemptsRow {
        attempt_id: r.attempt_id.clone(),
        registration_id: r.registration_id.clone(),
        attach_epoch: r.attach_epoch,
        request_id: r.request_id.clone(),
        operation_id: r.operation_id.clone(),
        invocation_id: r.invocation_id.clone(),
        runtime_id: r.runtime_id.clone(),
        host_binding_id: r.host_binding_id.clone(),
        state: r.state.clone(),
        prepared_profile_json: r.prepared_descriptor_json.clone(),
        adapter_dispatch_env_json: r.adapter_dispatch_env_json.clone(),
        hosting_intent_json: r.hosting_intent_json.clone(),
        realized_hosting_json: r.realized_hosting_json.clone(),
        dispatch_json: r.dispatch_json.clone(),
        broker_identity_json: r.broker_identity_json.clone(),
        initial_activation_confirmed_at: r.initial_activation_confirmed_at.clone(),
        activation_classification: r.activation_classification.clone(),
        writer_evidence_json: r.writer_evidence_json.clone(),
        recovery_disposition: r.recovery_disposition.clone(),
        recovery_reason: r.recovery_reason.clone(),
        establishment_work_state: r.establishment_work_state.clone(),
        establishment_attempt_count: r.establishment_attempt_count,
        establishment_next_attempt_at: r.establishment_next_attempt_at.clone(),
        establishment_last_error: r.establishment_last_error.clone(),
        attach_socket_path: r.attach_socket_path.clone(),
        continuation_resume_state: r.resume_state.clone(),
        continuation_resume_reason: r.resume_reason.clone(),
        replacement_intent_json: r.replacement_intent_json.clone(),
        disposition_reason: r.disposition_reason.clone(),
        created_at: r.created_at.clone(),
        updated_at: r.updated_at.clone(),
        continuation_carried: r
            .continuation
            .as_ref()
            .map(|c| if c.carried { 1 } else { 0 }),
        continuation_reason: r.continuation.as_ref().map(|c| c.reason.clone()),
        continuation_selected_json: r
            .continuation
            .as_ref()
            .and_then(|c| c.selected_json.clone()),
    }
}
