import type { Database, SQLQueryBindings } from 'bun:sqlite'

import {
  categoryForLegacyHrcEventKind,
  computeMigrationPermissionIdentityKey,
  normalizeLegacyHrcPayload,
  parseLegacyEventJson,
  type LegacyHrcEventRow,
} from './migrations/legacy-hrc-event-backfill.js'

export type HrcMigration = {
  id: string
  apply(db: Database): void
}

const phase1SchemaMigration: HrcMigration = {
  id: '0001_phase1_schema',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuities (
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        active_host_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_ref, lane_ref)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        host_session_id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        prior_host_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parsed_scope_json TEXT,
        ancestor_scope_refs_json TEXT NOT NULL,
        last_applied_intent_json TEXT,
        continuation_json TEXT,
        FOREIGN KEY (prior_host_session_id) REFERENCES sessions(host_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_scope_lane_generation
        ON sessions(scope_ref, lane_ref, generation);

      CREATE TABLE IF NOT EXISTS runtimes (
        runtime_id TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        launch_id TEXT,
        transport TEXT NOT NULL,
        harness TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        tmux_json TEXT,
        wrapper_pid INTEGER,
        child_pid INTEGER,
        harness_session_json TEXT,
        continuation_json TEXT,
        supports_inflight_input INTEGER NOT NULL,
        adopted INTEGER NOT NULL,
        active_run_id TEXT,
        last_activity_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runtimes_host_session_id
        ON runtimes(host_session_id);

      CREATE INDEX IF NOT EXISTS idx_runtimes_active_run_id
        ON runtimes(active_run_id);

      CREATE TABLE IF NOT EXISTS runs (
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
        error_message TEXT,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_runtime_id
        ON runs(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_runs_host_session_id
        ON runs(host_session_id);

      CREATE TABLE IF NOT EXISTS launches (
        launch_id TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        runtime_id TEXT,
        harness TEXT NOT NULL,
        provider TEXT NOT NULL,
        launch_artifact_path TEXT NOT NULL,
        tmux_json TEXT,
        wrapper_pid INTEGER,
        child_pid INTEGER,
        harness_session_json TEXT,
        continuation_json TEXT,
        wrapper_started_at TEXT,
        child_started_at TEXT,
        exited_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_launches_runtime_id
        ON launches(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_launches_host_session_id
        ON launches(host_session_id);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        run_id TEXT,
        runtime_id TEXT,
        source TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_host_session_seq
        ON events(host_session_id, seq);

      CREATE INDEX IF NOT EXISTS idx_events_runtime_seq
        ON events(runtime_id, seq);

      CREATE INDEX IF NOT EXISTS idx_events_run_seq
        ON events(run_id, seq);

      CREATE TABLE IF NOT EXISTS runtime_buffers (
        runtime_id TEXT NOT NULL,
        chunk_seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (runtime_id, chunk_seq),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );
    `)
  },
}

const phase4SurfaceBindingsMigration: HrcMigration = {
  id: '0002_phase4_surface_bindings',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS surface_bindings (
        surface_kind TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        window_id TEXT,
        tab_id TEXT,
        pane_id TEXT,
        bound_at TEXT NOT NULL,
        unbound_at TEXT,
        reason TEXT,
        PRIMARY KEY (surface_kind, surface_id),
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_surface_bindings_runtime_id
        ON surface_bindings(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_surface_bindings_active_runtime
        ON surface_bindings(runtime_id, unbound_at);
    `)
  },
}

const phase5WorkbenchSessionsAndLocalBridgesMigration: HrcMigration = {
  id: '0003_phase5_app_sessions_and_bridges',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        app_id TEXT NOT NULL,
        app_session_key TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        label TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT,
        PRIMARY KEY (app_id, app_session_key),
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_sessions_host_session_id
        ON app_sessions(host_session_id);

      CREATE TABLE IF NOT EXISTS local_bridges (
        bridge_id TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        runtime_id TEXT,
        transport TEXT NOT NULL,
        target TEXT NOT NULL,
        expected_host_session_id TEXT,
        expected_generation INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
        FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_local_bridges_host_session_id
        ON local_bridges(host_session_id);

      CREATE INDEX IF NOT EXISTS idx_local_bridges_status
        ON local_bridges(status);
    `)
  },
}

const phase6LocalBridgesRuntimeIdIndexMigration: HrcMigration = {
  id: '0004_phase6_local_bridges_runtime_id_index',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_bridges_runtime_id
        ON local_bridges(runtime_id);
    `)
  },
}

const phase7ManagedAppSessionsMigration: HrcMigration = {
  id: '0005_app_managed_sessions',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_managed_sessions (
        app_id TEXT NOT NULL,
        app_session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT,
        metadata_json TEXT,
        active_host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_applied_spec_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT,
        PRIMARY KEY (app_id, app_session_key),
        FOREIGN KEY (active_host_session_id) REFERENCES sessions(host_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_managed_sessions_active_host_session_id
        ON app_managed_sessions(active_host_session_id);

      CREATE INDEX IF NOT EXISTS idx_app_managed_sessions_status
        ON app_managed_sessions(status);

      CREATE INDEX IF NOT EXISTS idx_app_managed_sessions_kind
        ON app_managed_sessions(kind);
    `)
  },
}

const phase8CommandRuntimeFieldsMigration: HrcMigration = {
  id: '0006_command_runtime_fields',
  apply(db) {
    const runtimeColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
      .all()
      .map((row) => row.name)
    const existing = new Set(runtimeColumns)

    if (!existing.has('runtime_kind')) {
      db.exec(`
        ALTER TABLE runtimes
        ADD COLUMN runtime_kind TEXT
      `)
    }

    if (!existing.has('command_spec_json')) {
      db.exec(`
        ALTER TABLE runtimes
        ADD COLUMN command_spec_json TEXT
      `)
    }

    db.exec(`
      UPDATE runtimes
      SET runtime_kind = COALESCE(runtime_kind, 'harness')
    `)

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_runtime_kind
        ON runtimes(runtime_kind);
    `)
  },
}

const interactiveSurfaceJsonMigration: HrcMigration = {
  id: '0015_interactive_surface_json',
  apply(db) {
    const runtimeColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
      .all()
      .map((row) => row.name)
    const launchColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(launches)')
      .all()
      .map((row) => row.name)

    if (!runtimeColumns.includes('surface_json')) {
      db.exec(`
        ALTER TABLE runtimes
        ADD COLUMN surface_json TEXT
      `)
    }

    if (!launchColumns.includes('surface_json')) {
      db.exec(`
        ALTER TABLE launches
        ADD COLUMN surface_json TEXT
      `)
    }
  },
}

const hrcEventsMigration: HrcMigration = {
  id: '0008_hrc_events',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_stream_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_seq INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hrc_events (
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
        payload_json TEXT NOT NULL,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_hrc_events_host_session_seq
        ON hrc_events(host_session_id, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_host_session_generation_seq
        ON hrc_events(host_session_id, generation, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_scope_ref_seq
        ON hrc_events(scope_ref, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_runtime_seq
        ON hrc_events(runtime_id, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_run_seq
        ON hrc_events(run_id, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_launch_seq
        ON hrc_events(launch_id, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_kind_seq
        ON hrc_events(event_kind, hrc_seq);
    `)

    const eventsColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(events)')
      .all()
      .map((row) => row.name)

    if (!eventsColumns.includes('stream_seq')) {
      db.exec('ALTER TABLE events ADD COLUMN stream_seq INTEGER')
      db.exec('UPDATE events SET stream_seq = seq WHERE stream_seq IS NULL')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_stream_seq ON events(stream_seq)')
    }

    const maxEventSeq =
      db.query<{ max_seq: number | null }, []>('SELECT MAX(seq) AS max_seq FROM events').get()
        ?.max_seq ?? 0

    db.exec(
      `INSERT OR IGNORE INTO event_stream_cursor (id, next_seq) VALUES (1, ${maxEventSeq + 1})`
    )
  },
}

const legacyHrcEventsBackfillMigration: HrcMigration = {
  id: '0009_backfill_legacy_hrc_events',
  apply(db) {
    const eventsColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(events)')
      .all()
      .map((row) => row.name)

    if (!eventsColumns.includes('stream_seq')) {
      db.exec('ALTER TABLE events ADD COLUMN stream_seq INTEGER')
    }
    db.exec('UPDATE events SET stream_seq = seq WHERE stream_seq IS NULL')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_stream_seq ON events(stream_seq)')

    const legacyRows = db
      .query<LegacyHrcEventRow, [string]>(
        `
          SELECT
            seq,
            stream_seq,
            ts,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            runtime_id,
            run_id,
            event_kind,
            event_json
          FROM events
          WHERE source = ?
          ORDER BY stream_seq ASC, seq ASC
        `
      )
      .all('hrc')

    if (legacyRows.length > 0) {
      const insertHrcEvent = db.prepare<
        never,
        [
          number,
          string,
          string,
          string,
          string,
          number,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string,
          string,
          'sdk' | 'tmux' | 'ghostty' | null,
          string | null,
          number,
          string,
        ]
      >(`
        INSERT OR IGNORE INTO hrc_events (
          stream_seq,
          ts,
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          runtime_id,
          run_id,
          launch_id,
          app_id,
          app_session_key,
          category,
          event_kind,
          transport,
          error_code,
          replayed,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const row of legacyRows) {
        const eventJson = parseLegacyEventJson(row.event_json)
        const normalized = normalizeLegacyHrcPayload(eventJson)
        insertHrcEvent.run(
          row.stream_seq ?? row.seq,
          row.ts,
          row.host_session_id,
          row.scope_ref,
          row.lane_ref,
          row.generation,
          row.runtime_id ?? null,
          row.run_id ?? null,
          normalized.launchId ?? null,
          normalized.appId ?? null,
          normalized.appSessionKey ?? null,
          categoryForLegacyHrcEventKind(row.event_kind),
          row.event_kind,
          normalized.transport ?? null,
          normalized.errorCode ?? null,
          normalized.replayed ? 1 : 0,
          JSON.stringify(normalized.payload)
        )
      }

      execute(db, 'DELETE FROM events WHERE source = ?', 'hrc')
    }

    const maxStreamSeq =
      db
        .query<{ max_seq: number | null }, []>(
          `
            SELECT MAX(stream_seq) AS max_seq
            FROM (
              SELECT stream_seq FROM events
              UNION ALL
              SELECT stream_seq FROM hrc_events
            )
          `
        )
        .get()?.max_seq ?? 0

    execute(
      db,
      `
        INSERT INTO event_stream_cursor (id, next_seq)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq)
      `,
      maxStreamSeq + 1
    )
  },
}

const runtimeBuffersScopedByRunMigration: HrcMigration = {
  id: '0010_runtime_buffers_scoped_by_run',
  apply(db) {
    db.exec(`
      DROP TABLE IF EXISTS runtime_buffers;

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

      CREATE INDEX IF NOT EXISTS idx_runtime_buffers_runtime_id
        ON runtime_buffers(runtime_id, created_at, chunk_seq);
    `)
  },
}

const hrcchatMessagesMigration: HrcMigration = {
  id: '0007_hrcchat_messages',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
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
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to_seq
        ON messages(to_kind, to_ref, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_from_seq
        ON messages(from_kind, from_ref, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_root_seq
        ON messages(root_message_id, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_reply_to_seq
        ON messages(reply_to_message_id, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_session_seq
        ON messages(session_ref, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_host_session_seq
        ON messages(host_session_id, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_host_session_generation_seq
        ON messages(host_session_id, generation, message_seq);

      CREATE INDEX IF NOT EXISTS idx_messages_run
        ON messages(run_id);
    `)
  },
}

const activeInputDeliveriesMigration: HrcMigration = {
  id: '0010_active_input_deliveries',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_input_deliveries (
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

      CREATE INDEX IF NOT EXISTS idx_active_input_deliveries_runtime
        ON active_input_deliveries(runtime_id, run_id, status);
    `)
  },
}

const zombieRunSweepIndexesMigration: HrcMigration = {
  id: '0012_zombie_run_sweep_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_status_completed_at
        ON runs(status, completed_at);

      CREATE INDEX IF NOT EXISTS idx_events_run_ts
        ON events(run_id, ts);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_run_ts
        ON hrc_events(run_id, ts);

      CREATE INDEX IF NOT EXISTS idx_runtimes_active_run_id
        ON runtimes(active_run_id);
    `)
  },
}

const hrcEventsCanonicalReaderIndexesMigration: HrcMigration = {
  id: '0013_hrc_events_canonical_reader_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hrc_events_run_kind_seq
        ON hrc_events(run_id, event_kind, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_scope_lane_ts_seq
        ON hrc_events(scope_ref, lane_ref, ts, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_run_ts_seq
        ON hrc_events(run_id, ts, hrc_seq);
    `)
  },
}

const runSessionLookupIndexesMigration: HrcMigration = {
  id: '0014_run_session_lookup_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_session_generation_updated
        ON runs(host_session_id, generation, updated_at, run_id);

      CREATE INDEX IF NOT EXISTS idx_runs_runtime_updated
        ON runs(runtime_id, updated_at, run_id);
    `)
  },
}

// ── Harness Broker persistence (T-01690 W1B) ──────────────────────────────
// Additive-only: six new tables for broker operations/invocations/events/
// artifacts/permission decisions plus compiled plans. No existing table or
// query is altered here. The broker_invocation_events table carries the
// UNIQUE(invocation_id, seq) constraint that backs the mapper's idempotent
// append invariant. New tables intentionally carry no foreign keys so the
// event log can be persisted before/atomically with projection and so the
// broker subsystem stays decoupled from legacy launch tables.
const brokerPersistenceMigration: HrcMigration = {
  id: '0016_broker_persistence',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compiled_runtime_plans (
        plan_hash TEXT PRIMARY KEY,
        compile_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        compiler_name TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        plan_projection_json TEXT NOT NULL,
        diagnostics_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_compiled_runtime_plans_compile_id
        ON compiled_runtime_plans(compile_id);

      CREATE TABLE IF NOT EXISTS runtime_operations (
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
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_runtime_id
        ON runtime_operations(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_run_id
        ON runtime_operations(run_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_host_session_id
        ON runtime_operations(host_session_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_status
        ON runtime_operations(status);

      CREATE TABLE IF NOT EXISTS broker_invocations (
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
      );

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_operation_id
        ON broker_invocations(operation_id);

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_runtime_id
        ON broker_invocations(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_run_id
        ON broker_invocations(run_id);

      CREATE TABLE IF NOT EXISTS broker_invocation_events (
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
        created_at TEXT NOT NULL,
        UNIQUE (invocation_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_invocation_seq
        ON broker_invocation_events(invocation_id, seq);

      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_projection_status
        ON broker_invocation_events(projection_status);

      CREATE TABLE IF NOT EXISTS runtime_artifacts (
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

      CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_operation_id
        ON runtime_artifacts(operation_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_content_hash
        ON runtime_artifacts(content_hash);

      CREATE TABLE IF NOT EXISTS permission_decisions (
        permission_request_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        subject_display_json TEXT NOT NULL,
        default_decision TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_invocation_id
        ON permission_decisions(invocation_id);

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_runtime_id
        ON permission_decisions(runtime_id);
    `)
  },
}

// Nullable broker runtime/run state. Uses the PRAGMA table_info guard +
// ALTER TABLE ADD COLUMN pattern (same as 0006/0015) so the migration is safe
// to re-run and applies cleanly over a populated legacy DB. Every column is
// nullable with no default, so existing rows survive untouched and legacy code
// paths that never read these columns are unaffected.
const runtimeBrokerStateMigration: HrcMigration = {
  id: '0017_runtime_broker_state',
  apply(db) {
    const runtimeColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
        .all()
        .map((row) => row.name)
    )
    const runtimeAdditions = [
      'controller_kind',
      'active_operation_id',
      'active_invocation_id',
      'compile_id',
      'plan_hash',
      'selected_profile_hash',
      'runtime_state_json',
    ]
    for (const column of runtimeAdditions) {
      if (!runtimeColumns.has(column)) {
        db.exec(`ALTER TABLE runtimes ADD COLUMN ${column} TEXT`)
      }
    }

    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    for (const column of ['operation_id', 'invocation_id']) {
      if (!runColumns.has(column)) {
        db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_active_invocation_id
        ON runtimes(active_invocation_id);

      CREATE INDEX IF NOT EXISTS idx_runs_invocation_id
        ON runs(invocation_id);
    `)
  },
}

// Broker FIFO input-queue support: persist HRC's dispatched inputId on each run
// so the broker event-mapper can correlate a drained (queued) input.accepted
// envelope back to its run and flip invocation.runId before downstream turn.*
// events project. Same ALTER TABLE ADD COLUMN pattern as 0017; idempotent.
const runsDispatchedInputIdMigration: HrcMigration = {
  id: '0018_runs_dispatched_input_id',
  apply(db) {
    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    if (!runColumns.has('dispatched_input_id')) {
      db.exec('ALTER TABLE runs ADD COLUMN dispatched_input_id TEXT')
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_dispatched_input_id
        ON runs(dispatched_input_id);
    `)
  },
}

const lifecyclePolicyAuditMigration: HrcMigration = {
  id: '0019_lifecycle_policy_audit',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_policies (
        policy_id TEXT NOT NULL,
        lifecycle_policy_hash TEXT PRIMARY KEY,
        canonical_policy_json TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_policies_policy_id
        ON lifecycle_policies(policy_id);
    `)

    const invocationColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocations)')
        .all()
        .map((row) => row.name)
    )
    if (!invocationColumns.has('lifecycle_policy_hash')) {
      db.exec('ALTER TABLE broker_invocations ADD COLUMN lifecycle_policy_hash TEXT')
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_broker_invocations_lifecycle_policy_hash
        ON broker_invocations(lifecycle_policy_hash);
    `)
  },
}

const runtimeLifecycleStateMigration: HrcMigration = {
  id: '0020_runtime_lifecycle_state',
  apply(db) {
    const additions: Array<[column: string, type: string]> = [
      ['lifecycle_policy_hash', 'TEXT'],
      ['current_harness_generation', 'INTEGER'],
      ['current_turn_attempt', 'INTEGER'],
      ['lifecycle_terminal_reason', 'TEXT'],
      ['last_lifecycle_escalation_json', 'TEXT'],
    ]

    for (const table of ['runtimes', 'broker_invocations']) {
      const columns = new Set(
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name)
      )
      for (const [column, type] of additions) {
        if (!columns.has(column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
        }
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_lifecycle_policy_hash
        ON runtimes(lifecycle_policy_hash);

      CREATE INDEX IF NOT EXISTS idx_runtimes_lifecycle_current
        ON runtimes(current_harness_generation, current_turn_attempt);

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_lifecycle_current
        ON broker_invocations(current_harness_generation, current_turn_attempt);
    `)
  },
}

const permissionIdentityMigration: HrcMigration = {
  id: '0021_permission_identity',
  apply(db) {
    const columns = db
      .query<{ name: string; pk: number }, []>('PRAGMA table_info(permission_decisions)')
      .all()
    const hasIdentityKey = columns.some((row) => row.name === 'permission_identity_key')
    const identityKeyIsPrimary = columns.some(
      (row) => row.name === 'permission_identity_key' && row.pk > 0
    )

    if (!hasIdentityKey || !identityKeyIsPrimary) {
      db.exec('ALTER TABLE permission_decisions RENAME TO permission_decisions_legacy_0021')
      db.exec(`
        CREATE TABLE permission_decisions (
          permission_identity_key TEXT PRIMARY KEY,
          permission_request_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          harness_generation INTEGER,
          turn_attempt INTEGER,
          runtime_id TEXT NOT NULL,
          run_id TEXT,
          kind TEXT NOT NULL,
          subject_display_json TEXT NOT NULL,
          default_decision TEXT NOT NULL,
          decision TEXT NOT NULL,
          decided_by TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          UNIQUE (invocation_id, harness_generation, turn_attempt, permission_request_id)
        );
      `)

      const legacyRows = db
        .query<
          {
            permission_request_id: string
            invocation_id: string
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
          },
          []
        >(
          `
            SELECT
              permission_request_id,
              invocation_id,
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
            FROM permission_decisions_legacy_0021
          `
        )
        .all()

      const insert = db.prepare<
        never,
        [
          string,
          string,
          string,
          number | null,
          number | null,
          string,
          string | null,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      >(`
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
      `)

      for (const row of legacyRows) {
        insert.run(
          computeMigrationPermissionIdentityKey({
            invocationId: row.invocation_id,
            harnessGeneration: null,
            turnAttempt: null,
            permissionRequestId: row.permission_request_id,
          }),
          row.permission_request_id,
          row.invocation_id,
          null,
          null,
          row.runtime_id,
          row.run_id,
          row.kind,
          row.subject_display_json,
          row.default_decision,
          row.decision,
          row.decided_by,
          row.policy_json,
          row.requested_at,
          row.decided_at
        )
      }

      db.exec('DROP TABLE permission_decisions_legacy_0021')
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_decisions_identity_tuple
        ON permission_decisions(
          invocation_id,
          harness_generation,
          turn_attempt,
          permission_request_id
        );

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_permission_request_id
        ON permission_decisions(permission_request_id);

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_invocation_id
        ON permission_decisions(invocation_id);

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_runtime_id
        ON permission_decisions(runtime_id);
    `)
  },
}

// T-01946: persist the envelope-level identity (harnessGeneration / turnAttempt)
// on broker_invocation_events so the durable ledger can reconstruct the approved
// ask-bracket identity (invocationId, runId, harnessGeneration, turnAttempt,
// toolCallId). broker_event_json carries only envelope.payload; these envelope
// fields would otherwise be unrecoverable on restart, leaving the bracket close
// match unable to enforce same run/generation/attempt.
const brokerEventIdentityMigration: HrcMigration = {
  id: '0022_broker_event_identity',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocation_events)')
        .all()
        .map((row) => row.name)
    )
    for (const column of ['harness_generation', 'turn_attempt']) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE broker_invocation_events ADD COLUMN ${column} INTEGER`)
      }
    }
  },
}

export const phase1Migrations: readonly HrcMigration[] = [
  phase1SchemaMigration,
  phase4SurfaceBindingsMigration,
  phase5WorkbenchSessionsAndLocalBridgesMigration,
  phase6LocalBridgesRuntimeIdIndexMigration,
  phase7ManagedAppSessionsMigration,
  phase8CommandRuntimeFieldsMigration,
  interactiveSurfaceJsonMigration,
  hrcchatMessagesMigration,
  hrcEventsMigration,
  legacyHrcEventsBackfillMigration,
  runtimeBuffersScopedByRunMigration,
  activeInputDeliveriesMigration,
  zombieRunSweepIndexesMigration,
  hrcEventsCanonicalReaderIndexesMigration,
  runSessionLookupIndexesMigration,
  brokerPersistenceMigration,
  runtimeBrokerStateMigration,
  runsDispatchedInputIdMigration,
  lifecyclePolicyAuditMigration,
  runtimeLifecycleStateMigration,
  permissionIdentityMigration,
  brokerEventIdentityMigration,
]

function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
}

export function listAppliedMigrations(db: Database): string[] {
  ensureMigrationTable(db)

  const rows = db.query<{ id: string }, []>('SELECT id FROM hrc_migrations ORDER BY id ASC').all()

  return rows.map((row) => row.id)
}

export function runMigrations(db: Database): void {
  ensureMigrationTable(db)

  const applied = new Set(listAppliedMigrations(db))
  const pending = phase1Migrations.filter((migration) => !applied.has(migration.id))
  if (pending.length === 0) {
    return
  }

  const applyPending = db.transaction((migrations: readonly HrcMigration[]) => {
    for (const migration of migrations) {
      migration.apply(db)
      execute(
        db,
        'INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)',
        migration.id,
        new Date().toISOString()
      )
    }
  })

  applyPending.immediate(pending)
}
