import {
  type LegacyHrcEventRow,
  categoryForLegacyHrcEventKind,
  normalizeLegacyHrcPayload,
  parseLegacyEventJson,
} from './legacy-hrc-event-backfill.js'
import { type HrcMigration, execute } from './types.js'

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

// T-05010: indexes backing the public /v1/runs enrichment filters
// (scopeRef/laneRef and status). runId filtering already hits the runs
// primary key, so no run_id index is added.
const runEnrichmentFilterIndexesMigration: HrcMigration = {
  id: '0015_run_enrichment_filter_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_scope_lane_updated
        ON runs(scope_ref, lane_ref, updated_at, run_id);

      CREATE INDEX IF NOT EXISTS idx_runs_status_updated
        ON runs(status, updated_at, run_id);
    `)
  },
}

// H-00104 Node C (C-0004): opaque, best-effort correlation metadata an operator
// can stamp on an HRC run via `hrc run annotate --correlation`. HRC stores and
// echoes it verbatim and never interprets it; the DAG attempt edge is
// authoritative. Nullable/additive — legacy runs leave it unset.
const runCorrelationMigration: HrcMigration = {
  id: '0016_run_correlation',
  apply(db) {
    const existing = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    if (!existing.has('correlation_json')) {
      db.exec(`
        ALTER TABLE runs
        ADD COLUMN correlation_json TEXT
      `)
    }
  },
}

const runtimeStatusChangedAtMigration: HrcMigration = {
  id: '0017_runtime_status_changed_at',
  apply(db) {
    const existing = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
        .all()
        .map((row) => row.name)
    )
    if (!existing.has('status_changed_at')) {
      db.exec(`
        ALTER TABLE runtimes
        ADD COLUMN status_changed_at TEXT
      `)
    }
  },
}

const federationAcceptedRequestsMigration: HrcMigration = {
  id: '0018_federation_accepted_requests',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS federation_accepted_requests (
        request_message_id TEXT PRIMARY KEY,
        accepted_by_node_id TEXT NOT NULL,
        accepted_epoch INTEGER NOT NULL CHECK (accepted_epoch >= 1),
        accepted_at TEXT NOT NULL
      );
    `)
  },
}

const federationOutboxMigration: HrcMigration = {
  id: '0019_federation_outbox',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS federation_outbox_deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id) ON DELETE RESTRICT,
        peer_node_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'retry_scheduled', 'peer_unreachable', 'delivered', 'dead_letter')
        ),
        total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
        cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cycle_attempts >= 0),
        replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
        retry_window_started_at TEXT NOT NULL,
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        delivered_at TEXT,
        dead_lettered_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS federation_outbox_due_idx
        ON federation_outbox_deliveries(state, next_attempt_at);
      CREATE INDEX IF NOT EXISTS federation_outbox_peer_state_idx
        ON federation_outbox_deliveries(peer_node_id, state, created_at);
    `)
  },
}

export const schemaMigrations: readonly HrcMigration[] = [
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
  runEnrichmentFilterIndexesMigration,
  runCorrelationMigration,
  runtimeStatusChangedAtMigration,
  federationAcceptedRequestsMigration,
  federationOutboxMigration,
]
