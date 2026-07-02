import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type {
  HrcRuntimeSnapshot,
  PruneRuntimesRequest,
  PruneRuntimesResponse,
  SweepRuntimeTransport,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-runtime-prune-')
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
  childPid?: number | undefined
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
  const status = options.status ?? (options.activeRunId ? 'busy' : 'stale')
  const scopeRef = canonicalScopeRef(options.scopeRef)

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
      ...(options.childPid !== undefined ? { childPid: options.childPid } : {}),
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

/**
 * Seed a raw dependent event row pinned to a runtime. `events.runtime_id`
 * FK-references `runtimes(runtime_id)` with no ON DELETE CASCADE, so a runtime
 * that has any dependent row can only be deleted by the prune cascade.
 */
function seedRuntimeEvent(runtimeId: string, hostSessionId: string, scopeRef: string): void {
  const db = new Database(fixture.dbPath)
  try {
    db.query(
      `INSERT INTO events (ts, host_session_id, scope_ref, lane_ref, generation, run_id, runtime_id, source, event_kind, event_json)
       VALUES (?, ?, ?, 'default', 1, NULL, ?, 'hrc', 'runtime.stale', '{}')`
    ).run(fixture.now(), hostSessionId, canonicalScopeRef(scopeRef), runtimeId)
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

function countRuntimeEvents(runtimeId: string): number {
  const db = new Database(fixture.dbPath)
  try {
    return (
      db
        .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM events WHERE runtime_id = ?')
        .get(runtimeId)?.n ?? 0
    )
  } finally {
    db.close()
  }
}

async function prune(body: PruneRuntimesRequest = {}): Promise<PruneRuntimesResponse> {
  const res = await fixture.postJson('/v1/runtimes/prune', body)
  expect(res.status).toBe(200)
  return (await res.json()) as PruneRuntimesResponse
}

describe('POST /v1/runtimes/prune', () => {
  it('prunes an orphaned stale record (and its dependent event rows) when --yes', async () => {
    seedRuntime({
      runtimeId: 'rt-orphan',
      hostSessionId: 'hsid-orphan',
      scopeRef: 'prune-orphan',
      transport: 'tmux',
      status: 'stale',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntimeEvent('rt-orphan', 'hsid-orphan', 'prune-orphan')
    expect(countRuntimeEvents('rt-orphan')).toBe(1)

    const body = await prune({ transport: 'tmux', olderThan: '1h', yes: true })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 1, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runtimeId: 'rt-orphan',
      transport: 'tmux',
      status: 'pruned',
    })
    expect(getRuntime('rt-orphan')).toBeNull()
    expect(countRuntimeEvents('rt-orphan')).toBe(0)
  })

  it('preserves a record with an active run even when the status filter matches', async () => {
    seedRuntime({
      runtimeId: 'rt-active',
      hostSessionId: 'hsid-active',
      scopeRef: 'prune-active',
      transport: 'headless',
      status: 'stale',
      activeRunId: 'run-active',
      createdAt: isoMinutesAgo(180),
    })

    const body = await prune({ transport: 'headless', olderThan: '1h', yes: true })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 0, skipped: 1, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runtimeId: 'rt-active',
      status: 'skipped',
      reason: 'active_run',
    })
    expect(getRuntime('rt-active')).not.toBeNull()
  })

  it('preserves a live/ready record even when the caller overrides --status', async () => {
    seedRuntime({
      runtimeId: 'rt-ready',
      hostSessionId: 'hsid-ready',
      scopeRef: 'prune-ready',
      transport: 'headless',
      status: 'ready',
      createdAt: isoMinutesAgo(180),
    })

    const body = await prune({
      transport: 'headless',
      olderThan: '1h',
      status: ['ready'],
      yes: true,
    })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 0, skipped: 1, errors: 0 })
    expect(body.results[0]).toMatchObject({ runtimeId: 'rt-ready', status: 'skipped' })
    expect(body.results[0]?.reason).toContain('status_not_prunable')
    expect(getRuntime('rt-ready')).not.toBeNull()
  })

  it('preserves a record whose tracked process is still alive', async () => {
    seedRuntime({
      runtimeId: 'rt-livepid',
      hostSessionId: 'hsid-livepid',
      scopeRef: 'prune-livepid',
      transport: 'headless',
      status: 'stale',
      childPid: process.pid,
      createdAt: isoMinutesAgo(180),
    })

    const body = await prune({ transport: 'headless', olderThan: '1h', yes: true })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 0, skipped: 1, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runtimeId: 'rt-livepid',
      status: 'skipped',
      reason: 'live_process',
    })
    expect(getRuntime('rt-livepid')).not.toBeNull()
  })

  it('dry-run reports would-prune dispositions but mutates nothing', async () => {
    seedRuntime({
      runtimeId: 'rt-dry',
      hostSessionId: 'hsid-dry',
      scopeRef: 'prune-dry',
      transport: 'headless',
      status: 'stale',
      createdAt: isoMinutesAgo(180),
    })

    const body = await prune({ transport: 'headless', olderThan: '1h', dryRun: true })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 1, skipped: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runtimeId: 'rt-dry',
      status: 'pruned',
      reason: 'dry_run',
    })
    expect(getRuntime('rt-dry')).not.toBeNull()
  })

  it('does not mutate when --yes is absent even without an explicit dry-run', async () => {
    seedRuntime({
      runtimeId: 'rt-noyes',
      hostSessionId: 'hsid-noyes',
      scopeRef: 'prune-noyes',
      transport: 'headless',
      status: 'stale',
      createdAt: isoMinutesAgo(180),
    })

    const body = await prune({ transport: 'headless', olderThan: '1h' })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 1, skipped: 0 })
    expect(getRuntime('rt-noyes')).not.toBeNull()
  })

  it('honors the older-than age filter', async () => {
    seedRuntime({
      runtimeId: 'rt-old',
      hostSessionId: 'hsid-old',
      scopeRef: 'prune-age-old',
      transport: 'headless',
      status: 'stale',
      createdAt: isoMinutesAgo(120),
    })
    seedRuntime({
      runtimeId: 'rt-new',
      hostSessionId: 'hsid-new',
      scopeRef: 'prune-age-new',
      transport: 'headless',
      status: 'stale',
      createdAt: isoMinutesAgo(15),
    })

    const body = await prune({ transport: 'headless', olderThan: '1h', yes: true })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 1, skipped: 0, errors: 0 })
    expect(body.results.map((r) => r.runtimeId)).toEqual(['rt-old'])
    expect(getRuntime('rt-old')).toBeNull()
    expect(getRuntime('rt-new')).not.toBeNull()
  })

  it('defaults to the stale status filter and leaves ready runtimes untouched', async () => {
    seedRuntime({
      runtimeId: 'rt-default-stale',
      hostSessionId: 'hsid-default-stale',
      scopeRef: 'prune-default-stale',
      transport: 'headless',
      status: 'stale',
      createdAt: isoMinutesAgo(180),
    })
    seedRuntime({
      runtimeId: 'rt-default-ready',
      hostSessionId: 'hsid-default-ready',
      scopeRef: 'prune-default-ready',
      transport: 'headless',
      status: 'ready',
      createdAt: isoMinutesAgo(180),
    })

    const body = await prune({ transport: 'headless', olderThan: '1h', yes: true })

    expect(body.summary).toMatchObject({ matched: 1, pruned: 1, skipped: 0, errors: 0 })
    expect(body.results.map((r) => r.runtimeId)).toEqual(['rt-default-stale'])
    expect(getRuntime('rt-default-stale')).toBeNull()
    expect(getRuntime('rt-default-ready')).not.toBeNull()
  })

  it('is idempotent and safe to re-run', async () => {
    seedRuntime({
      runtimeId: 'rt-idem',
      hostSessionId: 'hsid-idem',
      scopeRef: 'prune-idem',
      transport: 'headless',
      status: 'stale',
      createdAt: isoMinutesAgo(180),
    })

    const first = await prune({ transport: 'headless', olderThan: '1h', yes: true })
    expect(first.summary).toMatchObject({ matched: 1, pruned: 1 })
    expect(getRuntime('rt-idem')).toBeNull()

    const second = await prune({ transport: 'headless', olderThan: '1h', yes: true })
    expect(second.summary).toMatchObject({ matched: 0, pruned: 0, skipped: 0, errors: 0 })
  })
})
