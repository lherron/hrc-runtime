import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-run-active-reconcile-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

type SeedRunOptions = {
  runId: string
  hostSessionId: string
  scopeRef: string
  runtimeId: string
  transport?: 'sdk' | 'tmux' | 'headless' | undefined
  runtimeStatus?: string | undefined
  updatedAt?: string | undefined
  activeRunOwner?: boolean | undefined
  tmuxSessionName?: string | undefined
  launchId?: string | undefined
  launchStatus?: string | undefined
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function canonicalScopeRef(scopeRef: string): string {
  return scopeRef.startsWith('agent:') ? scopeRef : `agent:${scopeRef}`
}

function seedRun(options: SeedRunOptions): void {
  fixture.seedSession(options.hostSessionId, options.scopeRef)

  const db = openHrcDatabase(fixture.dbPath)
  const scopeRef = canonicalScopeRef(options.scopeRef)
  const timestamp = options.updatedAt ?? isoMinutesAgo(60)
  const transport = options.transport ?? 'tmux'

  try {
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport,
      harness: transport === 'tmux' ? 'claude-code' : 'agent-sdk',
      provider: 'anthropic',
      status: options.runtimeStatus ?? 'busy',
      ...(options.launchId ? { launchId: options.launchId } : {}),
      ...(transport === 'tmux'
        ? {
            tmuxJson: {
              socketPath: fixture.tmuxSocketPath,
              sessionName: options.tmuxSessionName ?? 'hrc-missing-session',
              windowName: 'main',
            },
          }
        : {}),
      supportsInflightInput: false,
      adopted: false,
      ...(options.activeRunOwner === false ? {} : { activeRunId: options.runId }),
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    if (options.launchId && options.launchStatus) {
      db.launches.insert({
        launchId: options.launchId,
        hostSessionId: options.hostSessionId,
        generation: 1,
        runtimeId: options.runtimeId,
        harness: transport === 'tmux' ? 'claude-code' : 'codex-cli',
        provider: transport === 'tmux' ? 'anthropic' : 'openai',
        launchArtifactPath: `/tmp/${options.launchId}.json`,
        status: options.launchStatus,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }

    db.runs.insert({
      runId: options.runId,
      hostSessionId: options.hostSessionId,
      runtimeId: options.runtimeId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport,
      status: 'started',
      acceptedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }
}

function getRun(runId: string): HrcRunRecord | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.getByRunId(runId)
  } finally {
    db.close()
  }
}

function getRuntime(runtimeId: string): HrcRuntimeSnapshot | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function listEvents(eventKind: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((event) => event.eventKind === eventKind)
  } finally {
    db.close()
  }
}

async function reconcile(
  body: ReconcileActiveRunsRequest = {}
): Promise<ReconcileActiveRunsResponse> {
  const res = await fixture.postJson('/v1/runs/reconcile-active', body)
  expect(res.status).toBe(200)
  return (await res.json()) as ReconcileActiveRunsResponse
}

async function createTmuxSession(sessionName: string): Promise<void> {
  const { exited } = Bun.spawn(
    ['tmux', '-S', fixture.tmuxSocketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
    {
      stdout: 'ignore',
      stderr: 'ignore',
    }
  )
  expect(await exited).toBe(0)
}

describe('POST /v1/runs/reconcile-active', () => {
  it('dry-run reports reappable runtime contradictions without mutation', async () => {
    seedRun({
      runId: 'run-dry',
      hostSessionId: 'hsid-dry',
      scopeRef: 'reconcile-active-dry',
      runtimeId: 'rt-dry',
      runtimeStatus: 'terminated',
    })

    const body = await reconcile({ olderThan: '30m', dryRun: true })

    expect(body.summary).toMatchObject({ matched: 1, reaped: 0, suspect: 0, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runId: 'run-dry',
      status: 'matched',
      reason: 'runtime_terminated_with_active_run',
      runtimeStatus: 'terminated',
      runtimeOwnershipCleared: false,
    })
    expect(getRun('run-dry')?.status).toBe('started')
    expect(getRuntime('rt-dry')?.activeRunId).toBe('run-dry')
    expect(listEvents('turn.reaped')).toHaveLength(0)
  })

  it('reaps active runs owned by terminated runtimes as failed', async () => {
    seedRun({
      runId: 'run-terminated',
      hostSessionId: 'hsid-terminated',
      scopeRef: 'reconcile-active-terminated',
      runtimeId: 'rt-terminated',
      runtimeStatus: 'terminated',
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 0, reaped: 1, suspect: 0, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runId: 'run-terminated',
      status: 'reaped',
      reason: 'runtime_terminated_with_active_run',
      runtimeOwnershipCleared: true,
    })
    expect(getRun('run-terminated')?.status).toBe('failed')
    expect(getRun('run-terminated')?.errorCode).toBe('runtime_terminated_with_active_run')
    expect(getRun('run-terminated')?.completedAt).toBeDefined()
    expect(getRuntime('rt-terminated')?.status).toBe('terminated')
    expect(getRuntime('rt-terminated')?.activeRunId).toBeUndefined()
    expect(listEvents('turn.reaped')).toHaveLength(1)
  })

  it('reaps active runs owned by ready runtimes as failed', async () => {
    seedRun({
      runId: 'run-ready',
      hostSessionId: 'hsid-ready',
      scopeRef: 'reconcile-active-ready',
      runtimeId: 'rt-ready',
      runtimeStatus: 'ready',
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.results[0]).toMatchObject({
      runId: 'run-ready',
      status: 'reaped',
      reason: 'runtime_ready_with_active_run',
    })
    expect(getRun('run-ready')?.status).toBe('failed')
    expect(getRun('run-ready')?.errorCode).toBe('runtime_ready_with_active_run')
    expect(getRuntime('rt-ready')?.status).toBe('ready')
    expect(getRuntime('rt-ready')?.activeRunId).toBeUndefined()
  })

  it('marks tmux runtimes dead when their active run points at a missing tmux session', async () => {
    seedRun({
      runId: 'run-missing-tmux',
      hostSessionId: 'hsid-missing-tmux',
      scopeRef: 'reconcile-active-missing-tmux',
      runtimeId: 'rt-missing-tmux',
      runtimeStatus: 'busy',
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.results[0]).toMatchObject({
      runId: 'run-missing-tmux',
      status: 'reaped',
      reason: 'runtime_unavailable_with_active_run',
      nextRuntimeStatus: 'dead',
    })
    expect(getRun('run-missing-tmux')?.status).toBe('failed')
    expect(getRun('run-missing-tmux')?.errorCode).toBe('runtime_unavailable_with_active_run')
    expect(getRuntime('rt-missing-tmux')?.status).toBe('dead')
    expect(getRuntime('rt-missing-tmux')?.activeRunId).toBeUndefined()
  })

  it('reaps headless active runs whose launch is orphaned', async () => {
    seedRun({
      runId: 'run-headless-orphan',
      hostSessionId: 'hsid-headless-orphan',
      scopeRef: 'reconcile-active-headless-orphan',
      runtimeId: 'rt-headless-orphan',
      transport: 'headless',
      runtimeStatus: 'busy',
      launchId: 'launch-headless-orphan',
      launchStatus: 'orphaned',
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.results[0]).toMatchObject({
      runId: 'run-headless-orphan',
      transport: 'headless',
      status: 'reaped',
      reason: 'orphaned-headless',
      nextRuntimeStatus: 'stale',
      launchId: 'launch-headless-orphan',
      launchStatus: 'orphaned',
    })
    expect(getRun('run-headless-orphan')?.status).toBe('failed')
    expect(getRun('run-headless-orphan')?.errorCode).toBe(
      'runtime_unavailable_with_active_run'
    )
    expect(getRuntime('rt-headless-orphan')?.status).toBe('stale')
    expect(getRuntime('rt-headless-orphan')?.activeRunId).toBeUndefined()
    const reaped = listEvents('turn.reaped')
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.payload).toMatchObject({ reason: 'orphaned-headless' })
  })

  it('reaps stale busy tmux and sdk active runs after the activity threshold', async () => {
    await createTmuxSession('hrc-live-active-run')
    seedRun({
      runId: 'run-live-tmux',
      hostSessionId: 'hsid-live-tmux',
      scopeRef: 'reconcile-active-live-tmux',
      runtimeId: 'rt-live-tmux',
      runtimeStatus: 'busy',
      tmuxSessionName: 'hrc-live-active-run',
    })
    seedRun({
      runId: 'run-busy-sdk',
      hostSessionId: 'hsid-busy-sdk',
      scopeRef: 'reconcile-active-busy-sdk',
      runtimeId: 'rt-busy-sdk',
      transport: 'sdk',
      runtimeStatus: 'busy',
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 0, reaped: 2, suspect: 0, skipped: 0, errors: 0 })
    expect(
      body.results.map((result) => [result.runId, result.status, result.reason]).sort()
    ).toEqual([
      ['run-busy-sdk', 'reaped', 'runtime_busy_timeout_with_active_run'],
      ['run-live-tmux', 'reaped', 'runtime_busy_timeout_with_active_run'],
    ])
    expect(getRun('run-live-tmux')?.status).toBe('failed')
    expect(getRun('run-live-tmux')?.errorCode).toBe('runtime_busy_timeout_with_active_run')
    expect(getRun('run-busy-sdk')?.status).toBe('failed')
    expect(getRun('run-busy-sdk')?.errorCode).toBe('runtime_busy_timeout_with_active_run')
    // Reap must transition the runtime out of 'busy' — otherwise the runtime
    // wedges with status=busy + activeRunId=NULL, a self-contradiction.
    expect(getRuntime('rt-live-tmux')?.status).toBe('stale')
    expect(getRuntime('rt-live-tmux')?.activeRunId).toBeUndefined()
    expect(getRuntime('rt-busy-sdk')?.status).toBe('stale')
    expect(getRuntime('rt-busy-sdk')?.activeRunId).toBeUndefined()
    expect(listEvents('turn.reaped')).toHaveLength(2)
  })

  it('does not reap busy active runs with recent activity', async () => {
    seedRun({
      runId: 'run-recent-busy',
      hostSessionId: 'hsid-recent-busy',
      scopeRef: 'reconcile-active-recent-busy',
      runtimeId: 'rt-recent-busy',
      transport: 'sdk',
      runtimeStatus: 'busy',
      updatedAt: isoMinutesAgo(5),
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 0, reaped: 0, suspect: 0, skipped: 0, errors: 0 })
    expect(body.results).toHaveLength(0)
    expect(getRun('run-recent-busy')?.status).toBe('started')
    expect(getRuntime('rt-recent-busy')?.activeRunId).toBe('run-recent-busy')
    expect(listEvents('turn.reaped')).toHaveLength(0)
  })

  it('concurrent reconciles emit one reaped audit event', async () => {
    seedRun({
      runId: 'run-race',
      hostSessionId: 'hsid-race',
      scopeRef: 'reconcile-active-race',
      runtimeId: 'rt-race',
      runtimeStatus: 'terminated',
    })

    const results = await Promise.all([
      reconcile({ olderThan: '30m', yes: true }),
      reconcile({ olderThan: '30m', yes: true }),
    ])

    expect(results.reduce((count, result) => count + result.summary.reaped, 0)).toBe(1)
    expect(getRun('run-race')?.status).toBe('failed')
    expect(listEvents('turn.reaped')).toHaveLength(1)
  })
})
