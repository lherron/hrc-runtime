// RED tests for T-01786 (T-01783 Workstream B) — HRC lifecycle persistence.
//
// These cover the NEW persistence surface introduced by migrations:
//   0019_lifecycle_policy_audit   — lifecycle_policies audit table + broker_invocations.lifecycle_policy_hash
//   0020_runtime_lifecycle_state  — lifecycle columns on runtimes AND broker_invocations
//
// They are EXPECTED TO FAIL until the implementer adds the migrations, the
// repository methods, and the contract-type fields. RED is correct here.
//
// Run with: TMPDIR=/tmp bun run --filter hrc-store-sqlite test

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcDatabase } from '../database.js'
import { openHrcDatabase } from '../index'
import { phase1Migrations } from '../migrations.js'
let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:lifecycle:task:${key}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-lifecycle-test-'))
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

function tableColumns(db: ReturnType<typeof openHrcDatabase>, table: string): string[] {
  return db.sqlite
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
}

/**
 * Apply every migration with an id BEFORE 0019 (i.e. through
 * 0018_runs_dispatched_input_id) so we get a fully populated pre-lifecycle DB.
 * Robust against the number of migrations added after 0018 — filters by id
 * rather than slicing a fixed count off the tail.
 */
function createPre0019Database(): ReturnType<typeof createHrcDatabase> {
  const sqlite = createHrcDatabase(dbPath)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const preLifecycle = phase1Migrations.filter((m) => m.id < '0019')
  for (const migration of preLifecycle) {
    migration.apply(sqlite)
    sqlite
      .prepare('INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)')
      .run(migration.id, ts())
  }
  return sqlite
}

// ── 0019/0020/0021 migration shape ────────────────────────────────────────
describe('lifecycle persistence migrations (0019/0020/0021)', () => {
  it('retires the policy table while retaining invocation lifecycle state', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0126_plan_policy_table_removal')
      expect(tableExists(db, 'lifecycle_policies')).toBe(false)
      expect(tableExists(db, 'compiled_runtime_plans')).toBe(false)
      expect(tableColumns(db, 'broker_invocations')).toContain('lifecycle_policy_hash')
    } finally {
      db.close()
    }
  })

  it('adds lifecycle_policy_hash + lifecycle-state columns to runtimes AND broker_invocations', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const lifecycleStateCols = [
        'lifecycle_policy_hash',
        'current_harness_generation',
        'current_turn_attempt',
        'lifecycle_terminal_reason',
        'last_lifecycle_escalation_json',
      ]
      const runtimeCols = tableColumns(db, 'runtimes')
      const invocationCols = tableColumns(db, 'broker_invocations')
      for (const col of lifecycleStateCols) {
        if (col === 'lifecycle_terminal_reason') expect(runtimeCols).toContain(col)
        else expect(runtimeCols).not.toContain(col)
        expect(invocationCols).toContain(col)
      }
    } finally {
      db.close()
    }
  })

  it('applies idempotently over a populated 0018 db and existing rows survive', () => {
    const sqlite = createPre0019Database()
    try {
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
    } finally {
      sqlite.close()
    }

    // Re-open: triggers 0019/0020/0021 over the populated 0018 db.
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0019_lifecycle_policy_audit')
      expect(db.migrations.applied).toContain('0020_runtime_lifecycle_state')
      expect(db.migrations.applied).toContain('0021_permission_identity')

      const runtime = db.runtimes.getByRuntimeId('rt-legacy')
      expect(runtime).not.toBeNull()
      expect(runtime?.status).toBe('ready')
      // New lifecycle columns project to undefined on legacy rows.
      expect(runtime?.lifecyclePolicyHash).toBeUndefined()
      expect(runtime?.currentHarnessGeneration).toBeUndefined()
      expect(runtime?.currentTurnAttempt).toBeUndefined()
      expect(runtime?.lifecycleTerminalReason).toBeUndefined()
      expect(runtime?.lastLifecycleEscalationJson).toBeUndefined()
    } finally {
      db.close()
    }

    // Re-opening a third time is a no-op (migrations already recorded).
    const reopened = openHrcDatabase(dbPath)
    try {
      expect(reopened.runtimes.getByRuntimeId('rt-legacy')?.status).toBe('ready')
    } finally {
      reopened.close()
    }
  })
})

describe('invocation policy hash round-trip', () => {
  it('persists the invocation policy hash without a policy table', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()

      const inv = db.brokerInvocations.insert({
        invocationId: 'inv-link',
        operationId: 'op-link',
        runtimeId: 'rt-link',
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        invocationState: 'starting',
        capabilitiesJson: JSON.stringify({ input: true }),
        specHash: 'spec-1',
        startRequestHash: 'sr-1',
        selectedProfileHash: 'pf-1',
        lifecyclePolicyHash: 'lph-link-1',
        createdAt: now,
        updatedAt: now,
      })
      expect(inv.lifecyclePolicyHash).toBe('lph-link-1')

      const reloaded = db.brokerInvocations.getByInvocationId('inv-link')
      expect(reloaded?.lifecyclePolicyHash).toBe('lph-link-1')
    } finally {
      db.close()
    }
  })
})

// ── lifecycle-state columns on runtimes + broker_invocations ───────────────
describe('runtime + invocation lifecycle-state round-trip', () => {
  it('persists lifecycle columns on broker_invocations via insert and update', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      const escalationJson = JSON.stringify({ kind: 'permission-deny', at: now })
      const inv = db.brokerInvocations.insert({
        invocationId: 'inv-lc',
        operationId: 'op-lc',
        runtimeId: 'rt-lc',
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({ input: true }),
        specHash: 'spec-1',
        startRequestHash: 'sr-1',
        selectedProfileHash: 'pf-1',
        lifecyclePolicyHash: 'lph-inv',
        currentHarnessGeneration: 1,
        currentTurnAttempt: 3,
        lastLifecycleEscalationJson: escalationJson,
        createdAt: now,
        updatedAt: now,
      })
      expect(inv.currentHarnessGeneration).toBe(1)
      expect(inv.currentTurnAttempt).toBe(3)
      expect(inv.lastLifecycleEscalationJson).toBe(escalationJson)

      const updated = db.brokerInvocations.update('inv-lc', {
        currentTurnAttempt: 4,
        lifecycleTerminalReason: 'escalation-pause',
        updatedAt: ts(),
      })
      expect(updated?.currentTurnAttempt).toBe(4)
      expect(updated?.lifecycleTerminalReason).toBe('escalation-pause')
      expect(updated?.lifecyclePolicyHash).toBe('lph-inv')

      const reloaded = db.brokerInvocations.getByInvocationId('inv-lc')
      expect(reloaded?.currentHarnessGeneration).toBe(1)
      expect(reloaded?.currentTurnAttempt).toBe(4)
      expect(reloaded?.lifecycleTerminalReason).toBe('escalation-pause')
    } finally {
      db.close()
    }
  })
})
