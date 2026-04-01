/**
 * RED/GREEN tests for LocalBridgeRepository (T-00971 / Phase 5)
 *
 * Tests the local_bridges table through LocalBridgeRepository:
 *   - Phase 5 migration creates the local_bridges table
 *   - create() inserts a new bridge target record
 *   - findByTarget() retrieves by (transport, target)
 *   - findById() retrieves by bridgeId
 *   - listActive() returns all bridges where closedAt IS NULL
 *   - close() sets closedAt on a bridge
 *   - Fence columns (expectedHostSessionId, expectedGeneration) round-trip correctly
 *
 * Pass conditions for Larry (T-00971):
 *   1. openHrcDatabase(path).localBridges is defined
 *   2. Phase 5 migration '0003_phase5_app_sessions_and_bridges' is applied
 *   3. create() inserts and returns HrcLocalBridgeRecord with correct fields
 *   4. create() links to a valid hostSessionId FK
 *   5. findByTarget() returns null for non-existent (transport, target)
 *   6. findByTarget() returns the record after create()
 *   7. findById() returns null for non-existent bridgeId
 *   8. findById() returns the record after create()
 *   9. listActive() returns only bridges where closedAt IS NULL
 *  10. listActive() excludes closed bridges
 *  11. close() sets closedAt on an existing bridge
 *  12. close() returns null for unknown bridgeId
 *  13. expectedHostSessionId and expectedGeneration round-trip as fence columns
 *  14. Bridge with mismatched fence values can be detected (store level)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RED GATE: imports will fail until LocalBridgeRepository and Phase 5 migration are wired
import { createHrcDatabase } from '../database.js'
import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'
import { phase1Migrations } from '../migrations.js'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-bridge-store-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * Helper: seed prerequisite session + runtime rows for bridge FK constraints.
 */
function seedSessionAndRuntime(
  db: HrcDatabase,
  opts: {
    hostSessionId: string
    runtimeId: string
    scopeRef?: string
    laneRef?: string
    generation?: number
  }
) {
  const now = ts()
  const scopeRef = opts.scopeRef ?? 'test-scope'
  const laneRef = opts.laneRef ?? 'default'
  const generation = opts.generation ?? 1

  db.sessions.insert({
    hostSessionId: opts.hostSessionId,
    scopeRef,
    laneRef,
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })

  db.runtimes.insert({
    runtimeId: opts.runtimeId,
    hostSessionId: opts.hostSessionId,
    scopeRef,
    laneRef,
    generation,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
}

function getTableIndexColumns(db: HrcDatabase, tableName: string, indexName: string): string[] {
  const indexes = db.sqlite.query<{ name: string }, []>(`PRAGMA index_list(${tableName})`).all()

  const index = indexes.find((candidate) => candidate.name === indexName)
  expect(index).toBeDefined()

  return db.sqlite
    .query<{ name: string }, []>(`PRAGMA index_info(${indexName})`)
    .all()
    .map((column) => column.name)
}

// ---------------------------------------------------------------------------
// 1. Migration and database wiring
// ---------------------------------------------------------------------------
describe('Phase 5 migration — local_bridges', () => {
  it('applies the Phase 5 migration', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0003_phase5_app_sessions_and_bridges')
    } finally {
      db.close()
    }
  })

  it('exposes localBridges repository on HrcDatabase', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.localBridges).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('creates the runtime_id lookup index for local_bridges', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(getTableIndexColumns(db, 'local_bridges', 'idx_local_bridges_runtime_id')).toEqual([
        'runtime_id',
      ])
    } finally {
      db.close()
    }
  })

  it('backfills the runtime_id lookup index for databases already at phase 5', () => {
    const sqlite = createHrcDatabase(dbPath)
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS hrc_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `)

      for (const migration of phase1Migrations.slice(0, 3)) {
        migration.apply(sqlite)
        sqlite
          .prepare('INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)')
          .run(migration.id, ts())
      }
    } finally {
      sqlite.close()
    }

    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0004_phase6_local_bridges_runtime_id_index')
      expect(getTableIndexColumns(db, 'local_bridges', 'idx_local_bridges_runtime_id')).toEqual([
        'runtime_id',
      ])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. LocalBridgeRepository.create()
// ---------------------------------------------------------------------------
describe('LocalBridgeRepository.create', () => {
  it('inserts a new bridge and returns the record', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      const now = ts()
      const result = db.localBridges.create({
        bridgeId: 'br-001',
        transport: 'legacy-agentchat',
        target: 'smokey@agent-spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        expectedHostSessionId: 'hsid-1',
        expectedGeneration: 1,
        createdAt: now,
      })

      expect(result.bridgeId).toBe('br-001')
      expect(result.transport).toBe('legacy-agentchat')
      expect(result.target).toBe('smokey@agent-spaces')
      expect(result.hostSessionId).toBe('hsid-1')
      expect(result.runtimeId).toBe('rt-1')
      expect(result.expectedHostSessionId).toBe('hsid-1')
      expect(result.expectedGeneration).toBe(1)
      expect(result.closedAt).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('allows optional fence columns to be undefined', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      const now = ts()
      const result = db.localBridges.create({
        bridgeId: 'br-nofence',
        transport: 'legacy-agentchat',
        target: 'larry@agent-spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: now,
      })

      expect(result.expectedHostSessionId).toBeUndefined()
      expect(result.expectedGeneration).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. LocalBridgeRepository.findByTarget()
// ---------------------------------------------------------------------------
describe('LocalBridgeRepository.findByTarget', () => {
  it('returns null for non-existent target', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.localBridges.findByTarget('legacy-agentchat', 'nobody@nowhere')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('returns the record after create()', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.localBridges.create({
        bridgeId: 'br-find',
        transport: 'legacy-agentchat',
        target: 'curly@agent-spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })

      const found = db.localBridges.findByTarget('legacy-agentchat', 'curly@agent-spaces')
      expect(found).not.toBeNull()
      expect(found!.bridgeId).toBe('br-find')
      expect(found!.target).toBe('curly@agent-spaces')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. LocalBridgeRepository.findById()
// ---------------------------------------------------------------------------
describe('LocalBridgeRepository.findById', () => {
  it('returns null for non-existent bridgeId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.localBridges.findById('br-missing')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('returns the record after create()', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.localBridges.create({
        bridgeId: 'br-byid',
        transport: 'legacy-agentchat',
        target: 'animata@agent-spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })

      const found = db.localBridges.findById('br-byid')
      expect(found).not.toBeNull()
      expect(found!.bridgeId).toBe('br-byid')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. LocalBridgeRepository.listActive()
// ---------------------------------------------------------------------------
describe('LocalBridgeRepository.listActive', () => {
  it('returns only bridges where closedAt IS NULL', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.localBridges.create({
        bridgeId: 'br-active-1',
        transport: 'legacy-agentchat',
        target: 'agent-a@spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })
      db.localBridges.create({
        bridgeId: 'br-active-2',
        transport: 'legacy-agentchat',
        target: 'agent-b@spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })

      const active = db.localBridges.listActive()
      expect(active.length).toBe(2)
    } finally {
      db.close()
    }
  })

  it('excludes closed bridges', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.localBridges.create({
        bridgeId: 'br-open',
        transport: 'legacy-agentchat',
        target: 'open@spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })
      db.localBridges.create({
        bridgeId: 'br-closed',
        transport: 'legacy-agentchat',
        target: 'closed@spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })

      db.localBridges.close('br-closed', ts())

      const active = db.localBridges.listActive()
      expect(active.length).toBe(1)
      expect(active[0].bridgeId).toBe('br-open')
    } finally {
      db.close()
    }
  })

  it('returns empty array when no bridges exist', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.localBridges.listActive()).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. LocalBridgeRepository.close()
// ---------------------------------------------------------------------------
describe('LocalBridgeRepository.close', () => {
  it('sets closedAt on an existing bridge', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.localBridges.create({
        bridgeId: 'br-toclose',
        transport: 'legacy-agentchat',
        target: 'closing@spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        createdAt: ts(),
      })

      const now = ts()
      const result = db.localBridges.close('br-toclose', now)
      expect(result).not.toBeNull()
      expect(result!.closedAt).toBe(now)
    } finally {
      db.close()
    }
  })

  it('returns null for unknown bridgeId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const result = db.localBridges.close('br-nonexistent', ts())
      expect(result).toBeNull()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Fence columns round-trip
// ---------------------------------------------------------------------------
describe('fence columns', () => {
  it('expectedHostSessionId and expectedGeneration round-trip correctly', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1', generation: 3 })

      db.localBridges.create({
        bridgeId: 'br-fenced',
        transport: 'legacy-agentchat',
        target: 'fenced@spaces',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        expectedHostSessionId: 'hsid-1',
        expectedGeneration: 3,
        createdAt: ts(),
      })

      const found = db.localBridges.findById('br-fenced')
      expect(found).not.toBeNull()
      expect(found!.expectedHostSessionId).toBe('hsid-1')
      expect(found!.expectedGeneration).toBe(3)
    } finally {
      db.close()
    }
  })
})
