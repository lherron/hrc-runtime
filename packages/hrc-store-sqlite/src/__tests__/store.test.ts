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
import { HrcErrorCode } from 'hrc-core'
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

  it('round-trips surfaceJson through create', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-rt-surface',
        scopeRef: testScopeRef('scope-rt-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      const surfaceJson = {
        kind: 'ghostty',
        surfaceId: 'surface-1',
        title: 'claude-code: cody@hrc-runtime:T-01588',
        createdBy: 'ghostmux',
      }
      const created = db.runtimes.insert({
        runtimeId: 'rt-surface-1',
        hostSessionId: 'hsid-rt-surface',
        scopeRef: testScopeRef('scope-rt-surface'),
        laneRef: 'default',
        generation: 1,
        transport: 'ghostty',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        surfaceJson,
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      expect(created.surfaceJson).toEqual(surfaceJson)

      const found = db.runtimes.getByRuntimeId('rt-surface-1')
      expect(found!.surfaceJson).toEqual(surfaceJson)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. RunRepository
// ---------------------------------------------------------------------------
describe('RunRepository', () => {
  function insertRunSession(
    db: ReturnType<typeof openHrcDatabase>,
    input: {
      hostSessionId: string
      scopeKey: string
      generation?: number | undefined
      priorHostSessionId?: string | undefined
      updatedAt?: string | undefined
    }
  ): HrcSessionRecord {
    const updatedAt = input.updatedAt ?? ts()
    return db.sessions.insert({
      hostSessionId: input.hostSessionId,
      scopeRef: testScopeRef(input.scopeKey),
      laneRef: 'default',
      generation: input.generation ?? 1,
      status: 'active',
      ...(input.priorHostSessionId ? { priorHostSessionId: input.priorHostSessionId } : {}),
      createdAt: updatedAt,
      updatedAt,
      ancestorScopeRefs: [],
    })
  }

  function insertRunRuntime(
    db: ReturnType<typeof openHrcDatabase>,
    session: HrcSessionRecord,
    input: {
      runtimeId: string
      status: string
      activeRunId?: string | undefined
      updatedAt?: string | undefined
    }
  ): HrcRuntimeSnapshot {
    const updatedAt = input.updatedAt ?? ts()
    return db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: input.status,
      supportsInflightInput: false,
      adopted: false,
      ...(input.activeRunId ? { activeRunId: input.activeRunId } : {}),
      createdAt: updatedAt,
      updatedAt,
    })
  }

  function insertRun(
    db: ReturnType<typeof openHrcDatabase>,
    session: HrcSessionRecord,
    input: {
      runId: string
      runtimeId?: string | undefined
      status: HrcRunRecord['status']
      acceptedAt?: string | undefined
      startedAt?: string | undefined
      completedAt?: string | undefined
      updatedAt: string
      errorCode?: HrcRunRecord['errorCode'] | undefined
      errorMessage?: string | undefined
    }
  ): HrcRunRecord {
    return db.runs.insert({
      runId: input.runId,
      hostSessionId: session.hostSessionId,
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: input.status,
      ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      updatedAt: input.updatedAt,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    })
  }

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

  it('lists latest runs for a host session with generation and limit filters', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const session = insertRunSession(db, {
        hostSessionId: 'hsid-run-list',
        scopeKey: 'scope-run-list',
        generation: 2,
      })
      insertRunRuntime(db, session, { runtimeId: 'rt-run-list', status: 'busy' })
      insertRun(db, session, {
        runId: 'run-list-old',
        runtimeId: 'rt-run-list',
        status: 'completed',
        acceptedAt: '2026-05-18T10:00:00.000Z',
        completedAt: '2026-05-18T10:01:00.000Z',
        updatedAt: '2026-05-18T10:01:00.000Z',
      })
      insertRun(db, session, {
        runId: 'run-list-new',
        runtimeId: 'rt-run-list',
        status: 'running',
        acceptedAt: '2026-05-18T10:02:00.000Z',
        startedAt: '2026-05-18T10:02:01.000Z',
        updatedAt: '2026-05-18T10:03:00.000Z',
      })
      const otherSession = insertRunSession(db, {
        hostSessionId: 'hsid-run-list-other',
        scopeKey: 'scope-run-list-other',
      })
      insertRun(db, otherSession, {
        runId: 'run-list-other',
        status: 'running',
        updatedAt: '2026-05-18T10:04:00.000Z',
      })

      const runs = db.runs.listRuns({
        hostSessionId: 'hsid-run-list',
        generation: 2,
        limit: 1,
      })

      expect(runs.map((run) => run.runId)).toEqual(['run-list-new'])
      expect(runs[0].status).toBe('running')
      expect(runs[0].runtimeId).toBe('rt-run-list')
      expect(runs[0].acceptedAt).toBe('2026-05-18T10:02:00.000Z')
      expect(runs[0].startedAt).toBe('2026-05-18T10:02:01.000Z')
      expect(runs[0].updatedAt).toBe('2026-05-18T10:03:00.000Z')
    } finally {
      db.close()
    }
  })

  it('applies the run enrichment-filter index migration (T-05010)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0015_run_enrichment_filter_indexes')
      const indexes = db.sqlite
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'"
        )
        .all()
        .map((row) => row.name)
      expect(indexes).toContain('idx_runs_scope_lane_updated')
      expect(indexes).toContain('idx_runs_status_updated')
    } finally {
      db.close()
    }
  })

  it('filters listRuns by runId, scopeRef, laneRef, status, and composed filters (T-05010)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      // Single host session satisfies the runs FK; scopeRef/laneRef/status are
      // free columns we vary across the seeded runs.
      const session = insertRunSession(db, {
        hostSessionId: 'hsid-enrich',
        scopeKey: 'enrich-host',
      })
      insertRunRuntime(db, session, { runtimeId: 'rt-enrich-a', status: 'busy' })
      insertRunRuntime(db, session, { runtimeId: 'rt-enrich-b', status: 'busy' })

      const scopeA = 'agent:clod:project:hrc-runtime:task:T-05010'
      const scopeB = 'agent:cody:project:taskboard:task:T-09999'

      function seedRun(input: {
        runId: string
        runtimeId?: string | undefined
        scopeRef: string
        laneRef: string
        status: HrcRunRecord['status']
        updatedAt: string
      }): void {
        db.runs.insert({
          runId: input.runId,
          hostSessionId: session.hostSessionId,
          ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
          scopeRef: input.scopeRef,
          laneRef: input.laneRef,
          generation: session.generation,
          transport: 'tmux',
          status: input.status,
          acceptedAt: input.updatedAt,
          updatedAt: input.updatedAt,
        })
      }

      seedRun({
        runId: 'run-a-main-running',
        runtimeId: 'rt-enrich-a',
        scopeRef: scopeA,
        laneRef: 'main',
        status: 'running',
        updatedAt: '2026-06-21T10:00:00.000Z',
      })
      seedRun({
        runId: 'run-a-main-completed',
        runtimeId: 'rt-enrich-a',
        scopeRef: scopeA,
        laneRef: 'main',
        status: 'completed',
        updatedAt: '2026-06-21T10:01:00.000Z',
      })
      seedRun({
        runId: 'run-a-repair-running',
        runtimeId: 'rt-enrich-a',
        scopeRef: scopeA,
        laneRef: 'repair',
        status: 'running',
        updatedAt: '2026-06-21T10:02:00.000Z',
      })
      seedRun({
        runId: 'run-b-main-failed',
        runtimeId: 'rt-enrich-b',
        scopeRef: scopeB,
        laneRef: 'main',
        status: 'failed',
        updatedAt: '2026-06-21T10:03:00.000Z',
      })

      // runId is exact-match: exactly the one run or empty.
      expect(db.runs.listRuns({ runId: 'run-a-main-completed' }).map((r) => r.runId)).toEqual([
        'run-a-main-completed',
      ])
      expect(db.runs.listRuns({ runId: 'does-not-exist' })).toEqual([])

      // scopeRef exact-match (no prefix matching) returns both lanes under scopeA,
      // newest-first.
      expect(db.runs.listRuns({ scopeRef: scopeA }).map((r) => r.runId)).toEqual([
        'run-a-repair-running',
        'run-a-main-completed',
        'run-a-main-running',
      ])

      // scopeRef + laneRef composed.
      expect(db.runs.listRuns({ scopeRef: scopeA, laneRef: 'main' }).map((r) => r.runId)).toEqual([
        'run-a-main-completed',
        'run-a-main-running',
      ])

      // status set filter (one or more values).
      expect(new Set(db.runs.listRuns({ status: ['running'] }).map((r) => r.runId))).toEqual(
        new Set(['run-a-main-running', 'run-a-repair-running'])
      )
      expect(
        new Set(db.runs.listRuns({ status: ['completed', 'failed'] }).map((r) => r.runId))
      ).toEqual(new Set(['run-a-main-completed', 'run-b-main-failed']))

      // Composed scopeRef + laneRef + status.
      expect(
        db.runs
          .listRuns({ scopeRef: scopeA, laneRef: 'main', status: ['running'] })
          .map((r) => r.runId)
      ).toEqual(['run-a-main-running'])

      // Existing runtimeId filter still composes with the new filters.
      expect(new Set(db.runs.listRuns({ runtimeId: 'rt-enrich-a' }).map((r) => r.runId))).toEqual(
        new Set(['run-a-main-running', 'run-a-main-completed', 'run-a-repair-running'])
      )
    } finally {
      db.close()
    }
  })

  it('returns the latest run for the C-02541 session/runtime/run lifecycle matrix', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const ready = insertRunSession(db, {
        hostSessionId: 'hsid-matrix-ready',
        scopeKey: 'scope-matrix-ready',
      })
      insertRunRuntime(db, ready, { runtimeId: 'rt-matrix-ready', status: 'ready' })
      expect(db.runs.getLatestForSession({ hostSessionId: ready.hostSessionId })).toBeNull()

      const busy = insertRunSession(db, {
        hostSessionId: 'hsid-matrix-busy',
        scopeKey: 'scope-matrix-busy',
      })
      insertRunRuntime(db, busy, {
        runtimeId: 'rt-matrix-busy',
        status: 'busy',
        activeRunId: 'run-matrix-running',
      })
      insertRun(db, busy, {
        runId: 'run-matrix-running',
        runtimeId: 'rt-matrix-busy',
        status: 'running',
        acceptedAt: '2026-05-18T11:00:00.000Z',
        startedAt: '2026-05-18T11:00:01.000Z',
        updatedAt: '2026-05-18T11:00:02.000Z',
      })
      expect(db.runs.getLatestForSession({ hostSessionId: busy.hostSessionId })?.status).toBe(
        'running'
      )

      const stale = insertRunSession(db, {
        hostSessionId: 'hsid-matrix-stale',
        scopeKey: 'scope-matrix-stale',
      })
      insertRunRuntime(db, stale, {
        runtimeId: 'rt-matrix-stale',
        status: 'stale',
        activeRunId: 'run-matrix-started',
      })
      insertRun(db, stale, {
        runId: 'run-matrix-started',
        runtimeId: 'rt-matrix-stale',
        status: 'started',
        acceptedAt: '2026-05-18T11:10:00.000Z',
        startedAt: '2026-05-18T11:10:01.000Z',
        updatedAt: '2026-05-18T11:10:02.000Z',
      })
      expect(db.runs.getLatestForSession({ hostSessionId: stale.hostSessionId })?.status).toBe(
        'started'
      )

      const dead = insertRunSession(db, {
        hostSessionId: 'hsid-matrix-dead',
        scopeKey: 'scope-matrix-dead',
      })
      insertRunRuntime(db, dead, {
        runtimeId: 'rt-matrix-dead',
        status: 'dead',
        activeRunId: 'run-matrix-zombie',
      })
      insertRun(db, dead, {
        runId: 'run-matrix-zombie',
        runtimeId: 'rt-matrix-dead',
        status: 'zombie',
        acceptedAt: '2026-05-18T11:20:00.000Z',
        startedAt: '2026-05-18T11:20:01.000Z',
        completedAt: '2026-05-18T11:50:00.000Z',
        updatedAt: '2026-05-18T11:50:00.000Z',
        errorCode: HrcErrorCode.RUN_ZOMBIE_TIMEOUT,
        errorMessage: 'run timed out',
      })
      const zombie = db.runs.getLatestForSession({ hostSessionId: dead.hostSessionId })
      expect(zombie?.status).toBe('zombie')
      expect(zombie?.errorCode).toBe(HrcErrorCode.RUN_ZOMBIE_TIMEOUT)
      expect(zombie?.errorMessage).toBe('run timed out')

      const prior = insertRunSession(db, {
        hostSessionId: 'hsid-matrix-prior',
        scopeKey: 'scope-matrix-rotation',
        generation: 1,
      })
      const current = insertRunSession(db, {
        hostSessionId: 'hsid-matrix-current',
        scopeKey: 'scope-matrix-rotation',
        generation: 2,
        priorHostSessionId: prior.hostSessionId,
      })
      insertRunRuntime(db, current, { runtimeId: 'rt-matrix-current', status: 'ready' })
      insertRun(db, prior, {
        runId: 'run-matrix-prior',
        status: 'completed',
        completedAt: '2026-05-18T12:00:00.000Z',
        updatedAt: '2026-05-18T12:00:00.000Z',
      })
      insertRun(db, current, {
        runId: 'run-matrix-current',
        runtimeId: 'rt-matrix-current',
        status: 'accepted',
        acceptedAt: '2026-05-18T12:10:00.000Z',
        updatedAt: '2026-05-18T12:10:00.000Z',
      })

      expect(current.priorHostSessionId).toBe(prior.hostSessionId)
      expect(
        db.runs.getLatestForSession({
          hostSessionId: current.hostSessionId,
          generation: current.generation,
        })?.runId
      ).toBe('run-matrix-current')
      expect(
        db.runs.getLatestForSession({
          hostSessionId: prior.hostSessionId,
          generation: prior.generation,
        })?.runId
      ).toBe('run-matrix-prior')
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

  it('round-trips surfaceJson through create', () => {
    const db = openHrcDatabase(dbPath)
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
