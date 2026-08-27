import type { HrcMessageRecord } from 'hrc-core'

import { collectiveHistoryFilterColumnValues } from '../collective-history-columns.js'
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
        payload_json TEXT NOT NULL
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

// Federated lifecycle signals describe a session owned by a peer. hrc_events
// is an observation ledger, not a local-session ownership table, so its
// denormalized host_session_id must be allowed to name that remote identity.
// Local admission still fences every runtime/session mutation; this migration
// removes only the obsolete observation-time FK.
const federatedObservedEventsMigration: HrcMigration = {
  id: '0026_federated_observed_events',
  apply(db) {
    const hasHostSessionForeignKey = db
      .query<{ table: string; from: string }, []>('PRAGMA foreign_key_list(hrc_events)')
      .all()
      .some((row) => row.table === 'sessions' && row.from === 'host_session_id')
    if (!hasHostSessionForeignKey) return

    db.exec(`
      ALTER TABLE hrc_events RENAME TO hrc_events_local_only;

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
      );

      INSERT INTO hrc_events (
        hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref,
        generation, runtime_id, run_id, launch_id, app_id, app_session_key,
        category, event_kind, transport, error_code, replayed, payload_json
      )
      SELECT
        hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref,
        generation, runtime_id, run_id, launch_id, app_id, app_session_key,
        category, event_kind, transport, error_code, replayed, payload_json
      FROM hrc_events_local_only;

      DROP TABLE hrc_events_local_only;

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
      CREATE INDEX idx_hrc_events_run_ts
        ON hrc_events(run_id, ts);
      CREATE INDEX idx_hrc_events_run_kind_seq
        ON hrc_events(run_id, event_kind, hrc_seq);
      CREATE INDEX idx_hrc_events_scope_lane_ts_seq
        ON hrc_events(scope_ref, lane_ref, ts, hrc_seq);
      CREATE INDEX idx_hrc_events_run_ts_seq
        ON hrc_events(run_id, ts, hrc_seq);
    `)
  },
}

// T-06624: the wrkq bearer is daemon-private session authority. It is kept in
// a dedicated table instead of sessions JSON so ordinary session/status APIs
// can never serialize it accidentally. The public placement ledger carries
// only the non-secret claim-birth provenance tuple.
const sessionTaskClaimAuthorityMigration: HrcMigration = {
  id: '0027_session_task_claim_authority',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_task_claim_authorities (
        host_session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        claimed_by TEXT NOT NULL,
        claimed_scope TEXT NOT NULL,
        claimed_node TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
        claim_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_task_claim_authorities_task_generation
        ON session_task_claim_authorities(task_id, claim_generation);
    `)
  },
}

const hrcmailEnvelopeMigration: HrcMigration = {
  id: '0028_hrcmail_envelopes',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_envelopes (
        envelope_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL UNIQUE,
        ingress_id TEXT NOT NULL UNIQUE,
        from_kind TEXT NOT NULL CHECK (from_kind IN ('scope', 'operator')),
        from_ref TEXT NOT NULL,
        target_session_ref TEXT NOT NULL,
        payload_kind TEXT NOT NULL CHECK (payload_kind IN ('request', 'conversational')),
        body TEXT NOT NULL,
        metadata_json TEXT,
        reply_schema_json TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'presented', 'acked', 'deferred', 'dead')
        ),
        round_count INTEGER NOT NULL DEFAULT 0 CHECK (round_count >= 0),
        response_present INTEGER NOT NULL DEFAULT 0 CHECK (response_present IN (0, 1)),
        response_json TEXT,
        response_fingerprint TEXT,
        defer_reason TEXT,
        retry_after_ms INTEGER,
        retry_at TEXT,
        presented_at TEXT,
        acked_at TEXT,
        deferred_at TEXT,
        dead_at TEXT,
        terminal_actor_kind TEXT CHECK (
          terminal_actor_kind IS NULL OR terminal_actor_kind IN ('scope', 'operator')
        ),
        terminal_actor_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_envelopes_target_state_seq
        ON hrcmail_envelopes(target_session_ref, state, envelope_seq);

      CREATE INDEX IF NOT EXISTS idx_hrcmail_envelopes_deferred_retry
        ON hrcmail_envelopes(state, retry_at, envelope_seq);

      CREATE TABLE IF NOT EXISTS hrcmail_ingress_receipts (
        ingress_id TEXT PRIMARY KEY,
        path_choice TEXT NOT NULL CHECK (path_choice IN ('mail', 'v1_inline')),
        -- A v1_inline choice deliberately has no envelope row. Keeping this
        -- identifier unfenced by an FK lets a pre-cutover receipt survive a
        -- retry after cutover without manufacturing a second delivery.
        envelope_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  },
}

const hrcmailDriveMigration: HrcMigration = {
  id: '0029_hrcmail_drive_slots',
  apply(db) {
    db.exec(`
      ALTER TABLE hrcmail_envelopes
        ADD COLUMN materialization_intent_json TEXT;

      CREATE TABLE IF NOT EXISTS hrcmail_drive_attempts (
        drive_attempt_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        wake_reason TEXT NOT NULL CHECK (
          wake_reason IN ('insert', 'turn_completion', 'periodic', 'recovery')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('claimed', 'started', 'completed', 'failed', 'no_op')
        ),
        prompt TEXT NOT NULL,
        presented_count INTEGER NOT NULL DEFAULT 0 CHECK (presented_count >= 0),
        materialization_intent_json TEXT,
        host_session_id TEXT,
        generation INTEGER CHECK (generation IS NULL OR generation >= 1),
        runtime_id TEXT,
        start_hrc_seq INTEGER,
        terminal_event_kind TEXT,
        last_error TEXT,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_attempts_target_claimed
        ON hrcmail_drive_attempts(target_session_ref, claimed_at);

      CREATE TABLE IF NOT EXISTS hrcmail_drive_slots (
        target_session_ref TEXT PRIMARY KEY,
        active_drive_attempt_id TEXT UNIQUE,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (active_drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id)
      );

      CREATE TABLE IF NOT EXISTS hrcmail_drive_presentations (
        drive_attempt_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        PRIMARY KEY (drive_attempt_id, envelope_id),
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE,
        FOREIGN KEY (envelope_id)
          REFERENCES hrcmail_envelopes(envelope_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_presentations_envelope
        ON hrcmail_drive_presentations(envelope_id, drive_attempt_id);
    `)
  },
}

const hrcmailStopRefusalMigration: HrcMigration = {
  id: '0030_hrcmail_stop_refusals',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_stop_refusals (
        run_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        observed_envelope_seq INTEGER NOT NULL DEFAULT 0
          CHECK (observed_envelope_seq >= 0),
        refusal_count INTEGER NOT NULL DEFAULT 0
          CHECK (refusal_count >= 0 AND refusal_count <= 3),
        total_refusal_count INTEGER NOT NULL DEFAULT 0
          CHECK (total_refusal_count >= 0 AND total_refusal_count <= 50),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_stop_refusals_target
        ON hrcmail_stop_refusals(target_session_ref, updated_at);
    `)
  },
}

const hrcmailFederatedOriginsMigration: HrcMigration = {
  id: '0031_hrcmail_federated_origins',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_federated_origins (
        ingress_id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL UNIQUE,
        request_message_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        disposition_message_id TEXT UNIQUE,
        disposition_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  },
}

/**
 * ACK provenance is a per-hop transcript fact, not request-only placement
 * state. Keep the original request table for compatibility, but copy it into
 * the canonical phase-neutral table and seed historical delivered responses
 * so replies already waiting in peer outboxes become admissible immediately.
 */
const federationPeerAcceptancesMigration: HrcMigration = {
  id: '0032_federation_peer_acceptances',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS federation_peer_acceptances (
        message_id TEXT PRIMARY KEY,
        accepted_by_node_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('request', 'response')),
        request_epoch INTEGER CHECK (request_epoch IS NULL OR request_epoch >= 1),
        accepted_at TEXT NOT NULL,
        CHECK (
          (phase = 'request' AND request_epoch IS NOT NULL) OR
          (phase = 'response' AND request_epoch IS NULL)
        )
      );
    `)

    const record = (
      messageId: string,
      acceptedByNodeId: string,
      phase: 'request' | 'response',
      requestEpoch: number | null,
      acceptedAt: string
    ): void => {
      const existing = db
        .query<
          {
            accepted_by_node_id: string
            phase: 'request' | 'response'
            request_epoch: number | null
          },
          [string]
        >(
          `SELECT accepted_by_node_id, phase, request_epoch
             FROM federation_peer_acceptances
            WHERE message_id = ?`
        )
        .get(messageId)
      if (existing !== null) {
        if (
          existing.accepted_by_node_id !== acceptedByNodeId ||
          existing.phase !== phase ||
          existing.request_epoch !== requestEpoch
        ) {
          throw new Error(`conflicting peer-acceptance migration evidence for ${messageId}`)
        }
        return
      }
      db.query<unknown, [string, string, string, number | null, string]>(
        `INSERT INTO federation_peer_acceptances (
           message_id, accepted_by_node_id, phase, request_epoch, accepted_at
         ) VALUES (?, ?, ?, ?, ?)`
      ).run(messageId, acceptedByNodeId, phase, requestEpoch, acceptedAt)
    }

    for (const row of db
      .query<
        {
          request_message_id: string
          accepted_by_node_id: string
          accepted_epoch: number
          accepted_at: string
        },
        []
      >(
        `SELECT request_message_id, accepted_by_node_id, accepted_epoch, accepted_at
           FROM federation_accepted_requests`
      )
      .all()) {
      record(
        row.request_message_id,
        row.accepted_by_node_id,
        'request',
        row.accepted_epoch,
        row.accepted_at
      )
    }

    for (const row of db
      .query<
        {
          message_id: string
          peer_node_id: string
          envelope_json: string
          delivered_at: string
        },
        []
      >(
        `SELECT message_id, peer_node_id, envelope_json, delivered_at
           FROM federation_outbox_deliveries
          WHERE state = 'delivered' AND delivered_at IS NOT NULL`
      )
      .all()) {
      const payload = JSON.parse(row.envelope_json) as {
        stage?: string
        envelope?: { messageId?: string; phase?: string }
        messageId?: string
        phase?: string
      }
      const envelope = payload.stage === undefined ? payload : payload.envelope
      if (envelope?.messageId === row.message_id && envelope.phase === 'response') {
        record(row.message_id, row.peer_node_id, 'response', null, row.delivered_at)
      }
    }
  },
}

const collectiveMessageHistoryMigration: HrcMigration = {
  id: '0033_collective_message_history',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collective_history_messages (
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
      );

      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_created
        ON collective_history_messages(canonical_created_at, message_id);

      CREATE TABLE IF NOT EXISTS collective_history_observations (
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

      CREATE INDEX IF NOT EXISTS idx_collective_history_observations_origin
        ON collective_history_observations(origin_node_id, message_id);

      CREATE TABLE IF NOT EXISTS collective_history_replications (
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

      CREATE INDEX IF NOT EXISTS idx_collective_history_replications_due
        ON collective_history_replications(state, next_attempt_at, source_message_seq);
    `)
  },
}

const federationPeerAcceptanceOutcomeMigration: HrcMigration = {
  id: '0034_federation_peer_acceptance_outcome',
  apply(db) {
    db.exec(`
      ALTER TABLE federation_peer_acceptances
        ADD COLUMN ack_outcome TEXT CHECK (ack_outcome IN ('accepted', 'duplicate'));
    `)
  },
}

/**
 * Indexed materialization of every filterable collective-history field (T-06973).
 *
 * Migration 0033 kept all of `from`/`to`/`participant`/`thread`/`replyTo`/
 * `runId`/`kinds`/`phases`/`hostSessionId`/`generation` inside
 * `canonical_record_json`, so a `--limit 20` query selected every row, parsed
 * every record, ran one observation query per message and sorted in JS. At
 * svc's ~18k messages that cost ~0.55s and grew linearly; this class already
 * caused a live CPU incident.
 *
 * Columns are nullable and backfilled in place so the migration is safe on a
 * populated database: adding a column and building indexes never rewrites the
 * canonical JSON, and a row whose JSON is corrupt is left with NULL filter
 * columns rather than failing the whole migration.
 */
const collectiveHistoryFilterColumnsMigration: HrcMigration = {
  id: '0035_collective_history_filter_columns',
  apply(db) {
    db.exec(`
      ALTER TABLE collective_history_messages ADD COLUMN from_ref TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN to_ref TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN root_message_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN reply_to_message_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN kind TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN phase TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN host_session_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN run_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN generation INTEGER;
    `)

    // Backfill through the same projection the write path uses, so the two can
    // never disagree about how an address or a missing execution field encodes.
    const rows = db
      .query<{ collective_seq: number; canonical_record_json: string }, []>(
        'SELECT collective_seq, canonical_record_json FROM collective_history_messages'
      )
      .all()
    const update = db.prepare(
      `UPDATE collective_history_messages
          SET from_ref = ?, to_ref = ?, root_message_id = ?, reply_to_message_id = ?,
              kind = ?, phase = ?, host_session_id = ?, run_id = ?, generation = ?
        WHERE collective_seq = ?`
    )
    for (const row of rows) {
      let values: Array<string | number | null>
      try {
        values = collectiveHistoryFilterColumnValues(
          JSON.parse(row.canonical_record_json) as HrcMessageRecord
        )
      } catch {
        // A record written before a validating write path, or corrupted on
        // disk, must not make the whole database unopenable. Such a row keeps
        // NULL filter columns and stays reachable by messageId and cursor.
        continue
      }
      update.run(...values, row.collective_seq)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_from
        ON collective_history_messages(from_ref, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_to
        ON collective_history_messages(to_ref, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_root
        ON collective_history_messages(root_message_id, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_reply_to
        ON collective_history_messages(reply_to_message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_kind
        ON collective_history_messages(kind, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_phase
        ON collective_history_messages(phase, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_run
        ON collective_history_messages(run_id, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_host_session
        ON collective_history_messages(host_session_id, canonical_created_at, message_id);
    `)
  },
}

/**
 * Durable suffix-roster claims (T-07118).
 *
 * A `conflictPolicy: 'suffix'` start records its claim in the SAME transaction
 * as the successor session it claims, so a lost-response retry converges on the
 * recorded slot instead of walking the roster and minting a second brain. The
 * canonical `request_hash` is stored alongside the key so an identical replay
 * and a conflicting one stay distinguishable across a daemon restart — without
 * it, the promised same-key/different-body rejection is unenforceable once the
 * in-memory single-flight map is gone.
 *
 * No foreign key to `sessions`: if the recorded successor row disappears, the
 * supersession fence must SEE a claim whose successor is no longer active and
 * refuse, rather than have the claim silently cascade away and let the retry
 * walk the roster again.
 */
const rosterClaimsMigration: HrcMigration = {
  id: '0036_roster_claims',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS roster_claims (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        base_scope TEXT NOT NULL,
        claimed_scope TEXT NOT NULL,
        successor_host_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_roster_claims_base_scope
        ON roster_claims(base_scope, created_at);
      CREATE INDEX IF NOT EXISTS idx_roster_claims_successor
        ON roster_claims(successor_host_session_id);
    `)
  },
}

/**
 * EPR A1: one-time-secret external participant grants. The request metadata is
 * retained for A2 rendezvous, but only the credential hash reaches disk.
 */
const externalRegistrationGrantsMigration: HrcMigration = {
  id: '0037_external_registration_grants',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_registration_grants (
        registration_id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL,
        derived_scope TEXT NOT NULL UNIQUE,
        socket_path TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
        turns_allowed INTEGER NOT NULL CHECK (turns_allowed IN (0, 1)),
        provisioner_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_registration_grants_capacity
        ON external_registration_grants(class_id, consumed, expires_at);
    `)
  },
}

/**
 * EPR A2: link a consumed grant to the one start graph it minted. The delivery
 * marker is deliberately on the registration row: hello retry classification
 * must survive daemon restart without inferring acknowledgement from a live
 * socket or mutable runtime status.
 */
const externalRegistrationMintMigration: HrcMigration = {
  id: '0038_external_registration_mint',
  apply(db) {
    db.exec(`
      ALTER TABLE external_registration_grants ADD COLUMN host_session_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN runtime_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN operation_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN invocation_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN attach_token_ref TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN controller_instance_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN establishment_state TEXT
        CHECK (establishment_state IN ('DELIVERY_PENDING', 'ESTABLISHED'));
      ALTER TABLE external_registration_grants ADD COLUMN capabilities_json TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN participant_info_json TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN established_at TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_registration_grants_runtime
        ON external_registration_grants(runtime_id)
        WHERE runtime_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_registration_grants_invocation
        ON external_registration_grants(invocation_id)
        WHERE invocation_id IS NOT NULL;
    `)
  },
}

/** EPR A6: durable registration retirement projection and capacity release. */
const externalRegistrationRetirementMigration: HrcMigration = {
  id: '0039_external_registration_retirement',
  apply(db) {
    db.exec(`
      ALTER TABLE external_registration_grants ADD COLUMN retired_at TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN retirement_reason TEXT
        CHECK (retirement_reason IS NULL OR retirement_reason = 'external_registration_gc');

      DROP INDEX IF EXISTS idx_external_registration_grants_capacity;
      CREATE INDEX idx_external_registration_grants_capacity
        ON external_registration_grants(class_id, retired_at, consumed, expires_at);
    `)
  },
}

const dmQueueCoalescingMigration: HrcMigration = {
  id: '0040_dm_queue_coalescing',
  apply(db) {
    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    for (const [column, type] of [
      ['queue_snapshot_id', 'TEXT'],
      ['queued_input_seq', 'INTEGER'],
      ['queue_snapshot_position', 'INTEGER'],
      ['coalesced_into_run_id', 'TEXT'],
      ['coalesced_position', 'INTEGER'],
    ] as const) {
      if (!runColumns.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`)
    }
    db.exec(`UPDATE runs SET queued_input_seq = rowid
      WHERE status = 'queued' AND queued_input_seq IS NULL`)

    const messageColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(messages)')
        .all()
        .map((row) => row.name)
    )
    for (const [column, type] of [
      ['coalesced_into_run_id', 'TEXT'],
      ['coalesced_position', 'INTEGER'],
    ] as const) {
      if (!messageColumns.has(column)) {
        db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${type}`)
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_queued_snapshot
        ON runs(host_session_id, status, queue_snapshot_id, queue_snapshot_position, queued_input_seq);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_queued_input_seq
        ON runs(queued_input_seq) WHERE queued_input_seq IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_runs_coalesced_into
        ON runs(coalesced_into_run_id, coalesced_position);

      CREATE INDEX IF NOT EXISTS idx_messages_coalesced_into
        ON messages(coalesced_into_run_id, coalesced_position);
    `)
  },
}

/**
 * Current-generation Mobile session projection (T-07221).
 *
 * The projection is maintained by triggers so each source write and its index
 * effect share the caller's SQLite transaction. Recency is deliberately
 * monotonic: only contributing timestamps use MAX(); status, intent,
 * continuation and parsed-scope rewrites refresh derived columns without
 * moving the traversal key.
 */
const sessionIndexMigration: HrcMigration = {
  id: '0041_session_index',
  apply(db) {
    db.exec(`
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
        last_activity_at TEXT NOT NULL,
        PRIMARY KEY (scope_ref, lane_ref)
      );

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

      CREATE TABLE session_index_backfill_evidence (
        migration_id TEXT PRIMARY KEY,
        row_count INTEGER NOT NULL,
        changed_recency_count INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE VIEW session_index_projection_source AS
      SELECT
        s.scope_ref,
        s.lane_ref,
        s.host_session_id,
        s.generation,
        CASE
          WHEN substr(s.scope_ref, 1, 6) = 'agent:' THEN
            CASE
              WHEN instr(substr(s.scope_ref, 7), ':') = 0
                   AND instr(substr(s.scope_ref, 7), '/') = 0
                THEN substr(s.scope_ref, 7)
              WHEN instr(substr(s.scope_ref, 7), ':') = 0
                THEN substr(s.scope_ref, 7, instr(substr(s.scope_ref, 7), '/') - 1)
              WHEN instr(substr(s.scope_ref, 7), '/') = 0
                THEN substr(s.scope_ref, 7, instr(substr(s.scope_ref, 7), ':') - 1)
              ELSE substr(
                s.scope_ref,
                7,
                min(instr(substr(s.scope_ref, 7), ':'), instr(substr(s.scope_ref, 7), '/')) - 1
              )
            END
          ELSE s.scope_ref
        END AS agent_id,
        CASE
          WHEN instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') = 0 THEN NULL
          ELSE
            CASE
              WHEN instr(
                substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                ),
                ':'
              ) = 0
                THEN substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                )
              ELSE substr(
                substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                ),
                1,
                instr(
                  substr(
                    replace(s.scope_ref, '/project:', ':project:'),
                    instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                  ),
                  ':'
                ) - 1
              )
            END
        END AS project_id,
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
        ) AS backfill_last_activity_at
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

      INSERT INTO session_index (
        scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
        created_at, effective_status, execution_mode, last_activity_at
      )
      SELECT
        scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
        created_at, effective_status, execution_mode, backfill_last_activity_at
      FROM session_index_projection_source;

      INSERT INTO session_index_backfill_evidence (
        migration_id, row_count, changed_recency_count, recorded_at
      )
      SELECT
        '0041_session_index',
        (SELECT COUNT(*) FROM session_index),
        COUNT(*),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM sessions s
      INNER JOIN continuities c ON c.active_host_session_id = s.host_session_id
      WHERE (
        SELECT MAX(e.ts)
        FROM hrc_events e
        WHERE e.host_session_id = s.host_session_id
          AND e.generation = s.generation
      ) IS NOT (
        SELECT e.ts
        FROM hrc_events e
        WHERE e.host_session_id = s.host_session_id
          AND e.generation = s.generation
        ORDER BY e.hrc_seq DESC
        LIMIT 1
      );

      CREATE TRIGGER session_index_continuity_insert
      AFTER INSERT ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at;
      END;

      CREATE TRIGGER session_index_continuity_update
      AFTER UPDATE OF active_host_session_id ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at;
      END;

      CREATE TRIGGER session_index_session_derived_update
      AFTER UPDATE OF status, last_applied_intent_json, continuation_json, parsed_scope_json
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

      CREATE TRIGGER session_index_hrc_event_insert
      AFTER INSERT ON hrc_events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END;

      CREATE TRIGGER session_index_event_insert
      AFTER INSERT ON events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END;
    `)
  },
}

/**
 * T-07235 — generation-scoped provision-liveness watchdog state.
 *
 * One row per (runtime_id, generation). `first_turn_deadline_at` is an ABSOLUTE
 * timestamp stamped once at arm time, so a daemon restart never has to recover
 * a request-policy value and a generation's deadline cannot drift. All state is
 * durable rows; there are no in-memory timers to lose.
 *
 * The evaluation pass reads ONLY armed rows, so the hot predicate gets a
 * partial index: a handful of rows, not a table scan, on its 30s cadence.
 */
const firstTurnWatchMigration: HrcMigration = {
  id: '0042_first_turn_watch',
  apply(db) {
    db.exec(`
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
    `)
  },
}

/**
 * T-07236 — dispatch origin on the run row + the ACP bridge's durable producer
 * rate-cap ledger.
 *
 * The origin columns are the durable half of the principal transport: whatever
 * a dispatch source knows about who caused the turn is written once, at
 * dispatch, and joined back at emission time. Nullable/additive — every
 * pre-existing run reads as unattributed, which is the honest answer for a run
 * dispatched before the transport existed.
 *
 * `acp_bridge_emissions` is a producer-side bound, not a delivery log: one row
 * per admitted emission keyed by the canonical event id (so a retry of the same
 * fact cannot consume a second slot), counted over a sliding window per
 * (scope_ref, event). It is deliberately durable — an in-memory counter would
 * reset on every daemon restart, and a restart loop is exactly the condition a
 * runaway mint loop rides on.
 */
const dispatchOriginAndAcpBridgeMigration: HrcMigration = {
  id: '0043_dispatch_origin_and_acp_bridge',
  apply(db) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN origin_actor TEXT;
      ALTER TABLE runs ADD COLUMN origin_kind TEXT;
      ALTER TABLE runs ADD COLUMN origin_causation_ref TEXT;

      CREATE TABLE acp_bridge_emissions (
        event_id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        event TEXT NOT NULL,
        emitted_at TEXT NOT NULL
      );

      CREATE INDEX idx_acp_bridge_emissions_window
        ON acp_bridge_emissions(scope_ref, event, emitted_at);
    `)
  },
}

/**
 * T-07493 — durable identity for the canonical lifecycle-event ledger.
 *
 * The value belongs to the database incarnation: reopening the same database
 * preserves it, while constructing/replacing the database creates a new one.
 * SQLite supplies entropy directly so identity is independent of host, path,
 * time and sequence state.
 */
const hrcEventLedgerIncarnationMigration: HrcMigration = {
  id: '0044_hrc_event_ledger_incarnation',
  apply(db) {
    db.exec(`
      CREATE TABLE hrc_event_ledger_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ledger_incarnation_id TEXT NOT NULL UNIQUE
      );

      INSERT INTO hrc_event_ledger_metadata (id, ledger_incarnation_id)
      VALUES (1, lower(hex(randomblob(16))));
    `)
  },
}

/** T-07610 — transactional, hash-free storage for large tool results. */
const toolResultBlobsMigration: HrcMigration = {
  id: '0045_tool_result_blobs',
  apply(db) {
    db.exec(`
      CREATE TABLE tool_result_blobs (
        blob_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('broker_raw','lifecycle_canonical')),
        bytes INTEGER NOT NULL,
        complete INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tool_result_blobs_runtime
        ON tool_result_blobs(runtime_id);

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
    `)
  },
}

/**
 * T-07615 (T-07612 wave 3) — HRC becomes a consumer of the wrkq collaboration
 * ledger.
 *
 * Two things change in HRC's own store, and only these: the ledger itself lives
 * in wrkq and no table here mirrors it.
 *
 * 1. `hrcmail_drive_presentations` loses its foreign key to `hrcmail_envelopes`.
 *    A presentation receipt now names an `EN-xxxxx` row that lives in wrkq, so
 *    the local FK asserted a join that cannot exist. Everything else about the
 *    table -- its identity as the exactly-once record of "this drive attempt
 *    presented this envelope" -- is unchanged, and existing rows carry over.
 * 2. `wrkq_ledger_cursors` records the high-water mark of the ledger tail the
 *    kicker wakes on. It is persisted so a restart resumes where it stopped
 *    rather than replaying the log or silently skipping the gap.
 */
const wrkqLedgerConsumerMigration: HrcMigration = {
  id: '0046_wrkq_ledger_consumer',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_drive_presentations_wrkq (
        drive_attempt_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        PRIMARY KEY (drive_attempt_id, envelope_id),
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO hrcmail_drive_presentations_wrkq (
        drive_attempt_id, envelope_id, presented_at
      )
      SELECT drive_attempt_id, envelope_id, presented_at
      FROM hrcmail_drive_presentations;

      DROP TABLE hrcmail_drive_presentations;

      ALTER TABLE hrcmail_drive_presentations_wrkq
        RENAME TO hrcmail_drive_presentations;

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_presentations_envelope
        ON hrcmail_drive_presentations(envelope_id, drive_attempt_id);

      CREATE TABLE IF NOT EXISTS wrkq_ledger_cursors (
        stream TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL CHECK (high_water >= 0),
        updated_at TEXT NOT NULL
      );
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
  federatedObservedEventsMigration,
  sessionTaskClaimAuthorityMigration,
  hrcmailEnvelopeMigration,
  hrcmailDriveMigration,
  hrcmailStopRefusalMigration,
  hrcmailFederatedOriginsMigration,
  federationPeerAcceptancesMigration,
  collectiveMessageHistoryMigration,
  federationPeerAcceptanceOutcomeMigration,
  collectiveHistoryFilterColumnsMigration,
  rosterClaimsMigration,
  externalRegistrationGrantsMigration,
  externalRegistrationMintMigration,
  externalRegistrationRetirementMigration,
  dmQueueCoalescingMigration,
  sessionIndexMigration,
  firstTurnWatchMigration,
  dispatchOriginAndAcpBridgeMigration,
  hrcEventLedgerIncarnationMigration,
  toolResultBlobsMigration,
  wrkqLedgerConsumerMigration,
]
