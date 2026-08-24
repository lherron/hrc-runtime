import { describe, expect, it } from 'bun:test'

import { createStoreTestFixture, openHrcDatabase, testScopeRef, ts } from './store.fixture'

const fixture = createStoreTestFixture()
import type { HrcEventEnvelope, HrcLaunchRecord } from './store.fixture'

describe('LaunchRepository', () => {
  it('creates and retrieves a launch record', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-launch-1',
        scopeRef: testScopeRef('scope-launch'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const launch: HrcLaunchRecord = {
        launchId: 'launch-001',
        hostSessionId: 'hsid-launch-1',
        generation: 1,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: '/tmp/launches/launch-001.json',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      const created = db.launches.insert(launch)
      expect(created.launchId).toBe('launch-001')

      const found = db.launches.getByLaunchId('launch-001')
      expect(found).not.toBeNull()
      expect(found!.status).toBe('pending')
    } finally {
      db.close()
    }
  })

  it('round-trips surfaceJson through create', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-launch-surface',
        scopeRef: testScopeRef('scope-launch-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const surfaceJson = {
        kind: 'ghostty',
        surfaceId: 'surface-launch-1',
        createdBy: 'ghostmux',
      }
      const created = db.launches.insert({
        launchId: 'launch-surface-001',
        hostSessionId: 'hsid-launch-surface',
        generation: 1,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: '/tmp/launches/launch-surface-001.json',
        surfaceJson,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      expect(created.surfaceJson).toEqual(surfaceJson)

      const found = db.launches.getByLaunchId('launch-surface-001')
      expect(found!.surfaceJson).toEqual(surfaceJson)
    } finally {
      db.close()
    }
  })

  it('tracks wrapper lifecycle: started → child started → exited', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-launch-2',
        scopeRef: testScopeRef('scope-launch2'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.launches.insert({
        launchId: 'launch-002',
        hostSessionId: 'hsid-launch-2',
        generation: 1,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: '/tmp/launches/launch-002.json',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })

      // Wrapper started
      const ws = db.launches.updateWrapperStarted('launch-002', {
        wrapperPid: 9001,
        wrapperStartedAt: ts(),
        updatedAt: ts(),
      })
      expect(ws!.wrapperPid).toBe(9001)
      expect(ws!.wrapperStartedAt).toBeDefined()

      // Child started
      const cs = db.launches.updateChildStarted('launch-002', {
        childPid: 9002,
        childStartedAt: ts(),
        updatedAt: ts(),
      })
      expect(cs!.childPid).toBe(9002)

      // Exited
      const ex = db.launches.updateExited('launch-002', {
        exitedAt: ts(),
        updatedAt: ts(),
        status: 'exited',
        exitCode: 0,
      })
      expect(ex!.status).toBe('exited')
      expect(ex!.exitCode).toBe(0)
    } finally {
      db.close()
    }
  })
})

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
        ancestorScopeRefs: [],
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
        ancestorScopeRefs: [],
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
        ancestorScopeRefs: [],
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
        ancestorScopeRefs: [],
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
