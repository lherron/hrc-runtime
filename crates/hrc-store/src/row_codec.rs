// Generated typed row codecs. No arbitrary SQL or table API is public.
use hrc_domain::store::rows::*;
use rusqlite::{Row, types::Value};
pub(crate) trait RowCodec: Sized {
    const COLUMNS: &'static str;
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self>;
    fn values(&self) -> Vec<Value>;
}

impl RowCodec for AcpBridgeEmissionsRow {
    const COLUMNS: &'static str = "\"event_id\", \"scope_ref\", \"event\", \"emitted_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            event_id: row.get("event_id")?,
            scope_ref: row.get("scope_ref")?,
            event: row.get("event")?,
            emitted_at: row.get("emitted_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.event_id.clone().into(),
            self.scope_ref.clone().into(),
            self.event.clone().into(),
            self.emitted_at.clone().into(),
        ]
    }
}

impl RowCodec for ActiveInputDeliveriesRow {
    const COLUMNS: &'static str = "\"input_application_id\", \"input_attempt_id\", \"idempotency_key\", \"host_session_id\", \"generation\", \"runtime_id\", \"run_id\", \"status\", \"request_json\", \"response_json\", \"error_code\", \"error_message\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            input_application_id: row.get("input_application_id")?,
            input_attempt_id: row.get("input_attempt_id")?,
            idempotency_key: row.get("idempotency_key")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            status: row.get("status")?,
            request_json: row.get("request_json")?,
            response_json: row.get("response_json")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.input_application_id.clone().into(),
            self.input_attempt_id.clone().into(),
            self.idempotency_key.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.status.clone().into(),
            self.request_json.clone().into(),
            self.response_json.clone().into(),
            self.error_code.clone().into(),
            self.error_message.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for BrokerInvocationEventsRow {
    const COLUMNS: &'static str = "\"id\", \"invocation_id\", \"seq\", \"time\", \"type\", \"run_id\", \"runtime_id\", \"harness_generation\", \"turn_attempt\", \"broker_event_json\", \"hrc_event_seq\", \"projection_status\", \"projection_error\", \"created_at\", \"broker_envelope_json\", \"source_ref\", \"origin_seq\", \"evidence_origin\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            invocation_id: row.get("invocation_id")?,
            seq: row.get("seq")?,
            time: row.get("time")?,
            r#type: row.get("type")?,
            run_id: row.get("run_id")?,
            runtime_id: row.get("runtime_id")?,
            harness_generation: row.get("harness_generation")?,
            turn_attempt: row.get("turn_attempt")?,
            broker_event_json: row.get("broker_event_json")?,
            hrc_event_seq: row.get("hrc_event_seq")?,
            projection_status: row.get("projection_status")?,
            projection_error: row.get("projection_error")?,
            created_at: row.get("created_at")?,
            broker_envelope_json: row.get("broker_envelope_json")?,
            source_ref: row.get("source_ref")?,
            origin_seq: row.get("origin_seq")?,
            evidence_origin: row.get("evidence_origin")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.id.into(),
            self.invocation_id.clone().into(),
            self.seq.into(),
            self.time.clone().into(),
            self.r#type.clone().into(),
            self.run_id.clone().into(),
            self.runtime_id.clone().into(),
            self.harness_generation.into(),
            self.turn_attempt.into(),
            self.broker_event_json.clone().into(),
            self.hrc_event_seq.into(),
            self.projection_status.clone().into(),
            self.projection_error.clone().into(),
            self.created_at.clone().into(),
            self.broker_envelope_json.clone().into(),
            self.source_ref.clone().into(),
            self.origin_seq.into(),
            self.evidence_origin.clone().into(),
        ]
    }
}

impl RowCodec for BrokerInvocationsRow {
    const COLUMNS: &'static str = "\"invocation_id\", \"operation_id\", \"runtime_id\", \"run_id\", \"broker_protocol\", \"broker_driver\", \"broker_pid\", \"child_pid\", \"invocation_state\", \"capabilities_json\", \"continuation_json\", \"broker_continuation_json\", \"spec_hash\", \"start_request_hash\", \"selected_profile_hash\", \"spec_projection_json\", \"start_request_projection_json\", \"last_event_seq\", \"owner_server_instance_id\", \"created_at\", \"updated_at\", \"lifecycle_policy_hash\", \"current_harness_generation\", \"current_turn_attempt\", \"lifecycle_terminal_reason\", \"last_lifecycle_escalation_json\", \"last_projected_seq\", \"retained_projected_through_seq\", \"execution_format\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            invocation_id: row.get("invocation_id")?,
            operation_id: row.get("operation_id")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            broker_protocol: row.get("broker_protocol")?,
            broker_driver: row.get("broker_driver")?,
            broker_pid: row.get("broker_pid")?,
            child_pid: row.get("child_pid")?,
            invocation_state: row.get("invocation_state")?,
            capabilities_json: row.get("capabilities_json")?,
            continuation_json: row.get("continuation_json")?,
            broker_continuation_json: row.get("broker_continuation_json")?,
            spec_hash: row.get("spec_hash")?,
            start_request_hash: row.get("start_request_hash")?,
            selected_profile_hash: row.get("selected_profile_hash")?,
            spec_projection_json: row.get("spec_projection_json")?,
            start_request_projection_json: row.get("start_request_projection_json")?,
            last_event_seq: row.get("last_event_seq")?,
            owner_server_instance_id: row.get("owner_server_instance_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            lifecycle_policy_hash: row.get("lifecycle_policy_hash")?,
            current_harness_generation: row.get("current_harness_generation")?,
            current_turn_attempt: row.get("current_turn_attempt")?,
            lifecycle_terminal_reason: row.get("lifecycle_terminal_reason")?,
            last_lifecycle_escalation_json: row.get("last_lifecycle_escalation_json")?,
            last_projected_seq: row.get("last_projected_seq")?,
            retained_projected_through_seq: row.get("retained_projected_through_seq")?,
            execution_format: row.get("execution_format")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.invocation_id.clone().into(),
            self.operation_id.clone().into(),
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.broker_protocol.clone().into(),
            self.broker_driver.clone().into(),
            self.broker_pid.into(),
            self.child_pid.into(),
            self.invocation_state.clone().into(),
            self.capabilities_json.clone().into(),
            self.continuation_json.clone().into(),
            self.broker_continuation_json.clone().into(),
            self.spec_hash.clone().into(),
            self.start_request_hash.clone().into(),
            self.selected_profile_hash.clone().into(),
            self.spec_projection_json.clone().into(),
            self.start_request_projection_json.clone().into(),
            self.last_event_seq.into(),
            self.owner_server_instance_id.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.lifecycle_policy_hash.clone().into(),
            self.current_harness_generation.into(),
            self.current_turn_attempt.into(),
            self.lifecycle_terminal_reason.clone().into(),
            self.last_lifecycle_escalation_json.clone().into(),
            self.last_projected_seq.into(),
            self.retained_projected_through_seq.into(),
            self.execution_format.clone().into(),
        ]
    }
}

impl RowCodec for BrokerProjectionDispositionsRow {
    const COLUMNS: &'static str =
        "\"invocation_id\", \"seq\", \"envelope_hash\", \"disposition\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            invocation_id: row.get("invocation_id")?,
            seq: row.get("seq")?,
            envelope_hash: row.get("envelope_hash")?,
            disposition: row.get("disposition")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.invocation_id.clone().into(),
            self.seq.into(),
            self.envelope_hash.clone().into(),
            self.disposition.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for BrokerTurnAttributionsRow {
    const COLUMNS: &'static str = "\"invocation_id\", \"turn_id\", \"ownership\", \"input_id\", \"attributed_seq\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            invocation_id: row.get("invocation_id")?,
            turn_id: row.get("turn_id")?,
            ownership: row.get("ownership")?,
            input_id: row.get("input_id")?,
            attributed_seq: row.get("attributed_seq")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.invocation_id.clone().into(),
            self.turn_id.clone().into(),
            self.ownership.clone().into(),
            self.input_id.clone().into(),
            self.attributed_seq.into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for CollectiveHistoryMessagesRow {
    const COLUMNS: &'static str = "\"collective_seq\", \"message_id\", \"canonical_record_json\", \"canonical_source_node_id\", \"canonical_source_role\", \"canonical_created_at\", \"created_at\", \"updated_at\", \"from_ref\", \"to_ref\", \"root_message_id\", \"reply_to_message_id\", \"kind\", \"phase\", \"host_session_id\", \"run_id\", \"generation\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            collective_seq: row.get("collective_seq")?,
            message_id: row.get("message_id")?,
            canonical_record_json: row.get("canonical_record_json")?,
            canonical_source_node_id: row.get("canonical_source_node_id")?,
            canonical_source_role: row.get("canonical_source_role")?,
            canonical_created_at: row.get("canonical_created_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            from_ref: row.get("from_ref")?,
            to_ref: row.get("to_ref")?,
            root_message_id: row.get("root_message_id")?,
            reply_to_message_id: row.get("reply_to_message_id")?,
            kind: row.get("kind")?,
            phase: row.get("phase")?,
            host_session_id: row.get("host_session_id")?,
            run_id: row.get("run_id")?,
            generation: row.get("generation")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.collective_seq.into(),
            self.message_id.clone().into(),
            self.canonical_record_json.clone().into(),
            self.canonical_source_node_id.clone().into(),
            self.canonical_source_role.clone().into(),
            self.canonical_created_at.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.from_ref.clone().into(),
            self.to_ref.clone().into(),
            self.root_message_id.clone().into(),
            self.reply_to_message_id.clone().into(),
            self.kind.clone().into(),
            self.phase.clone().into(),
            self.host_session_id.clone().into(),
            self.run_id.clone().into(),
            self.generation.into(),
        ]
    }
}

impl RowCodec for CollectiveHistoryObservationsRow {
    const COLUMNS: &'static str = "\"message_id\", \"source_node_id\", \"source_message_seq\", \"source_role\", \"origin_node_id\", \"accepted_destination_node_id\", \"record_json\", \"observed_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            message_id: row.get("message_id")?,
            source_node_id: row.get("source_node_id")?,
            source_message_seq: row.get("source_message_seq")?,
            source_role: row.get("source_role")?,
            origin_node_id: row.get("origin_node_id")?,
            accepted_destination_node_id: row.get("accepted_destination_node_id")?,
            record_json: row.get("record_json")?,
            observed_at: row.get("observed_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.message_id.clone().into(),
            self.source_node_id.clone().into(),
            self.source_message_seq.into(),
            self.source_role.clone().into(),
            self.origin_node_id.clone().into(),
            self.accepted_destination_node_id.clone().into(),
            self.record_json.clone().into(),
            self.observed_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for CollectiveHistoryReplicationsRow {
    const COLUMNS: &'static str = "\"message_id\", \"source_node_id\", \"source_message_seq\", \"source_role\", \"origin_node_id\", \"accepted_destination_node_id\", \"record_json\", \"record_fingerprint\", \"state\", \"total_attempts\", \"next_attempt_at\", \"last_attempt_at\", \"delivered_at\", \"last_error_code\", \"last_error_message\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            message_id: row.get("message_id")?,
            source_node_id: row.get("source_node_id")?,
            source_message_seq: row.get("source_message_seq")?,
            source_role: row.get("source_role")?,
            origin_node_id: row.get("origin_node_id")?,
            accepted_destination_node_id: row.get("accepted_destination_node_id")?,
            record_json: row.get("record_json")?,
            record_fingerprint: row.get("record_fingerprint")?,
            state: row.get("state")?,
            total_attempts: row.get("total_attempts")?,
            next_attempt_at: row.get("next_attempt_at")?,
            last_attempt_at: row.get("last_attempt_at")?,
            delivered_at: row.get("delivered_at")?,
            last_error_code: row.get("last_error_code")?,
            last_error_message: row.get("last_error_message")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.message_id.clone().into(),
            self.source_node_id.clone().into(),
            self.source_message_seq.into(),
            self.source_role.clone().into(),
            self.origin_node_id.clone().into(),
            self.accepted_destination_node_id.clone().into(),
            self.record_json.clone().into(),
            self.record_fingerprint.clone().into(),
            self.state.clone().into(),
            self.total_attempts.into(),
            self.next_attempt_at.clone().into(),
            self.last_attempt_at.clone().into(),
            self.delivered_at.clone().into(),
            self.last_error_code.clone().into(),
            self.last_error_message.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for CompiledRuntimePlansRow {
    const COLUMNS: &'static str = "\"plan_hash\", \"compile_id\", \"schema_version\", \"compiler_name\", \"compiler_version\", \"plan_projection_json\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            plan_hash: row.get("plan_hash")?,
            compile_id: row.get("compile_id")?,
            schema_version: row.get("schema_version")?,
            compiler_name: row.get("compiler_name")?,
            compiler_version: row.get("compiler_version")?,
            plan_projection_json: row.get("plan_projection_json")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.plan_hash.clone().into(),
            self.compile_id.clone().into(),
            self.schema_version.clone().into(),
            self.compiler_name.clone().into(),
            self.compiler_version.clone().into(),
            self.plan_projection_json.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for ContinuitiesRow {
    const COLUMNS: &'static str = "\"scope_ref\", \"lane_ref\", \"active_host_session_id\", \"updated_at\", \"scope_kind\", \"agent_id\", \"project_id\", \"task_id\", \"role_name\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            active_host_session_id: row.get("active_host_session_id")?,
            updated_at: row.get("updated_at")?,
            scope_kind: row.get("scope_kind")?,
            agent_id: row.get("agent_id")?,
            project_id: row.get("project_id")?,
            task_id: row.get("task_id")?,
            role_name: row.get("role_name")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.active_host_session_id.clone().into(),
            self.updated_at.clone().into(),
            self.scope_kind.clone().into(),
            self.agent_id.clone().into(),
            self.project_id.clone().into(),
            self.task_id.clone().into(),
            self.role_name.clone().into(),
        ]
    }
}

impl RowCodec for EventStreamCursorRow {
    const COLUMNS: &'static str = "\"id\", \"next_seq\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            next_seq: row.get("next_seq")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![self.id.into(), self.next_seq.into()]
    }
}

impl RowCodec for EventsRow {
    const COLUMNS: &'static str = "\"seq\", \"ts\", \"host_session_id\", \"scope_ref\", \"lane_ref\", \"generation\", \"run_id\", \"runtime_id\", \"source\", \"event_kind\", \"event_json\", \"stream_seq\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            seq: row.get("seq")?,
            ts: row.get("ts")?,
            host_session_id: row.get("host_session_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            generation: row.get("generation")?,
            run_id: row.get("run_id")?,
            runtime_id: row.get("runtime_id")?,
            source: row.get("source")?,
            event_kind: row.get("event_kind")?,
            event_json: row.get("event_json")?,
            stream_seq: row.get("stream_seq")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.seq.into(),
            self.ts.clone().into(),
            self.host_session_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.generation.into(),
            self.run_id.clone().into(),
            self.runtime_id.clone().into(),
            self.source.clone().into(),
            self.event_kind.clone().into(),
            self.event_json.clone().into(),
            self.stream_seq.into(),
        ]
    }
}

impl RowCodec for ExternalRegistrationGrantsRow {
    const COLUMNS: &'static str = "\"registration_id\", \"class_id\", \"derived_scope\", \"socket_path\", \"credential_hash\", \"expires_at\", \"consumed\", \"turns_allowed\", \"provisioner_json\", \"created_at\", \"host_session_id\", \"runtime_id\", \"operation_id\", \"invocation_id\", \"attach_token_ref\", \"controller_instance_id\", \"establishment_state\", \"capabilities_json\", \"participant_info_json\", \"established_at\", \"retired_at\", \"retirement_reason\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            registration_id: row.get("registration_id")?,
            class_id: row.get("class_id")?,
            derived_scope: row.get("derived_scope")?,
            socket_path: row.get("socket_path")?,
            credential_hash: row.get("credential_hash")?,
            expires_at: row.get("expires_at")?,
            consumed: row.get("consumed")?,
            turns_allowed: row.get("turns_allowed")?,
            provisioner_json: row.get("provisioner_json")?,
            created_at: row.get("created_at")?,
            host_session_id: row.get("host_session_id")?,
            runtime_id: row.get("runtime_id")?,
            operation_id: row.get("operation_id")?,
            invocation_id: row.get("invocation_id")?,
            attach_token_ref: row.get("attach_token_ref")?,
            controller_instance_id: row.get("controller_instance_id")?,
            establishment_state: row.get("establishment_state")?,
            capabilities_json: row.get("capabilities_json")?,
            participant_info_json: row.get("participant_info_json")?,
            established_at: row.get("established_at")?,
            retired_at: row.get("retired_at")?,
            retirement_reason: row.get("retirement_reason")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.registration_id.clone().into(),
            self.class_id.clone().into(),
            self.derived_scope.clone().into(),
            self.socket_path.clone().into(),
            self.credential_hash.clone().into(),
            self.expires_at.clone().into(),
            self.consumed.into(),
            self.turns_allowed.into(),
            self.provisioner_json.clone().into(),
            self.created_at.clone().into(),
            self.host_session_id.clone().into(),
            self.runtime_id.clone().into(),
            self.operation_id.clone().into(),
            self.invocation_id.clone().into(),
            self.attach_token_ref.clone().into(),
            self.controller_instance_id.clone().into(),
            self.establishment_state.clone().into(),
            self.capabilities_json.clone().into(),
            self.participant_info_json.clone().into(),
            self.established_at.clone().into(),
            self.retired_at.clone().into(),
            self.retirement_reason.clone().into(),
        ]
    }
}

impl RowCodec for FederationAcceptedRequestsRow {
    const COLUMNS: &'static str =
        "\"request_message_id\", \"accepted_by_node_id\", \"accepted_epoch\", \"accepted_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            request_message_id: row.get("request_message_id")?,
            accepted_by_node_id: row.get("accepted_by_node_id")?,
            accepted_epoch: row.get("accepted_epoch")?,
            accepted_at: row.get("accepted_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.request_message_id.clone().into(),
            self.accepted_by_node_id.clone().into(),
            self.accepted_epoch.into(),
            self.accepted_at.clone().into(),
        ]
    }
}

impl RowCodec for FederationOutboxDeliveriesRow {
    const COLUMNS: &'static str = "\"delivery_id\", \"message_id\", \"peer_node_id\", \"envelope_json\", \"state\", \"total_attempts\", \"cycle_attempts\", \"replay_count\", \"retry_window_started_at\", \"next_attempt_at\", \"last_attempt_at\", \"delivered_at\", \"dead_lettered_at\", \"last_error_code\", \"last_error_message\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            delivery_id: row.get("delivery_id")?,
            message_id: row.get("message_id")?,
            peer_node_id: row.get("peer_node_id")?,
            envelope_json: row.get("envelope_json")?,
            state: row.get("state")?,
            total_attempts: row.get("total_attempts")?,
            cycle_attempts: row.get("cycle_attempts")?,
            replay_count: row.get("replay_count")?,
            retry_window_started_at: row.get("retry_window_started_at")?,
            next_attempt_at: row.get("next_attempt_at")?,
            last_attempt_at: row.get("last_attempt_at")?,
            delivered_at: row.get("delivered_at")?,
            dead_lettered_at: row.get("dead_lettered_at")?,
            last_error_code: row.get("last_error_code")?,
            last_error_message: row.get("last_error_message")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.delivery_id.clone().into(),
            self.message_id.clone().into(),
            self.peer_node_id.clone().into(),
            self.envelope_json.clone().into(),
            self.state.clone().into(),
            self.total_attempts.into(),
            self.cycle_attempts.into(),
            self.replay_count.into(),
            self.retry_window_started_at.clone().into(),
            self.next_attempt_at.clone().into(),
            self.last_attempt_at.clone().into(),
            self.delivered_at.clone().into(),
            self.dead_lettered_at.clone().into(),
            self.last_error_code.clone().into(),
            self.last_error_message.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for FederationPeerAcceptancesRow {
    const COLUMNS: &'static str = "\"message_id\", \"accepted_by_node_id\", \"phase\", \"request_epoch\", \"accepted_at\", \"ack_outcome\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            message_id: row.get("message_id")?,
            accepted_by_node_id: row.get("accepted_by_node_id")?,
            phase: row.get("phase")?,
            request_epoch: row.get("request_epoch")?,
            accepted_at: row.get("accepted_at")?,
            ack_outcome: row.get("ack_outcome")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.message_id.clone().into(),
            self.accepted_by_node_id.clone().into(),
            self.phase.clone().into(),
            self.request_epoch.into(),
            self.accepted_at.clone().into(),
            self.ack_outcome.clone().into(),
        ]
    }
}

impl RowCodec for HrcEventLedgerMetadataRow {
    const COLUMNS: &'static str = "\"id\", \"ledger_incarnation_id\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            ledger_incarnation_id: row.get("ledger_incarnation_id")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![self.id.into(), self.ledger_incarnation_id.clone().into()]
    }
}

impl RowCodec for HrcEventsRow {
    const COLUMNS: &'static str = "\"hrc_seq\", \"stream_seq\", \"ts\", \"host_session_id\", \"scope_ref\", \"lane_ref\", \"generation\", \"runtime_id\", \"run_id\", \"launch_id\", \"app_id\", \"app_session_key\", \"category\", \"event_kind\", \"transport\", \"error_code\", \"replayed\", \"payload_json\", \"source_ref\", \"origin_seq\", \"evidence_origin\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            hrc_seq: row.get("hrc_seq")?,
            stream_seq: row.get("stream_seq")?,
            ts: row.get("ts")?,
            host_session_id: row.get("host_session_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            generation: row.get("generation")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            launch_id: row.get("launch_id")?,
            app_id: row.get("app_id")?,
            app_session_key: row.get("app_session_key")?,
            category: row.get("category")?,
            event_kind: row.get("event_kind")?,
            transport: row.get("transport")?,
            error_code: row.get("error_code")?,
            replayed: row.get("replayed")?,
            payload_json: row.get("payload_json")?,
            source_ref: row.get("source_ref")?,
            origin_seq: row.get("origin_seq")?,
            evidence_origin: row.get("evidence_origin")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.hrc_seq.into(),
            self.stream_seq.into(),
            self.ts.clone().into(),
            self.host_session_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.generation.into(),
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.launch_id.clone().into(),
            self.app_id.clone().into(),
            self.app_session_key.clone().into(),
            self.category.clone().into(),
            self.event_kind.clone().into(),
            self.transport.clone().into(),
            self.error_code.clone().into(),
            self.replayed.into(),
            self.payload_json.clone().into(),
            self.source_ref.clone().into(),
            self.origin_seq.into(),
            self.evidence_origin.clone().into(),
        ]
    }
}

impl RowCodec for HrcMigrationsRow {
    const COLUMNS: &'static str = "\"id\", \"applied_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            applied_at: row.get("applied_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![self.id.clone().into(), self.applied_at.clone().into()]
    }
}

impl RowCodec for HrcmailBirthRefusalsRow {
    const COLUMNS: &'static str = "\"target_session_ref\", \"scope_ref\", \"refusals\", \"last_reason\", \"resolved_at\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            target_session_ref: row.get("target_session_ref")?,
            scope_ref: row.get("scope_ref")?,
            refusals: row.get("refusals")?,
            last_reason: row.get("last_reason")?,
            resolved_at: row.get("resolved_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.target_session_ref.clone().into(),
            self.scope_ref.clone().into(),
            self.refusals.into(),
            self.last_reason.clone().into(),
            self.resolved_at.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailDeliveryExpiriesRow {
    const COLUMNS: &'static str = "\"envelope_id\", \"runtime_id\", \"expiries\", \"first_expired_at\", \"last_expired_at\", \"refusal_window_opened_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            envelope_id: row.get("envelope_id")?,
            runtime_id: row.get("runtime_id")?,
            expiries: row.get("expiries")?,
            first_expired_at: row.get("first_expired_at")?,
            last_expired_at: row.get("last_expired_at")?,
            refusal_window_opened_at: row.get("refusal_window_opened_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.envelope_id.clone().into(),
            self.runtime_id.clone().into(),
            self.expiries.into(),
            self.first_expired_at.clone().into(),
            self.last_expired_at.clone().into(),
            self.refusal_window_opened_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailDeliveryIntentsRow {
    const COLUMNS: &'static str = "\"envelope_id\", \"target_session_ref\", \"door\", \"form\", \"presentation_id\", \"runtime_id\", \"submission_id\", \"host_session_id\", \"generation\", \"delivery_outcome\", \"submitted_hrc_seq\", \"submitted_at\", \"updated_at\", \"invocation_id\", \"broker_after_seq\", \"uncertain_cause\", \"uncertain_at\", \"last_evidence_kind\", \"last_evidence_at\", \"terminal_envelope_cause\", \"terminal_envelope_at\", \"cleanup_outcome\", \"cleanup_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            envelope_id: row.get("envelope_id")?,
            target_session_ref: row.get("target_session_ref")?,
            door: row.get("door")?,
            form: row.get("form")?,
            presentation_id: row.get("presentation_id")?,
            runtime_id: row.get("runtime_id")?,
            submission_id: row.get("submission_id")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            delivery_outcome: row.get("delivery_outcome")?,
            submitted_hrc_seq: row.get("submitted_hrc_seq")?,
            submitted_at: row.get("submitted_at")?,
            updated_at: row.get("updated_at")?,
            invocation_id: row.get("invocation_id")?,
            broker_after_seq: row.get("broker_after_seq")?,
            uncertain_cause: row.get("uncertain_cause")?,
            uncertain_at: row.get("uncertain_at")?,
            last_evidence_kind: row.get("last_evidence_kind")?,
            last_evidence_at: row.get("last_evidence_at")?,
            terminal_envelope_cause: row.get("terminal_envelope_cause")?,
            terminal_envelope_at: row.get("terminal_envelope_at")?,
            cleanup_outcome: row.get("cleanup_outcome")?,
            cleanup_at: row.get("cleanup_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.envelope_id.clone().into(),
            self.target_session_ref.clone().into(),
            self.door.clone().into(),
            self.form.clone().into(),
            self.presentation_id.clone().into(),
            self.runtime_id.clone().into(),
            self.submission_id.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.delivery_outcome.clone().into(),
            self.submitted_hrc_seq.into(),
            self.submitted_at.clone().into(),
            self.updated_at.clone().into(),
            self.invocation_id.clone().into(),
            self.broker_after_seq.into(),
            self.uncertain_cause.clone().into(),
            self.uncertain_at.clone().into(),
            self.last_evidence_kind.clone().into(),
            self.last_evidence_at.clone().into(),
            self.terminal_envelope_cause.clone().into(),
            self.terminal_envelope_at.clone().into(),
            self.cleanup_outcome.clone().into(),
            self.cleanup_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailEnvelopesRow {
    const COLUMNS: &'static str = "\"envelope_seq\", \"envelope_id\", \"ingress_id\", \"from_kind\", \"from_ref\", \"target_session_ref\", \"payload_kind\", \"body\", \"metadata_json\", \"reply_schema_json\", \"state\", \"round_count\", \"response_present\", \"response_json\", \"response_fingerprint\", \"defer_reason\", \"retry_after_ms\", \"retry_at\", \"presented_at\", \"acked_at\", \"deferred_at\", \"dead_at\", \"terminal_actor_kind\", \"terminal_actor_ref\", \"created_at\", \"updated_at\", \"materialization_intent_json\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            envelope_seq: row.get("envelope_seq")?,
            envelope_id: row.get("envelope_id")?,
            ingress_id: row.get("ingress_id")?,
            from_kind: row.get("from_kind")?,
            from_ref: row.get("from_ref")?,
            target_session_ref: row.get("target_session_ref")?,
            payload_kind: row.get("payload_kind")?,
            body: row.get("body")?,
            metadata_json: row.get("metadata_json")?,
            reply_schema_json: row.get("reply_schema_json")?,
            state: row.get("state")?,
            round_count: row.get("round_count")?,
            response_present: row.get("response_present")?,
            response_json: row.get("response_json")?,
            response_fingerprint: row.get("response_fingerprint")?,
            defer_reason: row.get("defer_reason")?,
            retry_after_ms: row.get("retry_after_ms")?,
            retry_at: row.get("retry_at")?,
            presented_at: row.get("presented_at")?,
            acked_at: row.get("acked_at")?,
            deferred_at: row.get("deferred_at")?,
            dead_at: row.get("dead_at")?,
            terminal_actor_kind: row.get("terminal_actor_kind")?,
            terminal_actor_ref: row.get("terminal_actor_ref")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            materialization_intent_json: row.get("materialization_intent_json")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.envelope_seq.into(),
            self.envelope_id.clone().into(),
            self.ingress_id.clone().into(),
            self.from_kind.clone().into(),
            self.from_ref.clone().into(),
            self.target_session_ref.clone().into(),
            self.payload_kind.clone().into(),
            self.body.clone().into(),
            self.metadata_json.clone().into(),
            self.reply_schema_json.clone().into(),
            self.state.clone().into(),
            self.round_count.into(),
            self.response_present.into(),
            self.response_json.clone().into(),
            self.response_fingerprint.clone().into(),
            self.defer_reason.clone().into(),
            self.retry_after_ms.into(),
            self.retry_at.clone().into(),
            self.presented_at.clone().into(),
            self.acked_at.clone().into(),
            self.deferred_at.clone().into(),
            self.dead_at.clone().into(),
            self.terminal_actor_kind.clone().into(),
            self.terminal_actor_ref.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.materialization_intent_json.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailFailureNoticesRow {
    const COLUMNS: &'static str =
        "\"envelope_id\", \"target_session_ref\", \"notice\", \"created_at\", \"delivered_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            envelope_id: row.get("envelope_id")?,
            target_session_ref: row.get("target_session_ref")?,
            notice: row.get("notice")?,
            created_at: row.get("created_at")?,
            delivered_at: row.get("delivered_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.envelope_id.clone().into(),
            self.target_session_ref.clone().into(),
            self.notice.clone().into(),
            self.created_at.clone().into(),
            self.delivered_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailFederatedOriginsRow {
    const COLUMNS: &'static str = "\"ingress_id\", \"envelope_id\", \"request_message_id\", \"request_fingerprint\", \"envelope_json\", \"disposition_message_id\", \"disposition_fingerprint\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            ingress_id: row.get("ingress_id")?,
            envelope_id: row.get("envelope_id")?,
            request_message_id: row.get("request_message_id")?,
            request_fingerprint: row.get("request_fingerprint")?,
            envelope_json: row.get("envelope_json")?,
            disposition_message_id: row.get("disposition_message_id")?,
            disposition_fingerprint: row.get("disposition_fingerprint")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.ingress_id.clone().into(),
            self.envelope_id.clone().into(),
            self.request_message_id.clone().into(),
            self.request_fingerprint.clone().into(),
            self.envelope_json.clone().into(),
            self.disposition_message_id.clone().into(),
            self.disposition_fingerprint.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailIngressReceiptsRow {
    const COLUMNS: &'static str = "\"ingress_id\", \"path_choice\", \"envelope_id\", \"request_fingerprint\", \"receipt_json\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            ingress_id: row.get("ingress_id")?,
            path_choice: row.get("path_choice")?,
            envelope_id: row.get("envelope_id")?,
            request_fingerprint: row.get("request_fingerprint")?,
            receipt_json: row.get("receipt_json")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.ingress_id.clone().into(),
            self.path_choice.clone().into(),
            self.envelope_id.clone().into(),
            self.request_fingerprint.clone().into(),
            self.receipt_json.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailPresentationsRow {
    const COLUMNS: &'static str = "\"envelope_id\", \"runtime_id\", \"target_session_ref\", \"generation\", \"presentation_id\", \"input_id\", \"delivery_outcome\", \"landing_hrc_seq\", \"landed_at\", \"turn_ended_at\", \"reminder_armed_at\", \"reminder_due_at\", \"reminder_landing_hrc_seq\", \"reminder_landed_at\", \"disposed_at\", \"disposition\", \"receipt_committed_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            envelope_id: row.get("envelope_id")?,
            runtime_id: row.get("runtime_id")?,
            target_session_ref: row.get("target_session_ref")?,
            generation: row.get("generation")?,
            presentation_id: row.get("presentation_id")?,
            input_id: row.get("input_id")?,
            delivery_outcome: row.get("delivery_outcome")?,
            landing_hrc_seq: row.get("landing_hrc_seq")?,
            landed_at: row.get("landed_at")?,
            turn_ended_at: row.get("turn_ended_at")?,
            reminder_armed_at: row.get("reminder_armed_at")?,
            reminder_due_at: row.get("reminder_due_at")?,
            reminder_landing_hrc_seq: row.get("reminder_landing_hrc_seq")?,
            reminder_landed_at: row.get("reminder_landed_at")?,
            disposed_at: row.get("disposed_at")?,
            disposition: row.get("disposition")?,
            receipt_committed_at: row.get("receipt_committed_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.envelope_id.clone().into(),
            self.runtime_id.clone().into(),
            self.target_session_ref.clone().into(),
            self.generation.into(),
            self.presentation_id.clone().into(),
            self.input_id.clone().into(),
            self.delivery_outcome.clone().into(),
            self.landing_hrc_seq.into(),
            self.landed_at.clone().into(),
            self.turn_ended_at.clone().into(),
            self.reminder_armed_at.clone().into(),
            self.reminder_due_at.clone().into(),
            self.reminder_landing_hrc_seq.into(),
            self.reminder_landed_at.clone().into(),
            self.disposed_at.clone().into(),
            self.disposition.clone().into(),
            self.receipt_committed_at.clone().into(),
        ]
    }
}

impl RowCodec for HrcmailSeatHintsRow {
    const COLUMNS: &'static str =
        "\"runtime_id\", \"target_session_ref\", \"hint_count\", \"last_hint_at\", \"last_count\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            runtime_id: row.get("runtime_id")?,
            target_session_ref: row.get("target_session_ref")?,
            hint_count: row.get("hint_count")?,
            last_hint_at: row.get("last_hint_at")?,
            last_count: row.get("last_count")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.runtime_id.clone().into(),
            self.target_session_ref.clone().into(),
            self.hint_count.into(),
            self.last_hint_at.clone().into(),
            self.last_count.into(),
        ]
    }
}

impl RowCodec for HrcmailStopRefusalsRow {
    const COLUMNS: &'static str = "\"runtime_id\", \"target_session_ref\", \"observed_envelope_seq\", \"refusal_count\", \"total_refusal_count\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            runtime_id: row.get("runtime_id")?,
            target_session_ref: row.get("target_session_ref")?,
            observed_envelope_seq: row.get("observed_envelope_seq")?,
            refusal_count: row.get("refusal_count")?,
            total_refusal_count: row.get("total_refusal_count")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.runtime_id.clone().into(),
            self.target_session_ref.clone().into(),
            self.observed_envelope_seq.into(),
            self.refusal_count.into(),
            self.total_refusal_count.into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for InputsRow {
    const COLUMNS: &'static str = "\"input_id\", \"admission_host_session_id\", \"idempotency_key\", \"request_hash\", \"host_session_id\", \"runtime_id\", \"operation_id\", \"invocation_id\", \"broker_submission_id\", \"door\", \"admission_class\", \"origin\", \"status\", \"uncertainty\", \"cleanup_protection\", \"landing_kind\", \"carrier_run_id\", \"turn_id\", \"run_started_hrc_seq\", \"legacy_run_id\", \"admitted_at\", \"landed_at\", \"terminal_at\", \"terminal_kind\", \"error_code\", \"error_message\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            input_id: row.get("input_id")?,
            admission_host_session_id: row.get("admission_host_session_id")?,
            idempotency_key: row.get("idempotency_key")?,
            request_hash: row.get("request_hash")?,
            host_session_id: row.get("host_session_id")?,
            runtime_id: row.get("runtime_id")?,
            operation_id: row.get("operation_id")?,
            invocation_id: row.get("invocation_id")?,
            broker_submission_id: row.get("broker_submission_id")?,
            door: row.get("door")?,
            admission_class: row.get("admission_class")?,
            origin: row.get("origin")?,
            status: row.get("status")?,
            uncertainty: row.get("uncertainty")?,
            cleanup_protection: row.get("cleanup_protection")?,
            landing_kind: row.get("landing_kind")?,
            carrier_run_id: row.get("carrier_run_id")?,
            turn_id: row.get("turn_id")?,
            run_started_hrc_seq: row.get("run_started_hrc_seq")?,
            legacy_run_id: row.get("legacy_run_id")?,
            admitted_at: row.get("admitted_at")?,
            landed_at: row.get("landed_at")?,
            terminal_at: row.get("terminal_at")?,
            terminal_kind: row.get("terminal_kind")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.input_id.clone().into(),
            self.admission_host_session_id.clone().into(),
            self.idempotency_key.clone().into(),
            self.request_hash.clone().into(),
            self.host_session_id.clone().into(),
            self.runtime_id.clone().into(),
            self.operation_id.clone().into(),
            self.invocation_id.clone().into(),
            self.broker_submission_id.clone().into(),
            self.door.clone().into(),
            self.admission_class.clone().into(),
            self.origin.clone().into(),
            self.status.clone().into(),
            self.uncertainty.clone().into(),
            self.cleanup_protection.clone().into(),
            self.landing_kind.clone().into(),
            self.carrier_run_id.clone().into(),
            self.turn_id.clone().into(),
            self.run_started_hrc_seq.into(),
            self.legacy_run_id.clone().into(),
            self.admitted_at.clone().into(),
            self.landed_at.clone().into(),
            self.terminal_at.clone().into(),
            self.terminal_kind.clone().into(),
            self.error_code.clone().into(),
            self.error_message.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for LifecyclePoliciesRow {
    const COLUMNS: &'static str = "\"policy_id\", \"lifecycle_policy_hash\", \"canonical_policy_json\", \"schema_version\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            policy_id: row.get("policy_id")?,
            lifecycle_policy_hash: row.get("lifecycle_policy_hash")?,
            canonical_policy_json: row.get("canonical_policy_json")?,
            schema_version: row.get("schema_version")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.policy_id.clone().into(),
            self.lifecycle_policy_hash.clone().into(),
            self.canonical_policy_json.clone().into(),
            self.schema_version.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for LocalBridgesRow {
    const COLUMNS: &'static str = "\"bridge_id\", \"host_session_id\", \"runtime_id\", \"transport\", \"target\", \"expected_host_session_id\", \"expected_generation\", \"status\", \"created_at\", \"closed_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            bridge_id: row.get("bridge_id")?,
            host_session_id: row.get("host_session_id")?,
            runtime_id: row.get("runtime_id")?,
            transport: row.get("transport")?,
            target: row.get("target")?,
            expected_host_session_id: row.get("expected_host_session_id")?,
            expected_generation: row.get("expected_generation")?,
            status: row.get("status")?,
            created_at: row.get("created_at")?,
            closed_at: row.get("closed_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.bridge_id.clone().into(),
            self.host_session_id.clone().into(),
            self.runtime_id.clone().into(),
            self.transport.clone().into(),
            self.target.clone().into(),
            self.expected_host_session_id.clone().into(),
            self.expected_generation.into(),
            self.status.clone().into(),
            self.created_at.clone().into(),
            self.closed_at.clone().into(),
        ]
    }
}

impl RowCodec for MessagesRow {
    const COLUMNS: &'static str = "\"message_seq\", \"message_id\", \"created_at\", \"kind\", \"phase\", \"from_kind\", \"from_ref\", \"to_kind\", \"to_ref\", \"reply_to_message_id\", \"root_message_id\", \"body\", \"body_format\", \"execution_state\", \"execution_mode\", \"session_ref\", \"host_session_id\", \"generation\", \"runtime_id\", \"run_id\", \"transport\", \"error_code\", \"error_message\", \"metadata_json\", \"coalesced_into_run_id\", \"coalesced_position\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            message_seq: row.get("message_seq")?,
            message_id: row.get("message_id")?,
            created_at: row.get("created_at")?,
            kind: row.get("kind")?,
            phase: row.get("phase")?,
            from_kind: row.get("from_kind")?,
            from_ref: row.get("from_ref")?,
            to_kind: row.get("to_kind")?,
            to_ref: row.get("to_ref")?,
            reply_to_message_id: row.get("reply_to_message_id")?,
            root_message_id: row.get("root_message_id")?,
            body: row.get("body")?,
            body_format: row.get("body_format")?,
            execution_state: row.get("execution_state")?,
            execution_mode: row.get("execution_mode")?,
            session_ref: row.get("session_ref")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            transport: row.get("transport")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            metadata_json: row.get("metadata_json")?,
            coalesced_into_run_id: row.get("coalesced_into_run_id")?,
            coalesced_position: row.get("coalesced_position")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.message_seq.into(),
            self.message_id.clone().into(),
            self.created_at.clone().into(),
            self.kind.clone().into(),
            self.phase.clone().into(),
            self.from_kind.clone().into(),
            self.from_ref.clone().into(),
            self.to_kind.clone().into(),
            self.to_ref.clone().into(),
            self.reply_to_message_id.clone().into(),
            self.root_message_id.clone().into(),
            self.body.clone().into(),
            self.body_format.clone().into(),
            self.execution_state.clone().into(),
            self.execution_mode.clone().into(),
            self.session_ref.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.transport.clone().into(),
            self.error_code.clone().into(),
            self.error_message.clone().into(),
            self.metadata_json.clone().into(),
            self.coalesced_into_run_id.clone().into(),
            self.coalesced_position.into(),
        ]
    }
}

impl RowCodec for ParticipantAddressReservationsRow {
    const COLUMNS: &'static str = "\"reservation_id\", \"class_id\", \"scope_ref\", \"lane_ref\", \"home_node_id\", \"state\", \"created_at\", \"updated_at\", \"released_at\", \"released_by\", \"release_reason\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            reservation_id: row.get("reservation_id")?,
            class_id: row.get("class_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            home_node_id: row.get("home_node_id")?,
            state: row.get("state")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            released_at: row.get("released_at")?,
            released_by: row.get("released_by")?,
            release_reason: row.get("release_reason")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.reservation_id.clone().into(),
            self.class_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.home_node_id.clone().into(),
            self.state.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.released_at.clone().into(),
            self.released_by.clone().into(),
            self.release_reason.clone().into(),
        ]
    }
}

impl RowCodec for ParticipantHostBindingsRow {
    const COLUMNS: &'static str = "\"binding_id\", \"reservation_id\", \"registration_id\", \"host_incarnation_id\", \"host_session_id\", \"generation\", \"runtime_id\", \"state\", \"predecessor_binding_id\", \"admitted_at\", \"updated_at\", \"bound_at\", \"retired_at\", \"retirement_receipt_json\", \"disposition_reason\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            binding_id: row.get("binding_id")?,
            reservation_id: row.get("reservation_id")?,
            registration_id: row.get("registration_id")?,
            host_incarnation_id: row.get("host_incarnation_id")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            runtime_id: row.get("runtime_id")?,
            state: row.get("state")?,
            predecessor_binding_id: row.get("predecessor_binding_id")?,
            admitted_at: row.get("admitted_at")?,
            updated_at: row.get("updated_at")?,
            bound_at: row.get("bound_at")?,
            retired_at: row.get("retired_at")?,
            retirement_receipt_json: row.get("retirement_receipt_json")?,
            disposition_reason: row.get("disposition_reason")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.binding_id.clone().into(),
            self.reservation_id.clone().into(),
            self.registration_id.clone().into(),
            self.host_incarnation_id.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.runtime_id.clone().into(),
            self.state.clone().into(),
            self.predecessor_binding_id.clone().into(),
            self.admitted_at.clone().into(),
            self.updated_at.clone().into(),
            self.bound_at.clone().into(),
            self.retired_at.clone().into(),
            self.retirement_receipt_json.clone().into(),
            self.disposition_reason.clone().into(),
        ]
    }
}

impl RowCodec for ParticipantRegistrationAttemptsRow {
    const COLUMNS: &'static str = "\"attempt_id\", \"registration_id\", \"attach_epoch\", \"request_id\", \"operation_id\", \"invocation_id\", \"runtime_id\", \"host_binding_id\", \"state\", \"prepared_profile_json\", \"adapter_dispatch_env_json\", \"hosting_intent_json\", \"realized_hosting_json\", \"dispatch_json\", \"broker_identity_json\", \"initial_activation_confirmed_at\", \"activation_classification\", \"writer_evidence_json\", \"recovery_disposition\", \"recovery_reason\", \"establishment_work_state\", \"establishment_attempt_count\", \"establishment_next_attempt_at\", \"establishment_last_error\", \"attach_socket_path\", \"continuation_carried\", \"continuation_reason\", \"continuation_selected_json\", \"continuation_resume_state\", \"continuation_resume_reason\", \"replacement_intent_json\", \"disposition_reason\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            attempt_id: row.get("attempt_id")?,
            registration_id: row.get("registration_id")?,
            attach_epoch: row.get("attach_epoch")?,
            request_id: row.get("request_id")?,
            operation_id: row.get("operation_id")?,
            invocation_id: row.get("invocation_id")?,
            runtime_id: row.get("runtime_id")?,
            host_binding_id: row.get("host_binding_id")?,
            state: row.get("state")?,
            prepared_profile_json: row.get("prepared_profile_json")?,
            adapter_dispatch_env_json: row.get("adapter_dispatch_env_json")?,
            hosting_intent_json: row.get("hosting_intent_json")?,
            realized_hosting_json: row.get("realized_hosting_json")?,
            dispatch_json: row.get("dispatch_json")?,
            broker_identity_json: row.get("broker_identity_json")?,
            initial_activation_confirmed_at: row.get("initial_activation_confirmed_at")?,
            activation_classification: row.get("activation_classification")?,
            writer_evidence_json: row.get("writer_evidence_json")?,
            recovery_disposition: row.get("recovery_disposition")?,
            recovery_reason: row.get("recovery_reason")?,
            establishment_work_state: row.get("establishment_work_state")?,
            establishment_attempt_count: row.get("establishment_attempt_count")?,
            establishment_next_attempt_at: row.get("establishment_next_attempt_at")?,
            establishment_last_error: row.get("establishment_last_error")?,
            attach_socket_path: row.get("attach_socket_path")?,
            continuation_carried: row.get("continuation_carried")?,
            continuation_reason: row.get("continuation_reason")?,
            continuation_selected_json: row.get("continuation_selected_json")?,
            continuation_resume_state: row.get("continuation_resume_state")?,
            continuation_resume_reason: row.get("continuation_resume_reason")?,
            replacement_intent_json: row.get("replacement_intent_json")?,
            disposition_reason: row.get("disposition_reason")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.attempt_id.clone().into(),
            self.registration_id.clone().into(),
            self.attach_epoch.into(),
            self.request_id.clone().into(),
            self.operation_id.clone().into(),
            self.invocation_id.clone().into(),
            self.runtime_id.clone().into(),
            self.host_binding_id.clone().into(),
            self.state.clone().into(),
            self.prepared_profile_json.clone().into(),
            self.adapter_dispatch_env_json.clone().into(),
            self.hosting_intent_json.clone().into(),
            self.realized_hosting_json.clone().into(),
            self.dispatch_json.clone().into(),
            self.broker_identity_json.clone().into(),
            self.initial_activation_confirmed_at.clone().into(),
            self.activation_classification.clone().into(),
            self.writer_evidence_json.clone().into(),
            self.recovery_disposition.clone().into(),
            self.recovery_reason.clone().into(),
            self.establishment_work_state.clone().into(),
            self.establishment_attempt_count.into(),
            self.establishment_next_attempt_at.clone().into(),
            self.establishment_last_error.clone().into(),
            self.attach_socket_path.clone().into(),
            self.continuation_carried.into(),
            self.continuation_reason.clone().into(),
            self.continuation_selected_json.clone().into(),
            self.continuation_resume_state.clone().into(),
            self.continuation_resume_reason.clone().into(),
            self.replacement_intent_json.clone().into(),
            self.disposition_reason.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for ParticipantRegistrationsRow {
    const COLUMNS: &'static str = "\"registration_id\", \"class_id\", \"join_direction\", \"participant_key\", \"scope_ref\", \"lane_ref\", \"host_session_id\", \"generation\", \"workspace_cwd\", \"serving_socket_path\", \"address_policy\", \"continuity_policy\", \"lifecycle_owner\", \"replay_semantics\", \"host_incarnation_id\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            registration_id: row.get("registration_id")?,
            class_id: row.get("class_id")?,
            join_direction: row.get("join_direction")?,
            participant_key: row.get("participant_key")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            workspace_cwd: row.get("workspace_cwd")?,
            serving_socket_path: row.get("serving_socket_path")?,
            address_policy: row.get("address_policy")?,
            continuity_policy: row.get("continuity_policy")?,
            lifecycle_owner: row.get("lifecycle_owner")?,
            replay_semantics: row.get("replay_semantics")?,
            host_incarnation_id: row.get("host_incarnation_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.registration_id.clone().into(),
            self.class_id.clone().into(),
            self.join_direction.clone().into(),
            self.participant_key.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.workspace_cwd.clone().into(),
            self.serving_socket_path.clone().into(),
            self.address_policy.clone().into(),
            self.continuity_policy.clone().into(),
            self.lifecycle_owner.clone().into(),
            self.replay_semantics.clone().into(),
            self.host_incarnation_id.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for PermissionDecisionsRow {
    const COLUMNS: &'static str = "\"permission_identity_key\", \"permission_request_id\", \"invocation_id\", \"harness_generation\", \"turn_attempt\", \"runtime_id\", \"run_id\", \"kind\", \"subject_display_json\", \"default_decision\", \"decision\", \"decided_by\", \"policy_json\", \"requested_at\", \"decided_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            permission_identity_key: row.get("permission_identity_key")?,
            permission_request_id: row.get("permission_request_id")?,
            invocation_id: row.get("invocation_id")?,
            harness_generation: row.get("harness_generation")?,
            turn_attempt: row.get("turn_attempt")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            kind: row.get("kind")?,
            subject_display_json: row.get("subject_display_json")?,
            default_decision: row.get("default_decision")?,
            decision: row.get("decision")?,
            decided_by: row.get("decided_by")?,
            policy_json: row.get("policy_json")?,
            requested_at: row.get("requested_at")?,
            decided_at: row.get("decided_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.permission_identity_key.clone().into(),
            self.permission_request_id.clone().into(),
            self.invocation_id.clone().into(),
            self.harness_generation.into(),
            self.turn_attempt.into(),
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.kind.clone().into(),
            self.subject_display_json.clone().into(),
            self.default_decision.clone().into(),
            self.decision.clone().into(),
            self.decided_by.clone().into(),
            self.policy_json.clone().into(),
            self.requested_at.clone().into(),
            self.decided_at.clone().into(),
        ]
    }
}

impl RowCodec for PlacementLedgerRow {
    const COLUMNS: &'static str = "\"scope_ref\", \"home_node_id\", \"state\", \"retired_at\", \"retirement_reason\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            scope_ref: row.get("scope_ref")?,
            home_node_id: row.get("home_node_id")?,
            state: row.get("state")?,
            retired_at: row.get("retired_at")?,
            retirement_reason: row.get("retirement_reason")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.scope_ref.clone().into(),
            self.home_node_id.clone().into(),
            self.state.clone().into(),
            self.retired_at.clone().into(),
            self.retirement_reason.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for RetainedEvidenceOutcomesRow {
    const COLUMNS: &'static str = "\"outcome_id\", \"runtime_id\", \"invocation_id\", \"recorded_at\", \"outcome\", \"outcome_class\", \"trigger\", \"attempts\", \"detail_json\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            outcome_id: row.get("outcome_id")?,
            runtime_id: row.get("runtime_id")?,
            invocation_id: row.get("invocation_id")?,
            recorded_at: row.get("recorded_at")?,
            outcome: row.get("outcome")?,
            outcome_class: row.get("outcome_class")?,
            trigger: row.get("trigger")?,
            attempts: row.get("attempts")?,
            detail_json: row.get("detail_json")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.outcome_id.into(),
            self.runtime_id.clone().into(),
            self.invocation_id.clone().into(),
            self.recorded_at.clone().into(),
            self.outcome.clone().into(),
            self.outcome_class.clone().into(),
            self.trigger.clone().into(),
            self.attempts.into(),
            self.detail_json.clone().into(),
        ]
    }
}

impl RowCodec for RosterClaimsRow {
    const COLUMNS: &'static str = "\"idempotency_key\", \"request_hash\", \"base_scope\", \"claimed_scope\", \"successor_host_session_id\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            idempotency_key: row.get("idempotency_key")?,
            request_hash: row.get("request_hash")?,
            base_scope: row.get("base_scope")?,
            claimed_scope: row.get("claimed_scope")?,
            successor_host_session_id: row.get("successor_host_session_id")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.idempotency_key.clone().into(),
            self.request_hash.clone().into(),
            self.base_scope.clone().into(),
            self.claimed_scope.clone().into(),
            self.successor_host_session_id.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for RunsRow {
    const COLUMNS: &'static str = "\"run_id\", \"host_session_id\", \"runtime_id\", \"scope_ref\", \"lane_ref\", \"generation\", \"transport\", \"status\", \"accepted_at\", \"started_at\", \"completed_at\", \"updated_at\", \"error_code\", \"error_message\", \"correlation_json\", \"queue_snapshot_id\", \"queued_input_seq\", \"queue_snapshot_position\", \"coalesced_into_run_id\", \"coalesced_position\", \"origin_actor\", \"origin_kind\", \"origin_causation_ref\", \"operation_id\", \"invocation_id\", \"dispatched_input_id\", \"broker_input_fenced_at\", \"broker_input_fence_reason\", \"dispatch_idempotency_key\", \"broker_submission_id\", \"execution_format\", \"turn_key\", \"native_turn_id\", \"native_harness_generation\", \"native_turn_attempt\", \"initiating_input_id\", \"ownership_conflict_json\", \"observation_state\", \"observed_start_hrc_seq\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            run_id: row.get("run_id")?,
            host_session_id: row.get("host_session_id")?,
            runtime_id: row.get("runtime_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            generation: row.get("generation")?,
            transport: row.get("transport")?,
            status: row.get("status")?,
            accepted_at: row.get("accepted_at")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            updated_at: row.get("updated_at")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            correlation_json: row.get("correlation_json")?,
            queue_snapshot_id: row.get("queue_snapshot_id")?,
            queued_input_seq: row.get("queued_input_seq")?,
            queue_snapshot_position: row.get("queue_snapshot_position")?,
            coalesced_into_run_id: row.get("coalesced_into_run_id")?,
            coalesced_position: row.get("coalesced_position")?,
            origin_actor: row.get("origin_actor")?,
            origin_kind: row.get("origin_kind")?,
            origin_causation_ref: row.get("origin_causation_ref")?,
            operation_id: row.get("operation_id")?,
            invocation_id: row.get("invocation_id")?,
            dispatched_input_id: row.get("dispatched_input_id")?,
            broker_input_fenced_at: row.get("broker_input_fenced_at")?,
            broker_input_fence_reason: row.get("broker_input_fence_reason")?,
            dispatch_idempotency_key: row.get("dispatch_idempotency_key")?,
            broker_submission_id: row.get("broker_submission_id")?,
            execution_format: row.get("execution_format")?,
            turn_key: row.get("turn_key")?,
            native_turn_id: row.get("native_turn_id")?,
            native_harness_generation: row.get("native_harness_generation")?,
            native_turn_attempt: row.get("native_turn_attempt")?,
            initiating_input_id: row.get("initiating_input_id")?,
            ownership_conflict_json: row.get("ownership_conflict_json")?,
            observation_state: row.get("observation_state")?,
            observed_start_hrc_seq: row.get("observed_start_hrc_seq")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.run_id.clone().into(),
            self.host_session_id.clone().into(),
            self.runtime_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.generation.into(),
            self.transport.clone().into(),
            self.status.clone().into(),
            self.accepted_at.clone().into(),
            self.started_at.clone().into(),
            self.completed_at.clone().into(),
            self.updated_at.clone().into(),
            self.error_code.clone().into(),
            self.error_message.clone().into(),
            self.correlation_json.clone().into(),
            self.queue_snapshot_id.clone().into(),
            self.queued_input_seq.into(),
            self.queue_snapshot_position.into(),
            self.coalesced_into_run_id.clone().into(),
            self.coalesced_position.into(),
            self.origin_actor.clone().into(),
            self.origin_kind.clone().into(),
            self.origin_causation_ref.clone().into(),
            self.operation_id.clone().into(),
            self.invocation_id.clone().into(),
            self.dispatched_input_id.clone().into(),
            self.broker_input_fenced_at.clone().into(),
            self.broker_input_fence_reason.clone().into(),
            self.dispatch_idempotency_key.clone().into(),
            self.broker_submission_id.clone().into(),
            self.execution_format.clone().into(),
            self.turn_key.clone().into(),
            self.native_turn_id.clone().into(),
            self.native_harness_generation.into(),
            self.native_turn_attempt.into(),
            self.initiating_input_id.clone().into(),
            self.ownership_conflict_json.clone().into(),
            self.observation_state.clone().into(),
            self.observed_start_hrc_seq.into(),
        ]
    }
}

impl RowCodec for RuntimeArtifactsRow {
    const COLUMNS: &'static str = "\"artifact_id\", \"operation_id\", \"artifact_kind\", \"media_type\", \"storage_kind\", \"content_hash\", \"artifact_json\", \"artifact_path\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            artifact_id: row.get("artifact_id")?,
            operation_id: row.get("operation_id")?,
            artifact_kind: row.get("artifact_kind")?,
            media_type: row.get("media_type")?,
            storage_kind: row.get("storage_kind")?,
            content_hash: row.get("content_hash")?,
            artifact_json: row.get("artifact_json")?,
            artifact_path: row.get("artifact_path")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.artifact_id.clone().into(),
            self.operation_id.clone().into(),
            self.artifact_kind.clone().into(),
            self.media_type.clone().into(),
            self.storage_kind.clone().into(),
            self.content_hash.clone().into(),
            self.artifact_json.clone().into(),
            self.artifact_path.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for RuntimeBuffersRow {
    const COLUMNS: &'static str =
        "\"runtime_id\", \"run_id\", \"chunk_seq\", \"text\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            chunk_seq: row.get("chunk_seq")?,
            text: row.get("text")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.chunk_seq.into(),
            self.text.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for RuntimeFirstTurnWatchRow {
    const COLUMNS: &'static str = "\"runtime_id\", \"generation\", \"host_session_id\", \"scope_ref\", \"lane_ref\", \"run_id\", \"invocation_id\", \"transport\", \"priming_dispatched_at\", \"first_turn_deadline_at\", \"first_turn_at\", \"first_turn_missing_tripped_at\", \"disarmed_at\", \"disarm_reason\", \"trip_event_seq\", \"diagnostics_event_seq\", \"bundle_dir\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            runtime_id: row.get("runtime_id")?,
            generation: row.get("generation")?,
            host_session_id: row.get("host_session_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            run_id: row.get("run_id")?,
            invocation_id: row.get("invocation_id")?,
            transport: row.get("transport")?,
            priming_dispatched_at: row.get("priming_dispatched_at")?,
            first_turn_deadline_at: row.get("first_turn_deadline_at")?,
            first_turn_at: row.get("first_turn_at")?,
            first_turn_missing_tripped_at: row.get("first_turn_missing_tripped_at")?,
            disarmed_at: row.get("disarmed_at")?,
            disarm_reason: row.get("disarm_reason")?,
            trip_event_seq: row.get("trip_event_seq")?,
            diagnostics_event_seq: row.get("diagnostics_event_seq")?,
            bundle_dir: row.get("bundle_dir")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.runtime_id.clone().into(),
            self.generation.into(),
            self.host_session_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.run_id.clone().into(),
            self.invocation_id.clone().into(),
            self.transport.clone().into(),
            self.priming_dispatched_at.clone().into(),
            self.first_turn_deadline_at.clone().into(),
            self.first_turn_at.clone().into(),
            self.first_turn_missing_tripped_at.clone().into(),
            self.disarmed_at.clone().into(),
            self.disarm_reason.clone().into(),
            self.trip_event_seq.into(),
            self.diagnostics_event_seq.into(),
            self.bundle_dir.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for RuntimeOperationsRow {
    const COLUMNS: &'static str = "\"operation_id\", \"runtime_id\", \"run_id\", \"host_session_id\", \"generation\", \"operation_kind\", \"controller\", \"compile_id\", \"plan_hash\", \"selected_profile_id\", \"selected_profile_hash\", \"startup_method\", \"turn_delivery\", \"status\", \"route_decision_json\", \"capability_resolution_json\", \"created_at\", \"started_at\", \"completed_at\", \"updated_at\", \"error_code\", \"error_message\", \"preparation_json\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            operation_id: row.get("operation_id")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            operation_kind: row.get("operation_kind")?,
            controller: row.get("controller")?,
            compile_id: row.get("compile_id")?,
            plan_hash: row.get("plan_hash")?,
            selected_profile_id: row.get("selected_profile_id")?,
            selected_profile_hash: row.get("selected_profile_hash")?,
            startup_method: row.get("startup_method")?,
            turn_delivery: row.get("turn_delivery")?,
            status: row.get("status")?,
            route_decision_json: row.get("route_decision_json")?,
            capability_resolution_json: row.get("capability_resolution_json")?,
            created_at: row.get("created_at")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            updated_at: row.get("updated_at")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            preparation_json: row.get("preparation_json")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.operation_id.clone().into(),
            self.runtime_id.clone().into(),
            self.run_id.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.operation_kind.clone().into(),
            self.controller.clone().into(),
            self.compile_id.clone().into(),
            self.plan_hash.clone().into(),
            self.selected_profile_id.clone().into(),
            self.selected_profile_hash.clone().into(),
            self.startup_method.clone().into(),
            self.turn_delivery.clone().into(),
            self.status.clone().into(),
            self.route_decision_json.clone().into(),
            self.capability_resolution_json.clone().into(),
            self.created_at.clone().into(),
            self.started_at.clone().into(),
            self.completed_at.clone().into(),
            self.updated_at.clone().into(),
            self.error_code.clone().into(),
            self.error_message.clone().into(),
            self.preparation_json.clone().into(),
        ]
    }
}

impl RowCodec for RuntimesRow {
    const COLUMNS: &'static str = "\"runtime_id\", \"host_session_id\", \"scope_ref\", \"lane_ref\", \"generation\", \"transport\", \"harness\", \"provider\", \"status\", \"tmux_json\", \"supports_inflight_input\", \"active_run_id\", \"last_activity_at\", \"created_at\", \"updated_at\", \"status_changed_at\", \"controller_kind\", \"active_operation_id\", \"active_invocation_id\", \"plan_hash\", \"selected_profile_hash\", \"runtime_state_json\", \"lifecycle_terminal_reason\", \"presentation_json\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            runtime_id: row.get("runtime_id")?,
            host_session_id: row.get("host_session_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            generation: row.get("generation")?,
            transport: row.get("transport")?,
            harness: row.get("harness")?,
            provider: row.get("provider")?,
            status: row.get("status")?,
            tmux_json: row.get("tmux_json")?,
            supports_inflight_input: row.get("supports_inflight_input")?,
            active_run_id: row.get("active_run_id")?,
            last_activity_at: row.get("last_activity_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            status_changed_at: row.get("status_changed_at")?,
            controller_kind: row.get("controller_kind")?,
            active_operation_id: row.get("active_operation_id")?,
            active_invocation_id: row.get("active_invocation_id")?,
            plan_hash: row.get("plan_hash")?,
            selected_profile_hash: row.get("selected_profile_hash")?,
            runtime_state_json: row.get("runtime_state_json")?,
            lifecycle_terminal_reason: row.get("lifecycle_terminal_reason")?,
            presentation_json: row.get("presentation_json")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.runtime_id.clone().into(),
            self.host_session_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.generation.into(),
            self.transport.clone().into(),
            self.harness.clone().into(),
            self.provider.clone().into(),
            self.status.clone().into(),
            self.tmux_json.clone().into(),
            self.supports_inflight_input.into(),
            self.active_run_id.clone().into(),
            self.last_activity_at.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.status_changed_at.clone().into(),
            self.controller_kind.clone().into(),
            self.active_operation_id.clone().into(),
            self.active_invocation_id.clone().into(),
            self.plan_hash.clone().into(),
            self.selected_profile_hash.clone().into(),
            self.runtime_state_json.clone().into(),
            self.lifecycle_terminal_reason.clone().into(),
            self.presentation_json.clone().into(),
        ]
    }
}

impl RowCodec for SessionIndexRow {
    const COLUMNS: &'static str = "\"scope_ref\", \"lane_ref\", \"host_session_id\", \"generation\", \"agent_id\", \"project_id\", \"created_at\", \"effective_status\", \"execution_mode\", \"last_activity_at\", \"title\", \"task_id\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            host_session_id: row.get("host_session_id")?,
            generation: row.get("generation")?,
            agent_id: row.get("agent_id")?,
            project_id: row.get("project_id")?,
            created_at: row.get("created_at")?,
            effective_status: row.get("effective_status")?,
            execution_mode: row.get("execution_mode")?,
            last_activity_at: row.get("last_activity_at")?,
            title: row.get("title")?,
            task_id: row.get("task_id")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.host_session_id.clone().into(),
            self.generation.into(),
            self.agent_id.clone().into(),
            self.project_id.clone().into(),
            self.created_at.clone().into(),
            self.effective_status.clone().into(),
            self.execution_mode.clone().into(),
            self.last_activity_at.clone().into(),
            self.title.clone().into(),
            self.task_id.clone().into(),
        ]
    }
}

impl RowCodec for SessionIndexBackfillEvidenceRow {
    const COLUMNS: &'static str =
        "\"migration_id\", \"row_count\", \"changed_recency_count\", \"recorded_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            migration_id: row.get("migration_id")?,
            row_count: row.get("row_count")?,
            changed_recency_count: row.get("changed_recency_count")?,
            recorded_at: row.get("recorded_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.migration_id.clone().into(),
            self.row_count.into(),
            self.changed_recency_count.into(),
            self.recorded_at.clone().into(),
        ]
    }
}

impl RowCodec for SessionMetadataRow {
    const COLUMNS: &'static str = "\"scope_ref\", \"lane_ref\", \"key\", \"source\", \"value_json\", \"updated_at\", \"updated_by\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            key: row.get("key")?,
            source: row.get("source")?,
            value_json: row.get("value_json")?,
            updated_at: row.get("updated_at")?,
            updated_by: row.get("updated_by")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.key.clone().into(),
            self.source.clone().into(),
            self.value_json.clone().into(),
            self.updated_at.clone().into(),
            self.updated_by.clone().into(),
        ]
    }
}

impl RowCodec for SessionsRow {
    const COLUMNS: &'static str = "\"host_session_id\", \"scope_ref\", \"lane_ref\", \"generation\", \"status\", \"prior_host_session_id\", \"created_at\", \"updated_at\", \"last_applied_intent_json\", \"continuation_json\", \"continuation_reuse_disabled\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            host_session_id: row.get("host_session_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            generation: row.get("generation")?,
            status: row.get("status")?,
            prior_host_session_id: row.get("prior_host_session_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            last_applied_intent_json: row.get("last_applied_intent_json")?,
            continuation_json: row.get("continuation_json")?,
            continuation_reuse_disabled: row.get("continuation_reuse_disabled")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.host_session_id.clone().into(),
            self.scope_ref.clone().into(),
            self.lane_ref.clone().into(),
            self.generation.into(),
            self.status.clone().into(),
            self.prior_host_session_id.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.last_applied_intent_json.clone().into(),
            self.continuation_json.clone().into(),
            self.continuation_reuse_disabled.into(),
        ]
    }
}

impl RowCodec for SteerContributionsRow {
    const COLUMNS: &'static str = "\"contribution_id\", \"host_session_id\", \"idempotency_key\", \"runtime_id\", \"invocation_id\", \"active_run_id\", \"input_id\", \"state\", \"outcome_code\", \"outcome_json\", \"created_at\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            contribution_id: row.get("contribution_id")?,
            host_session_id: row.get("host_session_id")?,
            idempotency_key: row.get("idempotency_key")?,
            runtime_id: row.get("runtime_id")?,
            invocation_id: row.get("invocation_id")?,
            active_run_id: row.get("active_run_id")?,
            input_id: row.get("input_id")?,
            state: row.get("state")?,
            outcome_code: row.get("outcome_code")?,
            outcome_json: row.get("outcome_json")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.contribution_id.clone().into(),
            self.host_session_id.clone().into(),
            self.idempotency_key.clone().into(),
            self.runtime_id.clone().into(),
            self.invocation_id.clone().into(),
            self.active_run_id.clone().into(),
            self.input_id.clone().into(),
            self.state.clone().into(),
            self.outcome_code.clone().into(),
            self.outcome_json.clone().into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for SubmissionAdmissionsRow {
    const COLUMNS: &'static str = "\"submission_id\", \"run_id\", \"runtime_id\", \"invocation_id\", \"door\", \"envelope_id\", \"admitted_at\", \"disposition\", \"disposed_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            submission_id: row.get("submission_id")?,
            run_id: row.get("run_id")?,
            runtime_id: row.get("runtime_id")?,
            invocation_id: row.get("invocation_id")?,
            door: row.get("door")?,
            envelope_id: row.get("envelope_id")?,
            admitted_at: row.get("admitted_at")?,
            disposition: row.get("disposition")?,
            disposed_at: row.get("disposed_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.submission_id.clone().into(),
            self.run_id.clone().into(),
            self.runtime_id.clone().into(),
            self.invocation_id.clone().into(),
            self.door.clone().into(),
            self.envelope_id.clone().into(),
            self.admitted_at.clone().into(),
            self.disposition.clone().into(),
            self.disposed_at.clone().into(),
        ]
    }
}

impl RowCodec for SurfaceBindingsRow {
    const COLUMNS: &'static str = "\"surface_kind\", \"surface_id\", \"host_session_id\", \"runtime_id\", \"generation\", \"window_id\", \"pane_id\", \"bound_at\", \"unbound_at\", \"reason\", \"client_tty\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            surface_kind: row.get("surface_kind")?,
            surface_id: row.get("surface_id")?,
            host_session_id: row.get("host_session_id")?,
            runtime_id: row.get("runtime_id")?,
            generation: row.get("generation")?,
            window_id: row.get("window_id")?,
            pane_id: row.get("pane_id")?,
            bound_at: row.get("bound_at")?,
            unbound_at: row.get("unbound_at")?,
            reason: row.get("reason")?,
            client_tty: row.get("client_tty")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.surface_kind.clone().into(),
            self.surface_id.clone().into(),
            self.host_session_id.clone().into(),
            self.runtime_id.clone().into(),
            self.generation.into(),
            self.window_id.clone().into(),
            self.pane_id.clone().into(),
            self.bound_at.clone().into(),
            self.unbound_at.clone().into(),
            self.reason.clone().into(),
            self.client_tty.clone().into(),
        ]
    }
}

impl RowCodec for ToolResultBlobPartsRow {
    const COLUMNS: &'static str =
        "\"blob_id\", \"part\", \"parts\", \"runtime_id\", \"kind\", \"bytes\", \"chunk\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            blob_id: row.get("blob_id")?,
            part: row.get("part")?,
            parts: row.get("parts")?,
            runtime_id: row.get("runtime_id")?,
            kind: row.get("kind")?,
            bytes: row.get("bytes")?,
            chunk: row.get("chunk")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.blob_id.clone().into(),
            self.part.into(),
            self.parts.into(),
            self.runtime_id.clone().into(),
            self.kind.clone().into(),
            self.bytes.into(),
            self.chunk.clone().into(),
        ]
    }
}

impl RowCodec for ToolResultBlobsRow {
    const COLUMNS: &'static str = "\"blob_id\", \"runtime_id\", \"kind\", \"bytes\", \"complete\", \"result_json\", \"created_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            blob_id: row.get("blob_id")?,
            runtime_id: row.get("runtime_id")?,
            kind: row.get("kind")?,
            bytes: row.get("bytes")?,
            complete: row.get("complete")?,
            result_json: row.get("result_json")?,
            created_at: row.get("created_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.blob_id.clone().into(),
            self.runtime_id.clone().into(),
            self.kind.clone().into(),
            self.bytes.into(),
            self.complete.into(),
            self.result_json.clone().into(),
            self.created_at.clone().into(),
        ]
    }
}

impl RowCodec for TranscriptIndexCursorRow {
    const COLUMNS: &'static str = "\"id\", \"last_event_id\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            last_event_id: row.get("last_event_id")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.id.into(),
            self.last_event_id.into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for TranscriptIndexInvocationsRow {
    const COLUMNS: &'static str =
        "\"invocation_id\", \"runtime_id\", \"last_terminal_seq\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            invocation_id: row.get("invocation_id")?,
            runtime_id: row.get("runtime_id")?,
            last_terminal_seq: row.get("last_terminal_seq")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.invocation_id.clone().into(),
            self.runtime_id.clone().into(),
            self.last_terminal_seq.into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl RowCodec for TranscriptTurnsRow {
    const COLUMNS: &'static str = "\"turn_rowid\", \"invocation_id\", \"runtime_id\", \"agent\", \"project\", \"task\", \"scope_ref\", \"generation\", \"seq_from\", \"seq_to\", \"started_at\", \"completed_at\", \"terminal_status\", \"message_count\", \"truncated\", \"user_text\", \"final_text\", \"mid_text\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            turn_rowid: row.get("turn_rowid")?,
            invocation_id: row.get("invocation_id")?,
            runtime_id: row.get("runtime_id")?,
            agent: row.get("agent")?,
            project: row.get("project")?,
            task: row.get("task")?,
            scope_ref: row.get("scope_ref")?,
            generation: row.get("generation")?,
            seq_from: row.get("seq_from")?,
            seq_to: row.get("seq_to")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            terminal_status: row.get("terminal_status")?,
            message_count: row.get("message_count")?,
            truncated: row.get("truncated")?,
            user_text: row.get("user_text")?,
            final_text: row.get("final_text")?,
            mid_text: row.get("mid_text")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.turn_rowid.into(),
            self.invocation_id.clone().into(),
            self.runtime_id.clone().into(),
            self.agent.clone().into(),
            self.project.clone().into(),
            self.task.clone().into(),
            self.scope_ref.clone().into(),
            self.generation.into(),
            self.seq_from.into(),
            self.seq_to.into(),
            self.started_at.clone().into(),
            self.completed_at.clone().into(),
            self.terminal_status.clone().into(),
            self.message_count.into(),
            self.truncated.into(),
            self.user_text.clone().into(),
            self.final_text.clone().into(),
            self.mid_text.clone().into(),
        ]
    }
}

impl RowCodec for WrkqLedgerCursorsRow {
    const COLUMNS: &'static str = "\"stream\", \"high_water\", \"updated_at\"";
    fn decode(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            stream: row.get("stream")?,
            high_water: row.get("high_water")?,
            updated_at: row.get("updated_at")?,
        })
    }
    fn values(&self) -> Vec<Value> {
        vec![
            self.stream.clone().into(),
            self.high_water.into(),
            self.updated_at.clone().into(),
        ]
    }
}
