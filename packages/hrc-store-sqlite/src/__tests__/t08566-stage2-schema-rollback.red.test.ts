/** T-08566 stage-2 schema, retention audit and rollback-floor contracts. */
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { openHrcDatabase } from '../index'

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
}

function retainedFloor(db: Database, table: 'hrc_events' | 'broker_invocation_events'): number {
  const known = columns(db, table)
  if (known.length === 0) throw new Error(`required table missing: ${table}`)
  if (!known.includes('evidence_origin')) return 0
  return (
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) count FROM ${table} WHERE evidence_origin IS NOT NULL`
      )
      .get()?.count ?? 0
  )
}

test('stage-2 additive migration installs origin, marker and keep-forever outcome authority', () => {
  const hrc = openHrcDatabase(':memory:')
  try {
    expect(columns(hrc.sqlite, 'hrc_events')).toContain('evidence_origin')
    expect(columns(hrc.sqlite, 'broker_invocation_events')).toContain('evidence_origin')
    expect(columns(hrc.sqlite, 'broker_invocations')).toContain('retained_projected_through_seq')
    expect(columns(hrc.sqlite, 'retained_evidence_outcomes')).toEqual(
      expect.arrayContaining([
        'runtime_id',
        'invocation_id',
        'outcome',
        'outcome_class',
        'trigger',
        'attempts',
        'detail_json',
        'recorded_at',
      ])
    )
  } finally {
    hrc.close()
  }
})

test('origin domain is exactly NULL or retained in both durable event tables', () => {
  const hrc = openHrcDatabase(':memory:')
  try {
    for (const table of ['hrc_events', 'broker_invocation_events']) {
      const sql = hrc.sqlite
        .query<{ sql: string }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
        )
        .get(table)?.sql
      expect(sql).toContain("evidence_origin IS NULL OR evidence_origin = 'retained'")
    }
  } finally {
    hrc.close()
  }
})

test('two-step rollback readback is zero on pre-stage-2 columns and refuses a missing table', () => {
  const db = new Database(':memory:')
  try {
    db.run('CREATE TABLE hrc_events (hrc_seq INTEGER PRIMARY KEY)')
    db.run('CREATE TABLE broker_invocation_events (id INTEGER PRIMARY KEY)')
    expect(retainedFloor(db, 'hrc_events')).toBe(0)
    expect(retainedFloor(db, 'broker_invocation_events')).toBe(0)
    db.run('DROP TABLE broker_invocation_events')
    expect(() => retainedFloor(db, 'broker_invocation_events')).toThrow(
      'required table missing: broker_invocation_events'
    )
  } finally {
    db.close()
  }
})

test('outcome audit cannot cascade with runtime deletion', () => {
  const hrc = openHrcDatabase(':memory:')
  try {
    const foreignKeys = hrc.sqlite
      .query<{ table: string; on_delete: string }, []>(
        'PRAGMA foreign_key_list(retained_evidence_outcomes)'
      )
      .all()
    expect(foreignKeys.some((key) => key.table === 'runtimes' && key.on_delete === 'CASCADE')).toBe(
      false
    )
  } finally {
    hrc.close()
  }
})
