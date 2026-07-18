import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { pruneDeltaEvents } from './prune-hrc-event-deltas'

const SCRIPT_PATH = join(import.meta.dir, 'prune-hrc-event-deltas.ts')
const NOW = new Date('2026-07-18T12:00:00.000Z')
const OLD = '2026-07-11T11:59:59.999Z'
const CUTOFF = '2026-07-11T12:00:00.000Z'
const NEW = '2026-07-11T12:00:00.001Z'
const tempDirs: string[] = []

type ScriptResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function makeStore(): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-prune-deltas-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE broker_invocation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      broker_event_json TEXT NOT NULL,
      UNIQUE (invocation_id, seq)
    );
  `)
  return { path, db }
}

function insertEvent(db: Database, eventKind: string, ts = OLD, payload = '{}'): number {
  const result = db
    .prepare('INSERT INTO events (ts, source, event_kind, event_json) VALUES (?, ?, ?, ?)')
    .run(ts, 'broker', eventKind, payload)
  return Number(result.lastInsertRowid)
}

function insertBrokerInvocationEvent(db: Database, type: string, time = OLD): number {
  const seq = Number(
    db
      .query<{ nextSeq: number }, []>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM broker_invocation_events'
      )
      .get()?.nextSeq ?? 1
  )
  const result = db
    .prepare(
      `INSERT INTO broker_invocation_events
        (invocation_id, seq, time, type, broker_event_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run('invocation-1', seq, time, type, '{}')
  return Number(result.lastInsertRowid)
}

function eventSeqs(db: Database): number[] {
  return db
    .query<{ seq: number }, []>('SELECT seq FROM events ORDER BY seq ASC')
    .all()
    .map((row) => row.seq)
}

function brokerInvocationEventIds(db: Database): number[] {
  return db
    .query<{ id: number }, []>('SELECT id FROM broker_invocation_events ORDER BY id ASC')
    .all()
    .map((row) => row.id)
}

function pruneOptions(path: string, apply: boolean, batchSize = 10_000) {
  return {
    dbPath: path,
    apply,
    batchSize,
    checkpoint: false,
    vacuum: false,
    now: NOW,
  }
}

function runScript(path: string, ...args: string[]): ScriptResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT_PATH, '--db', path, '--no-checkpoint', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('prune-hrc-event-deltas', () => {
  test('apply deletes only the two events delta kinds', () => {
    const { path, db } = makeStore()
    const assistantDelta = insertEvent(db, 'broker.assistant.message.delta')
    const toolDelta = insertEvent(db, 'broker.tool.call.delta')
    const assistantMessage = insertEvent(db, 'broker.assistant.message')
    const misleadingSuffix = insertEvent(db, 'broker.input.delta')
    insertBrokerInvocationEvent(db, 'assistant.message.delta', NEW)
    db.close()

    pruneDeltaEvents(pruneOptions(path, true))

    const verify = new Database(path)
    try {
      expect(eventSeqs(verify)).toEqual([assistantMessage, misleadingSuffix])
      expect(eventSeqs(verify)).not.toContain(assistantDelta)
      expect(eventSeqs(verify)).not.toContain(toolDelta)
    } finally {
      verify.close()
    }
  })

  test('apply deletes only the two broker_invocation_events delta types', () => {
    const { path, db } = makeStore()
    const assistantDelta = insertBrokerInvocationEvent(db, 'assistant.message.delta')
    const toolDelta = insertBrokerInvocationEvent(db, 'tool.call.delta')
    const assistantMessage = insertBrokerInvocationEvent(db, 'assistant.message')
    const misleadingSuffix = insertBrokerInvocationEvent(db, 'input.delta')
    insertEvent(db, 'broker.assistant.message.delta', NEW)
    db.close()

    pruneDeltaEvents(pruneOptions(path, true))

    const verify = new Database(path)
    try {
      expect(brokerInvocationEventIds(verify)).toEqual([assistantMessage, misleadingSuffix])
      expect(brokerInvocationEventIds(verify)).not.toContain(assistantDelta)
      expect(brokerInvocationEventIds(verify)).not.toContain(toolDelta)
    } finally {
      verify.close()
    }
  })

  test('seven-day cutoff deletes older rows but retains boundary and newer rows in both tables', () => {
    const { path, db } = makeStore()
    const oldEvent = insertEvent(db, 'broker.assistant.message.delta', OLD)
    const boundaryEvent = insertEvent(db, 'broker.assistant.message.delta', CUTOFF)
    const newEvent = insertEvent(db, 'broker.tool.call.delta', NEW)
    const oldBrokerEvent = insertBrokerInvocationEvent(db, 'assistant.message.delta', OLD)
    const boundaryBrokerEvent = insertBrokerInvocationEvent(db, 'assistant.message.delta', CUTOFF)
    const newBrokerEvent = insertBrokerInvocationEvent(db, 'tool.call.delta', NEW)
    db.close()

    pruneDeltaEvents(pruneOptions(path, true))

    const verify = new Database(path)
    try {
      expect(eventSeqs(verify)).toEqual([boundaryEvent, newEvent])
      expect(eventSeqs(verify)).not.toContain(oldEvent)
      expect(brokerInvocationEventIds(verify)).toEqual([boundaryBrokerEvent, newBrokerEvent])
      expect(brokerInvocationEventIds(verify)).not.toContain(oldBrokerEvent)
    } finally {
      verify.close()
    }
  })

  test('CLI exits nonzero and names both table predicates when no target delta kind exists', () => {
    const { path, db } = makeStore()
    insertEvent(db, 'broker.assistant.message')
    insertBrokerInvocationEvent(db, 'assistant.message')
    db.close()

    const result = runScript(path)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/predicate|delta/i)
    expect(result.stderr).toContain('events')
    expect(result.stderr).toContain('broker_invocation_events')
  })

  test('young target rows pass the age-unfiltered drift guard while reporting zero deletions', () => {
    const { path, db } = makeStore()
    insertEvent(db, 'broker.assistant.message.delta', new Date().toISOString())
    insertBrokerInvocationEvent(db, 'tool.call.delta', new Date().toISOString())
    db.close()

    const result = runScript(path, '--apply')

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.matchedCount).toBe(2)
    expect(report.eligibleCount).toBe(0)
    expect(report.deleted).toBe(0)

    const verify = new Database(path)
    try {
      expect(eventSeqs(verify)).toHaveLength(1)
      expect(brokerInvocationEventIds(verify)).toHaveLength(1)
    } finally {
      verify.close()
    }
  })

  test('dry-run reports both tables without deletion and apply loops batches without vacuuming', () => {
    const { path, db } = makeStore()
    for (let index = 0; index < 3; index += 1) {
      insertEvent(db, 'broker.tool.call.delta', OLD, 'x'.repeat(64 * 1024))
      insertBrokerInvocationEvent(db, 'tool.call.delta', OLD)
    }
    db.close()

    const dryRun = runScript(path)
    expect(dryRun.exitCode).toBe(0)
    const report = JSON.parse(dryRun.stdout)
    expect(report.tables.events.eligibleCount).toBe(3)
    expect(report.tables.broker_invocation_events.eligibleCount).toBe(3)
    expect(report.deleted).toBe(0)

    const afterDryRun = new Database(path)
    try {
      expect(eventSeqs(afterDryRun)).toHaveLength(3)
      expect(brokerInvocationEventIds(afterDryRun)).toHaveLength(3)
    } finally {
      afterDryRun.close()
    }

    const apply = runScript(path, '--apply', '--batch-size', '1')
    expect(apply.exitCode).toBe(0)

    const afterApply = new Database(path)
    try {
      expect(eventSeqs(afterApply)).toEqual([])
      expect(brokerInvocationEventIds(afterApply)).toEqual([])
      const freelist = afterApply
        .query<{ pages: number }, []>('SELECT freelist_count AS pages FROM pragma_freelist_count')
        .get()
      expect(freelist?.pages ?? 0).toBeGreaterThan(0)
    } finally {
      afterApply.close()
    }
  })
})
