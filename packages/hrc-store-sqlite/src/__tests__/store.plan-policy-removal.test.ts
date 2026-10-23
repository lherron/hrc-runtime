import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { listAppliedMigrations, phase1Migrations, runMigrations } from '../migrations'

test('upgrades populated plan/policy tables and preserves invocation hashes across repeated migration', () => {
  const db = new Database(':memory:')
  try {
    db.exec(
      'PRAGMA foreign_keys = ON; CREATE TABLE hrc_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
    )
    for (const migration of phase1Migrations.filter((m) => m.id < '0126')) {
      migration.apply(db)
      db.query('INSERT INTO hrc_migrations VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      )
    }
    db.exec(`
      INSERT INTO compiled_runtime_plans VALUES ('plan', 'compile', '2', 'aspc', 'v2', '{}', '2026-10-23');
      INSERT INTO lifecycle_policies VALUES ('policy', 'policy-hash', '{}', '1', '2026-10-23');
      INSERT INTO broker_invocations (invocation_id, operation_id, runtime_id, broker_protocol,
        broker_driver, invocation_state, capabilities_json, spec_hash, start_request_hash,
        selected_profile_hash, lifecycle_policy_hash, created_at, updated_at)
      VALUES ('inv', 'op', 'rt', 'test/1', 'test', 'ready', '{}', 'spec', 'request',
        'profile', 'policy-hash', '2026-10-23', '2026-10-23');
    `)
    runMigrations(db)
    expect(listAppliedMigrations(db)).toContain('0126_plan_policy_table_removal')
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('compiled_runtime_plans', 'lifecycle_policies')"
        )
        .all()
    ).toEqual([])
    expect(db.query('SELECT lifecycle_policy_hash FROM broker_invocations').get()).toEqual({
      lifecycle_policy_hash: 'policy-hash',
    })
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    const applied = listAppliedMigrations(db)
    runMigrations(db)
    expect(listAppliedMigrations(db)).toEqual(applied)
  } finally {
    db.close()
  }
})
