import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

export { Database }
import { afterEach, expect } from 'bun:test'

export {
  parsePruneStateRetentionArgs,
  stripEnvelopePayloads,
} from './prune-hrc-event-deltas'

export const SCRIPT_PATH = join(import.meta.dir, 'prune-hrc-event-deltas.ts')
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
      invocation_state TEXT NOT NULL,
      updated_at TEXT,
      last_projected_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE broker_projection_dispositions (
      invocation_id TEXT NOT NULL, seq INTEGER NOT NULL, envelope_hash TEXT NOT NULL,
      disposition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (invocation_id, seq)
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

// The script prints one L2 log line per run; tests read the report from `data`.
export function parseScriptLog(stdout: string, event = 'prune.report') {
  const lines = stdout.trimEnd().split('\n')
  expect(lines).toHaveLength(1)
  const line = JSON.parse(lines[0] ?? '')
  expect(line).toMatchObject({ component: 'hrc-prune-deltas', event })
  expect(typeof line.ts).toBe('string')
  expect(line.level).toBe(event === 'prune.report' ? 'info' : 'error')
  return line.data
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
