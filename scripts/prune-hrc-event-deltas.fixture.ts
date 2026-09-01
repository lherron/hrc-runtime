import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'
import { openHrcDatabase } from '../packages/hrc-store-sqlite/src/database'

export { Database }
import { afterEach } from 'bun:test'

export {
  createPurgePlans,
  createRetentionPlans,
  deleteSelectedBatch,
  deleteSelectedBatchSql,
  parsePruneStateRetentionArgs,
  pruneStateRetention,
  selectEligibleBatch,
  selectEligibleBatchSql,
  stripEnvelopePayloads,
} from './prune-hrc-event-deltas'

export const SCRIPT_PATH = join(import.meta.dir, 'prune-hrc-event-deltas.ts')
export const NOW = new Date('2026-07-18T12:00:00.000Z')
export const OLD = '2026-07-14T11:59:59.999Z'
export const EVENT_BOUNDARY = '2026-07-15T12:00:00.000Z'
export const EVENT_NEW = '2026-07-15T12:00:00.001Z'
export const BUFFER_BOUNDARY = '2026-07-17T12:00:00.000Z'
const tempDirs: string[] = []

type ScriptResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export function makeStore(incrementalAutoVacuum = true): {
  path: string
  db: Database
} {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-state-retention-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  if (incrementalAutoVacuum) {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;')
  }
  db.exec(`
    CREATE TABLE runtimes (
      runtime_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      active_run_id TEXT
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE broker_invocations (
      invocation_id TEXT PRIMARY KEY,
      invocation_state TEXT NOT NULL
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      run_id TEXT,
      runtime_id TEXT
    );
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      source_ref TEXT,
      run_id TEXT,
      runtime_id TEXT
    );
    CREATE TABLE broker_invocation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      run_id TEXT,
      runtime_id TEXT,
      source_ref TEXT,
      broker_event_json TEXT NOT NULL,
      broker_envelope_json TEXT,
      UNIQUE(invocation_id, seq)
    );
    CREATE TABLE runtime_buffers (
      runtime_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      chunk_seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, chunk_seq)
    );
  `)
  return { path, db }
}

export function makeProductStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-product-state-retention-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.sqlite')
  return { path, db: openHrcDatabase(path) }
}

export function seedTerminalAuthority(
  db: Database,
  suffix = 'terminal'
): {
  runtimeId: string
  runId: string
  invocationId: string
} {
  const runtimeId = `runtime-${suffix}`
  const runId = `run-${suffix}`
  const invocationId = `invocation-${suffix}`
  db.prepare('INSERT INTO runtimes (runtime_id, status, active_run_id) VALUES (?, ?, NULL)').run(
    runtimeId,
    'terminated'
  )
  db.prepare('INSERT INTO runs (run_id, status) VALUES (?, ?)').run(runId, 'completed')
  db.prepare('INSERT INTO broker_invocations (invocation_id, invocation_state) VALUES (?, ?)').run(
    invocationId,
    'exited'
  )
  return { runtimeId, runId, invocationId }
}

export function insertEvent(
  db: Database,
  eventKind: string,
  options: { ts?: string; runId?: string; runtimeId?: string } = {}
): number {
  return Number(
    db
      .prepare('INSERT INTO events (ts, event_kind, run_id, runtime_id) VALUES (?, ?, ?, ?)')
      .run(options.ts ?? OLD, eventKind, options.runId ?? null, options.runtimeId ?? null)
      .lastInsertRowid
  )
}

export function insertHrcEvent(
  db: Database,
  eventKind: string,
  options: {
    ts?: string
    runId?: string
    runtimeId?: string
    sourceRef?: string
  } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO hrc_events
          (ts, event_kind, source_ref, run_id, runtime_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        options.ts ?? OLD,
        eventKind,
        options.sourceRef ?? null,
        options.runId ?? null,
        options.runtimeId ?? null
      ).lastInsertRowid
  )
}

export function insertBrokerEvent(
  db: Database,
  invocationId: string,
  options: {
    seq?: number
    time?: string
    type?: string
    runId?: string
    runtimeId?: string
    sourceRef?: string
  } = {}
): number {
  const seq =
    options.seq ??
    db
      .query<{ seq: number }, [string]>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM broker_invocation_events WHERE invocation_id = ?'
      )
      .get(invocationId)?.seq ??
    1
  return Number(
    db
      .prepare(
        `INSERT INTO broker_invocation_events
          (invocation_id, seq, time, type, run_id, runtime_id, source_ref,
           broker_event_json, broker_envelope_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}')`
      )
      .run(
        invocationId,
        seq,
        options.time ?? OLD,
        options.type ?? 'turn.message',
        options.runId ?? null,
        options.runtimeId ?? null,
        options.sourceRef ?? null
      ).lastInsertRowid
  )
}

export function insertBuffer(
  db: Database,
  runtimeId: string,
  runId: string,
  chunkSeq: number,
  createdAt = OLD,
  text = 'buffer'
): void {
  db.prepare(
    `INSERT INTO runtime_buffers (runtime_id, run_id, chunk_seq, text, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(runtimeId, runId, chunkSeq, text, createdAt)
}

export function ids(db: Database, table: string, key: string): number[] {
  return db
    .query<Record<string, number>, []>(`SELECT ${key} FROM ${table} ORDER BY ${key} ASC`)
    .all()
    .map((row) => row[key] ?? -1)
}

export function pruneOptions(path: string, apply: boolean, batchSize = 10_000) {
  return {
    dbPath: path,
    operation: 'retention' as const,
    expectedT07040BackfillRows: 822,
    apply,
    batchSize,
    checkpoint: false,
    eventRetentionDays: 3,
    runtimeBufferRetentionDays: 1,
    incrementalVacuumPages: 0,
    incrementalVacuumChunkPages: 200,
    deadlineMillis: 60_000,
    paceMillis: 0,
    maxWriteHoldMillis: 500,
    maxDutyCycle: 1,
    busyMaxRetries: 8,
    countEligible: true,
    tables: ['events', 'hrc_events', 'broker_invocation_events', 'runtime_buffers'] as const,
    runtimeRoot: join(dirname(path), 'runtime'),
    firstTurnBundleKeep: 3,
    firstTurnBundleTtlDays: 14,
    now: NOW,
  }
}

export function runScript(path: string, ...args: string[]): ScriptResult {
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
