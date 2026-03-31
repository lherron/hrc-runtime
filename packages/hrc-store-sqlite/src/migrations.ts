import type { Database, SQLQueryBindings } from 'bun:sqlite'

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

export const phase1Migrations: readonly HrcMigration[] = [
  phase1SchemaMigration,
  phase4SurfaceBindingsMigration,
  phase5WorkbenchSessionsAndLocalBridgesMigration,
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
