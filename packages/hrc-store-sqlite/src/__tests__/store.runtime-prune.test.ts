/**
 * T-05441: record-level prune for orphaned runtime store rows.
 *
 * `runtimes(runtime_id)` is referenced by FK-enforced satellite tables (runs,
 * launches, events, ...) with no ON DELETE CASCADE and `foreign_keys = ON`, so a
 * plain DELETE throws whenever any dependent row exists. `pruneRuntime` clears
 * the dependents in a transaction before removing the runtime; these tests pin
 * that cascade and its idempotency.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function seedRuntimeWithDependents(
  db: ReturnType<typeof openHrcDatabase>,
  runtimeId: string
): void {
  const now = ts()
  const hostSessionId = `hsid-${runtimeId}`
  const scopeRef = `agent:test:project:hrc-store:task:${runtimeId}`

  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'stale',
    supportsInflightInput: false,
    adopted: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  })
  // A run + an event pinned to that run (event carries a null runtime_id but a
  // non-null run_id — the cascade must clear it via the run edge).
  db.runs.insert({
    runId: `run-${runtimeId}`,
    hostSessionId,
    runtimeId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    status: 'completed',
    updatedAt: now,
    acceptedAt: now,
    completedAt: now,
  })
  db.sqlite
    .query(
      `INSERT INTO events (ts, host_session_id, scope_ref, lane_ref, generation, run_id, runtime_id, source, event_kind, event_json)
       VALUES (?, ?, ?, 'default', 1, ?, NULL, 'hrc', 'turn.completed', '{}')`
    )
    .run(now, hostSessionId, scopeRef, `run-${runtimeId}`)
  db.sqlite
    .query(
      `INSERT INTO events (ts, host_session_id, scope_ref, lane_ref, generation, run_id, runtime_id, source, event_kind, event_json)
       VALUES (?, ?, ?, 'default', 1, NULL, ?, 'hrc', 'runtime.stale', '{}')`
    )
    .run(now, hostSessionId, scopeRef, runtimeId)
  // A runtime_buffer FK-references BOTH runtimes(runtime_id) AND runs(run_id).
  // It is the row that forces the delete order: if runs are deleted before the
  // buffer, the buffer's run_id FK trips FK_CONSTRAINT (the T-05441 live bug).
  db.sqlite
    .query(
      `INSERT INTO runtime_buffers (runtime_id, run_id, chunk_seq, text, created_at)
       VALUES (?, ?, 0, 'buffered output', ?)`
    )
    .run(runtimeId, `run-${runtimeId}`, now)
}

function countWhere(
  db: ReturnType<typeof openHrcDatabase>,
  table: string,
  runtimeId: string
): number {
  return (
    db.sqlite
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE runtime_id = ?`)
      .get(runtimeId)?.n ?? 0
  )
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-store-prune-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('RuntimeRepository.pruneRuntime (T-05441)', () => {
  it('deletes the runtime and its FK-referencing dependent rows', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-cascade')
      expect(db.runtimes.getByRuntimeId('rt-cascade')).not.toBeNull()
      expect(countWhere(db, 'runs', 'rt-cascade')).toBe(1)
      expect(countWhere(db, 'events', 'rt-cascade')).toBe(1)
      expect(countWhere(db, 'runtime_buffers', 'rt-cascade')).toBe(1)

      const removed = db.runtimes.pruneRuntime('rt-cascade')

      expect(removed).toBe(true)
      expect(db.runtimes.getByRuntimeId('rt-cascade')).toBeNull()
      expect(countWhere(db, 'runs', 'rt-cascade')).toBe(0)
      expect(countWhere(db, 'runtime_buffers', 'rt-cascade')).toBe(0)
      // both the runtime-pinned and the run-pinned events are gone
      expect(
        db.sqlite
          .query<{ n: number }, [string, string]>(
            'SELECT COUNT(*) AS n FROM events WHERE run_id = ? OR runtime_id = ?'
          )
          .get('run-rt-cascade', 'rt-cascade')?.n ?? 0
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  it('returns false for an absent runtime and is safe to re-run', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-idem')
      expect(db.runtimes.pruneRuntime('rt-idem')).toBe(true)
      expect(db.runtimes.pruneRuntime('rt-idem')).toBe(false)
      expect(db.runtimes.pruneRuntime('rt-never-existed')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('leaves unrelated runtimes and their dependents intact', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-target')
      seedRuntimeWithDependents(db, 'rt-bystander')

      db.runtimes.pruneRuntime('rt-target')

      expect(db.runtimes.getByRuntimeId('rt-bystander')).not.toBeNull()
      expect(countWhere(db, 'runs', 'rt-bystander')).toBe(1)
      expect(countWhere(db, 'events', 'rt-bystander')).toBe(1)
    } finally {
      db.close()
    }
  })
})
