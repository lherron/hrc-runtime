import { describe, expect, it } from 'bun:test'

import {
  HrcErrorCode,
  createStoreTestFixture,
  openHrcDatabase,
  testScopeRef,
  ts,
} from './store.fixture'

const fixture = createStoreTestFixture()
import type { HrcRunRecord, HrcRuntimeSnapshot, HrcSessionRecord } from './store.fixture'

describe('RuntimeRepository', () => {
  it('creates and retrieves a runtime snapshot', () => {
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
    const db = openHrcDatabase(fixture.dbPath)
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
