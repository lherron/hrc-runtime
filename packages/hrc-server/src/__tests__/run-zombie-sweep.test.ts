import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-run-zombie-sweep-')
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
  runtimeId?: string | undefined
  transport?: 'headless' | 'sdk' | 'tmux' | undefined
  status?: string | undefined
  acceptedAt?: string | null | undefined
  startedAt?: string | undefined
  updatedAt?: string | undefined
  completedAt?: string | undefined
  activeRunOwner?: boolean | undefined
  runtimeStatus?: string | undefined
  tmuxSessionName?: string | undefined
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
  const transport = options.transport ?? 'headless'
  const runtimeId = options.runtimeId

  try {
    if (runtimeId) {
      db.runtimes.insert({
        runtimeId,
        hostSessionId: options.hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport,
        harness: transport === 'tmux' ? 'claude-code' : 'agent-sdk',
        provider: 'anthropic',
        status: options.runtimeStatus ?? (options.activeRunOwner ? 'busy' : 'ready'),
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
        ...(options.activeRunOwner ? { activeRunId: options.runId } : {}),
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }

    db.runs.insert({
      runId: options.runId,
      hostSessionId: options.hostSessionId,
      ...(runtimeId ? { runtimeId } : {}),
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport,
      status: options.status ?? 'running',
      ...(options.acceptedAt === null ? {} : { acceptedAt: options.acceptedAt ?? timestamp }),
      ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      ...(options.completedAt ? { completedAt: options.completedAt } : {}),
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }
}

function appendRunEvent(runId: string, ts: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  const run = db.runs.getByRunId(runId)
  if (!run) throw new Error(`missing run ${runId}`)
  try {
    db.hrcEvents.append({
      ts,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
      ...(run.runtimeId ? { runtimeId: run.runtimeId } : {}),
      runId,
      category: 'turn',
      eventKind: 'turn.message',
      replayed: false,
      payload: { text: 'activity' },
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

async function sweep(body: SweepZombieRunsRequest = {}): Promise<SweepZombieRunsResponse> {
  const res = await fixture.postJson('/v1/runs/sweep-zombies', body)
  expect(res.status).toBe(200)
  return (await res.json()) as SweepZombieRunsResponse
}

describe('POST /v1/runs/sweep-zombies', () => {
  it('dry-run reports eligible runs without mutating rows or emitting audit events', async () => {
    seedRun({
      runId: 'run-dry',
      hostSessionId: 'hsid-dry',
      scopeRef: 'sweep-zombie-dry',
      runtimeId: 'rt-dry',
      updatedAt: isoMinutesAgo(75),
      activeRunOwner: true,
    })

    const body = await sweep({ olderThan: '30m', dryRun: true })

    expect(body.summary).toMatchObject({ matched: 1, zombied: 0, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runId: 'run-dry',
      status: 'matched',
      observedSource: 'accepted_at',
      runtimeOwnershipCleared: false,
    })
    expect(getRun('run-dry')?.status).toBe('running')
    expect(getRuntime('rt-dry')?.activeRunId).toBe('run-dry')
    expect(listEvents('turn.zombied')).toHaveLength(0)
  })

  it('zombies stale active runs by latest correlated event timestamp', async () => {
    seedRun({
      runId: 'run-event-old',
      hostSessionId: 'hsid-event-old',
      scopeRef: 'sweep-zombie-event-old',
      runtimeId: 'rt-event-old',
      updatedAt: isoMinutesAgo(90),
    })
    seedRun({
      runId: 'run-event-fresh',
      hostSessionId: 'hsid-event-fresh',
      scopeRef: 'sweep-zombie-event-fresh',
      runtimeId: 'rt-event-fresh',
      updatedAt: isoMinutesAgo(90),
    })
    appendRunEvent('run-event-old', isoMinutesAgo(70))
    appendRunEvent('run-event-fresh', isoMinutesAgo(5))

    const body = await sweep({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 1, zombied: 1, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({ runId: 'run-event-old', observedSource: 'event' })
    expect(getRun('run-event-old')?.status).toBe('zombie')
    expect(getRun('run-event-old')?.errorCode).toBe('run_zombie_timeout')
    expect(getRun('run-event-fresh')?.status).toBe('running')
    expect(listEvents('turn.zombied')).toHaveLength(1)
  })

  it('uses started/accepted/updated fallback only when a run has no correlated events', async () => {
    seedRun({
      runId: 'run-started-fallback',
      hostSessionId: 'hsid-started-fallback',
      scopeRef: 'sweep-zombie-started-fallback',
      acceptedAt: isoMinutesAgo(90),
      startedAt: isoMinutesAgo(70),
      updatedAt: isoMinutesAgo(10),
    })
    seedRun({
      runId: 'run-updated-fallback',
      hostSessionId: 'hsid-updated-fallback',
      scopeRef: 'sweep-zombie-updated-fallback',
      acceptedAt: null,
      updatedAt: isoMinutesAgo(70),
    })

    const body = await sweep({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 2, zombied: 2 })
    expect(body.results.map((result) => [result.runId, result.observedSource]).sort()).toEqual([
      ['run-started-fallback', 'started_at'],
      ['run-updated-fallback', 'updated_at'],
    ])
    const payloads = listEvents('turn.zombied').map(
      (event) => event.payload as Record<string, unknown>
    )
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fallbackTimestampSource: 'started_at' }),
        expect.objectContaining({ fallbackTimestampSource: 'updated_at' }),
      ])
    )
  })

  it('never touches completed, failed, or already zombie runs', async () => {
    for (const status of ['completed', 'failed', 'zombie']) {
      seedRun({
        runId: `run-terminal-${status}`,
        hostSessionId: `hsid-terminal-${status}`,
        scopeRef: `sweep-zombie-terminal-${status}`,
        status,
        completedAt: isoMinutesAgo(60),
        updatedAt: isoMinutesAgo(60),
      })
    }

    const body = await sweep({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 0, zombied: 0, skipped: 0, errors: 0 })
    expect(listEvents('turn.zombied')).toHaveLength(0)
  })

  it('clears active runtime ownership and marks unconfirmed runtime health stale', async () => {
    seedRun({
      runId: 'run-owned-headless',
      hostSessionId: 'hsid-owned-headless',
      scopeRef: 'sweep-zombie-owned-headless',
      runtimeId: 'rt-owned-headless',
      updatedAt: isoMinutesAgo(60),
      activeRunOwner: true,
    })

    const body = await sweep({ olderThan: '30m', yes: true })

    expect(body.results[0]).toMatchObject({
      runId: 'run-owned-headless',
      status: 'zombied',
      runtimeOwnershipCleared: true,
      runtimeStatus: 'stale',
    })
    expect(getRuntime('rt-owned-headless')?.activeRunId).toBeUndefined()
    expect(getRuntime('rt-owned-headless')?.status).toBe('stale')
  })

  it('does not zombie sdk or tmux active runs even when stale', async () => {
    seedRun({
      runId: 'run-owned-sdk',
      hostSessionId: 'hsid-owned-sdk',
      scopeRef: 'sweep-zombie-owned-sdk',
      runtimeId: 'rt-owned-sdk',
      transport: 'sdk',
      updatedAt: isoMinutesAgo(60),
      activeRunOwner: true,
    })
    seedRun({
      runId: 'run-owned-tmux',
      hostSessionId: 'hsid-owned-tmux',
      scopeRef: 'sweep-zombie-owned-tmux',
      runtimeId: 'rt-owned-tmux',
      transport: 'tmux',
      updatedAt: isoMinutesAgo(60),
      activeRunOwner: true,
    })

    const body = await sweep({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ matched: 0, zombied: 0, skipped: 0, errors: 0 })
    expect(getRun('run-owned-sdk')?.status).toBe('running')
    expect(getRun('run-owned-tmux')?.status).toBe('running')
    expect(getRuntime('rt-owned-sdk')?.activeRunId).toBe('run-owned-sdk')
    expect(getRuntime('rt-owned-tmux')?.activeRunId).toBe('run-owned-tmux')
    expect(listEvents('turn.zombied')).toHaveLength(0)
  })

  it('concurrent mutation sweeps emit one zombie audit event', async () => {
    seedRun({
      runId: 'run-race',
      hostSessionId: 'hsid-race',
      scopeRef: 'sweep-zombie-race',
      runtimeId: 'rt-race',
      updatedAt: isoMinutesAgo(60),
      activeRunOwner: true,
    })

    const results = await Promise.all([
      sweep({ olderThan: '30m', yes: true }),
      sweep({ olderThan: '30m', yes: true }),
    ])

    expect(results.reduce((count, result) => count + result.summary.zombied, 0)).toBe(1)
    expect(getRun('run-race')?.status).toBe('zombie')
    expect(listEvents('turn.zombied')).toHaveLength(1)
  })
})
