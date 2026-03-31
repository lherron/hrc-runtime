/**
 * RED/GREEN tests for hrc-server Phase 6 diagnostics surfaces (T-00973 / T-00974)
 *
 * Tests the diagnostics, listing, and adoption endpoints:
 *   - GET /v1/status — daemon status (uptime, version, socket path, counts)
 *   - GET /v1/health — liveness check
 *   - GET /v1/runtimes — list runtimes with optional ?hostSessionId filter
 *   - GET /v1/launches — list launches with optional ?hostSessionId/?runtimeId filter
 *   - POST /v1/runtimes/adopt — mark orphaned runtime as adopted
 *
 * Pass conditions for Curly (T-00973):
 *   1. GET /v1/health returns 200 with { ok: true }
 *   2. GET /v1/status returns 200 with uptime, socketPath, and aggregate counts
 *      (sessionCount, runtimeCount)
 *   3. GET /v1/runtimes returns all runtimes as JSON array
 *   4. GET /v1/runtimes?hostSessionId=X filters to that session's runtimes
 *   5. GET /v1/runtimes returns empty array when no runtimes exist
 *   6. GET /v1/launches returns all launches as JSON array
 *   7. GET /v1/launches?hostSessionId=X filters by hostSessionId
 *   8. GET /v1/launches?runtimeId=X filters by runtimeId
 *   9. GET /v1/launches returns empty array when no launches exist
 *  10. POST /v1/runtimes/adopt on dead runtime sets adopted=true, status="adopted"
 *  11. POST /v1/runtimes/adopt on active runtime returns 409 CONFLICT
 *  12. POST /v1/runtimes/adopt on unknown runtime returns 404 UNKNOWN_RUNTIME
 *
 * Reference: T-00946 (parent plan), T-00973 (Curly diagnostics), T-00974 (Smokey validation)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcHttpError, HrcLaunchRecord, HrcRuntimeSnapshot } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

function ts(): string {
  return new Date().toISOString()
}

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-phase6-diagnostics-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
})

afterEach(async () => {
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine when no tmux server exists
  }
  await rm(tmpDir, { recursive: true, force: true })
})

function serverOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    ...overrides,
  }
}

/** Helper: seed a session and runtime via DB for listing tests */
function seedRuntime(opts?: {
  scopeRef?: string
  status?: string
  adopted?: boolean
}): {
  hostSessionId: string
  runtimeId: string
} {
  const now = ts()
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const scopeRef = opts?.scopeRef ?? 'project:diag-test'

  const db = openHrcDatabase(dbPath)

  db.continuities.upsert({
    scopeRef,
    laneRef: 'default',
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })
  db.sessions.create({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })
  db.runtimes.create({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: opts?.status ?? 'ready',
    supportsInflightInput: false,
    adopted: opts?.adopted ?? false,
    createdAt: now,
    updatedAt: now,
  })

  db.close()
  return { hostSessionId, runtimeId }
}

/** Helper: seed a launch record for a given runtime */
function seedLaunch(hostSessionId: string, runtimeId: string, opts?: {
  status?: string
}): string {
  const now = ts()
  const launchId = `launch-${randomUUID()}`

  const db = openHrcDatabase(dbPath)
  db.launches.create({
    launchId,
    hostSessionId,
    generation: 1,
    runtimeId,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: join(tmpDir, 'artifacts', launchId),
    status: opts?.status ?? 'exited',
    createdAt: now,
    updatedAt: now,
  })
  db.close()

  return launchId
}

// ---------------------------------------------------------------------------
// 1. GET /v1/health — liveness check
// ---------------------------------------------------------------------------
describe('GET /v1/health', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns 200 with { ok: true }', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// 2. GET /v1/status — daemon status
// ---------------------------------------------------------------------------
describe('GET /v1/status', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns 200 with uptime, socketPath, and aggregate counts', async () => {
    server = await createHrcServer(serverOpts())

    // Seed some data so counts are non-zero
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:status-test/lane:default',
    })

    const res = await fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = await res.json()

    // Must include uptime (number of seconds or milliseconds)
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)

    // Must include socketPath
    expect(body.socketPath).toBe(socketPath)

    // Must include aggregate counts
    expect(typeof body.sessionCount).toBe('number')
    expect(body.sessionCount).toBeGreaterThanOrEqual(1)
    expect(typeof body.runtimeCount).toBe('number')
  })

  it('returns zero counts when daemon has no data', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.sessionCount).toBe(0)
    expect(body.runtimeCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. GET /v1/runtimes — list runtimes
// ---------------------------------------------------------------------------
describe('GET /v1/runtimes', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns empty array when no runtimes exist', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/runtimes')
    expect(res.status).toBe(200)
    const body: HrcRuntimeSnapshot[] = await res.json()
    expect(body).toEqual([])
  })

  it('returns all runtimes as JSON array', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:rt-list-a' })
    const seed2 = seedRuntime({ scopeRef: 'project:rt-list-b' })

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/runtimes')
    expect(res.status).toBe(200)
    const body: HrcRuntimeSnapshot[] = await res.json()
    expect(body.length).toBe(2)

    const ids = body.map((r) => r.runtimeId)
    expect(ids).toContain(seed1.runtimeId)
    expect(ids).toContain(seed2.runtimeId)
  })

  it('filters by hostSessionId query param', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:rt-filter-a' })
    seedRuntime({ scopeRef: 'project:rt-filter-b' })

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket(
      `/v1/runtimes?hostSessionId=${encodeURIComponent(seed1.hostSessionId)}`
    )
    expect(res.status).toBe(200)
    const body: HrcRuntimeSnapshot[] = await res.json()
    expect(body.length).toBe(1)
    expect(body[0]!.runtimeId).toBe(seed1.runtimeId)
    expect(body[0]!.hostSessionId).toBe(seed1.hostSessionId)
  })

  it('returns runtime records with expected shape', async () => {
    seedRuntime()

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/runtimes')
    const body: HrcRuntimeSnapshot[] = await res.json()
    expect(body.length).toBe(1)

    const rt = body[0]!
    expect(rt.runtimeId).toBeString()
    expect(rt.hostSessionId).toBeString()
    expect(rt.scopeRef).toBeString()
    expect(rt.laneRef).toBeString()
    expect(typeof rt.generation).toBe('number')
    expect(rt.transport).toBeString()
    expect(rt.harness).toBeString()
    expect(rt.provider).toBeString()
    expect(rt.status).toBeString()
    expect(typeof rt.adopted).toBe('boolean')
    expect(rt.createdAt).toBeString()
    expect(rt.updatedAt).toBeString()
  })
})

// ---------------------------------------------------------------------------
// 4. GET /v1/launches — list launches
// ---------------------------------------------------------------------------
describe('GET /v1/launches', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns empty array when no launches exist', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/launches')
    expect(res.status).toBe(200)
    const body: HrcLaunchRecord[] = await res.json()
    expect(body).toEqual([])
  })

  it('returns all launches as JSON array', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:launch-list-a' })
    const seed2 = seedRuntime({ scopeRef: 'project:launch-list-b' })
    const launchId1 = seedLaunch(seed1.hostSessionId, seed1.runtimeId)
    const launchId2 = seedLaunch(seed2.hostSessionId, seed2.runtimeId)

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/launches')
    expect(res.status).toBe(200)
    const body: HrcLaunchRecord[] = await res.json()
    expect(body.length).toBe(2)

    const ids = body.map((l) => l.launchId)
    expect(ids).toContain(launchId1)
    expect(ids).toContain(launchId2)
  })

  it('filters by hostSessionId query param', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:launch-filter-host-a' })
    const seed2 = seedRuntime({ scopeRef: 'project:launch-filter-host-b' })
    const launchId1 = seedLaunch(seed1.hostSessionId, seed1.runtimeId)
    seedLaunch(seed2.hostSessionId, seed2.runtimeId)

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket(
      `/v1/launches?hostSessionId=${encodeURIComponent(seed1.hostSessionId)}`
    )
    expect(res.status).toBe(200)
    const body: HrcLaunchRecord[] = await res.json()
    expect(body.length).toBe(1)
    expect(body[0]!.launchId).toBe(launchId1)
  })

  it('filters by runtimeId query param', async () => {
    const seed1 = seedRuntime({ scopeRef: 'project:launch-filter-rt-a' })
    const seed2 = seedRuntime({ scopeRef: 'project:launch-filter-rt-b' })
    const launchId1 = seedLaunch(seed1.hostSessionId, seed1.runtimeId)
    seedLaunch(seed2.hostSessionId, seed2.runtimeId)

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket(
      `/v1/launches?runtimeId=${encodeURIComponent(seed1.runtimeId)}`
    )
    expect(res.status).toBe(200)
    const body: HrcLaunchRecord[] = await res.json()
    expect(body.length).toBe(1)
    expect(body[0]!.launchId).toBe(launchId1)
  })

  it('returns launch records with expected shape', async () => {
    const seed = seedRuntime()
    seedLaunch(seed.hostSessionId, seed.runtimeId)

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/launches')
    const body: HrcLaunchRecord[] = await res.json()
    expect(body.length).toBe(1)

    const launch = body[0]!
    expect(launch.launchId).toBeString()
    expect(launch.hostSessionId).toBeString()
    expect(typeof launch.generation).toBe('number')
    expect(launch.harness).toBeString()
    expect(launch.provider).toBeString()
    expect(launch.status).toBeString()
    expect(launch.createdAt).toBeString()
    expect(launch.updatedAt).toBeString()
  })
})

// ---------------------------------------------------------------------------
// 5. POST /v1/runtimes/adopt — adoption semantics
// ---------------------------------------------------------------------------
describe('POST /v1/runtimes/adopt', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('marks a dead runtime as adopted with status "adopted" and adopted=true', async () => {
    const { runtimeId } = seedRuntime({ status: 'dead' })

    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', { runtimeId })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runtimeId).toBe(runtimeId)
    expect(body.adopted).toBe(true)
    expect(body.status).toBe('adopted')
  })

  it('emits runtime.adopted event on successful adoption', async () => {
    const { runtimeId } = seedRuntime({ status: 'dead' })

    server = await createHrcServer(serverOpts())
    await postJson('/v1/runtimes/adopt', { runtimeId })

    const eventsRes = await fetchSocket('/v1/events')
    const events = (await eventsRes.text())
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    const adoptEvents = events.filter(
      (e: { eventKind: string }) => e.eventKind === 'runtime.adopted'
    )
    expect(adoptEvents.length).toBeGreaterThanOrEqual(1)
    expect(
      adoptEvents.some(
        (e: { eventJson: Record<string, unknown> }) => e.eventJson.runtimeId === runtimeId
      )
    ).toBe(true)
  })

  it('returns 409 CONFLICT when adopting an active (non-dead) runtime', async () => {
    const { runtimeId } = seedRuntime({ status: 'ready' })

    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', { runtimeId })
    expect(res.status).toBe(409)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.CONFLICT)
  })

  it('returns 404 UNKNOWN_RUNTIME for nonexistent runtimeId', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', {
      runtimeId: `rt-nonexistent-${randomUUID()}`,
    })
    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_RUNTIME)
  })

  it('returns 400 for missing runtimeId in body', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/runtimes/adopt', {})
    expect(res.status).toBe(400)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.MALFORMED_REQUEST)
  })
})
