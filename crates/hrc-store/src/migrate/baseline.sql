-- HRC schema baseline at 0131_runtime_live_indexes (T-12840 r3, T-12854).
-- Produced once from a fresh store built by the last Bun migrator and
-- owned and edited as Rust source since. Each statement is the stored
-- sqlite_master text, so a store created from it carries the same text.
-- SQLite-owned objects (sqlite_sequence, autoindexes, FTS5 shadow tables)
-- are created by SQLite itself. Seed rows live in migrate::seed: a minted
-- ledger incarnation must never be copied from a dump.
-- Never applied to an existing store; forward changes are FORWARD entries.

-- tables

CREATE TABLE hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

CREATE TABLE continuities (
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        active_host_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL, scope_kind TEXT NOT NULL DEFAULT 'unparsed', agent_id TEXT NOT NULL DEFAULT '', project_id TEXT, task_id TEXT, role_name TEXT, seat_kind TEXT NOT NULL DEFAULT 'adhoc'
        CHECK (seat_kind IN ('task','standing','adhoc')), seat_work_json TEXT NOT NULL DEFAULT '{"kind":"none"}', seat_work_etag INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (scope_ref, lane_ref)
      );

CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        runtime_id TEXT,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT, correlation_json TEXT, queue_snapshot_id TEXT, queued_input_seq INTEGER, queue_snapshot_position INTEGER, coalesced_into_run_id TEXT, coalesced_position INTEGER, origin_actor TEXT, origin_kind TEXT, origin_causation_ref TEXT, operation_id TEXT, invocation_id TEXT, dispatched_input_id TEXT, broker_input_fenced_at TEXT, broker_input_fence_reason TEXT, dispatch_idempotency_key TEXT, broker_submission_id TEXT, execution_format TEXT NOT NULL DEFAULT 'format1', turn_key TEXT, native_turn_id TEXT, native_harness_generation INTEGER, native_turn_attempt INTEGER, initiating_input_id TEXT, ownership_conflict_json TEXT, observation_state TEXT, observed_start_hrc_seq INTEGER,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );

CREATE TABLE messages (
        message_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        phase TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        from_ref TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_ref TEXT NOT NULL,
        reply_to_message_id TEXT,
        root_message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        body_format TEXT NOT NULL,
        execution_state TEXT NOT NULL,
        execution_mode TEXT,
        session_ref TEXT,
        host_session_id TEXT,
        generation INTEGER,
        runtime_id TEXT,
        run_id TEXT,
        transport TEXT,
        error_code TEXT,
        error_message TEXT,
        metadata_json TEXT
      , coalesced_into_run_id TEXT, coalesced_position INTEGER);

CREATE TABLE event_stream_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_seq INTEGER NOT NULL
      );

CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_seq INTEGER NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        runtime_id TEXT,
        run_id TEXT,
        launch_id TEXT,
        app_id TEXT,
        app_session_key TEXT,
        category TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        transport TEXT,
        error_code TEXT,
        replayed INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL
      , source_ref TEXT, origin_seq INTEGER, evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained'));

CREATE TABLE runtime_buffers (
        runtime_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        chunk_seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, chunk_seq),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

CREATE TABLE active_input_deliveries (
        input_application_id TEXT PRIMARY KEY,
        input_attempt_id TEXT NOT NULL,
        idempotency_key TEXT,
        host_session_id TEXT,
        generation INTEGER,
        runtime_id TEXT,
        run_id TEXT,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE collective_history_messages (
        collective_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        canonical_record_json TEXT NOT NULL,
        canonical_source_node_id TEXT NOT NULL,
        canonical_source_role TEXT NOT NULL CHECK (
          canonical_source_role IN ('origin', 'destination')
        ),
        canonical_created_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , from_ref TEXT, to_ref TEXT, root_message_id TEXT, reply_to_message_id TEXT, kind TEXT, phase TEXT, host_session_id TEXT, run_id TEXT, generation INTEGER);

CREATE TABLE collective_history_observations (
        message_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        source_message_seq INTEGER NOT NULL CHECK (source_message_seq >= 1),
        source_role TEXT NOT NULL CHECK (source_role IN ('origin', 'destination')),
        origin_node_id TEXT NOT NULL,
        accepted_destination_node_id TEXT,
        record_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, source_node_id),
        FOREIGN KEY (message_id)
          REFERENCES collective_history_messages(message_id) ON DELETE CASCADE
      );

CREATE TABLE collective_history_replications (
        message_id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        source_message_seq INTEGER NOT NULL CHECK (source_message_seq >= 1),
        source_role TEXT NOT NULL CHECK (source_role IN ('origin', 'destination')),
        origin_node_id TEXT NOT NULL,
        accepted_destination_node_id TEXT,
        record_json TEXT NOT NULL,
        record_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
        total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_attempt_at TEXT,
        delivered_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE roster_claims (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        base_scope TEXT NOT NULL,
        claimed_scope TEXT NOT NULL,
        successor_host_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

CREATE TABLE session_index (
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        host_session_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL,
        effective_status TEXT NOT NULL
          CHECK (effective_status IN ('active', 'detached', 'inactive', 'stale')),
        execution_mode TEXT NOT NULL
          CHECK (execution_mode IN ('headless', 'interactive', 'nonInteractive')),
        last_activity_at TEXT NOT NULL, title TEXT, task_id TEXT,
        PRIMARY KEY (scope_ref, lane_ref)
      );

CREATE TABLE runtime_first_turn_watch (
        runtime_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        run_id TEXT,
        invocation_id TEXT,
        transport TEXT,
        priming_dispatched_at TEXT,
        first_turn_deadline_at TEXT,
        first_turn_at TEXT,
        first_turn_missing_tripped_at TEXT,
        disarmed_at TEXT,
        disarm_reason TEXT,
        trip_event_seq INTEGER,
        diagnostics_event_seq INTEGER,
        bundle_dir TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (runtime_id, generation)
      );

CREATE TABLE acp_bridge_emissions (
        event_id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        event TEXT NOT NULL,
        emitted_at TEXT NOT NULL
      );

CREATE TABLE hrc_event_ledger_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ledger_incarnation_id TEXT NOT NULL UNIQUE
      );

CREATE TABLE tool_result_blobs (
        blob_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('broker_raw','lifecycle_canonical')),
        bytes INTEGER NOT NULL,
        complete INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

CREATE TABLE tool_result_blob_parts (
        blob_id TEXT NOT NULL,
        part INTEGER NOT NULL,
        parts INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (blob_id, part)
      );

CREATE TABLE wrkq_ledger_cursors (
        stream TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL CHECK (high_water >= 0),
        updated_at TEXT NOT NULL
      );

CREATE TABLE hrcmail_seat_hints (
        runtime_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        hint_count INTEGER NOT NULL DEFAULT 0 CHECK (hint_count >= 0),
        last_hint_at TEXT,
        last_count INTEGER NOT NULL DEFAULT 0 CHECK (last_count >= 0)
      );

CREATE TABLE hrcmail_stop_refusals (
          runtime_id TEXT PRIMARY KEY,
          target_session_ref TEXT NOT NULL,
          observed_envelope_seq INTEGER NOT NULL DEFAULT 0
            CHECK (observed_envelope_seq >= 0),
          refusal_count INTEGER NOT NULL DEFAULT 0
            CHECK (refusal_count >= 0 AND refusal_count <= 3),
          total_refusal_count INTEGER NOT NULL DEFAULT 0
            CHECK (total_refusal_count >= 0 AND total_refusal_count <= 50),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

CREATE TABLE participant_address_reservations (
        reservation_id TEXT PRIMARY KEY,
        class_id TEXT,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        home_node_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT,
        released_by TEXT,
        release_reason TEXT
      );

CREATE TABLE participant_host_bindings (
        binding_id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL
          REFERENCES participant_address_reservations(reservation_id),
        registration_id TEXT NOT NULL
          REFERENCES participant_registrations(registration_id),
        host_incarnation_id TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        runtime_id TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('BINDING', 'BOUND', 'DETACHED', 'RETIRING', 'RETIRED')),
        predecessor_binding_id TEXT
          REFERENCES participant_host_bindings(binding_id),
        admitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        bound_at TEXT,
        retired_at TEXT,
        retirement_receipt_json TEXT,
        disposition_reason TEXT
      );

CREATE TABLE runtime_operations (
        operation_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        run_id TEXT,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation_kind TEXT NOT NULL,
        controller TEXT NOT NULL,
        compile_id TEXT,
        plan_hash TEXT,
        selected_profile_id TEXT,
        selected_profile_hash TEXT,
        startup_method TEXT NOT NULL,
        turn_delivery TEXT,
        status TEXT NOT NULL,
        route_decision_json TEXT NOT NULL,
        capability_resolution_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT
      , preparation_json TEXT);

CREATE TABLE broker_invocations (
        invocation_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        run_id TEXT,
        broker_protocol TEXT NOT NULL,
        broker_driver TEXT NOT NULL,
        broker_pid INTEGER,
        child_pid INTEGER,
        invocation_state TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        continuation_json TEXT,
        broker_continuation_json TEXT,
        spec_hash TEXT NOT NULL,
        start_request_hash TEXT NOT NULL,
        selected_profile_hash TEXT NOT NULL,
        spec_projection_json TEXT,
        start_request_projection_json TEXT,
        last_event_seq INTEGER,
        owner_server_instance_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , lifecycle_policy_hash TEXT, current_harness_generation INTEGER, current_turn_attempt INTEGER, lifecycle_terminal_reason TEXT, last_lifecycle_escalation_json TEXT, last_projected_seq INTEGER NOT NULL DEFAULT 0, retained_projected_through_seq INTEGER, execution_format TEXT NOT NULL DEFAULT 'format1');

CREATE TABLE broker_invocation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        run_id TEXT,
        runtime_id TEXT NOT NULL,
        -- Envelope-level identity (T-01946): persisted so the durable ledger can
        -- reconstruct the approved ask-bracket identity
        -- (invocationId, runId, harnessGeneration, turnAttempt, toolCallId) on
        -- restart. broker_event_json carries only envelope.payload, so these
        -- envelope fields would otherwise be lost.
        harness_generation INTEGER,
        turn_attempt INTEGER,
        broker_event_json TEXT NOT NULL,
        hrc_event_seq INTEGER,
        projection_status TEXT NOT NULL DEFAULT 'pending',
        projection_error TEXT,
        created_at TEXT NOT NULL, broker_envelope_json TEXT, source_ref TEXT, origin_seq INTEGER, evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained'),
        UNIQUE (invocation_id, seq)
      );

CREATE TABLE runtime_artifacts (
        artifact_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        storage_kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        artifact_json TEXT,
        artifact_path TEXT,
        created_at TEXT NOT NULL
      );

CREATE TABLE broker_projection_dispositions (
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        envelope_hash TEXT NOT NULL,
        disposition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (invocation_id, seq)
      );

CREATE TABLE transcript_turns (
        turn_rowid INTEGER PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent TEXT,
        project TEXT,
        task TEXT,
        scope_ref TEXT,
        generation INTEGER,
        seq_from INTEGER NOT NULL,
        seq_to INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        terminal_status TEXT NOT NULL
          CHECK (terminal_status IN ('completed', 'failed', 'interrupted')),
        message_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        user_text TEXT NOT NULL,
        final_text TEXT NOT NULL,
        mid_text TEXT NOT NULL,
        UNIQUE (invocation_id, seq_from)
      );

CREATE VIRTUAL TABLE transcript_turns_fts USING fts5(
        user_text,
        final_text,
        mid_text,
        content='transcript_turns',
        content_rowid='turn_rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

CREATE TABLE transcript_index_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_event_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE transcript_index_invocations (
        invocation_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        last_terminal_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

CREATE TABLE retained_evidence_outcomes (
        outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
        runtime_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcome_class TEXT NOT NULL,
        trigger TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL
      );

CREATE TABLE submission_admissions (
        submission_id TEXT PRIMARY KEY,
        run_id TEXT,
        runtime_id TEXT,
        invocation_id TEXT,
        door TEXT,
        envelope_id TEXT,
        admitted_at TEXT,
        disposition TEXT,
        disposed_at TEXT
      );

CREATE TABLE inputs (
        input_id TEXT PRIMARY KEY,
        admission_host_session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        host_session_id TEXT,
        runtime_id TEXT,
        operation_id TEXT,
        invocation_id TEXT,
        broker_submission_id TEXT,
        door TEXT,
        admission_class TEXT,
        origin TEXT,
        status TEXT NOT NULL,
        uncertainty TEXT,
        cleanup_protection TEXT NOT NULL,
        landing_kind TEXT,
        carrier_run_id TEXT,
        turn_id TEXT,
        run_started_hrc_seq INTEGER,
        legacy_run_id TEXT,
        admitted_at TEXT,
        landed_at TEXT,
        terminal_at TEXT,
        terminal_kind TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (admission_host_session_id, idempotency_key)
      );

CREATE TABLE "sessions" (
  host_session_id TEXT PRIMARY KEY,
  scope_ref TEXT NOT NULL,
  lane_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  prior_host_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_applied_intent_json TEXT,
  continuation_json TEXT,
  continuation_reuse_disabled INTEGER NOT NULL DEFAULT 0
          CHECK (continuation_reuse_disabled IN (0, 1)),
  FOREIGN KEY (prior_host_session_id) REFERENCES sessions(host_session_id)
);

CREATE TABLE "runtimes" (
  runtime_id TEXT PRIMARY KEY,
  host_session_id TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  lane_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  transport TEXT NOT NULL,
  harness TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  tmux_json TEXT,
  supports_inflight_input INTEGER NOT NULL,
  active_run_id TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT,
  controller_kind TEXT,
  active_operation_id TEXT,
  active_invocation_id TEXT,
  plan_hash TEXT,
  selected_profile_hash TEXT,
  runtime_state_json TEXT,
  lifecycle_terminal_reason TEXT,
  presentation_json TEXT,
  FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
);

CREATE TABLE "surface_bindings" (
  surface_kind TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  window_id TEXT,
  pane_id TEXT,
  bound_at TEXT NOT NULL,
  unbound_at TEXT,
  reason TEXT,
  client_tty TEXT,
  PRIMARY KEY (surface_kind, surface_id),
  FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
  FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
);

CREATE TABLE "participant_registrations" (
  registration_id TEXT PRIMARY KEY,
  class_id TEXT,
  join_direction TEXT NOT NULL CHECK (join_direction IN ('hrc-hosted', 'participant-served')),
  participant_key TEXT,
  scope_ref TEXT NOT NULL UNIQUE,
  lane_ref TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  workspace_cwd TEXT,
  serving_socket_path TEXT,
  address_policy TEXT
          CHECK (address_policy IS NULL OR address_policy IN ('permanent-keyed', 'selected-scope')),
  continuity_policy TEXT
          CHECK (continuity_policy IS NULL OR continuity_policy IN ('key-scoped', 'host-incarnation')),
  lifecycle_owner TEXT
          CHECK (lifecycle_owner IS NULL OR lifecycle_owner IN ('hrc-managed', 'externally-owned')),
  replay_semantics TEXT
          CHECK (replay_semantics IS NULL OR replay_semantics IN ('none', 'full-source-replay')),
  host_incarnation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (address_policy IS NOT NULL AND continuity_policy IS NOT NULL AND lifecycle_owner IS NOT NULL AND replay_semantics IS NOT NULL AND host_incarnation_id IS NOT NULL)
);

CREATE TABLE session_metadata(scope_ref TEXT NOT NULL,lane_ref TEXT NOT NULL,key TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('launch','hrc','api')),value_json TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,PRIMARY KEY(scope_ref,lane_ref,key,source));

CREATE TABLE "participant_registration_attempts" (
  attempt_id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  attach_epoch INTEGER NOT NULL CHECK (attach_epoch >= 1),
  request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  runtime_id TEXT NOT NULL,
  host_binding_id TEXT REFERENCES participant_host_bindings(binding_id),
  state TEXT NOT NULL CHECK (state IN (
          'REGISTERED', 'IDENTITY_MINTED', 'PREPARED', 'HOSTING_INTENT_PERSISTED',
          'REALIZED', 'DISPATCH_FROZEN', 'INSTALL_CONFIRMED', 'INVOCATION_READY',
          'ATTACH_CONFIRMED', 'ACTIVE', 'DETACHED', 'SUPERSEDED', 'ABANDONED', 'TERMINAL'
        )),
  prepared_profile_json TEXT,
  adapter_dispatch_env_json TEXT,
  hosting_intent_json TEXT,
  realized_hosting_json TEXT,
  dispatch_json TEXT,
  broker_identity_json TEXT,
  initial_activation_confirmed_at TEXT,
  activation_classification TEXT
          CHECK (activation_classification IN ('attached', 'replacement', 'resume', 'attached_unknown')),
  writer_evidence_json TEXT,
  recovery_disposition TEXT NOT NULL DEFAULT 'unresolved'
          CHECK (recovery_disposition IN ('unresolved', 'reconciled', 'abandoned')),
  recovery_reason TEXT,
  establishment_work_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (establishment_work_state IN ('pending', 'retry_wait', 'exhausted', 'completed')),
  establishment_attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (establishment_attempt_count >= 0),
  establishment_next_attempt_at TEXT,
  establishment_last_error TEXT,
  attach_socket_path TEXT,
  continuation_carried INTEGER
          CHECK (continuation_carried IS NULL OR continuation_carried IN (0, 1)),
  continuation_reason TEXT
          CHECK (continuation_reason IS NULL OR continuation_reason IN (
            'carried', 'no_continuation', 'continuation_invalidated', 'reuse_disabled', 'participant_fresh'
          )),
  continuation_selected_json TEXT,
  continuation_resume_state TEXT
          CHECK (continuation_resume_state IS NULL OR continuation_resume_state IN (
            'not_requested', 'requested', 'unsupported', 'indeterminate'
          )),
  continuation_resume_reason TEXT,
  replacement_intent_json TEXT,
  disposition_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((prepared_profile_json IS NULL) = (adapter_dispatch_env_json IS NULL)),
  CHECK (
          continuation_carried IS NULL
          OR (continuation_carried = 1 AND continuation_selected_json IS NOT NULL
              AND continuation_reason = 'carried')
          OR (continuation_carried = 0 AND continuation_selected_json IS NULL
              AND continuation_reason IS NOT NULL AND continuation_reason <> 'carried')
        ),
  UNIQUE(registration_id, attach_epoch),
  FOREIGN KEY (registration_id) REFERENCES participant_registrations(registration_id)
);

CREATE TABLE seat_annotations (
        scope_ref       TEXT NOT NULL,
        lane_ref        TEXT NOT NULL,
        subject         TEXT NOT NULL CHECK (subject IN ('seat','generation')),
        host_session_id TEXT NOT NULL DEFAULT '',
        generation      INTEGER,
        ns              TEXT NOT NULL,
        kind            TEXT NOT NULL,
        id              TEXT NOT NULL,
        body_json       TEXT NOT NULL,
        fence_json      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        updated_by      TEXT NOT NULL,
        PRIMARY KEY (scope_ref, lane_ref, host_session_id, ns, kind, id)
      );

CREATE TABLE seat_kind_policies (agent_id TEXT PRIMARY KEY, placement_json TEXT NOT NULL);

CREATE TABLE seat_handoffs (
        id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','acknowledged')),
        etag INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        legacy_scope TEXT
      );

-- indexs

CREATE INDEX idx_runs_runtime_id
        ON runs(runtime_id);

CREATE INDEX idx_runs_host_session_id
        ON runs(host_session_id);

CREATE INDEX idx_messages_to_seq
        ON messages(to_kind, to_ref, message_seq);

CREATE INDEX idx_messages_from_seq
        ON messages(from_kind, from_ref, message_seq);

CREATE INDEX idx_messages_root_seq
        ON messages(root_message_id, message_seq);

CREATE INDEX idx_messages_reply_to_seq
        ON messages(reply_to_message_id, message_seq);

CREATE INDEX idx_messages_session_seq
        ON messages(session_ref, message_seq);

CREATE INDEX idx_messages_host_session_seq
        ON messages(host_session_id, message_seq);

CREATE INDEX idx_messages_host_session_generation_seq
        ON messages(host_session_id, generation, message_seq);

CREATE INDEX idx_messages_run
        ON messages(run_id);

CREATE INDEX idx_hrc_events_host_session_seq
        ON hrc_events(host_session_id, hrc_seq);

CREATE INDEX idx_hrc_events_host_session_generation_seq
        ON hrc_events(host_session_id, generation, hrc_seq);

CREATE INDEX idx_hrc_events_scope_ref_seq
        ON hrc_events(scope_ref, hrc_seq);

CREATE INDEX idx_hrc_events_runtime_seq
        ON hrc_events(runtime_id, hrc_seq);

CREATE INDEX idx_hrc_events_run_seq
        ON hrc_events(run_id, hrc_seq);

CREATE INDEX idx_hrc_events_launch_seq
        ON hrc_events(launch_id, hrc_seq);

CREATE INDEX idx_hrc_events_kind_seq
        ON hrc_events(event_kind, hrc_seq);

CREATE INDEX idx_runtime_buffers_runtime_id
        ON runtime_buffers(runtime_id, created_at, chunk_seq);

CREATE INDEX idx_active_input_deliveries_runtime
        ON active_input_deliveries(runtime_id, run_id, status);

CREATE INDEX idx_runs_status_completed_at
        ON runs(status, completed_at);

CREATE INDEX idx_hrc_events_run_ts
        ON hrc_events(run_id, ts);

CREATE INDEX idx_hrc_events_run_kind_seq
        ON hrc_events(run_id, event_kind, hrc_seq);

CREATE INDEX idx_hrc_events_scope_lane_ts_seq
        ON hrc_events(scope_ref, lane_ref, ts, hrc_seq);

CREATE INDEX idx_hrc_events_run_ts_seq
        ON hrc_events(run_id, ts, hrc_seq);

CREATE INDEX idx_runs_session_generation_updated
        ON runs(host_session_id, generation, updated_at, run_id);

CREATE INDEX idx_runs_runtime_updated
        ON runs(runtime_id, updated_at, run_id);

CREATE INDEX idx_runs_scope_lane_updated
        ON runs(scope_ref, lane_ref, updated_at, run_id);

CREATE INDEX idx_runs_status_updated
        ON runs(status, updated_at, run_id);

CREATE INDEX idx_collective_history_messages_created
        ON collective_history_messages(canonical_created_at, message_id);

CREATE INDEX idx_collective_history_observations_origin
        ON collective_history_observations(origin_node_id, message_id);

CREATE INDEX idx_collective_history_replications_due
        ON collective_history_replications(state, next_attempt_at, source_message_seq);

CREATE INDEX idx_collective_history_messages_from
        ON collective_history_messages(from_ref, canonical_created_at, message_id);

CREATE INDEX idx_collective_history_messages_to
        ON collective_history_messages(to_ref, canonical_created_at, message_id);

CREATE INDEX idx_collective_history_messages_root
        ON collective_history_messages(root_message_id, canonical_created_at, message_id);

CREATE INDEX idx_collective_history_messages_reply_to
        ON collective_history_messages(reply_to_message_id);

CREATE INDEX idx_collective_history_messages_kind
        ON collective_history_messages(kind, canonical_created_at, message_id);

CREATE INDEX idx_collective_history_messages_phase
        ON collective_history_messages(phase, canonical_created_at, message_id);

CREATE INDEX idx_collective_history_messages_run
        ON collective_history_messages(run_id, canonical_created_at, message_id);

CREATE INDEX idx_collective_history_messages_host_session
        ON collective_history_messages(host_session_id, canonical_created_at, message_id);

CREATE INDEX idx_roster_claims_base_scope
        ON roster_claims(base_scope, created_at);

CREATE INDEX idx_roster_claims_successor
        ON roster_claims(successor_host_session_id);

CREATE INDEX idx_runs_queued_snapshot
        ON runs(host_session_id, status, queue_snapshot_id, queue_snapshot_position, queued_input_seq);

CREATE UNIQUE INDEX idx_runs_queued_input_seq
        ON runs(queued_input_seq) WHERE queued_input_seq IS NOT NULL;

CREATE INDEX idx_runs_coalesced_into
        ON runs(coalesced_into_run_id, coalesced_position);

CREATE INDEX idx_messages_coalesced_into
        ON messages(coalesced_into_run_id, coalesced_position);

CREATE INDEX idx_session_index_page
        ON session_index(
          last_activity_at DESC,
          host_session_id DESC,
          scope_ref,
          lane_ref,
          generation,
          agent_id,
          project_id,
          created_at,
          effective_status,
          execution_mode
        );

CREATE INDEX idx_session_index_effective_status
        ON session_index(effective_status, last_activity_at DESC, host_session_id DESC);

CREATE INDEX idx_session_index_execution_mode
        ON session_index(execution_mode, last_activity_at DESC, host_session_id DESC);

CREATE INDEX idx_session_index_agent
        ON session_index(agent_id, last_activity_at DESC, host_session_id DESC);

CREATE INDEX idx_session_index_project
        ON session_index(project_id, last_activity_at DESC, host_session_id DESC);

CREATE INDEX idx_session_index_lane
        ON session_index(lane_ref, last_activity_at DESC, host_session_id DESC);

CREATE INDEX idx_first_turn_watch_armed
        ON runtime_first_turn_watch(first_turn_deadline_at)
        WHERE first_turn_deadline_at IS NOT NULL
          AND first_turn_at IS NULL
          AND first_turn_missing_tripped_at IS NULL;

CREATE INDEX idx_first_turn_watch_trip_event
        ON runtime_first_turn_watch(trip_event_seq)
        WHERE trip_event_seq IS NOT NULL;

CREATE INDEX idx_first_turn_watch_tripped
        ON runtime_first_turn_watch(first_turn_missing_tripped_at)
        WHERE first_turn_missing_tripped_at IS NOT NULL;

CREATE INDEX idx_first_turn_watch_run_id
        ON runtime_first_turn_watch(run_id)
        WHERE run_id IS NOT NULL;

CREATE INDEX idx_acp_bridge_emissions_window
        ON acp_bridge_emissions(scope_ref, event, emitted_at);

CREATE INDEX idx_tool_result_blobs_runtime
        ON tool_result_blobs(runtime_id);

CREATE INDEX idx_hrcmail_stop_refusals_target
          ON hrcmail_stop_refusals(target_session_ref, updated_at);

CREATE UNIQUE INDEX idx_participant_reservation_address
        ON participant_address_reservations(scope_ref, lane_ref);

CREATE INDEX idx_participant_reservation_class
        ON participant_address_reservations(class_id, state);

CREATE UNIQUE INDEX idx_participant_binding_live_address
        ON participant_host_bindings(reservation_id)
        WHERE state IN ('BINDING', 'BOUND', 'DETACHED', 'RETIRING');

CREATE INDEX idx_participant_binding_registration
        ON participant_host_bindings(registration_id);

CREATE UNIQUE INDEX idx_participant_binding_incarnation
        ON participant_host_bindings(host_incarnation_id)
        WHERE state IN ('BINDING', 'BOUND');

CREATE INDEX idx_runtime_operations_runtime_id
        ON runtime_operations(runtime_id);

CREATE INDEX idx_runtime_operations_run_id
        ON runtime_operations(run_id);

CREATE INDEX idx_runtime_operations_host_session_id
        ON runtime_operations(host_session_id);

CREATE INDEX idx_runtime_operations_status
        ON runtime_operations(status);

CREATE INDEX idx_broker_invocations_operation_id
        ON broker_invocations(operation_id);

CREATE INDEX idx_broker_invocations_runtime_id
        ON broker_invocations(runtime_id);

CREATE INDEX idx_broker_invocations_run_id
        ON broker_invocations(run_id);

CREATE INDEX idx_broker_invocation_events_invocation_seq
        ON broker_invocation_events(invocation_id, seq);

CREATE INDEX idx_broker_invocation_events_projection_status
        ON broker_invocation_events(projection_status);

CREATE INDEX idx_runtime_artifacts_operation_id
        ON runtime_artifacts(operation_id);

CREATE INDEX idx_runtime_artifacts_content_hash
        ON runtime_artifacts(content_hash);

CREATE INDEX idx_runs_invocation_id
        ON runs(invocation_id);

CREATE INDEX idx_runs_dispatched_input_id
        ON runs(dispatched_input_id);

CREATE INDEX idx_broker_invocations_lifecycle_policy_hash
        ON broker_invocations(lifecycle_policy_hash);

CREATE INDEX idx_broker_invocations_lifecycle_current
        ON broker_invocations(current_harness_generation, current_turn_attempt);

CREATE INDEX idx_runtime_artifacts_operation_kind_created
        ON runtime_artifacts(operation_id, artifact_kind, created_at);

CREATE INDEX idx_runs_broker_input_fenced_at
        ON runs(broker_input_fenced_at);

CREATE UNIQUE INDEX idx_hrc_events_source_origin
          ON hrc_events(source_ref, origin_seq)
          WHERE source_ref IS NOT NULL;

CREATE UNIQUE INDEX idx_broker_invocation_events_source_origin
          ON broker_invocation_events(source_ref, origin_seq)
          WHERE source_ref IS NOT NULL;

CREATE UNIQUE INDEX idx_runs_dispatch_idempotency
        ON runs(host_session_id, dispatch_idempotency_key)
        WHERE dispatch_idempotency_key IS NOT NULL;

CREATE INDEX idx_broker_invocation_events_runtime_time_invocation_seq
        ON broker_invocation_events(runtime_id, time, invocation_id, seq);

CREATE INDEX idx_hrc_events_source_ref_seq
        ON hrc_events(source_ref, hrc_seq);

CREATE INDEX idx_hrc_events_generation_seq
        ON hrc_events(generation, hrc_seq);

CREATE INDEX idx_hrc_events_lane_seq
        ON hrc_events(lane_ref, hrc_seq);

CREATE INDEX idx_hrc_events_category_seq
        ON hrc_events(category, hrc_seq);

CREATE INDEX idx_hrc_events_retention_ts
        ON hrc_events(ts);

CREATE INDEX idx_broker_invocation_events_retention_time
        ON broker_invocation_events(time);

CREATE INDEX idx_runtime_buffers_retention_created
        ON runtime_buffers(created_at);

CREATE INDEX idx_broker_invocation_events_type
        ON broker_invocation_events(type);

CREATE UNIQUE INDEX idx_runs_broker_submission_id
        ON runs(broker_submission_id)
        WHERE broker_submission_id IS NOT NULL;

CREATE INDEX idx_transcript_turns_runtime_seq
        ON transcript_turns(runtime_id, seq_from);

CREATE INDEX idx_transcript_turns_facets
        ON transcript_turns(project, agent, task, started_at);

CREATE INDEX idx_transcript_index_invocations_runtime
        ON transcript_index_invocations(runtime_id);

CREATE INDEX idx_broker_invocation_events_invocation_type_seq
        ON broker_invocation_events(invocation_id, type, seq);

CREATE INDEX idx_runtime_operations_host_session_status
        ON runtime_operations(host_session_id, status);

CREATE INDEX idx_retained_evidence_outcomes_runtime_invocation
        ON retained_evidence_outcomes(runtime_id, invocation_id, outcome_id);

CREATE INDEX idx_submission_admissions_runtime_outstanding
        ON submission_admissions(runtime_id, door, envelope_id, disposition);

CREATE INDEX idx_broker_invocation_events_submission_disposition
        ON broker_invocation_events(CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.submissionId') END, runtime_id)
        WHERE type IN (
  'submission.absorbed', 'submission.executed', 'submission.rejected',
  'submission.expired', 'submission.withdrawn', 'submission.cancelled',
  'submission.lost'
);

CREATE INDEX idx_broker_invocation_events_input_rejected
        ON broker_invocation_events(CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.inputId') END, runtime_id)
        WHERE type = 'input.rejected';

CREATE UNIQUE INDEX idx_inputs_broker_submission_id
        ON inputs(broker_submission_id)
        WHERE broker_submission_id IS NOT NULL;

CREATE INDEX idx_inputs_runtime_protected
        ON inputs(runtime_id, invocation_id, cleanup_protection)
        WHERE cleanup_protection = 'protected';

CREATE INDEX idx_inputs_carrier_run
        ON inputs(carrier_run_id)
        WHERE carrier_run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_runs_turn_key
        ON runs(turn_key)
        WHERE turn_key IS NOT NULL;

CREATE INDEX idx_runs_initiating_input
        ON runs(initiating_input_id)
        WHERE initiating_input_id IS NOT NULL;

CREATE INDEX idx_broker_invocations_execution_format
        ON broker_invocations(execution_format);

CREATE INDEX idx_broker_invocation_events_turn_id
        ON broker_invocation_events(invocation_id, COALESCE(
  CASE WHEN json_valid(broker_envelope_json) THEN
    CASE WHEN json_type(broker_envelope_json, '$.turnId') = 'text'
      THEN json_extract(broker_envelope_json, '$.turnId') END END,
  CASE WHEN json_valid(broker_event_json) THEN
    CASE WHEN json_type(broker_event_json, '$.turnId') = 'text'
      THEN json_extract(broker_event_json, '$.turnId') END END));

CREATE INDEX idx_hrc_events_input_id_seq
        ON hrc_events(
          CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inputId') END,
          hrc_seq
        )
        WHERE category = 'input';

CREATE INDEX idx_hrc_events_turn_id_seq
        ON hrc_events(
          CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.turnId') END,
          hrc_seq
        )
        WHERE event_kind IN ('turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted');

CREATE INDEX idx_broker_invocation_events_input_id
        ON broker_invocation_events(invocation_id, CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.inputId') END);

CREATE INDEX idx_sessions_scope_lane_generation
        ON sessions(scope_ref, lane_ref, generation);

CREATE INDEX idx_runtimes_host_session_id ON runtimes(host_session_id);

CREATE INDEX idx_runtimes_active_run_id ON runtimes(active_run_id);

CREATE INDEX idx_runtimes_scope_ref ON runtimes(scope_ref);

CREATE INDEX idx_runtimes_active_invocation_id ON runtimes(active_invocation_id);

CREATE INDEX idx_runtimes_lifecycle_current
        ON runtimes(host_session_id, generation, lifecycle_terminal_reason);

CREATE INDEX idx_surface_bindings_runtime_id
        ON surface_bindings(runtime_id);

CREATE INDEX idx_surface_bindings_active_runtime
        ON surface_bindings(runtime_id, unbound_at);

CREATE UNIQUE INDEX idx_surface_bindings_active_ghostty_client_tty
        ON surface_bindings(client_tty)
        WHERE surface_kind = 'ghostty' AND unbound_at IS NULL AND client_tty IS NOT NULL;

CREATE INDEX idx_participant_registration_incarnation
        ON participant_registrations(host_incarnation_id)
        WHERE host_incarnation_id IS NOT NULL;

CREATE INDEX idx_participant_attempts_registration
        ON participant_registration_attempts(registration_id, attach_epoch);

CREATE INDEX idx_participant_attempts_state
        ON participant_registration_attempts(state, updated_at);

CREATE INDEX idx_participant_attempts_establishment_work
        ON participant_registration_attempts(establishment_work_state, establishment_next_attempt_at);

CREATE INDEX idx_participant_attempts_host_binding
        ON participant_registration_attempts(host_binding_id);

CREATE INDEX idx_participant_attempts_runtime
        ON participant_registration_attempts(runtime_id);

CREATE INDEX seat_annotations_by_session ON seat_annotations (host_session_id, updated_at);

CREATE UNIQUE INDEX seat_handoffs_pending ON seat_handoffs(scope_ref,lane_ref) WHERE state='pending';

CREATE INDEX seat_handoffs_project ON seat_handoffs(project_id,created_at);

CREATE INDEX seat_handoffs_seat ON seat_handoffs(scope_ref,lane_ref,created_at);

CREATE INDEX idx_runtimes_status ON runtimes(status);

CREATE INDEX idx_runtimes_live ON runtimes(created_at, runtime_id)
        WHERE status NOT IN ('archived','crashed','dead','disposed','exited','failed','stale','stopped','terminal','terminated');

CREATE INDEX idx_runtimes_available ON runtimes(host_session_id)
        WHERE status NOT IN ('terminated','dead','stale','crashed','detached');

CREATE INDEX idx_runtimes_recent_activity
        ON runtimes(COALESCE(last_activity_at, status_changed_at, updated_at, created_at));

CREATE INDEX idx_runtimes_session_activity
        ON runtimes(COALESCE(last_activity_at, created_at), host_session_id);

CREATE INDEX idx_sessions_created_at ON sessions(created_at);

-- views

CREATE VIEW session_index_projection_source AS
      SELECT
        s.scope_ref,
        s.lane_ref,
        s.host_session_id,
        s.generation,
        c.agent_id, c.project_id, c.task_id,
        s.created_at,
        CASE
          WHEN lower(s.status) LIKE '%stale%' THEN 'stale'
          WHEN lower(s.status) LIKE '%inactive%'
            OR lower(s.status) LIKE '%archived%'
            OR lower(s.status) LIKE '%closed%'
            OR lower(s.status) LIKE '%terminated%' THEN 'inactive'
          WHEN lower(r.status) = 'detached' THEN 'detached'
          WHEN lower(r.status) LIKE '%stale%' THEN 'stale'
          WHEN r.runtime_id IS NULL
            OR lower(r.status) IN ('dead', 'stopped', 'crashed', 'exited', 'terminated')
            THEN 'inactive'
          ELSE 'active'
        END AS effective_status,
        CASE
          WHEN json_extract(s.last_applied_intent_json, '$.execution.preferredMode')
            IN ('headless', 'interactive', 'nonInteractive')
            THEN json_extract(s.last_applied_intent_json, '$.execution.preferredMode')
          WHEN r.transport = 'headless' THEN 'headless'
          WHEN r.supports_inflight_input = 1 THEN 'interactive'
          ELSE 'nonInteractive'
        END AS execution_mode,
        COALESCE(
          (
            SELECT MAX(e.ts)
            FROM hrc_events e
            WHERE e.host_session_id = s.host_session_id
              AND e.generation = s.generation
          ),
          r.last_activity_at,
          s.updated_at
        ) AS backfill_last_activity_at,
        (SELECT json_extract(m.value_json,'$') FROM session_metadata m WHERE m.scope_ref=s.scope_ref AND m.lane_ref=s.lane_ref AND m.key='title' ORDER BY CASE m.source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC LIMIT 1) AS title
      FROM sessions s
      INNER JOIN continuities c
        ON c.scope_ref = s.scope_ref
       AND c.lane_ref = s.lane_ref
       AND c.active_host_session_id = s.host_session_id
      LEFT JOIN runtimes r
        ON r.runtime_id = (
          SELECT lr.runtime_id
          FROM runtimes lr
          WHERE lr.host_session_id = s.host_session_id
            AND lr.generation = s.generation
          ORDER BY lr.updated_at DESC, lr.runtime_id DESC
          LIMIT 1
        );

-- triggers

CREATE TRIGGER participant_reservation_release_insert
      BEFORE INSERT ON participant_address_reservations
      WHEN NEW.state = 'released'
        AND (length(trim(COALESCE(NEW.released_at, ''))) = 0
          OR length(trim(COALESCE(NEW.released_by, ''))) = 0
          OR length(trim(COALESCE(NEW.release_reason, ''))) = 0)
      BEGIN
        SELECT RAISE(ABORT, 'participant address release requires actor and reason');
      END;

CREATE TRIGGER participant_reservation_release_update
      BEFORE UPDATE OF state, released_at, released_by, release_reason
        ON participant_address_reservations
      WHEN NEW.state = 'released'
        AND (length(trim(COALESCE(NEW.released_at, ''))) = 0
          OR length(trim(COALESCE(NEW.released_by, ''))) = 0
          OR length(trim(COALESCE(NEW.release_reason, ''))) = 0)
      BEGIN
        SELECT RAISE(ABORT, 'participant address release requires actor and reason');
      END;

CREATE TRIGGER participant_binding_retiring_receipt_insert
      BEFORE INSERT ON participant_host_bindings
      WHEN NEW.state = 'RETIRING'
        AND length(trim(COALESCE(NEW.retirement_receipt_json, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retiring participant host binding requires a retirement receipt');
      END;

CREATE TRIGGER participant_binding_retiring_receipt_update
      BEFORE UPDATE OF state, retirement_receipt_json ON participant_host_bindings
      WHEN NEW.state = 'RETIRING'
        AND length(trim(COALESCE(NEW.retirement_receipt_json, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retiring participant host binding requires a retirement receipt');
      END;

CREATE TRIGGER participant_binding_retired_reason_insert
      BEFORE INSERT ON participant_host_bindings
      WHEN NEW.state = 'RETIRED'
        AND length(trim(COALESCE(NEW.disposition_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retired participant host binding requires a disposition reason');
      END;

CREATE TRIGGER participant_binding_retired_reason_update
      BEFORE UPDATE OF state, disposition_reason ON participant_host_bindings
      WHEN NEW.state = 'RETIRED'
        AND length(trim(COALESCE(NEW.disposition_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retired participant host binding requires a disposition reason');
      END;

CREATE TRIGGER trg_hrc_events_source_origin_insert
          BEFORE INSERT ON hrc_events
          WHEN (NEW.source_ref IS NULL) != (NEW.origin_seq IS NULL)
          BEGIN
            SELECT RAISE(ABORT, 'source_ref and origin_seq must be both null or both non-null');
          END;

CREATE TRIGGER trg_hrc_events_source_origin_update
          BEFORE UPDATE OF source_ref, origin_seq ON hrc_events
          WHEN (NEW.source_ref IS NULL) != (NEW.origin_seq IS NULL)
          BEGIN
            SELECT RAISE(ABORT, 'source_ref and origin_seq must be both null or both non-null');
          END;

CREATE TRIGGER trg_broker_invocation_events_source_origin_insert
          BEFORE INSERT ON broker_invocation_events
          WHEN (NEW.source_ref IS NULL) != (NEW.origin_seq IS NULL)
          BEGIN
            SELECT RAISE(ABORT, 'source_ref and origin_seq must be both null or both non-null');
          END;

CREATE TRIGGER trg_broker_invocation_events_source_origin_update
          BEFORE UPDATE OF source_ref, origin_seq ON broker_invocation_events
          WHEN (NEW.source_ref IS NULL) != (NEW.origin_seq IS NULL)
          BEGIN
            SELECT RAISE(ABORT, 'source_ref and origin_seq must be both null or both non-null');
          END;

CREATE TRIGGER transcript_turns_ai AFTER INSERT ON transcript_turns BEGIN
        INSERT INTO transcript_turns_fts(rowid, user_text, final_text, mid_text)
        VALUES (new.turn_rowid, new.user_text, new.final_text, new.mid_text);
      END;

CREATE TRIGGER transcript_turns_ad AFTER DELETE ON transcript_turns BEGIN
        INSERT INTO transcript_turns_fts(transcript_turns_fts, rowid, user_text, final_text, mid_text)
        VALUES ('delete', old.turn_rowid, old.user_text, old.final_text, old.mid_text);
      END;

CREATE TRIGGER transcript_turns_au AFTER UPDATE ON transcript_turns BEGIN
        INSERT INTO transcript_turns_fts(transcript_turns_fts, rowid, user_text, final_text, mid_text)
        VALUES ('delete', old.turn_rowid, old.user_text, old.final_text, old.mid_text);
        INSERT INTO transcript_turns_fts(rowid, user_text, final_text, mid_text)
        VALUES (new.turn_rowid, new.user_text, new.final_text, new.mid_text);
      END;

CREATE TRIGGER session_index_session_derived_update
      AFTER UPDATE OF status, last_applied_intent_json, continuation_json
      ON sessions
      BEGIN
        UPDATE session_index
        SET
          agent_id = (
            SELECT agent_id FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          ),
          project_id = (
            SELECT project_id FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          ),
          effective_status = (
            SELECT effective_status FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          ),
          execution_mode = (
            SELECT execution_mode FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          )
        WHERE host_session_id = NEW.host_session_id;
      END;

CREATE TRIGGER session_index_hrc_event_insert
      AFTER INSERT ON hrc_events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END;

CREATE TRIGGER session_index_continuity_insert
      AFTER INSERT ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id, task_id,
          created_at, effective_status, execution_mode, last_activity_at, title
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id, task_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at, title
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id, task_id = excluded.task_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at,
          title = excluded.title;
      END;

CREATE TRIGGER session_index_continuity_update
      AFTER UPDATE OF active_host_session_id ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id, task_id,
          created_at, effective_status, execution_mode, last_activity_at, title
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id, task_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at, title
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id, task_id = excluded.task_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at,
          title = excluded.title;
      END;

CREATE TRIGGER session_index_runtime_insert
    AFTER INSERT ON runtimes
    BEGIN
      UPDATE session_index
      SET
        effective_status = (
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        execution_mode = (
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        last_activity_at = max(last_activity_at, COALESCE(NEW.last_activity_at, last_activity_at))
      WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
    END;

CREATE TRIGGER session_index_runtime_update
    AFTER UPDATE ON runtimes
    BEGIN
      UPDATE session_index
      SET
        effective_status = COALESCE((
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        ), effective_status),
        execution_mode = COALESCE((
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        ), execution_mode)
      WHERE host_session_id = OLD.host_session_id AND generation = OLD.generation;

      UPDATE session_index
      SET
        effective_status = (
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        execution_mode = (
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        last_activity_at = max(last_activity_at, COALESCE(NEW.last_activity_at, last_activity_at))
      WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
    END;

CREATE TRIGGER session_index_runtime_delete
    AFTER DELETE ON runtimes
    BEGIN
      UPDATE session_index
      SET
        effective_status = (
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        ),
        execution_mode = (
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        )
      WHERE host_session_id = OLD.host_session_id AND generation = OLD.generation;
    END;

CREATE TRIGGER session_index_metadata_insert AFTER INSERT ON session_metadata WHEN NEW.key='title' BEGIN UPDATE session_index SET title=(SELECT json_extract(value_json,'$') FROM session_metadata WHERE scope_ref=NEW.scope_ref AND lane_ref=NEW.lane_ref AND key='title' ORDER BY CASE source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC LIMIT 1) WHERE scope_ref=NEW.scope_ref AND lane_ref=NEW.lane_ref; END;

CREATE TRIGGER session_index_metadata_update AFTER UPDATE ON session_metadata WHEN NEW.key='title' BEGIN UPDATE session_index SET title=(SELECT json_extract(value_json,'$') FROM session_metadata WHERE scope_ref=NEW.scope_ref AND lane_ref=NEW.lane_ref AND key='title' ORDER BY CASE source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC LIMIT 1) WHERE scope_ref=NEW.scope_ref AND lane_ref=NEW.lane_ref; END;

CREATE TRIGGER session_index_metadata_delete AFTER DELETE ON session_metadata WHEN OLD.key='title' BEGIN UPDATE session_index SET title=(SELECT json_extract(value_json,'$') FROM session_metadata WHERE scope_ref=OLD.scope_ref AND lane_ref=OLD.lane_ref AND key='title' ORDER BY CASE source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC LIMIT 1) WHERE scope_ref=OLD.scope_ref AND lane_ref=OLD.lane_ref; END;

CREATE TRIGGER participant_recovery_reason_insert
      BEFORE INSERT ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END;

CREATE TRIGGER participant_recovery_reason_update
      BEFORE UPDATE OF recovery_disposition, recovery_reason ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END;

CREATE TRIGGER participant_attempt_runtime_owner_insert
      BEFORE INSERT ON participant_registration_attempts
      WHEN EXISTS (
        SELECT 1 FROM participant_registration_attempts other
         WHERE other.runtime_id = NEW.runtime_id
           AND other.attempt_id <> NEW.attempt_id
           AND (other.host_binding_id IS NULL
             OR NEW.host_binding_id IS NULL
             OR other.host_binding_id <> NEW.host_binding_id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'participant attempt runtime is owned by a different host binding');
      END;

CREATE TRIGGER participant_attempt_runtime_owner_update
      BEFORE UPDATE OF runtime_id, host_binding_id ON participant_registration_attempts
      WHEN EXISTS (
        SELECT 1 FROM participant_registration_attempts other
         WHERE other.runtime_id = NEW.runtime_id
           AND other.attempt_id <> NEW.attempt_id
           AND (other.host_binding_id IS NULL
             OR NEW.host_binding_id IS NULL
             OR other.host_binding_id <> NEW.host_binding_id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'participant attempt runtime is owned by a different host binding');
      END;
