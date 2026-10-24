import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { listAppliedMigrations, phase1Migrations, runMigrations } from '../migrations'

test('retires permission audit storage while preserving neighbouring broker records', () => {
  const db = new Database(':memory:')
  try {
    db.exec(
      'PRAGMA foreign_keys = ON; CREATE TABLE hrc_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
    )
    for (const migration of phase1Migrations.filter((m) => m.id < '0127')) {
      migration.apply(db)
      db.query('INSERT INTO hrc_migrations VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      )
    }
    const retired = 'permission_decisions'
    const indexes = db.query(`PRAGMA index_list(${retired})`).all()
    expect(indexes.length).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) {
      db.query(`INSERT INTO ${retired} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `key-${i}`,
        `request-${i}`,
        'inv',
        i,
        1,
        'rt',
        null,
        'command',
        '{}',
        'deny',
        'deny',
        'policy',
        '{}',
        '2026-10-24',
        '2026-10-24'
      )
    }
    db.exec(`
      INSERT INTO broker_invocations (invocation_id, operation_id, runtime_id, broker_protocol,
        broker_driver, invocation_state, capabilities_json, spec_hash, start_request_hash,
        selected_profile_hash, created_at, updated_at)
      VALUES ('inv', 'op', 'rt', 'test/1', 'test', 'ready', '{}', 'spec', 'request', 'profile', '2026-10-24', '2026-10-24');
      INSERT INTO runtime_artifacts VALUES ('artifact', 'op', 'test', 'application/json', 'inline-json', 'hash', '{}', NULL, '2026-10-24');
    `)
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all()
    const before = Object.fromEntries(
      tables
        .filter(({ name }) => name !== retired)
        .map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()])
    )
    runMigrations(db)
    expect(listAppliedMigrations(db)).toContain('0127_permission_audit_removal')
    expect(
      db
        .query('SELECT name FROM sqlite_master WHERE name = ? OR tbl_name = ?')
        .all(retired, retired)
    ).toEqual([])
    for (const [name, rows] of Object.entries(before)) {
      // The runner appends its standard migration event and advances its cursors.
      if (
        !['hrc_migrations', 'hrc_events', 'event_stream_cursor', 'sqlite_sequence'].includes(name)
      )
        expect(db.query(`SELECT * FROM "${name}"`).all()).toEqual(rows)
    }
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    const applied = listAppliedMigrations(db)
    runMigrations(db)
    expect(listAppliedMigrations(db)).toEqual(applied)
  } finally {
    db.close()
  }
})
