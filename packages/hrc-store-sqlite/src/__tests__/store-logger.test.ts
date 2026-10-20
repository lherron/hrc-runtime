import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../database.js'
import { phase1Migrations, resolveMigrationActor } from '../migrations.js'

function historicalStore(path: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE hrc_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  for (const migration of phase1Migrations) {
    if (migration.id === '0122_session_identity_metadata') break
    migration.apply(db)
    db.query('INSERT INTO hrc_migrations VALUES (?,?)').run(migration.id, '2026-10-20')
  }
  for (const scope of ['agent:cody:project:hrc-runtime:task:T-11439', 'legacy-unknown']) {
    db.query(
      "INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at) VALUES (?,'main','historical','2026-10-20')"
    ).run(scope)
  }
  db.close()
}

test('database open routes both upgrade diagnostics through its logger with preserved fields and data', () => {
  const root = mkdtempSync(join(tmpdir(), 'store-logger-'))
  const path = join(root, 'store.sqlite')
  historicalStore(path)
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  const events: { event: string; data: Record<string, unknown> }[] = []
  try {
    const logger = {
      info: (event: string, data: Record<string, unknown>) => {
        events.push({ event, data })
      },
    }
    const db = openHrcDatabase(path, { logger })
    expect(stderr).not.toHaveBeenCalled()
    expect(events).toEqual([
      { event: 'session.identity.backfill', data: { total: 2, unparsed: 1 } },
      {
        event: 'store.migrated',
        data: { applied: 2, version: phase1Migrations.at(-1)!.id, ...resolveMigrationActor() },
      },
    ])
    expect(
      db.sqlite
        .query('SELECT scope_kind,agent_id,task_id FROM continuities ORDER BY scope_ref')
        .all()
    ).toEqual([
      { scope_kind: 'project-task', agent_id: 'cody', task_id: 'T-11439' },
      { scope_kind: 'unparsed', agent_id: 'legacy-unknown', task_id: null },
    ])
    db.close()
    events.length = 0
    openHrcDatabase(path, { logger }).close()
    expect(events).toEqual([])
  } finally {
    stderr.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('logger failure preserves migration rollback and original error', () => {
  const root = mkdtempSync(join(tmpdir(), 'store-logger-failure-'))
  const path = join(root, 'store.sqlite')
  historicalStore(path)
  const failure = new Error('logger unavailable')
  try {
    expect(() =>
      openHrcDatabase(path, {
        logger: {
          info: () => {
            throw failure
          },
        },
      })
    ).toThrow(failure)
    const db = new Database(path)
    expect(
      db.query("SELECT id FROM hrc_migrations WHERE id='0122_session_identity_metadata'").get()
    ).toBeNull()
    expect(
      db.query("SELECT name FROM pragma_table_info('continuities') WHERE name='scope_kind'").get()
    ).toBeNull()
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default logger retains standalone stderr diagnostics and fresh stores omit upgrade events', () => {
  const root = mkdtempSync(join(tmpdir(), 'store-logger-default-'))
  const path = join(root, 'store.sqlite')
  historicalStore(path)
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    openHrcDatabase(path).close()
    expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([
      'hrc-store: session.identity.backfill total=2 unparsed=1\n',
      expect.stringContaining('hrc-store: store.migrated applied=2 version='),
    ])
    stderr.mockClear()
    const events: string[] = []
    openHrcDatabase(':memory:', {
      logger: {
        info: (event) => {
          events.push(event)
        },
      },
    }).close()
    expect(events).toEqual(['session.identity.backfill'])
    expect(stderr).not.toHaveBeenCalled()
  } finally {
    stderr.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
