import { describe, expect, it } from 'bun:test'

import { createStoreTestFixture, openHrcDatabase, testScopeRef, ts } from './store.fixture'

const fixture = createStoreTestFixture()
import type { HrcEventEnvelope } from './store.fixture'

// ---------------------------------------------------------------------------
// 7. EventRepository — monotonic seq ordering
// ---------------------------------------------------------------------------
describe('EventRepository', () => {
  it('appends events with monotonically increasing seq', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-evt-1',
        scopeRef: testScopeRef('scope-evt'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })

      const base: Omit<HrcEventEnvelope, 'seq'> = {
        ts: now,
        hostSessionId: 'hsid-evt-1',
        scopeRef: testScopeRef('scope-evt'),
        laneRef: 'default',
        generation: 1,
        source: 'hrc',
        eventKind: 'session.created',
        eventJson: { detail: 'test' },
      }

      const e1 = db.events.append(base)
      const e2 = db.events.append({ ...base, eventKind: 'runtime.created' })
      const e3 = db.events.append({ ...base, eventKind: 'turn.accepted' })

      expect(e1.seq).toBeDefined()
      expect(e2.seq).toBeGreaterThan(e1.seq)
      expect(e3.seq).toBeGreaterThan(e2.seq)
    } finally {
      db.close()
    }
  })

  it('queries events with fromSeq filter', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-evt-2',
        scopeRef: testScopeRef('scope-evt2'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })

      const base: Omit<HrcEventEnvelope, 'seq'> = {
        ts: now,
        hostSessionId: 'hsid-evt-2',
        scopeRef: testScopeRef('scope-evt2'),
        laneRef: 'default',
        generation: 1,
        source: 'hrc',
        eventKind: 'test.event',
        eventJson: {},
      }

      const e1 = db.events.append(base)
      db.events.append(base)
      db.events.append(base)

      const fromE2 = db.events.listFromSeq(e1.seq + 1, { hostSessionId: 'hsid-evt-2' })
      expect(fromE2.length).toBe(2)
    } finally {
      db.close()
    }
  })

  it('counts events with filters', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-evt-3',
        scopeRef: testScopeRef('scope-evt3'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })

      const base: Omit<HrcEventEnvelope, 'seq'> = {
        ts: now,
        hostSessionId: 'hsid-evt-3',
        scopeRef: testScopeRef('scope-evt3'),
        laneRef: 'default',
        generation: 1,
        source: 'hrc',
        eventKind: 'test.event',
        eventJson: {},
      }

      db.events.append(base)
      db.events.append(base)
      db.events.append(base)

      const count = db.events.count({ hostSessionId: 'hsid-evt-3' })
      expect(count).toBe(3)
    } finally {
      db.close()
    }
  })

  // JSON round-trip: eventJson
  it('round-trips eventJson with nested objects', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-evt-json',
        scopeRef: testScopeRef('scope-evt-json'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })

      const complexPayload = {
        nested: { deep: { value: 42 } },
        array: [1, 'two', { three: true }],
        unicode: '日本語テスト',
      }

      const _evt = db.events.append({
        ts: now,
        hostSessionId: 'hsid-evt-json',
        scopeRef: testScopeRef('scope-evt-json'),
        laneRef: 'default',
        generation: 1,
        source: 'hook',
        eventKind: 'hook.ingested',
        eventJson: complexPayload,
      })

      const queried = db.events.listFromSeq(1, { hostSessionId: 'hsid-evt-json' })
      expect(queried.length).toBe(1)
      expect(queried[0].eventJson).toEqual(complexPayload)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. SurfaceBindingRepository
// ---------------------------------------------------------------------------
