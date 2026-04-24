import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type {
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  SweepRuntimeTransport,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-runtime-sweep-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

type SeedRuntimeOptions = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  transport?: SweepRuntimeTransport | undefined
  status?: string | undefined
  createdAt?: string | undefined
  activeRunId?: string | undefined
  continuationKey?: string | undefined
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function canonicalScopeRef(scopeRef: string): string {
  return scopeRef.startsWith('agent:') ? scopeRef : `agent:${scopeRef}`
}

function seedRuntime(options: SeedRuntimeOptions): void {
  fixture.seedSession(options.hostSessionId, options.scopeRef)

  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const createdAt = options.createdAt ?? now
  const transport = options.transport ?? 'headless'
  const status = options.status ?? (options.activeRunId ? 'busy' : 'ready')
  const scopeRef = canonicalScopeRef(options.scopeRef)

  try {
    if (options.continuationKey) {
      db.sessions.updateContinuation(
        options.hostSessionId,
        { provider: 'anthropic', key: options.continuationKey },
        now
      )
    }

    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport,
      harness: transport === 'tmux' ? 'claude-code' : 'agent-sdk',
      provider: 'anthropic',
      status,
      ...(transport === 'tmux'
        ? {
            tmuxJson: {
              socketPath: fixture.tmuxSocketPath,
              sessionName: 'hrc-missing-session',
              windowName: 'main',
              sessionId: '$dead',
              windowId: '@dead',
              paneId: '%dead',
            },
          }
        : {}),
      supportsInflightInput: false,
      adopted: false,
      ...(options.activeRunId ? { activeRunId: options.activeRunId } : {}),
      lastActivityAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    })

    if (options.activeRunId) {
      db.runs.insert({
        runId: options.activeRunId,
        hostSessionId: options.hostSessionId,
        runtimeId: options.runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport,
        status: 'running',
        acceptedAt: createdAt,
        startedAt: createdAt,
        updatedAt: createdAt,
      })
    }
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

function readContinuationJson(hostSessionId: string): string | null {
  const db = new Database(fixture.dbPath)
  try {
    return (
      db
        .query<{ continuation_json: string | null }, [string]>(
          'SELECT continuation_json FROM sessions WHERE host_session_id = ?'
        )
        .get(hostSessionId)?.continuation_json ?? null
    )
  } finally {
    db.close()
  }
}

function listRuntimeEvents(eventKind: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((event) => event.eventKind === eventKind)
  } finally {
    db.close()
  }
}

function eventRuntimeIds(events: HrcLifecycleEvent[]): string[] {
  return events.map((event) => event.runtimeId).filter((runtimeId) => runtimeId !== undefined)
}

async function sweep(body: SweepRuntimesRequest = {}): Promise<SweepRuntimesResponse> {
  const res = await fixture.postJson('/v1/runtimes/sweep', body)
  expect(res.status).toBe(200)
  return (await res.json()) as SweepRuntimesResponse
}

describe('POST /v1/runtimes/sweep', () => {
  it('returns an empty summary and emits sweep_completed when there are no matches', async () => {
    const body = await sweep({ transport: 'headless', olderThan: '1h' })

    expect(body.results).toEqual([])
    expect(body.summary).toEqual({
      type: 'summary',
      matched: 0,
      terminated: 0,
      skipped: 0,
      errors: 0,
    })

    const sweepEvents = listRuntimeEvents('runtime.sweep_completed')
    expect(sweepEvents).toHaveLength(1)
    expect(sweepEvents[0]?.payload).toMatchObject({
      matched: 0,
      terminated: 0,
      skipped: 0,
      errors: 0,
    })
  })

  it('terminates three stale headless runtimes and emits per-runtime plus summary events', async () => {
    for (const suffix of ['one', 'two', 'three']) {
      seedRuntime({
        runtimeId: `rt-stale-${suffix}`,
        hostSessionId: `hsid-stale-${suffix}`,
        scopeRef: `sweep-stale-${suffix}`,
        transport: 'headless',
        createdAt: isoMinutesAgo(180),
      })
    }

    const body = await sweep({ transport: 'headless', olderThan: '1h' })

    expect(body.summary).toMatchObject({
      matched: 3,
      terminated: 3,
      skipped: 0,
      errors: 0,
    })
    expect(body.results.map((result) => result.runtimeId).sort()).toEqual([
      'rt-stale-one',
      'rt-stale-three',
      'rt-stale-two',
    ])
    expect(body.results.every((result) => result.status === 'terminated')).toBe(true)
    expect(getRuntime('rt-stale-one')?.status).toBe('terminated')
    expect(getRuntime('rt-stale-two')?.status).toBe('terminated')
    expect(getRuntime('rt-stale-three')?.status).toBe('terminated')

    expect(eventRuntimeIds(listRuntimeEvents('runtime.terminated')).sort()).toEqual([
      'rt-stale-one',
      'rt-stale-three',
      'rt-stale-two',
    ])
    expect(listRuntimeEvents('runtime.sweep_completed')).toHaveLength(1)
  })

  it('honors the transport filter and only touches matching rows', async () => {
    seedRuntime({
      runtimeId: 'rt-filter-headless',
      hostSessionId: 'hsid-filter-headless',
      scopeRef: 'sweep-filter-headless',
      transport: 'headless',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-filter-sdk',
      hostSessionId: 'hsid-filter-sdk',
      scopeRef: 'sweep-filter-sdk',
      transport: 'sdk',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-filter-tmux',
      hostSessionId: 'hsid-filter-tmux',
      scopeRef: 'sweep-filter-tmux',
      transport: 'tmux',
      createdAt: isoMinutesAgo(180),
    })

    const body = await sweep({ transport: 'headless', olderThan: '1h' })

    expect(body.summary).toMatchObject({ matched: 1, terminated: 1, skipped: 0, errors: 0 })
    expect(body.results.map((result) => result.runtimeId)).toEqual(['rt-filter-headless'])
    expect(getRuntime('rt-filter-headless')?.status).toBe('terminated')
    expect(getRuntime('rt-filter-sdk')?.status).toBe('ready')
    expect(getRuntime('rt-filter-tmux')?.status).toBe('ready')
  })

  it('honors scope prefix filtering', async () => {
    seedRuntime({
      runtimeId: 'rt-scope-match-a',
      hostSessionId: 'hsid-scope-match-a',
      scopeRef: 'sweep-scope/team-a/main',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-scope-match-b',
      hostSessionId: 'hsid-scope-match-b',
      scopeRef: 'sweep-scope/team-a/worker',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-scope-other',
      hostSessionId: 'hsid-scope-other',
      scopeRef: 'sweep-scope/team-b/main',
      createdAt: isoMinutesAgo(180),
    })

    const body = await sweep({
      transport: 'headless',
      olderThan: '1h',
      scope: 'agent:sweep-scope/team-a',
    })

    expect(body.summary).toMatchObject({ matched: 2, terminated: 2, skipped: 0, errors: 0 })
    expect(body.results.map((result) => result.runtimeId).sort()).toEqual([
      'rt-scope-match-a',
      'rt-scope-match-b',
    ])
    expect(getRuntime('rt-scope-other')?.status).toBe('ready')
  })

  it('honors olderThan by comparing runtime createdAt to now', async () => {
    seedRuntime({
      runtimeId: 'rt-old-enough',
      hostSessionId: 'hsid-old-enough',
      scopeRef: 'sweep-age-old',
      createdAt: isoMinutesAgo(120),
    })
    seedRuntime({
      runtimeId: 'rt-too-new',
      hostSessionId: 'hsid-too-new',
      scopeRef: 'sweep-age-new',
      createdAt: isoMinutesAgo(15),
    })

    const body = await sweep({ transport: 'headless', olderThan: '1h' })

    expect(body.summary).toMatchObject({ matched: 1, terminated: 1, skipped: 0, errors: 0 })
    expect(body.results.map((result) => result.runtimeId)).toEqual(['rt-old-enough'])
    expect(getRuntime('rt-old-enough')?.status).toBe('terminated')
    expect(getRuntime('rt-too-new')?.status).toBe('ready')
  })

  it('honors explicit status filters instead of the ready,busy default', async () => {
    seedRuntime({
      runtimeId: 'rt-status-starting',
      hostSessionId: 'hsid-status-starting',
      scopeRef: 'sweep-status-starting',
      status: 'starting',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-status-ready',
      hostSessionId: 'hsid-status-ready',
      scopeRef: 'sweep-status-ready',
      status: 'ready',
      createdAt: isoMinutesAgo(180),
    })

    const body = await sweep({ transport: 'headless', olderThan: '1h', status: ['starting'] })

    expect(body.summary).toMatchObject({ matched: 1, terminated: 1, skipped: 0, errors: 0 })
    expect(body.results.map((result) => result.runtimeId)).toEqual(['rt-status-starting'])
    expect(getRuntime('rt-status-starting')?.status).toBe('terminated')
    expect(getRuntime('rt-status-ready')?.status).toBe('ready')
  })

  it('second concurrent sweep sees no matches once the first sweep has bumped lastActivityAt', async () => {
    // Under lastActivityAt-based staleness, once the first sweep terminates a row
    // its activity timestamp is refreshed to "now", so a subsequent sweep's match
    // phase naturally excludes it. The within-iteration atomic claim guard (see
    // claimRuntimeForSweep) remains in place for the narrower race where both
    // sweeps' match phases interleave with their termination loops.
    for (const suffix of ['one', 'two']) {
      seedRuntime({
        runtimeId: `rt-race-${suffix}`,
        hostSessionId: `hsid-race-${suffix}`,
        scopeRef: `sweep-race-${suffix}`,
        createdAt: isoMinutesAgo(180),
      })
    }

    const [first, second] = await Promise.all([
      sweep({ transport: 'headless', olderThan: '1h' }),
      sweep({ transport: 'headless', olderThan: '1h' }),
    ])

    const summaries = [first.summary, second.summary].sort(
      (left, right) => right.terminated - left.terminated
    )
    expect(summaries[0]).toMatchObject({ matched: 2, terminated: 2, skipped: 0, errors: 0 })
    expect(summaries[1]).toMatchObject({ matched: 0, terminated: 0, skipped: 0, errors: 0 })
    expect(listRuntimeEvents('runtime.terminated')).toHaveLength(2)
    expect(listRuntimeEvents('runtime.sweep_completed')).toHaveLength(2)
  })

  it('nulls continuation_json for matched headless sessions with dropContinuation', async () => {
    seedRuntime({
      runtimeId: 'rt-drop-explicit',
      hostSessionId: 'hsid-drop-explicit',
      scopeRef: 'sweep-drop-explicit',
      continuationKey: 'cont-drop-explicit',
      createdAt: isoMinutesAgo(180),
    })

    const body = await sweep({ transport: 'headless', olderThan: '1h', dropContinuation: true })

    expect(body.summary).toMatchObject({ matched: 1, terminated: 1, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runtimeId: 'rt-drop-explicit',
      droppedContinuation: true,
    })
    expect(readContinuationJson('hsid-drop-explicit')).toBeNull()
  })

  it('applies default continuation drop only to busy non-tmux runtimes', async () => {
    seedRuntime({
      runtimeId: 'rt-default-busy',
      hostSessionId: 'hsid-default-busy',
      scopeRef: 'sweep-default-busy',
      activeRunId: 'run-default-busy',
      continuationKey: 'cont-default-busy',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-default-ready',
      hostSessionId: 'hsid-default-ready',
      scopeRef: 'sweep-default-ready',
      continuationKey: 'cont-default-ready',
      createdAt: isoMinutesAgo(180),
    })

    const body = await sweep({ transport: 'headless', olderThan: '1h' })

    expect(body.summary).toMatchObject({ matched: 2, terminated: 2, skipped: 0, errors: 0 })
    expect(body.results.find((result) => result.runtimeId === 'rt-default-busy')).toMatchObject({
      droppedContinuation: true,
    })
    expect(body.results.find((result) => result.runtimeId === 'rt-default-ready')).toMatchObject({
      droppedContinuation: false,
    })
    expect(readContinuationJson('hsid-default-busy')).toBeNull()
    expect(readContinuationJson('hsid-default-ready')).not.toBeNull()
  })

  it('emits exactly one sweep_completed event per sweep call', async () => {
    seedRuntime({
      runtimeId: 'rt-summary-once',
      hostSessionId: 'hsid-summary-once',
      scopeRef: 'sweep-summary-once',
      createdAt: isoMinutesAgo(180),
    })

    await sweep({ transport: 'headless', olderThan: '1h' })

    const sweepEvents = listRuntimeEvents('runtime.sweep_completed')
    expect(sweepEvents).toHaveLength(1)
    expect(sweepEvents[0]?.payload).toMatchObject({
      matched: 1,
      terminated: 1,
      skipped: 0,
      errors: 0,
    })
  })
})
