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

function countTable(db: ReturnType<typeof openHrcDatabase>, table: string): number {
  return db.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0
}

function createPhaseFourBlobTables(db: ReturnType<typeof openHrcDatabase>): void {
  const alreadyMigrated = db.sqlite
    .query<{ present: number }, []>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_result_blobs') AS present"
    )
    .get()?.present
  if (alreadyMigrated === 1) return
  db.sqlite.exec(`
    CREATE TABLE tool_result_blobs (
      blob_id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 1,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tool_result_blob_parts (
      blob_id TEXT NOT NULL,
      part INTEGER NOT NULL,
      parts INTEGER NOT NULL,
      runtime_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      chunk TEXT NOT NULL,
      PRIMARY KEY (blob_id, part)
    );
  `)
}

function seedLedgerDependents(
  db: ReturnType<typeof openHrcDatabase>,
  runtimeId: string,
  options: { withBlobs?: boolean | undefined } = {}
): string {
  const now = ts()
  const planHash = `plan-${runtimeId}`
  const operationId = `op-${runtimeId}`
  const invocationId = `inv-${runtimeId}`
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error(`missing seeded runtime ${runtimeId}`)

  db.compiledRuntimePlans.insert({
    planHash,
    compileId: `compile-${runtimeId}`,
    schemaVersion: '1',
    compilerName: 'test',
    compilerVersion: '1',
    planProjectionJson: '{}',
    createdAt: now,
  })
  db.runtimes.update(runtimeId, { planHash, updatedAt: now })
  db.runtimeOperations.insert({
    operationId,
    runtimeId,
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    operationKind: 'broker_invocation',
    controller: 'harness-broker',
    planHash,
    startupMethod: 'test',
    status: 'completed',
    routeDecisionJson: '{}',
    createdAt: now,
    updatedAt: now,
  })
  db.brokerInvocations.insert({
    invocationId,
    operationId,
    runtimeId,
    brokerProtocol: 'test/1',
    brokerDriver: 'test',
    invocationState: 'completed',
    capabilitiesJson: '{}',
    specHash: `spec-${runtimeId}`,
    startRequestHash: `request-${runtimeId}`,
    selectedProfileHash: `profile-${runtimeId}`,
    createdAt: now,
    updatedAt: now,
  })
  db.sqlite
    .query(
      `INSERT INTO broker_invocation_events (
         invocation_id, seq, time, type, runtime_id, broker_event_json,
         projection_status, created_at
       ) VALUES (?, 1, ?, 'turn.completed', ?, '{}', 'applied', ?)`
    )
    .run(invocationId, now, runtimeId, now)
  db.sqlite
    .query(
      `INSERT INTO hrc_events (
         stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
         runtime_id, category, event_kind, payload_json
       ) VALUES ((SELECT COALESCE(MAX(stream_seq), 0) + 1 FROM hrc_events), ?, ?, ?, 'default', 1, ?, 'turn', 'turn.completed', '{}')`
    )
    .run(now, runtime.hostSessionId, runtime.scopeRef, runtimeId)
  db.firstTurnWatch.arm({
    runtimeId,
    generation: runtime.generation,
    hostSessionId: runtime.hostSessionId,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    invocationId,
    transport: runtime.transport,
    primingDispatchedAt: now,
    firstTurnDeadlineAt: now,
  })
  db.sqlite
    .query(
      `INSERT INTO runtime_artifacts (
         artifact_id, operation_id, artifact_kind, media_type, storage_kind,
         content_hash, artifact_json, created_at
       ) VALUES (?, ?, 'test', 'application/json', 'inline', ?, '{}', ?)`
    )
    .run(`artifact-${runtimeId}`, operationId, `hash-${runtimeId}`, now)

  if (options.withBlobs) {
    db.sqlite
      .query(
        `INSERT INTO tool_result_blobs (
           blob_id, runtime_id, kind, bytes, complete, result_json, created_at
         ) VALUES (?, ?, 'broker_raw', 2, 1, '{}', ?)`
      )
      .run(`blob-${runtimeId}`, runtimeId, now)
    db.sqlite
      .query(
        `INSERT INTO tool_result_blob_parts (
           blob_id, part, parts, runtime_id, kind, bytes, chunk
         ) VALUES (?, 0, 1, ?, 'broker_raw', 2, '{}')`
      )
      .run(`part-${runtimeId}`, runtimeId)
  }

  return planHash
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

  it('keeps durable ledgers and broker projections with the default cascade', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-default-ledgers')
      createPhaseFourBlobTables(db)
      seedLedgerDependents(db, 'rt-default-ledgers', { withBlobs: true })

      expect(db.runtimes.pruneRuntime('rt-default-ledgers')).toBe(true)

      expect(countTable(db, 'broker_invocation_events')).toBe(1)
      expect(countTable(db, 'hrc_events')).toBe(1)
      expect(countTable(db, 'broker_invocations')).toBe(1)
      expect(countTable(db, 'runtime_operations')).toBe(1)
      expect(countTable(db, 'runtime_first_turn_watch')).toBe(1)
      expect(countTable(db, 'runtime_artifacts')).toBe(1)
      expect(countTable(db, 'tool_result_blob_parts')).toBe(1)
      expect(countTable(db, 'tool_result_blobs')).toBe(1)
      expect(countTable(db, 'compiled_runtime_plans')).toBe(1)
    } finally {
      db.close()
    }
  })

  it('deletes ledgers, Phase 4 blobs, and newly orphaned plans when requested', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-ledger-cascade')
      createPhaseFourBlobTables(db)
      seedLedgerDependents(db, 'rt-ledger-cascade', { withBlobs: true })
      db.transcriptIndex.upsertTurn({
        invocationId: 'inv-rt-ledger-cascade',
        runtimeId: 'rt-ledger-cascade',
        seqFrom: 1,
        seqTo: 1,
        startedAt: ts(),
        completedAt: ts(),
        terminalStatus: 'completed',
        messageCount: 1,
        truncated: false,
        userText: 'prune sentinel',
        finalText: 'answer',
        midText: '',
      })
      db.transcriptIndex.setInvocationMark({
        invocationId: 'inv-rt-ledger-cascade',
        runtimeId: 'rt-ledger-cascade',
        lastTerminalSeq: 1,
        updatedAt: ts(),
      })

      expect(
        db.runtimes.countPruneRows(['rt-ledger-cascade'], { includeLedgers: true })
      ).toMatchObject({
        broker_invocation_events: 1,
        hrc_events: 1,
        broker_invocations: 1,
        runtime_operations: 1,
        runtime_first_turn_watch: 1,
        runtime_artifacts: 1,
        tool_result_blob_parts: 1,
        tool_result_blobs: 1,
        compiled_runtime_plans: 1,
        events: 2,
        runtime_buffers: 1,
        runs: 1,
        runtimes: 1,
      })

      expect(db.runtimes.pruneRuntime('rt-ledger-cascade', { includeLedgers: true })).toBe(true)

      for (const table of [
        'broker_invocation_events',
        'transcript_turns',
        'transcript_index_invocations',
        'hrc_events',
        'broker_invocations',
        'runtime_operations',
        'runtime_first_turn_watch',
        'runtime_artifacts',
        'tool_result_blob_parts',
        'tool_result_blobs',
        'compiled_runtime_plans',
        'events',
        'runtime_buffers',
        'runs',
        'runtimes',
      ]) {
        expect(countTable(db, table), table).toBe(0)
      }
    } finally {
      db.close()
    }
  })

  it('guards absent Phase 4 blob tables and preserves plans still referenced elsewhere', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-plan-owner')
      seedRuntimeWithDependents(db, 'rt-plan-peer')
      const sharedPlanHash = seedLedgerDependents(db, 'rt-plan-owner')
      const peer = db.runtimes.getByRuntimeId('rt-plan-peer')
      if (!peer) throw new Error('missing peer runtime')
      db.runtimes.update('rt-plan-peer', { planHash: sharedPlanHash, updatedAt: ts() })

      expect(db.runtimes.pruneRuntime('rt-plan-owner', { includeLedgers: true })).toBe(true)

      expect(countTable(db, 'compiled_runtime_plans')).toBe(1)
      expect(db.runtimes.getByRuntimeId('rt-plan-peer')).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('prunes a ledger manifest as one set and refuses a partially missing set', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRuntimeWithDependents(db, 'rt-batch-one')
      seedRuntimeWithDependents(db, 'rt-batch-two')
      seedLedgerDependents(db, 'rt-batch-one')
      seedLedgerDependents(db, 'rt-batch-two')

      expect(() =>
        db.runtimes.pruneRuntimes(['rt-batch-one', 'rt-missing'], { includeLedgers: true })
      ).toThrow('runtime prune manifest changed before apply')
      expect(db.runtimes.getByRuntimeId('rt-batch-one')).not.toBeNull()
      expect(countTable(db, 'broker_invocation_events')).toBe(2)

      expect(
        db.runtimes.pruneRuntimes(['rt-batch-one', 'rt-batch-two'], { includeLedgers: true })
      ).toBe(2)
      expect(countTable(db, 'runtimes')).toBe(0)
      expect(countTable(db, 'broker_invocation_events')).toBe(0)
      expect(countTable(db, 'compiled_runtime_plans')).toBe(0)
    } finally {
      db.close()
    }
  })
})
