import { describe, expect, test } from 'bun:test'

import { openHrcDatabase } from '../database.js'
import type { SqliteSlowStatement } from '../statement-telemetry.js'

describe('SQLite statement telemetry', () => {
  test('observes direct and prepared execution outside any HTTP request', () => {
    const observed: SqliteSlowStatement[] = []
    const db = openHrcDatabase(':memory:', {
      slowStatementThresholdMs: 0,
      onSlowStatement: (statement) => observed.push(statement),
    })
    observed.length = 0

    db.sqlite.exec('CREATE TABLE telemetry_probe (value TEXT)')
    db.sqlite.prepare('INSERT INTO telemetry_probe (value) VALUES (?)').run('one')
    expect(
      db.sqlite.query<{ value: string }, []>('SELECT value FROM telemetry_probe').get()?.value
    ).toBe('one')
    expect([
      ...db.sqlite.query<{ value: string }, []>('SELECT value FROM telemetry_probe').iterate(),
    ]).toEqual([{ value: 'one' }])

    expect(observed.map((statement) => statement.sql)).toEqual([
      'CREATE TABLE telemetry_probe (value TEXT)',
      'INSERT INTO telemetry_probe (value) VALUES (?)',
      'SELECT value FROM telemetry_probe',
      'SELECT value FROM telemetry_probe',
    ])
    for (const statement of observed) {
      expect(statement.durationMs).toBeGreaterThanOrEqual(0)
      expect(statement.callerTag).toContain('statement-telemetry.test.ts')
    }
    db.close()
  })

  test('does not emit below threshold and isolates observer failures', () => {
    const observed: SqliteSlowStatement[] = []
    const quiet = openHrcDatabase(':memory:', {
      slowStatementThresholdMs: Number.MAX_SAFE_INTEGER,
      onSlowStatement: (statement) => observed.push(statement),
    })
    quiet.sqlite.query('SELECT 1').get()
    expect(observed).toEqual([])
    quiet.close()

    const throwing = openHrcDatabase(':memory:', {
      slowStatementThresholdMs: 0,
      onSlowStatement: () => {
        throw new Error('observability must not affect SQLite')
      },
    })
    expect(throwing.sqlite.query<{ value: number }, []>('SELECT 1 AS value').get()?.value).toBe(1)
    throwing.close()
  })
})
