// RED tests for T-01786 (T-01783 Workstream B) — HRC lifecycle persistence.
//
// These cover the NEW persistence surface introduced by migrations:
//   0019_lifecycle_policy_audit   — lifecycle_policies audit table + broker_invocations.lifecycle_policy_hash
//   0020_runtime_lifecycle_state  — lifecycle columns on runtimes AND broker_invocations
//   0021_permission_identity      — generation-aware permission_decisions identity
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
// computePermissionIdentityKey is the stable canonical join the repo layer must
// expose (null gen/attempt normalized consistently). Imported here so the RED
// suite fails to resolve until it exists.
import { computePermissionIdentityKey } from '../repositories.js'

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

type IndexInfo = { name: string; unique: number; columns: string[] }

function indexes(db: ReturnType<typeof openHrcDatabase>, table: string): IndexInfo[] {
  return db.sqlite
    .query<{ name: string; unique: number }, []>(`PRAGMA index_list('${table}')`)
    .all()
    .map((idx) => ({
      name: idx.name,
      unique: idx.unique,
      columns: db.sqlite
        .query<{ name: string }, []>(`PRAGMA index_info('${idx.name}')`)
        .all()
        .map((c) => c.name),
    }))
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
  it('creates the lifecycle_policies audit table on a fresh db', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0019_lifecycle_policy_audit')
      expect(db.migrations.applied).toContain('0020_runtime_lifecycle_state')
      expect(db.migrations.applied).toContain('0021_permission_identity')

      expect(tableExists(db, 'lifecycle_policies')).toBe(true)
      const cols = tableColumns(db, 'lifecycle_policies')
      for (const col of [
        'policy_id',
        'lifecycle_policy_hash',
        'canonical_policy_json',
        'schema_version',
        'created_at',
      ]) {
        expect(cols).toContain(col)
      }

      // lifecycle_policy_hash is the PK / content fence.
      const pkCols = db.sqlite
        .query<{ name: string; pk: number }, []>('PRAGMA table_info(lifecycle_policies)')
        .all()
        .filter((r) => r.pk > 0)
        .map((r) => r.name)
      expect(pkCols).toEqual(['lifecycle_policy_hash'])
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
        expect(runtimeCols).toContain(col)
        expect(invocationCols).toContain(col)
      }
    } finally {
      db.close()
    }
  })

  it('makes permission_decisions generation-aware: identity-key PK/unique, composite unique, bare-id index retained', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const cols = tableColumns(db, 'permission_decisions')
      for (const col of [
        'permission_identity_key',
        'invocation_id',
        'harness_generation',
        'turn_attempt',
        'permission_request_id',
      ]) {
        expect(cols).toContain(col)
      }

      // permission_identity_key is the new PK.
      const pkCols = db.sqlite
        .query<{ name: string; pk: number }, []>('PRAGMA table_info(permission_decisions)')
        .all()
        .filter((r) => r.pk > 0)
        .map((r) => r.name)
      expect(pkCols).toEqual(['permission_identity_key'])

      const idx = indexes(db, 'permission_decisions')

      // Composite UNIQUE over (invocation_id, harness_generation, turn_attempt, permission_request_id).
      const hasComposite = idx.some(
        (i) =>
          i.unique === 1 &&
          i.columns.length === 4 &&
          i.columns[0] === 'invocation_id' &&
          i.columns[1] === 'harness_generation' &&
          i.columns[2] === 'turn_attempt' &&
          i.columns[3] === 'permission_request_id'
      )
      expect(hasComposite).toBe(true)

      // A NON-unique index on bare permission_request_id is retained for compat/diagnostics.
      const hasBareNonUnique = idx.some(
        (i) => i.unique === 0 && i.columns.length === 1 && i.columns[0] === 'permission_request_id'
      )
      expect(hasBareNonUnique).toBe(true)
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

      // A legacy permission_decisions row keyed only by the old PK (permission_request_id).
      sqlite
        .prepare(
          `INSERT INTO permission_decisions (
             permission_request_id, invocation_id, runtime_id, run_id, kind,
             subject_display_json, default_decision, decision, decided_by,
             policy_json, requested_at, decided_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'perm-legacy',
          'inv-legacy',
          'rt-legacy',
          null,
          'tool.exec',
          JSON.stringify({ tool: 'shell' }),
          'deny',
          'deny',
          'policy',
          JSON.stringify({ mode: 'default-deny' }),
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

      // Legacy permission row survives the PK rebuild and gets a backfilled
      // (non-empty) permission_identity_key; gen/attempt stay unset.
      const perm = db.permissionDecisions.getByPermissionRequestId('perm-legacy')
      expect(perm).not.toBeNull()
      expect(perm?.decision).toBe('deny')
      expect(typeof perm?.permissionIdentityKey).toBe('string')
      expect(perm?.permissionIdentityKey?.length ?? 0).toBeGreaterThan(0)
      expect(perm?.harnessGeneration).toBeUndefined()
      expect(perm?.turnAttempt).toBeUndefined()
    } finally {
      db.close()
    }

    // Re-opening a third time is a no-op (migrations already recorded).
    const reopened = openHrcDatabase(dbPath)
    try {
      expect(reopened.permissionDecisions.getByPermissionRequestId('perm-legacy')).not.toBeNull()
    } finally {
      reopened.close()
    }
  })
})

// ── lifecycle_policies audit round-trip ────────────────────────────────────
describe('lifecycle_policies audit repository round-trip', () => {
  it('inserts and looks up a policy by lifecycle_policy_hash, content-addressed', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      const canonical = JSON.stringify({ maxTurns: 50, escalation: { onDeny: 'pause' } })

      const policy = db.lifecyclePolicies.insert({
        policyId: 'route:agent-spaces:default',
        lifecyclePolicyHash: 'lph-abc123',
        canonicalPolicyJson: canonical,
        schemaVersion: 'lifecycle-policy/v1',
        createdAt: now,
      })
      expect(policy.policyId).toBe('route:agent-spaces:default')
      expect(policy.lifecyclePolicyHash).toBe('lph-abc123')
      expect(policy.canonicalPolicyJson).toBe(canonical)
      expect(policy.schemaVersion).toBe('lifecycle-policy/v1')

      const reloaded = db.lifecyclePolicies.getByPolicyHash('lph-abc123')
      expect(reloaded).not.toBeNull()
      expect(reloaded?.policyId).toBe('route:agent-spaces:default')
      expect(reloaded?.canonicalPolicyJson).toBe(canonical)

      // Content-addressed: same hash, different policy metadata is a no-op,
      // first stored canonical/metadata preserved (audit fence).
      const again = db.lifecyclePolicies.insert({
        policyId: 'route:agent-spaces:default',
        lifecyclePolicyHash: 'lph-abc123',
        canonicalPolicyJson: JSON.stringify({ maxTurns: 9999 }),
        schemaVersion: 'lifecycle-policy/v1',
        createdAt: ts(),
      })
      expect(again.canonicalPolicyJson).toBe(canonical)

      // Same policyId, DIFFERENT hash = a distinct audit row (version fence).
      const v2 = db.lifecyclePolicies.insert({
        policyId: 'route:agent-spaces:default',
        lifecyclePolicyHash: 'lph-def456',
        canonicalPolicyJson: JSON.stringify({ maxTurns: 75 }),
        schemaVersion: 'lifecycle-policy/v1',
        createdAt: ts(),
      })
      expect(v2.lifecyclePolicyHash).toBe('lph-def456')
      expect(db.lifecyclePolicies.getByPolicyHash('lph-def456')?.policyId).toBe(
        'route:agent-spaces:default'
      )
      // The original version is still independently retrievable.
      expect(db.lifecyclePolicies.getByPolicyHash('lph-abc123')).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('links broker_invocations to a lifecycle_policies row via lifecycle_policy_hash', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.lifecyclePolicies.insert({
        policyId: 'route:agent-spaces:default',
        lifecyclePolicyHash: 'lph-link-1',
        canonicalPolicyJson: JSON.stringify({ maxTurns: 50 }),
        schemaVersion: 'lifecycle-policy/v1',
        createdAt: now,
      })

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
  it('persists lifecycle columns on runtimes via insert and update', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-lc',
        scopeRef: scopeRef('lc'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const escalationJson = JSON.stringify({ kind: 'turn-limit', at: now })
      const runtime = db.runtimes.insert({
        runtimeId: 'rt-lc',
        hostSessionId: 'hsid-lc',
        scopeRef: scopeRef('lc'),
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        lifecyclePolicyHash: 'lph-rt',
        currentHarnessGeneration: 2,
        currentTurnAttempt: 5,
        lifecycleTerminalReason: undefined,
        lastLifecycleEscalationJson: escalationJson,
        createdAt: now,
        updatedAt: now,
      })
      expect(runtime.lifecyclePolicyHash).toBe('lph-rt')
      expect(runtime.currentHarnessGeneration).toBe(2)
      expect(runtime.currentTurnAttempt).toBe(5)
      expect(runtime.lastLifecycleEscalationJson).toBe(escalationJson)

      const reloaded = db.runtimes.getByRuntimeId('rt-lc')
      expect(reloaded?.currentHarnessGeneration).toBe(2)
      expect(reloaded?.currentTurnAttempt).toBe(5)
      expect(reloaded?.lifecyclePolicyHash).toBe('lph-rt')

      const updated = db.runtimes.update('rt-lc', {
        currentHarnessGeneration: 3,
        currentTurnAttempt: 0,
        lifecycleTerminalReason: 'turn-budget-exhausted',
        updatedAt: ts(),
      })
      expect(updated?.currentHarnessGeneration).toBe(3)
      expect(updated?.currentTurnAttempt).toBe(0)
      expect(updated?.lifecycleTerminalReason).toBe('turn-budget-exhausted')
      // Untouched lifecycle column survives the patch.
      expect(updated?.lastLifecycleEscalationJson).toBe(escalationJson)
    } finally {
      db.close()
    }
  })

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

// ── generation-aware permission identity ───────────────────────────────────
describe('permission_decisions generation-aware identity', () => {
  function baseDecision(overrides: Record<string, unknown>) {
    const now = ts()
    return {
      permissionRequestId: 'perm-req-1',
      invocationId: 'inv-perm',
      runtimeId: 'rt-perm',
      kind: 'tool.exec',
      subjectDisplayJson: JSON.stringify({ tool: 'shell' }),
      defaultDecision: 'deny',
      decision: 'allow',
      decidedBy: 'user',
      policyJson: JSON.stringify({ mode: 'ask' }),
      requestedAt: now,
      decidedAt: now,
      ...overrides,
    }
  }

  it('computes a stable permission_identity_key and looks up by it', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const inserted = db.permissionDecisions.insert(
        baseDecision({ harnessGeneration: 2, turnAttempt: 1 }) as never
      )

      const expectedKey = computePermissionIdentityKey({
        invocationId: 'inv-perm',
        harnessGeneration: 2,
        turnAttempt: 1,
        permissionRequestId: 'perm-req-1',
      })
      expect(inserted.permissionIdentityKey).toBe(expectedKey)

      const byKey = db.permissionDecisions.getByPermissionIdentityKey(expectedKey)
      expect(byKey).not.toBeNull()
      expect(byKey?.permissionRequestId).toBe('perm-req-1')
      expect(byKey?.harnessGeneration).toBe(2)
      expect(byKey?.turnAttempt).toBe(1)

      // Compat lookup by bare request id still resolves.
      const byReq = db.permissionDecisions.getByPermissionRequestId('perm-req-1')
      expect(byReq?.permissionIdentityKey).toBe(expectedKey)
    } finally {
      db.close()
    }
  })

  it('allows the same permission_request_id across different harness generations', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const gen1 = db.permissionDecisions.insert(
        baseDecision({ harnessGeneration: 1, turnAttempt: 0 }) as never
      )
      const gen2 = db.permissionDecisions.insert(
        baseDecision({ harnessGeneration: 2, turnAttempt: 0 }) as never
      )
      expect(gen1.permissionIdentityKey).not.toBe(gen2.permissionIdentityKey)

      // Both rows persist under the shared bare permission_request_id.
      const count = db.sqlite
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM permission_decisions WHERE permission_request_id = ?'
        )
        .get('perm-req-1')
      expect(count?.n).toBe(2)
    } finally {
      db.close()
    }
  })

  it('rejects a duplicate identity (same invocation/gen/attempt/request id)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      db.permissionDecisions.insert(baseDecision({ harnessGeneration: 1, turnAttempt: 0 }) as never)
      expect(() =>
        db.permissionDecisions.insert(
          baseDecision({ harnessGeneration: 1, turnAttempt: 0, decision: 'deny' }) as never
        )
      ).toThrow()
    } finally {
      db.close()
    }
  })

  it('fences duplicates even when generation/attempt are null (identity-key normalizes null)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      // SQLite treats NULLs as distinct in a composite UNIQUE, so the
      // permission_identity_key (null normalized to a sentinel) is what
      // actually enforces uniqueness here.
      db.permissionDecisions.insert(
        baseDecision({ harnessGeneration: undefined, turnAttempt: undefined }) as never
      )
      expect(() =>
        db.permissionDecisions.insert(
          baseDecision({
            harnessGeneration: undefined,
            turnAttempt: undefined,
            decision: 'deny',
          }) as never
        )
      ).toThrow()

      const key = computePermissionIdentityKey({
        invocationId: 'inv-perm',
        harnessGeneration: undefined,
        turnAttempt: undefined,
        permissionRequestId: 'perm-req-1',
      })
      expect(typeof key).toBe('string')
      expect(key.length).toBeGreaterThan(0)
      expect(db.permissionDecisions.getByPermissionIdentityKey(key)).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('treats null and zero generation/attempt as distinct identities', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const nullKey = computePermissionIdentityKey({
        invocationId: 'inv-perm',
        harnessGeneration: undefined,
        turnAttempt: undefined,
        permissionRequestId: 'perm-req-1',
      })
      const zeroKey = computePermissionIdentityKey({
        invocationId: 'inv-perm',
        harnessGeneration: 0,
        turnAttempt: 0,
        permissionRequestId: 'perm-req-1',
      })
      expect(nullKey).not.toBe(zeroKey)
    } finally {
      db.close()
    }
  })
})
