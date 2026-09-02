import { describe, expect, it } from 'bun:test'

import {
  createStoreTestFixture,
  openHrcDatabase,
  testScopeRef,
  testSessionRef,
  ts,
} from './store.fixture'

const fixture = createStoreTestFixture()
import type { HrcContinuationRef, HrcRuntimeIntent, HrcSessionRecord } from './store.fixture'

describe('openHrcDatabase', () => {
  it('opens a database and applies migrations', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db).toBeDefined()
      expect(db.migrations.applied.length).toBeGreaterThan(0)
      expect(db.migrations.applied).toContain('0053_continuation_reuse_state')
      // All repositories must be present
      expect(db.continuities).toBeDefined()
      expect(db.sessions).toBeDefined()
      expect(db.runtimes).toBeDefined()
      expect(db.runs).toBeDefined()
      expect(db.launches).toBeDefined()
      expect(db.events).toBeDefined()
      expect(db.surfaceBindings).toBeDefined()
      expect(db.runtimeBuffers).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('enables WAL mode', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const result = db.sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(result.journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('enables foreign keys', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const result = db.sqlite.query('PRAGMA foreign_keys').get() as { foreign_keys: number }
      expect(result.foreign_keys).toBe(1)
    } finally {
      db.close()
    }
  })

  it('sets busy_timeout', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const result = db.sqlite.query('PRAGMA busy_timeout').get() as {
        busy_timeout?: number
        timeout?: number
      }
      expect(result.busy_timeout ?? result.timeout).toBe(5000)
    } finally {
      db.close()
    }
  })

  it('accepts a bounded busy_timeout override', () => {
    const db = openHrcDatabase(fixture.dbPath, { busyTimeoutMs: 125 })
    try {
      const result = db.sqlite.query('PRAGMA busy_timeout').get() as {
        busy_timeout?: number
        timeout?: number
      }
      expect(result.busy_timeout ?? result.timeout).toBe(125)
    } finally {
      db.close()
    }
  })

  it('is idempotent — opening twice on the same file succeeds', () => {
    const db1 = openHrcDatabase(fixture.dbPath)
    db1.close()
    const db2 = openHrcDatabase(fixture.dbPath)
    try {
      expect(db2.migrations.applied.length).toBeGreaterThan(0)
    } finally {
      db2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. ContinuityRepository
// ---------------------------------------------------------------------------
describe('ContinuityRepository', () => {
  it('upserts and finds a continuity record', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const record = db.continuities.upsert({
        sessionRef: testSessionRef('continuity'),
        scopeRef: testScopeRef('continuity'),
        laneRef: 'default',
        activeHostSessionId: 'hsid-001',
        updatedAt: ts(),
      })
      expect(record.scopeRef).toBe(testScopeRef('continuity'))
      expect(record.laneRef).toBe('default')
      expect(record.activeHostSessionId).toBe('hsid-001')

      const found = db.continuities.getByKey(testScopeRef('continuity'), 'default')
      expect(found).not.toBeNull()
      expect(found!.activeHostSessionId).toBe('hsid-001')
    } finally {
      db.close()
    }
  })

  it('upsert replaces activeHostSessionId on conflict', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.continuities.upsert({
        sessionRef: testSessionRef('continuity'),
        scopeRef: testScopeRef('continuity'),
        laneRef: 'default',
        activeHostSessionId: 'hsid-001',
        updatedAt: ts(),
      })
      db.continuities.upsert({
        sessionRef: testSessionRef('continuity'),
        scopeRef: testScopeRef('continuity'),
        laneRef: 'default',
        activeHostSessionId: 'hsid-002',
        updatedAt: ts(),
      })
      const found = db.continuities.getByKey(testScopeRef('continuity'), 'default')
      expect(found!.activeHostSessionId).toBe('hsid-002')
    } finally {
      db.close()
    }
  })

  it('returns null for unknown ref', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const found = db.continuities.getByKey('nonexistent', 'nope')
      expect(found).toBeNull()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. SessionRepository
// ---------------------------------------------------------------------------
describe('SessionRepository', () => {
  it('creates and retrieves a session by hostSessionId', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      const session: HrcSessionRecord = {
        hostSessionId: 'hsid-100',
        scopeRef: testScopeRef('scope-a'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      }
      const created = db.sessions.insert(session)
      expect(created.hostSessionId).toBe('hsid-100')

      const found = db.sessions.getByHostSessionId('hsid-100')
      expect(found).not.toBeNull()
      expect(found!.generation).toBe(1)
      expect(found!.status).toBe('active')
    } finally {
      db.close()
    }
  })

  it('lists sessions by scopeRef and laneRef', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-200',
        scopeRef: testScopeRef('scope-b'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.sessions.insert({
        hostSessionId: 'hsid-201',
        scopeRef: testScopeRef('scope-b'),
        laneRef: 'default',
        generation: 2,
        status: 'active',
        priorHostSessionId: 'hsid-200',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      const list = db.sessions.listByScopeRef(testScopeRef('scope-b'), 'default')
      expect(list.length).toBe(2)
    } finally {
      db.close()
    }
  })

  it('updates session status', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-300',
        scopeRef: testScopeRef('scope-c'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      const updated = db.sessions.updateStatus('hsid-300', 'archived', ts())
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('archived')
    } finally {
      db.close()
    }
  })

  // JSON round-trip: lastAppliedIntentJson
  it('round-trips lastAppliedIntentJson through updateIntent', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-json-1',
        scopeRef: testScopeRef('scope-json'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const intent: HrcRuntimeIntent = {
        placement: {} as any,
        harness: {
          provider: 'anthropic',
          interactive: true,
          model: 'sonnet',
        },
        execution: {
          preferredMode: 'interactive',
        },
      }

      const updated = db.sessions.updateIntent('hsid-json-1', intent, ts())
      expect(updated).not.toBeNull()
      expect(updated!.lastAppliedIntentJson).toEqual(intent)
    } finally {
      db.close()
    }
  })

  // JSON round-trip: continuation
  it('round-trips continuation through updateContinuation', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-json-2',
        scopeRef: testScopeRef('scope-json'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const continuation: HrcContinuationRef = {
        provider: 'anthropic',
        key: 'fixture',
      }

      const updated = db.sessions.updateContinuation('hsid-json-2', continuation, ts())
      expect(updated).not.toBeNull()
      expect(updated!.continuation).toEqual(continuation)
    } finally {
      db.close()
    }
  })

  it('retains continuation while disabling and re-enabling automatic reuse', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-reuse-state',
        scopeRef: testScopeRef('scope-reuse-state'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.sessions.updateContinuation(
        'hsid-reuse-state',
        { provider: 'anthropic', key: 'retained-key' },
        ts()
      )

      db.sessions.setContinuationReuseDisabled('hsid-reuse-state', true, ts())
      expect(db.sessions.getByHostSessionId('hsid-reuse-state')?.continuation).toEqual({
        provider: 'anthropic',
        key: 'retained-key',
      })
      expect(db.sessions.isContinuationReuseDisabled('hsid-reuse-state')).toBe(true)

      db.sessions.updateContinuation(
        'hsid-reuse-state',
        { provider: 'anthropic', key: 'new-key' },
        ts()
      )
      expect(db.sessions.isContinuationReuseDisabled('hsid-reuse-state')).toBe(false)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. RuntimeRepository
// ---------------------------------------------------------------------------
