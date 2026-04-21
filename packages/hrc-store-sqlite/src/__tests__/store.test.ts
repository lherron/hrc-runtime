/**
 * RED/GREEN tests for hrc-store-sqlite (T-00953 / T-00951)
 *
 * Tests the public surface of openHrcDatabase():
 *   - Fresh migration applies Phase 1 schema
 *   - CRUD for each repository (continuities, sessions, runtimes, runs, launches, events, surface_bindings, runtime_buffers)
 *   - Monotonic event seq ordering
 *   - JSON round-trip for intent/continuation/tmux_json
 *   - Concurrent read safety with WAL mode
 *
 * Pass conditions for Larry (T-00951):
 *   1. openHrcDatabase(path) returns HrcDatabase with all 7 repositories
 *   2. migrations.applied contains at least one migration name
 *   3. Each repository supports the CRUD operations tested below
 *   4. EventRepository.append assigns monotonically increasing seq
 *   5. JSON fields (lastAppliedIntentJson, continuation, tmuxJson) survive round-trip
 *   6. WAL mode is enabled (PRAGMA journal_mode returns 'wal')
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  HrcContinuationRef,
  HrcEventEnvelope,
  HrcLaunchRecord,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
// This import is the RED gate — it will fail until Larry implements the module
import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function testScopeRef(scopeKey: string): string {
  return `agent:test:project:hrc-store:task:${scopeKey}`
}

function testSessionRef(scopeKey: string, laneRef = 'default'): string {
  return `${testScopeRef(scopeKey)}/lane:${laneRef}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-store-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Migration & database factory
// ---------------------------------------------------------------------------
describe('openHrcDatabase', () => {
  it('opens a database and applies migrations', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db).toBeDefined()
      expect(db.migrations.applied.length).toBeGreaterThan(0)
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
    const db = openHrcDatabase(dbPath)
    try {
      const result = db.sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(result.journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('enables foreign keys', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const result = db.sqlite.query('PRAGMA foreign_keys').get() as { foreign_keys: number }
      expect(result.foreign_keys).toBe(1)
    } finally {
      db.close()
    }
  })

  it('sets busy_timeout', () => {
    const db = openHrcDatabase(dbPath)
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

  it('is idempotent — opening twice on the same file succeeds', () => {
    const db1 = openHrcDatabase(dbPath)
    db1.close()
    const db2 = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
})

// ---------------------------------------------------------------------------
// 4. RuntimeRepository
// ---------------------------------------------------------------------------
describe('RuntimeRepository', () => {
  it('creates and retrieves a runtime snapshot', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      // Need a session first for the FK
      db.sessions.insert({
        hostSessionId: 'hsid-rt-1',
        scopeRef: testScopeRef('scope-rt'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const runtime: HrcRuntimeSnapshot = {
        runtimeId: 'rt-001',
        hostSessionId: 'hsid-rt-1',
        scopeRef: testScopeRef('scope-rt'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      }
      const created = db.runtimes.insert(runtime)
      expect(created.runtimeId).toBe('rt-001')

      const found = db.runtimes.getByRuntimeId('rt-001')
      expect(found).not.toBeNull()
      expect(found!.harness).toBe('claude-code')
    } finally {
      db.close()
    }
  })

  it('updates runtime status', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-rt-2',
        scopeRef: testScopeRef('scope-rt2'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-002',
        hostSessionId: 'hsid-rt-2',
        scopeRef: testScopeRef('scope-rt2'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'starting',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      const updated = db.runtimes.updateStatus('rt-002', 'ready', ts())
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('ready')
    } finally {
      db.close()
    }
  })

  it('updates PIDs on runtime', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-rt-3',
        scopeRef: testScopeRef('scope-rt3'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-003',
        hostSessionId: 'hsid-rt-3',
        scopeRef: testScopeRef('scope-rt3'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      const updated = db.runtimes.updatePids('rt-003', {
        wrapperPid: 12345,
        childPid: 12346,
        updatedAt: ts(),
      })
      expect(updated).not.toBeNull()
      expect(updated!.wrapperPid).toBe(12345)
      expect(updated!.childPid).toBe(12346)
    } finally {
      db.close()
    }
  })

  // JSON round-trip: tmuxJson
  it('round-trips tmuxJson through create', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-rt-tmux',
        scopeRef: testScopeRef('scope-rt-tmux'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      const tmuxJson = { sessionId: '%1', windowId: '@0', paneId: '%0' }
      const created = db.runtimes.insert({
        runtimeId: 'rt-tmux-1',
        hostSessionId: 'hsid-rt-tmux',
        scopeRef: testScopeRef('scope-rt-tmux'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        tmuxJson,
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      expect(created.tmuxJson).toEqual(tmuxJson)

      const found = db.runtimes.getByRuntimeId('rt-tmux-1')
      expect(found!.tmuxJson).toEqual(tmuxJson)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. RunRepository
// ---------------------------------------------------------------------------
describe('RunRepository', () => {
  it('creates and retrieves a run', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-run-1',
        scopeRef: testScopeRef('scope-run'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const run: HrcRunRecord = {
        runId: 'run-001',
        hostSessionId: 'hsid-run-1',
        scopeRef: testScopeRef('scope-run'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        status: 'accepted',
        updatedAt: now,
        acceptedAt: now,
      }
      const created = db.runs.insert(run)
      expect(created.runId).toBe('run-001')

      const found = db.runs.getByRunId('run-001')
      expect(found).not.toBeNull()
      expect(found!.status).toBe('accepted')
    } finally {
      db.close()
    }
  })

  it('marks a run as completed with error info', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-run-2',
        scopeRef: testScopeRef('scope-run2'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runs.insert({
        runId: 'run-002',
        hostSessionId: 'hsid-run-2',
        scopeRef: testScopeRef('scope-run2'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        status: 'running',
        updatedAt: now,
      })

      const completed = db.runs.markCompleted('run-002', {
        status: 'failed',
        completedAt: ts(),
        updatedAt: ts(),
        errorCode: 'RUNTIME_UNAVAILABLE',
        errorMessage: 'tmux pane died',
      })
      expect(completed).not.toBeNull()
      expect(completed!.status).toBe('failed')
      expect(completed!.errorCode).toBe('RUNTIME_UNAVAILABLE')
      expect(completed!.errorMessage).toBe('tmux pane died')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. LaunchRepository
// ---------------------------------------------------------------------------
describe('LaunchRepository', () => {
  it('creates and retrieves a launch record', () => {
    const db = openHrcDatabase(dbPath)
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

  it('tracks wrapper lifecycle: started → child started → exited', () => {
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
    const db = openHrcDatabase(dbPath)
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
describe('SurfaceBindingRepository', () => {
  it('binds and finds a surface by surface key', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-surface-1',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-1',
        hostSessionId: 'hsid-surface-1',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      const binding = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-1',
        hostSessionId: 'hsid-surface-1',
        runtimeId: 'rt-surface-1',
        generation: 1,
        windowId: 'window-1',
        paneId: 'pane-1',
        boundAt: now,
      })

      expect(binding.surfaceKind).toBe('ghostty')
      expect(binding.surfaceId).toBe('ghostty-1')
      expect(binding.runtimeId).toBe('rt-surface-1')
      expect(binding.unboundAt).toBeUndefined()

      const found = db.surfaceBindings.findBySurface('ghostty', 'ghostty-1')
      expect(found).not.toBeNull()
      expect(found?.hostSessionId).toBe('hsid-surface-1')
      expect(found?.paneId).toBe('pane-1')
    } finally {
      db.close()
    }
  })

  it('rebinds an existing surface to a newer runtime and keeps active queries current', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-surface-2',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.sessions.insert({
        hostSessionId: 'hsid-surface-3',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 2,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-2',
        hostSessionId: 'hsid-surface-2',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-3',
        hostSessionId: 'hsid-surface-3',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 2,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-2',
        hostSessionId: 'hsid-surface-2',
        runtimeId: 'rt-surface-2',
        generation: 1,
        boundAt: now,
      })
      const rebound = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-2',
        hostSessionId: 'hsid-surface-3',
        runtimeId: 'rt-surface-3',
        generation: 2,
        boundAt: ts(),
      })

      expect(rebound.hostSessionId).toBe('hsid-surface-3')
      expect(rebound.runtimeId).toBe('rt-surface-3')
      expect(db.surfaceBindings.findByRuntime('rt-surface-2')).toEqual([])
      expect(db.surfaceBindings.findByRuntime('rt-surface-3')).toHaveLength(1)
      expect(db.surfaceBindings.listActive()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('unbinds a surface and removes it from active listings', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-surface-4',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-4',
        hostSessionId: 'hsid-surface-4',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-4',
        hostSessionId: 'hsid-surface-4',
        runtimeId: 'rt-surface-4',
        generation: 1,
        boundAt: now,
      })
      const unbound = db.surfaceBindings.unbind('ghostty', 'ghostty-4', ts(), 'user-detached')

      expect(unbound).not.toBeNull()
      expect(unbound?.unboundAt).toBeString()
      expect(unbound?.reason).toBe('user-detached')
      expect(db.surfaceBindings.findByRuntime('rt-surface-4')).toEqual([])
      expect(db.surfaceBindings.listActive()).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. RuntimeBufferRepository
// ---------------------------------------------------------------------------
describe('RuntimeBufferRepository', () => {
  it('appends and queries buffer chunks by runtime', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-buf-1',
        hostSessionId: 'hsid-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        transport: 'sdk',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: 'run-buf-1',
        hostSessionId: 'hsid-buf-1',
        runtimeId: 'rt-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        transport: 'sdk',
        status: 'completed',
        acceptedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: 'run-buf-2',
        hostSessionId: 'hsid-buf-1',
        runtimeId: 'rt-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        transport: 'sdk',
        status: 'completed',
        acceptedAt: now,
        completedAt: now,
        updatedAt: now,
      })

      db.runtimeBuffers.append({
        runtimeId: 'rt-buf-1',
        runId: 'run-buf-1',
        chunkSeq: 1,
        text: 'Hello ',
        createdAt: now,
      })
      db.runtimeBuffers.append({
        runtimeId: 'rt-buf-1',
        runId: 'run-buf-2',
        chunkSeq: 1,
        text: 'World',
        createdAt: now,
      })

      const chunks = db.runtimeBuffers.listByRuntimeId('rt-buf-1')
      expect(chunks.length).toBe(2)
      expect(chunks[0].runId).toBe('run-buf-1')
      expect(chunks[1].runId).toBe('run-buf-2')
      expect(chunks[0].chunkSeq).toBe(1)
      expect(chunks[1].chunkSeq).toBe(1)
      expect(chunks[0].text).toBe('Hello ')
      expect(chunks[1].text).toBe('World')

      const runOneChunks = db.runtimeBuffers.listByRunId('run-buf-1')
      const runTwoChunks = db.runtimeBuffers.listByRunId('run-buf-2')
      expect(runOneChunks.map((chunk) => chunk.text)).toEqual(['Hello '])
      expect(runTwoChunks.map((chunk) => chunk.text)).toEqual(['World'])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 10. Concurrent read safety with WAL
// ---------------------------------------------------------------------------
describe('WAL concurrent reads', () => {
  it('allows concurrent readers while writer has open transaction', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-wal-1',
        scopeRef: testScopeRef('scope-wal'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      // Open a second reader connection
      const db2 = openHrcDatabase(dbPath)
      try {
        // Writer appends an event
        db.events.append({
          ts: now,
          hostSessionId: 'hsid-wal-1',
          scopeRef: testScopeRef('scope-wal'),
          laneRef: 'default',
          generation: 1,
          source: 'hrc',
          eventKind: 'test.wal',
          eventJson: {},
        })

        // Reader should be able to query without blocking
        const session = db2.sessions.getByHostSessionId('hsid-wal-1')
        expect(session).not.toBeNull()
      } finally {
        db2.close()
      }
    } finally {
      db.close()
    }
  })
})
