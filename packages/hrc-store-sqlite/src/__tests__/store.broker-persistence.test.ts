import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcDatabase } from '../database.js'
import { openHrcDatabase } from '../index'
import { phase1Migrations } from '../migrations.js'
import { BrokerInvocationEventConflictError } from '../repositories/broker-repositories.js'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:broker:task:${key}`
}

const BROKER_TABLES = [
  'compiled_runtime_plans',
  'runtime_operations',
  'broker_invocations',
  'broker_invocation_events',
  'runtime_artifacts',
  'permission_decisions',
] as const

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-broker-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function tableExists(db: ReturnType<typeof openHrcDatabase>, name: string): boolean {
  const row = db.sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(name)
  return row !== null
}

/**
 * Apply every migration EXCEPT the two broker migrations (0016/0017) so we have
 * a fully populated pre-broker ("legacy") database, then return the raw handle.
 */
function createLegacyPreBrokerDatabase(): ReturnType<typeof createHrcDatabase> {
  const sqlite = createHrcDatabase(dbPath)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const preBroker = phase1Migrations.slice(0, phase1Migrations.length - 2)
  for (const migration of preBroker) {
    migration.apply(sqlite)
    sqlite
      .prepare('INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)')
      .run(migration.id, ts())
  }

  return sqlite
}

describe('broker persistence migration (0016/0017)', () => {
  it('creates all six broker tables on a fresh db with the UNIQUE(invocation_id, seq) constraint', () => {
    const db = openHrcDatabase(dbPath)
    try {
      for (const table of BROKER_TABLES) {
        expect(tableExists(db, table)).toBe(true)
      }

      expect(db.migrations.applied).toContain('0016_broker_persistence')
      expect(db.migrations.applied).toContain('0017_runtime_broker_state')

      // The UNIQUE(invocation_id, seq) index must exist on broker_invocation_events.
      const indexes = db.sqlite
        .query<{ name: string; unique: number }, []>(
          "PRAGMA index_list('broker_invocation_events')"
        )
        .all()
      const uniqueIndexes = indexes.filter((idx) => idx.unique === 1)
      const hasInvocationSeqUnique = uniqueIndexes.some((idx) => {
        const cols = db.sqlite
          .query<{ name: string }, []>(`PRAGMA index_info('${idx.name}')`)
          .all()
          .map((c) => c.name)
        return cols.length === 2 && cols[0] === 'invocation_id' && cols[1] === 'seq'
      })
      expect(hasInvocationSeqUnique).toBe(true)

      // New nullable runtime/run columns exist.
      const runtimeColumns = db.sqlite
        .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
        .all()
        .map((row) => row.name)
      for (const col of [
        'controller_kind',
        'active_operation_id',
        'active_invocation_id',
        'compile_id',
        'plan_hash',
        'selected_profile_hash',
        'runtime_state_json',
      ]) {
        expect(runtimeColumns).toContain(col)
      }
      const runColumns = db.sqlite
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
      expect(runColumns).toContain('operation_id')
      expect(runColumns).toContain('invocation_id')
    } finally {
      db.close()
    }
  })

  it('applies cleanly over a populated legacy db and existing rows survive', () => {
    const sqlite = createLegacyPreBrokerDatabase()
    try {
      // Seed a session + runtime + run + launch using the legacy column set.
      const now = ts()
      sqlite
        .prepare(
          `INSERT INTO sessions (
             host_session_id, scope_ref, lane_ref, generation, status,
             created_at, updated_at, ancestor_scope_refs_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('hsid-legacy', scopeRef('legacy'), 'default', 1, 'active', now, now, '[]')

      sqlite
        .prepare(
          `INSERT INTO runtimes (
             runtime_id, host_session_id, scope_ref, lane_ref, generation,
             transport, harness, provider, status,
             supports_inflight_input, adopted, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'rt-legacy',
          'hsid-legacy',
          scopeRef('legacy'),
          'default',
          1,
          'headless',
          'codex-cli',
          'openai',
          'ready',
          1,
          0,
          now,
          now
        )

      sqlite
        .prepare(
          `INSERT INTO runs (
             run_id, host_session_id, runtime_id, scope_ref, lane_ref,
             generation, transport, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'run-legacy',
          'hsid-legacy',
          'rt-legacy',
          scopeRef('legacy'),
          'default',
          1,
          'headless',
          'completed',
          now
        )

      sqlite
        .prepare(
          `INSERT INTO launches (
             launch_id, host_session_id, generation, runtime_id, harness, provider,
             launch_artifact_path, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'lch-legacy',
          'hsid-legacy',
          1,
          'rt-legacy',
          'codex-cli',
          'openai',
          '/tmp/launch.json',
          'exited',
          now,
          now
        )
    } finally {
      sqlite.close()
    }

    // Re-open: this triggers the broker migrations over the populated legacy db.
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0016_broker_persistence')
      expect(db.migrations.applied).toContain('0017_runtime_broker_state')

      const runtime = db.runtimes.getByRuntimeId('rt-legacy')
      expect(runtime).not.toBeNull()
      expect(runtime?.status).toBe('ready')
      // New broker columns are null on legacy rows and project to undefined.
      expect(runtime?.controllerKind).toBeUndefined()
      expect(runtime?.activeInvocationId).toBeUndefined()
      expect(runtime?.runtimeStateJson).toBeUndefined()

      const run = db.runs.getByRunId('run-legacy')
      expect(run).not.toBeNull()
      expect(run?.status).toBe('completed')
      expect(run?.operationId).toBeUndefined()
      expect(run?.invocationId).toBeUndefined()

      const launch = db.launches.getByLaunchId('lch-legacy')
      expect(launch).not.toBeNull()
      expect(launch?.status).toBe('exited')

      for (const table of BROKER_TABLES) {
        expect(tableExists(db, table)).toBe(true)
      }
    } finally {
      db.close()
    }
  })
})

describe('BrokerInvocationEventRepository.appendEvent idempotency', () => {
  it('inserts once, is a no-op on identical re-append, and throws on conflicting payload', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const base = {
        invocationId: 'inv-1',
        seq: 1,
        time: ts(),
        type: 'turn.started',
        runtimeId: 'rt-1',
        runId: 'run-1',
      }

      const first = db.brokerInvocationEvents.appendEvent({
        ...base,
        payload: { turnId: 't-1', detail: { a: 1 } },
      })
      expect(first.idempotent).toBe(false)
      expect(first.record.seq).toBe(1)

      // Same (invocationId, seq) + same payload → idempotent no-op, no throw.
      const second = db.brokerInvocationEvents.appendEvent({
        ...base,
        payload: { turnId: 't-1', detail: { a: 1 } },
      })
      expect(second.idempotent).toBe(true)

      expect(db.brokerInvocationEvents.listByInvocationId('inv-1')).toHaveLength(1)

      // Same key + DIFFERENT payload → throws loudly, no overwrite.
      expect(() =>
        db.brokerInvocationEvents.appendEvent({
          ...base,
          payload: { turnId: 't-1', detail: { a: 2 } },
        })
      ).toThrow(BrokerInvocationEventConflictError)

      // Still exactly one row, original payload preserved.
      const rows = db.brokerInvocationEvents.listByInvocationId('inv-1')
      expect(rows).toHaveLength(1)
      expect(JSON.parse(rows[0]!.brokerEventJson)).toEqual({ turnId: 't-1', detail: { a: 1 } })

      // Different seq for the same invocation is a fresh row.
      const next = db.brokerInvocationEvents.appendEvent({
        ...base,
        seq: 2,
        type: 'turn.completed',
        payload: { turnId: 't-1' },
      })
      expect(next.idempotent).toBe(false)
      expect(db.brokerInvocationEvents.listByInvocationId('inv-1')).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('idempotency includes harnessGeneration + turnAttempt in the identity check', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const base = {
        invocationId: 'inv-identity',
        seq: 1,
        time: ts(),
        type: 'tool.call.started',
        runtimeId: 'rt-identity',
        runId: 'run-identity',
        harnessGeneration: 1,
        turnAttempt: 1,
      }

      // First append: fresh row, idempotent:false.
      const first = db.brokerInvocationEvents.appendEvent({
        ...base,
        payload: { turnId: 't-1' },
      })
      expect(first.idempotent).toBe(false)
      expect(first.record.seq).toBe(1)

      // Same payload + same gen/attempt → idempotent:true, no throw.
      const second = db.brokerInvocationEvents.appendEvent({
        ...base,
        payload: { turnId: 't-1' },
      })
      expect(second.idempotent).toBe(true)

      // Same payload but DIFFERENT harnessGeneration → conflict.
      expect(() =>
        db.brokerInvocationEvents.appendEvent({
          ...base,
          harnessGeneration: 2,
          payload: { turnId: 't-1' },
        })
      ).toThrow(BrokerInvocationEventConflictError)

      // Same payload but DIFFERENT turnAttempt → conflict.
      expect(() =>
        db.brokerInvocationEvents.appendEvent({
          ...base,
          turnAttempt: 2,
          payload: { turnId: 't-1' },
        })
      ).toThrow(BrokerInvocationEventConflictError)

      // Same payload + gen/attempt but DIFFERENT runId → conflict (runId is a
      // durable bracket-identity field keyed by the authority SQL).
      expect(() =>
        db.brokerInvocationEvents.appendEvent({
          ...base,
          runId: 'run-other',
          payload: { turnId: 't-1' },
        })
      ).toThrow(BrokerInvocationEventConflictError)

      // Regression: seq=2 with NO gen/attempt; re-append also no gen/attempt → idempotent.
      const noGenBase = {
        invocationId: 'inv-identity',
        seq: 2,
        time: ts(),
        type: 'tool.call.started',
        runtimeId: 'rt-identity',
        runId: 'run-identity',
      }
      const third = db.brokerInvocationEvents.appendEvent({
        ...noGenBase,
        payload: { turnId: 't-2' },
      })
      expect(third.idempotent).toBe(false)
      const fourth = db.brokerInvocationEvents.appendEvent({
        ...noGenBase,
        payload: { turnId: 't-2' },
      })
      expect(fourth.idempotent).toBe(true)

      // Only two rows for this invocation.
      expect(db.brokerInvocationEvents.listByInvocationId('inv-identity')).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('records projection outcome via updateProjection', () => {
    const db = openHrcDatabase(dbPath)
    try {
      db.brokerInvocationEvents.appendEvent({
        invocationId: 'inv-2',
        seq: 1,
        time: ts(),
        type: 'invocation.started',
        runtimeId: 'rt-2',
        payload: { pid: 123 },
      })

      const updated = db.brokerInvocationEvents.updateProjection('inv-2', 1, {
        hrcEventSeq: 42,
        projectionStatus: 'applied',
      })
      expect(updated?.hrcEventSeq).toBe(42)
      expect(updated?.projectionStatus).toBe('applied')
    } finally {
      db.close()
    }
  })

  // T-05078: the raw observer (`GET /v1/broker-events`) must reconstruct a TRUE
  // InvocationEventEnvelope, including optional envelope-level fields the
  // payload-only `brokerEventJson` drops. Persist + reload the full envelope JSON.
  it('persists and round-trips the full broker envelope JSON (turnId/inputId/itemId/correlation/driver)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const envelope = {
        invocationId: 'inv-env',
        seq: 7,
        time: ts(),
        type: 'assistant.message.delta',
        turnId: 'turn-9',
        inputId: 'input-3',
        itemId: 'item-42',
        correlation: { actionRunRef: 'wrkf:a-1' },
        driver: { kind: 'codex-app-server', rawType: 'item/text/delta' },
        payload: { delta: 'hello' },
      }

      db.brokerInvocationEvents.appendEvent({
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        time: envelope.time,
        type: envelope.type,
        runtimeId: 'rt-env',
        runId: 'run-env',
        payload: envelope.payload,
        envelopeJson: JSON.stringify(envelope),
      })

      const [row] = db.brokerInvocationEvents.listByInvocationId('inv-env')
      expect(row).toBeDefined()
      // payload-only column stays payload-only (unchanged behavior)...
      expect(JSON.parse(row!.brokerEventJson)).toEqual(envelope.payload)
      // ...and the full envelope round-trips verbatim, optional fields intact.
      expect(row!.brokerEnvelopeJson).toBeDefined()
      expect(JSON.parse(row!.brokerEnvelopeJson!)).toEqual(envelope)
    } finally {
      db.close()
    }
  })
})

describe('broker record repositories round-trip', () => {
  it('persists and reloads compiled plans, operations, invocations, artifacts, and permission decisions', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()

      const plan = db.compiledRuntimePlans.insert({
        planHash: 'plan-hash-1',
        compileId: 'compile-1',
        schemaVersion: 'agent-runtime-plan/v1',
        compilerName: 'agent-spaces',
        compilerVersion: '1.2.3',
        planProjectionJson: JSON.stringify({ ok: true }),
        createdAt: now,
      })
      expect(plan.planHash).toBe('plan-hash-1')
      // Content-addressed re-insert is a no-op (keeps first compile metadata).
      const planAgain = db.compiledRuntimePlans.insert({
        planHash: 'plan-hash-1',
        compileId: 'compile-2',
        schemaVersion: 'agent-runtime-plan/v1',
        compilerName: 'agent-spaces',
        compilerVersion: '9.9.9',
        planProjectionJson: JSON.stringify({ ok: false }),
        createdAt: ts(),
      })
      expect(planAgain.compileId).toBe('compile-1')

      const op = db.runtimeOperations.insert({
        operationId: 'op-1',
        runtimeId: 'rt-1',
        hostSessionId: 'hsid-1',
        generation: 1,
        operationKind: 'broker_invocation',
        controller: 'harness-broker',
        startupMethod: 'broker.startInvocationFromRequest',
        status: 'accepted',
        routeDecisionJson: JSON.stringify({ admission: { decision: 'admit' } }),
        createdAt: now,
        updatedAt: now,
      })
      expect(op.controller).toBe('harness-broker')
      const opUpdated = db.runtimeOperations.update('op-1', {
        status: 'completed',
        updatedAt: ts(),
      })
      expect(opUpdated?.status).toBe('completed')

      const inv = db.brokerInvocations.insert({
        invocationId: 'inv-1',
        operationId: 'op-1',
        runtimeId: 'rt-1',
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        invocationState: 'starting',
        capabilitiesJson: JSON.stringify({ input: true }),
        specHash: 'spec-1',
        startRequestHash: 'sr-1',
        selectedProfileHash: 'pf-1',
        createdAt: now,
        updatedAt: now,
      })
      expect(inv.brokerDriver).toBe('codex-app-server')
      const invUpdated = db.brokerInvocations.update('inv-1', {
        invocationState: 'ready',
        lastEventSeq: 7,
        updatedAt: ts(),
      })
      expect(invUpdated?.invocationState).toBe('ready')
      expect(invUpdated?.lastEventSeq).toBe(7)

      const artifact = db.runtimeArtifacts.insert({
        artifactId: 'art-1',
        operationId: 'op-1',
        artifactKind: 'broker-start-request',
        mediaType: 'application/json',
        storageKind: 'inline-json',
        contentHash: 'ch-1',
        artifactJson: JSON.stringify({ startRequest: {} }),
        createdAt: now,
      })
      expect(db.runtimeArtifacts.listByOperationId('op-1')).toHaveLength(1)
      expect(artifact.artifactKind).toBe('broker-start-request')
      expect(db.runtimeArtifacts.listByOperationIdAndKind('op-1', 'broker-start-request')).toEqual([
        artifact,
      ])
      expect(
        db.runtimeArtifacts.getLatestByOperationIdAndKind('op-1', 'broker-start-request')
      ).toEqual(artifact)
      expect(db.runtimeArtifacts.insertIdempotent(artifact)).toEqual(artifact)

      const decision = db.permissionDecisions.insert({
        permissionRequestId: 'perm-1',
        invocationId: 'inv-1',
        runtimeId: 'rt-1',
        kind: 'tool.exec',
        subjectDisplayJson: JSON.stringify({ tool: 'shell' }),
        defaultDecision: 'deny',
        decision: 'deny',
        decidedBy: 'policy',
        policyJson: JSON.stringify({ mode: 'default-deny' }),
        requestedAt: now,
        decidedAt: now,
      })
      expect(decision.decision).toBe('deny')
      expect(db.permissionDecisions.listByInvocationId('inv-1')).toHaveLength(1)

      // Runtime broker-state columns round-trip through RuntimeRepository.
      db.sessions.insert({
        hostSessionId: 'hsid-rt',
        scopeRef: scopeRef('rt'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      const runtime = db.runtimes.insert({
        runtimeId: 'rt-broker',
        hostSessionId: 'hsid-rt',
        scopeRef: scopeRef('rt'),
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: 'op-1',
        activeInvocationId: 'inv-1',
        compileId: 'compile-1',
        planHash: 'plan-hash-1',
        selectedProfileHash: 'pf-1',
        runtimeStateJson: { kind: 'harness-broker', status: 'ready' },
        createdAt: now,
        updatedAt: now,
      })
      expect(runtime.controllerKind).toBe('harness-broker')
      expect(runtime.activeInvocationId).toBe('inv-1')
      expect(runtime.runtimeStateJson).toEqual({ kind: 'harness-broker', status: 'ready' })

      const reloaded = db.runtimes.getByRuntimeId('rt-broker')
      expect(reloaded?.compileId).toBe('compile-1')
      expect(reloaded?.planHash).toBe('plan-hash-1')
    } finally {
      db.close()
    }
  })
})
