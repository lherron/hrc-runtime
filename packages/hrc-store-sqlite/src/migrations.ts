import type { Database, SQLQueryBindings } from 'bun:sqlite'

export type HrcMigration = {
  id: string
  apply(db: Database): void
}

type LegacyHrcEventRow = {
  seq: number
  stream_seq: number | null
  ts: string
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  runtime_id: string | null
  run_id: string | null
  event_kind: string
  event_json: string
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

function parseLegacyEventJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLifecycleTransport(value: unknown): 'sdk' | 'tmux' | undefined {
  return value === 'sdk' || value === 'tmux' ? value : undefined
}

function categoryForLegacyHrcEventKind(eventKind: string): string {
  if (eventKind.startsWith('session.')) {
    return 'session'
  }
  if (eventKind.startsWith('runtime.')) {
    return 'runtime'
  }
  if (eventKind.startsWith('launch.')) {
    return 'launch'
  }
  if (eventKind.startsWith('turn.')) {
    return 'turn'
  }
  if (eventKind.startsWith('inflight.')) {
    return 'inflight'
  }
  if (eventKind.startsWith('surface.')) {
    return 'surface'
  }
  if (eventKind.startsWith('bridge.')) {
    return 'bridge'
  }
  if (eventKind.startsWith('context.')) {
    return 'context'
  }
  if (eventKind.startsWith('app-session.') || eventKind.startsWith('target.')) {
    return 'app_session'
  }
  throw new Error(`unknown legacy hrc event kind: ${eventKind}`)
}

function normalizeLegacyHrcPayload(eventJson: unknown): {
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  transport?: 'sdk' | 'tmux' | undefined
  errorCode?: string | undefined
  replayed?: boolean | undefined
  payload: unknown
} {
  if (!isRecord(eventJson)) {
    return { payload: eventJson ?? {} }
  }

  const {
    ts: _ts,
    hostSessionId: _hostSessionId,
    scopeRef: _scopeRef,
    laneRef: _laneRef,
    generation: _generation,
    runtimeId: _runtimeId,
    runId: _runId,
    launchId: rawLaunchId,
    appId: rawAppId,
    appSessionKey: rawAppSessionKey,
    source: _source,
    eventKind: _eventKind,
    category: _category,
    seq: _seq,
    streamSeq: _streamSeq,
    transport: rawTransport,
    errorCode: rawErrorCode,
    replayed: rawReplayed,
    ...payload
  } = eventJson
  const launchId =
    typeof rawLaunchId === 'string' && rawLaunchId.length > 0 ? rawLaunchId : undefined
  const appId = typeof rawAppId === 'string' && rawAppId.length > 0 ? rawAppId : undefined
  const appSessionKey =
    typeof rawAppSessionKey === 'string' && rawAppSessionKey.length > 0
      ? rawAppSessionKey
      : undefined
  const transport = readLifecycleTransport(rawTransport)
  const errorCode =
    typeof rawErrorCode === 'string' && rawErrorCode.length > 0 ? rawErrorCode : undefined
  const replayed = typeof rawReplayed === 'boolean' ? rawReplayed : undefined
  const normalizedPayload =
    rawTransport !== undefined && transport === undefined
      ? { ...payload, transport: rawTransport }
      : payload

  return {
    ...(launchId ? { launchId } : {}),
    ...(appId ? { appId } : {}),
    ...(appSessionKey ? { appSessionKey } : {}),
    ...(transport ? { transport } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(replayed !== undefined ? { replayed } : {}),
    payload: normalizedPayload,
  }
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
          'sdk' | 'tmux' | null,
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

      CREATE INDEX IF NOT EXISTS idx_messages_run
        ON messages(run_id);
    `)
  },
}

export const phase1Migrations: readonly HrcMigration[] = [
  phase1SchemaMigration,
  phase4SurfaceBindingsMigration,
  phase5WorkbenchSessionsAndLocalBridgesMigration,
  phase6LocalBridgesRuntimeIdIndexMigration,
  phase7ManagedAppSessionsMigration,
  phase8CommandRuntimeFieldsMigration,
  hrcchatMessagesMigration,
  hrcEventsMigration,
  legacyHrcEventsBackfillMigration,
  runtimeBuffersScopedByRunMigration,
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
