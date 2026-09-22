import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { runMigrations } from '../migrations.js'
import { runtimeLegacyIdentityNullableMigration } from '../migrations/runtime-legacy-identity-nullability.js'

test('v2 runtime identity migration preserves legacy rows, accepts null v2 fields, and is idempotent', () => {
  const db = new Database(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (host_session_id TEXT PRIMARY KEY);
    CREATE TABLE runtimes (
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
      runtime_kind TEXT,
      command_spec_json TEXT,
      surface_json TEXT,
      status_changed_at TEXT,
      controller_kind TEXT,
      active_operation_id TEXT,
      active_invocation_id TEXT,
      compile_id TEXT,
      plan_hash TEXT,
      selected_profile_hash TEXT,
      runtime_state_json TEXT,
      lifecycle_policy_hash TEXT,
      current_harness_generation INTEGER,
      current_turn_attempt INTEGER,
      lifecycle_terminal_reason TEXT,
      last_lifecycle_escalation_json TEXT,
      presentation_json TEXT
      ,FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id)
    );
    INSERT INTO sessions (host_session_id) VALUES ('hs');
    INSERT INTO runtimes (
      runtime_id, host_session_id, scope_ref, lane_ref, generation, transport,
      harness, provider, status, supports_inflight_input, adopted, created_at, updated_at
    ) VALUES ('legacy', 'hs', 'agent:legacy', 'main', 1, 'tmux', 'claude-code', 'anthropic', 'ready', 1, 0, 't', 't');
    INSERT INTO runs (run_id, runtime_id) VALUES ('r-legacy', 'legacy');
  `)

  // The migration runner does this around the transactional table rebuild.
  db.exec('PRAGMA foreign_keys = OFF;')
  runtimeLegacyIdentityNullableMigration.apply(db)
  runtimeLegacyIdentityNullableMigration.apply(db)
  db.exec('PRAGMA foreign_keys = ON;')

  expect(
    db.query("SELECT harness, provider FROM runtimes WHERE runtime_id = 'legacy'").get()
  ).toEqual({
    harness: 'claude-code',
    provider: 'anthropic',
  })
  expect(() =>
    db.exec(`
      INSERT INTO runtimes (
        runtime_id, host_session_id, scope_ref, lane_ref, generation, transport,
        harness, provider, status, supports_inflight_input, adopted, created_at, updated_at
      ) VALUES ('v2', 'hs', 'agent:v2', 'main', 1, 'headless', NULL, NULL, 'ready', 1, 0, 't', 't');
    `)
  ).not.toThrow()
  expect(db.query("SELECT runtime_id FROM runs WHERE run_id = 'r-legacy'").get()).toEqual({
    runtime_id: 'legacy',
  })
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
})

test('repository migration mechanism records the nullable identity migration once', () => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')

  runMigrations(db)
  runMigrations(db)

  expect(
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM hrc_migrations WHERE id = '0074_runtime_legacy_identity_nullable'"
      )
      .get()
  ).toEqual({ count: 1 })
  const columns = db
    .query<{ name: string; notnull: number }, []>('PRAGMA table_info(runtimes)')
    .all()
  expect(columns.find((column) => column.name === 'harness')?.notnull).toBe(0)
  expect(columns.find((column) => column.name === 'provider')?.notnull).toBe(0)
})
