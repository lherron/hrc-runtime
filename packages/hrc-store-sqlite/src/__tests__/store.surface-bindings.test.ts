/**
 * RED/GREEN tests for SurfaceBindingRepository (T-00970 / Phase 4)
 *
 * Tests the surface_bindings table through SurfaceBindingRepository:
 *   - Phase 4 migration creates the surface_bindings table
 *   - bind() inserts a new active binding
 *   - bind() upserts (rebind) when surface already bound
 *   - unbind() sets unbound_at and optional reason
 *   - findBySurface() returns binding by (surfaceKind, surfaceId)
 *   - findByRuntime() returns only active bindings for a runtime
 *   - listActive() returns all active (unbound_at IS NULL) bindings
 *   - Optional fields (windowId, tabId, paneId) round-trip correctly
 *
 * Pass conditions for Larry (T-00970):
 *   1. openHrcDatabase(path).surfaceBindings is defined
 *   2. Phase 4 migration '0002_phase4_surface_bindings' is applied
 *   3. bind() inserts and returns HrcSurfaceBindingRecord with correct fields
 *   4. bind() on same (surfaceKind, surfaceId) upserts — updates runtimeId, clears unboundAt
 *   5. unbind() sets unboundAt and reason on existing binding
 *   6. unbind() on unknown surface returns null
 *   7. findBySurface() returns null for non-existent surface
 *   8. findBySurface() returns the binding after bind()
 *   9. findByRuntime() returns only active (unbound_at IS NULL) bindings for that runtimeId
 *  10. findByRuntime() excludes unbound bindings
 *  11. listActive() returns all active bindings across runtimes
 *  12. listActive() excludes unbound bindings
 *  13. Optional windowId/tabId/paneId round-trip as undefined when omitted
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RED GATE: imports will fail until the repository and database are wired for Phase 4
import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-surface-store-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * Helper: seed the prerequisite session + runtime rows that surface_bindings
 * foreign keys point to.  Returns the IDs so tests can reference them.
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

  db.sessions.create({
    hostSessionId: opts.hostSessionId,
    scopeRef,
    laneRef,
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })

  db.runtimes.create({
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

// ---------------------------------------------------------------------------
// 1. Migration and database wiring
// ---------------------------------------------------------------------------
describe('Phase 4 migration', () => {
  it('applies the surface_bindings migration', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0002_phase4_surface_bindings')
    } finally {
      db.close()
    }
  })

  it('exposes surfaceBindings repository on HrcDatabase', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.surfaceBindings).toBeDefined()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. SurfaceBindingRepository.bind()
// ---------------------------------------------------------------------------
describe('SurfaceBindingRepository.bind', () => {
  it('inserts a new binding and returns the record', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      const now = ts()
      const result = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-001',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: now,
      })

      expect(result.surfaceKind).toBe('ghostty')
      expect(result.surfaceId).toBe('surf-001')
      expect(result.hostSessionId).toBe('hsid-1')
      expect(result.runtimeId).toBe('rt-1')
      expect(result.generation).toBe(1)
      expect(result.boundAt).toBe(now)
      expect(result.unboundAt).toBeUndefined()
      expect(result.reason).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('round-trips optional windowId, tabId, paneId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      const result = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-002',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        windowId: 'win-1',
        tabId: 'tab-1',
        paneId: 'pane-1',
        boundAt: ts(),
      })

      expect(result.windowId).toBe('win-1')
      expect(result.tabId).toBe('tab-1')
      expect(result.paneId).toBe('pane-1')
    } finally {
      db.close()
    }
  })

  it('returns undefined for omitted optional fields', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      const result = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-003',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      expect(result.windowId).toBeUndefined()
      expect(result.tabId).toBeUndefined()
      expect(result.paneId).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('upserts when the same surface is bound again (rebind)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-2', runtimeId: 'rt-2' })

      const t1 = ts()
      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-rebind',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: t1,
      })

      // Rebind to a different runtime
      const t2 = ts()
      const rebound = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-rebind',
        hostSessionId: 'hsid-2',
        runtimeId: 'rt-2',
        generation: 1,
        boundAt: t2,
      })

      expect(rebound.runtimeId).toBe('rt-2')
      expect(rebound.hostSessionId).toBe('hsid-2')
      expect(rebound.boundAt).toBe(t2)
      expect(rebound.unboundAt).toBeUndefined() // upsert clears unboundAt
      expect(rebound.reason).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('clears unboundAt on rebind of a previously unbound surface', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-reactivate',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      // Unbind it
      db.surfaceBindings.unbind('ghostty', 'surf-reactivate', ts(), 'detached')

      const unbound = db.surfaceBindings.findBySurface('ghostty', 'surf-reactivate')
      expect(unbound!.unboundAt).toBeDefined()

      // Rebind — should clear unboundAt
      const rebound = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-reactivate',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      expect(rebound.unboundAt).toBeUndefined()
      expect(rebound.reason).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. SurfaceBindingRepository.unbind()
// ---------------------------------------------------------------------------
describe('SurfaceBindingRepository.unbind', () => {
  it('sets unboundAt and reason on an existing binding', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-unbind',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      const now = ts()
      const result = db.surfaceBindings.unbind('ghostty', 'surf-unbind', now, 'user-detach')

      expect(result).not.toBeNull()
      expect(result!.unboundAt).toBe(now)
      expect(result!.reason).toBe('user-detach')
    } finally {
      db.close()
    }
  })

  it('returns null for an unknown surface', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const result = db.surfaceBindings.unbind('ghostty', 'nonexistent', ts())
      expect(result).toBeNull()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. SurfaceBindingRepository.findBySurface()
// ---------------------------------------------------------------------------
describe('SurfaceBindingRepository.findBySurface', () => {
  it('returns null for non-existent surface', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.surfaceBindings.findBySurface('ghostty', 'missing')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('returns the binding after bind()', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      const now = ts()
      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-find',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: now,
      })

      const found = db.surfaceBindings.findBySurface('ghostty', 'surf-find')
      expect(found).not.toBeNull()
      expect(found!.surfaceKind).toBe('ghostty')
      expect(found!.surfaceId).toBe('surf-find')
      expect(found!.runtimeId).toBe('rt-1')
    } finally {
      db.close()
    }
  })

  it('returns unbound binding too (findBySurface does not filter by active)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-unbound-find',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      db.surfaceBindings.unbind('ghostty', 'surf-unbound-find', ts(), 'gone')

      const found = db.surfaceBindings.findBySurface('ghostty', 'surf-unbound-find')
      expect(found).not.toBeNull()
      expect(found!.unboundAt).toBeDefined()
      expect(found!.reason).toBe('gone')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. SurfaceBindingRepository.findByRuntime()
// ---------------------------------------------------------------------------
describe('SurfaceBindingRepository.findByRuntime', () => {
  it('returns active bindings for a given runtimeId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-a',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })
      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-b',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      const results = db.surfaceBindings.findByRuntime('rt-1')
      expect(results.length).toBe(2)
      expect(results.map((r) => r.surfaceId).sort()).toEqual(['surf-a', 'surf-b'])
    } finally {
      db.close()
    }
  })

  it('excludes unbound bindings', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-active',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })
      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-gone',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      db.surfaceBindings.unbind('ghostty', 'surf-gone', ts())

      const results = db.surfaceBindings.findByRuntime('rt-1')
      expect(results.length).toBe(1)
      expect(results[0].surfaceId).toBe('surf-active')
    } finally {
      db.close()
    }
  })

  it('returns empty array for unknown runtimeId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.surfaceBindings.findByRuntime('rt-nonexistent')).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. SurfaceBindingRepository.listActive()
// ---------------------------------------------------------------------------
describe('SurfaceBindingRepository.listActive', () => {
  it('returns all active bindings across runtimes', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-2', runtimeId: 'rt-2' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-1',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })
      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-2',
        hostSessionId: 'hsid-2',
        runtimeId: 'rt-2',
        generation: 1,
        boundAt: ts(),
      })

      const active = db.surfaceBindings.listActive()
      expect(active.length).toBe(2)
    } finally {
      db.close()
    }
  })

  it('excludes unbound bindings', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSessionAndRuntime(db, { hostSessionId: 'hsid-1', runtimeId: 'rt-1' })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-still-active',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })
      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'surf-removed',
        hostSessionId: 'hsid-1',
        runtimeId: 'rt-1',
        generation: 1,
        boundAt: ts(),
      })

      db.surfaceBindings.unbind('ghostty', 'surf-removed', ts())

      const active = db.surfaceBindings.listActive()
      expect(active.length).toBe(1)
      expect(active[0].surfaceId).toBe('surf-still-active')
    } finally {
      db.close()
    }
  })

  it('returns empty array when no bindings exist', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.surfaceBindings.listActive()).toEqual([])
    } finally {
      db.close()
    }
  })
})
