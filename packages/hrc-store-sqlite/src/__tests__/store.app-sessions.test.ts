/**
 * RED/GREEN tests for AppSessionRepository (T-00971 / Phase 5)
 *
 * Tests the app_sessions table through AppSessionRepository:
 *   - Phase 5 migration creates the app_sessions table
 *   - create() inserts an app-owned session record
 *   - findByKey() retrieves by (appId, appSessionKey)
 *   - findByHostSession() returns app sessions linked to a host session
 *   - update() patches mutable fields (label, metadata)
 *   - bulkApply() upserts a batch — inserts new, updates existing, marks missing as removed
 *
 * Pass conditions for Larry (T-00971):
 *   1. openHrcDatabase(path).appSessions is defined
 *   2. Phase 5 migration '0003_phase5_app_sessions_and_bridges' is applied
 *   3. create() inserts and returns HrcAppSessionRecord with correct fields
 *   4. create() links to a valid hostSessionId FK
 *   5. findByKey() returns null for non-existent (appId, appSessionKey)
 *   6. findByKey() returns the record after create()
 *   7. findByHostSession() returns all app sessions for a hostSessionId
 *   8. findByHostSession() returns empty array for unknown hostSessionId
 *   9. update() patches label and metadata, preserves other fields
 *  10. bulkApply() inserts new records not previously present
 *  11. bulkApply() updates existing records when key matches
 *  12. bulkApply() marks records as removed when absent from the apply set
 *  13. bulkApply() is idempotent — re-applying same set produces same result
 *  14. bulkApply() scoped to appId — does not touch records from other apps
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RED GATE: imports will fail until the AppSessionRepository and Phase 5 migration are wired
import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-appsession-store-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * Helper: seed the prerequisite session row that app_sessions FK points to.
 */
function seedSession(
  db: HrcDatabase,
  opts: {
    hostSessionId: string
    scopeRef?: string
    laneRef?: string
    generation?: number
  }
) {
  const now = ts()
  db.sessions.insert({
    hostSessionId: opts.hostSessionId,
    scopeRef: opts.scopeRef ?? 'test-scope',
    laneRef: opts.laneRef ?? 'default',
    generation: opts.generation ?? 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

// ---------------------------------------------------------------------------
// 1. Migration and database wiring
// ---------------------------------------------------------------------------
describe('Phase 5 migration — app_sessions', () => {
  it('applies the Phase 5 migration', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0003_phase5_app_sessions_and_bridges')
    } finally {
      db.close()
    }
  })

  it('exposes appSessions repository on HrcDatabase', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.appSessions).toBeDefined()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. AppSessionRepository.create()
// ---------------------------------------------------------------------------
describe('AppSessionRepository.create', () => {
  it('inserts a new app session and returns the record', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      const result = db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-session-001',
        hostSessionId: 'hsid-1',
        label: 'Main workspace',
        metadata: { color: 'blue' },
        createdAt: now,
        updatedAt: now,
      })

      expect(result.appId).toBe('workbench')
      expect(result.appSessionKey).toBe('wb-session-001')
      expect(result.hostSessionId).toBe('hsid-1')
      expect(result.label).toBe('Main workspace')
      expect(result.metadata).toEqual({ color: 'blue' })
      expect(result.removedAt).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('round-trips with undefined optional fields', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      const result = db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-minimal',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })

      expect(result.label).toBeUndefined()
      expect(result.metadata).toBeUndefined()
      expect(result.removedAt).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. AppSessionRepository.findByKey()
// ---------------------------------------------------------------------------
describe('AppSessionRepository.findByKey', () => {
  it('returns null for non-existent key', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.appSessions.findByKey('workbench', 'nonexistent')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('returns the record after create()', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-find',
        hostSessionId: 'hsid-1',
        label: 'Findable',
        createdAt: now,
        updatedAt: now,
      })

      const found = db.appSessions.findByKey('workbench', 'wb-find')
      expect(found).not.toBeNull()
      expect(found!.appId).toBe('workbench')
      expect(found!.appSessionKey).toBe('wb-find')
      expect(found!.label).toBe('Findable')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. AppSessionRepository.findByHostSession()
// ---------------------------------------------------------------------------
describe('AppSessionRepository.findByHostSession', () => {
  it('returns all app sessions for a hostSessionId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-a',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-b',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })

      const results = db.appSessions.findByHostSession('hsid-1')
      expect(results.length).toBe(2)
      expect(results.map((r) => r.appSessionKey).sort()).toEqual(['wb-a', 'wb-b'])
    } finally {
      db.close()
    }
  })

  it('returns empty array for unknown hostSessionId', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.appSessions.findByHostSession('hsid-unknown')).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. AppSessionRepository.update()
// ---------------------------------------------------------------------------
describe('AppSessionRepository.update', () => {
  it('patches label and metadata, preserves other fields', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-update',
        hostSessionId: 'hsid-1',
        label: 'Original',
        createdAt: now,
        updatedAt: now,
      })

      const updated = db.appSessions.update('workbench', 'wb-update', {
        label: 'Renamed',
        metadata: { theme: 'dark' },
        updatedAt: ts(),
      })

      expect(updated).not.toBeNull()
      expect(updated!.label).toBe('Renamed')
      expect(updated!.metadata).toEqual({ theme: 'dark' })
      expect(updated!.hostSessionId).toBe('hsid-1') // unchanged
      expect(updated!.appId).toBe('workbench') // unchanged
    } finally {
      db.close()
    }
  })

  it('returns null when updating non-existent key', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const result = db.appSessions.update('workbench', 'nonexistent', {
        label: 'Ghost',
        updatedAt: ts(),
      })
      expect(result).toBeNull()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. AppSessionRepository.bulkApply()
// ---------------------------------------------------------------------------
describe('AppSessionRepository.bulkApply', () => {
  it('inserts new records not previously present', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const result = db.appSessions.bulkApply('workbench', 'hsid-1', [
        { appSessionKey: 'wb-new-1', label: 'New One' },
        { appSessionKey: 'wb-new-2', label: 'New Two' },
      ])

      expect(result.inserted).toBe(2)
      expect(result.updated).toBe(0)
      expect(result.removed).toBe(0)

      const all = db.appSessions.findByHostSession('hsid-1')
      expect(all.length).toBe(2)
    } finally {
      db.close()
    }
  })

  it('updates existing records when key matches', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-existing',
        hostSessionId: 'hsid-1',
        label: 'Old Label',
        createdAt: now,
        updatedAt: now,
      })

      const result = db.appSessions.bulkApply('workbench', 'hsid-1', [
        { appSessionKey: 'wb-existing', label: 'Updated Label' },
      ])

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(1)
      expect(result.removed).toBe(0)

      const found = db.appSessions.findByKey('workbench', 'wb-existing')
      expect(found!.label).toBe('Updated Label')
    } finally {
      db.close()
    }
  })

  it('marks records as removed when absent from the apply set', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-keep',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'wb-remove',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })

      // Apply with only wb-keep — wb-remove should be marked removed
      const result = db.appSessions.bulkApply('workbench', 'hsid-1', [{ appSessionKey: 'wb-keep' }])

      expect(result.removed).toBe(1)

      const removed = db.appSessions.findByKey('workbench', 'wb-remove')
      expect(removed).not.toBeNull()
      expect(removed!.removedAt).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('is idempotent — re-applying same set produces same result', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const entries = [
        { appSessionKey: 'wb-idem-1', label: 'One' },
        { appSessionKey: 'wb-idem-2', label: 'Two' },
      ]

      db.appSessions.bulkApply('workbench', 'hsid-1', entries)
      const result2 = db.appSessions.bulkApply('workbench', 'hsid-1', entries)

      // Second apply should update existing, not insert
      expect(result2.inserted).toBe(0)
      expect(result2.updated).toBe(2)
      expect(result2.removed).toBe(0)
    } finally {
      db.close()
    }
  })

  it('is scoped to appId — does not touch records from other apps', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })

      const now = ts()
      db.appSessions.create({
        appId: 'other-app',
        appSessionKey: 'other-key',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })

      // bulkApply for 'workbench' should not remove 'other-app' records
      db.appSessions.bulkApply('workbench', 'hsid-1', [{ appSessionKey: 'wb-only' }])

      const otherRecord = db.appSessions.findByKey('other-app', 'other-key')
      expect(otherRecord).not.toBeNull()
      expect(otherRecord!.removedAt).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
