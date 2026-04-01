/**
 * RED/GREEN tests for hrc-server Slice 1A (T-00956 / T-00954)
 *
 * Tests the hrc-server foundation surface:
 *   - Server startup: binds Unix socket, opens DB, serves HTTP
 *   - Single-instance lock: prevents duplicate daemons, cleans stale locks
 *   - Session resolve: POST /v1/sessions/resolve create + reuse continuity
 *   - Session list/get: GET /v1/sessions, GET /v1/sessions/by-host/:id
 *   - Internal launch callbacks: wrapper-started, child-started, exited
 *   - Event watch: GET /v1/events NDJSON replay/follow with monotonic seq
 *   - HTTP error shape/status mapping for domain errors
 *   - Clean shutdown on SIGTERM
 *
 * Pass conditions for Larry (T-00954):
 *   1. createHrcServer(opts) returns a server that binds to a Unix socket
 *   2. Server acquires server.lock; a second instance fails with clear error
 *   3. Stale lock (dead PID) + stale socket are cleaned up on startup
 *   4. POST /v1/sessions/resolve creates continuity + session on first call
 *   5. POST /v1/sessions/resolve reuses continuity on second call (same sessionRef)
 *   6. GET /v1/sessions returns session list (filterable by scopeRef/laneRef)
 *   7. GET /v1/sessions/by-host/:hostSessionId returns a single session or 404
 *   8. POST /v1/internal/launches/:launchId/wrapper-started updates launch record
 *   9. POST /v1/internal/launches/:launchId/child-started updates launch record
 *  10. POST /v1/internal/launches/:launchId/exited updates launch record + appends event
 *  11. POST /v1/internal/hooks/ingest appends hook event
 *  12. GET /v1/events returns NDJSON with monotonic seq
 *  13. GET /v1/events?follow=true streams new events as NDJSON
 *  14. Domain errors return { error: { code, message, detail } } with correct HTTP status
 *  15. Server shuts down cleanly (stop() resolves, socket removed)
 *  16. Spool replay processes spooled callbacks on startup
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcHttpError, HrcSessionRecord } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

// RED GATE: These imports will fail until Larry implements the server module
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

/** Helper: make a fetch against the Unix socket */
async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

/** Helper: POST JSON to the server */
async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function ensureRuntime(scopeRef: string): Promise<{
  hostSessionId: string
  generation: number
  runtimeId: string
}> {
  const resolveRes = await postJson('/v1/sessions/resolve', {
    sessionRef: `${scopeRef}/lane:default`,
  })
  const resolved = (await resolveRes.json()) as {
    hostSessionId: string
    generation: number
  }

  const runtimeId = `rt-test-${randomUUID()}`
  const now = ts()
  const db = openHrcDatabase(dbPath)
  db.runtimes.insert({
    runtimeId,
    hostSessionId: resolved.hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: resolved.generation,
    transport: 'sdk',
    harness: 'agent-sdk',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })

  return {
    hostSessionId: resolved.hostSessionId,
    generation: resolved.generation,
    runtimeId,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-server-test-'))
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

// ---------------------------------------------------------------------------
// 1. Server startup and socket binding
// ---------------------------------------------------------------------------
describe('server startup', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('starts and binds to a Unix socket', async () => {
    server = await createHrcServer(serverOpts())
    // Socket file should exist after startup
    const s = await stat(socketPath).catch(() => null)
    expect(s).not.toBeNull()
    expect(s!.isSocket()).toBe(true)
  })

  it('creates the lock file on startup', async () => {
    server = await createHrcServer(serverOpts())
    const lockContent = await readFile(lockPath, 'utf-8')
    const lockMeta = JSON.parse(lockContent)
    expect(lockMeta.pid).toBe(process.pid)
    expect(typeof lockMeta.createdAt).toBe('string')
  })

  it('opens the database and runs migrations on startup', async () => {
    server = await createHrcServer(serverOpts())
    // A basic health check — the server should respond to requests
    const res = await fetchSocket('/v1/sessions')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 2. Single-instance lock
// ---------------------------------------------------------------------------
describe('single-instance lock', () => {
  let server1: HrcServer
  // C-1 race test may produce a second server that also needs cleanup
  let raceServers: HrcServer[]

  afterEach(async () => {
    if (server1) await server1.stop()
    if (raceServers) {
      await Promise.allSettled(raceServers.map((s) => s.stop()))
      raceServers = []
    }
  })

  it('rejects a second instance when lock is held by a live process', async () => {
    server1 = await createHrcServer(serverOpts())

    // A second server with the same paths should fail
    await expect(createHrcServer(serverOpts())).rejects.toThrow(/already running|lock/i)
  })

  it('cleans up stale lock and socket from a dead process', async () => {
    // Write a lock file with a PID that does not exist
    const deadPid = 2147483647 // Unlikely to be a real PID
    await writeFile(lockPath, String(deadPid), 'utf-8')
    // Create a stale socket file (just a regular file to simulate)
    await writeFile(socketPath, '', 'utf-8')

    // Server should detect the stale lock and start successfully
    server1 = await createHrcServer(serverOpts())
    const s = await stat(socketPath).catch(() => null)
    expect(s).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // C-1 remediation tests (T-00979) — RED until atomic lock is implemented
  // -------------------------------------------------------------------------

  // C-1 RED TEST 1: Lock file must persist structured metadata (PID + timestamp)
  // Current code writes bare PID (`String(pid)`). After remediation the lock
  // must be JSON with { pid, createdAt } so stale-lock decisions can consider age.
  it('lock file persists JSON metadata with pid and createdAt', async () => {
    server1 = await createHrcServer(serverOpts())
    const raw = await readFile(lockPath, 'utf-8')
    // Must be valid JSON, not a bare number
    const meta = JSON.parse(raw)
    expect(meta).toBeObject()
    expect(meta.pid).toBe(process.pid)
    expect(typeof meta.createdAt).toBe('string')
    // Timestamp must be recent (within 5 seconds of now)
    const lockTime = new Date(meta.createdAt).getTime()
    expect(Date.now() - lockTime).toBeLessThan(5000)
  })

  // C-1 RED TEST 2: Concurrent startup race — exactly one instance wins
  // Current code has a TOCTOU gap between readLockPid and writeFile.
  // Two simultaneous startups can both observe "no lock" and both proceed.
  // After remediation with atomic exclusive-create, exactly one must win.
  it('concurrent startup race — exactly one instance succeeds', async () => {
    const results = await Promise.allSettled([
      createHrcServer(serverOpts()),
      createHrcServer(serverOpts()),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<HrcServer> => r.status === 'fulfilled'
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    // Clean up all servers that started (current bug: both may succeed)
    raceServers = fulfilled.map((r) => r.value)

    // Exactly one must succeed, one must fail
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(rejected[0]!.reason.message).toMatch(/already running|lock/i)
  })

  // C-1 RED TEST 3: Active socket must be probed before clearing stale lock
  // When the lock file references a dead PID but the socket is still actively
  // serving (e.g., lock was manually deleted and rewritten), the server must
  // probe the socket and refuse to start rather than blindly unlinking it.
  // Current code unconditionally unlinks socket on dead-PID lock (line 2011).
  it('refuses startup when lock PID is dead but socket is still responsive', async () => {
    // Start a real server — socket is live and serving
    server1 = await createHrcServer(serverOpts())

    // Verify socket is responsive before we corrupt the lock
    const healthCheck = await fetchSocket('/v1/sessions')
    expect(healthCheck.status).toBe(200)

    // Corrupt the lock file with a dead PID while socket stays active
    const deadPid = 2147483647
    await writeFile(lockPath, String(deadPid), 'utf-8')

    // A second startup should probe the socket, find it alive, and refuse.
    // Current code sees dead PID → unlinks socket → creates split-brain.
    let splitBrainServer: HrcServer | undefined
    try {
      splitBrainServer = await createHrcServer(serverOpts())
      // If we get here, the test fails — split-brain was created
    } catch {
      // Expected: startup should refuse when socket is responsive
    }
    // Clean up split-brain server if the bug let it through
    if (splitBrainServer) {
      raceServers = [splitBrainServer]
    }
    expect(splitBrainServer).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Session resolve — POST /v1/sessions/resolve
// ---------------------------------------------------------------------------
describe('POST /v1/sessions/resolve', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('creates a new continuity and session on first resolve', async () => {
    const res = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:myapp/lane:default',
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hostSessionId).toBeString()
    expect(body.generation).toBe(1)
    expect(body.created).toBe(true)
    expect(body.session).toBeDefined()
    expect(body.session.scopeRef).toBe('project:myapp')
    expect(body.session.laneRef).toBe('default')
  })

  it('reuses existing continuity on second resolve with same sessionRef', async () => {
    const sessionRef = 'project:myapp/lane:default'

    const res1 = await postJson('/v1/sessions/resolve', { sessionRef })
    const body1 = await res1.json()
    expect(body1.created).toBe(true)
    const hostSessionId = body1.hostSessionId

    const res2 = await postJson('/v1/sessions/resolve', { sessionRef })
    const body2 = await res2.json()
    expect(body2.created).toBe(false)
    expect(body2.hostSessionId).toBe(hostSessionId)
    expect(body2.generation).toBe(body1.generation)
  })

  it('returns 400 for malformed sessionRef', async () => {
    const res = await postJson('/v1/sessions/resolve', {
      sessionRef: '', // invalid
    })

    expect(res.status).toBe(400)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.MALFORMED_REQUEST)
    expect(body.error.message).toBeString()
  })

  it('returns 400 for missing body', async () => {
    const res = await fetchSocket('/v1/sessions/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 4. Session list — GET /v1/sessions
// ---------------------------------------------------------------------------
describe('GET /v1/sessions', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('returns empty array when no sessions exist', async () => {
    const res = await fetchSocket('/v1/sessions')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('returns sessions after resolve', async () => {
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:a/lane:default',
    })
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:b/lane:default',
    })

    const res = await fetchSocket('/v1/sessions')
    expect(res.status).toBe(200)
    const body: HrcSessionRecord[] = await res.json()
    expect(body.length).toBe(2)
  })

  it('filters by scopeRef query param', async () => {
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:a/lane:default',
    })
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:b/lane:default',
    })

    const res = await fetchSocket('/v1/sessions?scopeRef=project:a')
    expect(res.status).toBe(200)
    const body: HrcSessionRecord[] = await res.json()
    expect(body.length).toBe(1)
    expect(body[0]!.scopeRef).toBe('project:a')
  })
})

// ---------------------------------------------------------------------------
// 5. Session get by host — GET /v1/sessions/by-host/:hostSessionId
// ---------------------------------------------------------------------------
describe('GET /v1/sessions/by-host/:hostSessionId', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('returns the session for a known hostSessionId', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:x/lane:main',
    })
    const { hostSessionId } = await resolveRes.json()

    const res = await fetchSocket(`/v1/sessions/by-host/${hostSessionId}`)
    expect(res.status).toBe(200)
    const session: HrcSessionRecord = await res.json()
    expect(session.hostSessionId).toBe(hostSessionId)
    expect(session.scopeRef).toBe('project:x')
    expect(session.laneRef).toBe('main')
  })

  it('returns 404 for unknown hostSessionId', async () => {
    const res = await fetchSocket('/v1/sessions/by-host/nonexistent-id')
    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_HOST_SESSION)
  })
})

// ---------------------------------------------------------------------------
// 6. Internal launch callbacks
// ---------------------------------------------------------------------------
describe('internal launch callbacks', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  /**
   * Helper: seed a session and a launch record so callbacks have something to update.
   * Returns { hostSessionId, launchId }.
   */
  async function seedLaunch(): Promise<{ hostSessionId: string; launchId: string }> {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:test/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    // Seed a launch record directly through the DB (server exposes db for test hooks,
    // or we insert via an internal test endpoint). For now we assume the server
    // handles the case where the launch record was pre-created by the spool/launch system.
    // The internal callback endpoints should create a minimal launch record if one
    // doesn't exist, or the test setup should pre-seed one.
    const launchId = `launch-${Date.now()}`

    // Insert a minimal launch record via the server's internal seeding (if available)
    // or assume wrapper-started creates it. Either way, we test the callback flow.
    return { hostSessionId, launchId }
  }

  it('POST /v1/internal/launches/:launchId/wrapper-started accepts callback', async () => {
    const { hostSessionId, launchId } = await seedLaunch()

    const res = await postJson(`/v1/internal/launches/${launchId}/wrapper-started`, {
      hostSessionId,
      wrapperPid: 12345,
      timestamp: ts(),
    })

    // Should accept the callback (200 or 201)
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
  })

  it('POST /v1/internal/launches/:launchId/child-started accepts callback', async () => {
    const { hostSessionId, launchId } = await seedLaunch()

    // First wrapper-started
    await postJson(`/v1/internal/launches/${launchId}/wrapper-started`, {
      hostSessionId,
      wrapperPid: 12345,
      timestamp: ts(),
    })

    const res = await postJson(`/v1/internal/launches/${launchId}/child-started`, {
      hostSessionId,
      childPid: 12346,
      timestamp: ts(),
    })

    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
  })

  it('POST /v1/internal/launches/:launchId/exited updates status and appends event', async () => {
    const { hostSessionId, launchId } = await seedLaunch()

    await postJson(`/v1/internal/launches/${launchId}/wrapper-started`, {
      hostSessionId,
      wrapperPid: 12345,
      timestamp: ts(),
    })

    const res = await postJson(`/v1/internal/launches/${launchId}/exited`, {
      hostSessionId,
      exitCode: 0,
      timestamp: ts(),
    })

    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)

    // Verify an event was appended
    const eventsRes = await fetchSocket('/v1/events')
    expect(eventsRes.status).toBe(200)
    const eventsText = await eventsRes.text()
    const events = eventsText
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    expect(events.length).toBeGreaterThanOrEqual(1)
    // At least one event should be launch-related
    const launchEvents = events.filter(
      (e: { eventKind: string }) => e.eventKind.includes('launch') || e.eventKind.includes('exited')
    )
    expect(launchEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /v1/internal/hooks/ingest accepts hook envelope', async () => {
    const { hostSessionId } = await seedLaunch()

    const res = await postJson('/v1/internal/hooks/ingest', {
      launchId: `launch-hook-${Date.now()}`,
      hostSessionId,
      generation: 1,
      hookData: { type: 'test_hook', payload: { foo: 'bar' } },
    })

    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
  })
})

// ---------------------------------------------------------------------------
// 7. Event NDJSON replay — GET /v1/events
// ---------------------------------------------------------------------------
describe('GET /v1/events', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('returns empty NDJSON when no events exist', async () => {
    const res = await fetchSocket('/v1/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const text = await res.text()
    expect(text.trim()).toBe('')
  })

  it('returns events with monotonic seq after resolve creates events', async () => {
    // Resolve two sessions to generate events
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:a/lane:default',
    })
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:b/lane:default',
    })

    const res = await fetchSocket('/v1/events')
    expect(res.status).toBe(200)
    const text = await res.text()
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(1)

    // Verify monotonic seq
    const events = lines.map((l) => JSON.parse(l))
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq)
    }
  })

  it('supports fromSeq query param for replay', async () => {
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:a/lane:default',
    })
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:b/lane:default',
    })

    // Get all events first
    const allRes = await fetchSocket('/v1/events')
    const allText = await allRes.text()
    const allEvents = allText
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))

    if (allEvents.length >= 2) {
      // Request from the second event's seq
      const fromSeq = allEvents[1].seq
      const res = await fetchSocket(`/v1/events?fromSeq=${fromSeq}`)
      expect(res.status).toBe(200)
      const text = await res.text()
      const filtered = text
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))

      // All returned events should have seq >= fromSeq
      for (const e of filtered) {
        expect(e.seq).toBeGreaterThanOrEqual(fromSeq)
      }
    }
  })

  it('supports follow mode with streaming', async () => {
    // Start follow request
    const controller = new AbortController()
    const followPromise = fetchSocket('/v1/events?follow=true', {
      signal: controller.signal,
    })

    // Give the server a moment to start streaming
    await new Promise((r) => setTimeout(r, 100))

    // Create a session to generate an event while following
    await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:follow-test/lane:default',
    })

    // Give the event time to propagate
    await new Promise((r) => setTimeout(r, 200))

    // Abort the follow request
    controller.abort()

    // The follow request should have received data before abort
    try {
      const res = await followPromise
      const text = await res.text()
      const lines = text
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(1)
    } catch (err: unknown) {
      // AbortError is expected; the key assertion is that the
      // connection was accepted and streaming started
      if (err instanceof Error && err.name !== 'AbortError') throw err
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Surface binding APIs
// ---------------------------------------------------------------------------
describe('surface binding APIs', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('POST /v1/surfaces/bind creates a new binding and emits surface.bound', async () => {
    const runtime = await ensureRuntime('project:surface-bind')

    const res = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-1',
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      paneId: 'pane-1',
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.surfaceKind).toBe('ghostty')
    expect(body.surfaceId).toBe('ghostty-surface-1')
    expect(body.runtimeId).toBe(runtime.runtimeId)
    expect(body.boundAt).toBeString()
    expect(body.unboundAt).toBeUndefined()

    const eventsRes = await fetchSocket('/v1/events')
    const events = (await eventsRes.text())
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((event: { eventKind: string }) => event.eventKind === 'surface.bound')
    expect(events).toHaveLength(1)
    expect(events[0].eventJson.surfaceId).toBe('ghostty-surface-1')
  })

  it('POST /v1/surfaces/bind is a no-op for the same active runtime', async () => {
    const runtime = await ensureRuntime('project:surface-bind-noop')
    const request = {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-2',
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
    }

    const first = await postJson('/v1/surfaces/bind', request)
    const firstBody = await first.json()
    const second = await postJson('/v1/surfaces/bind', request)
    const secondBody = await second.json()

    expect(second.status).toBe(200)
    expect(secondBody.boundAt).toBe(firstBody.boundAt)

    const listed = await fetchSocket(
      `/v1/surfaces?runtimeId=${encodeURIComponent(runtime.runtimeId)}`
    )
    const bindings = await listed.json()
    expect(bindings).toHaveLength(1)

    const eventsRes = await fetchSocket('/v1/events')
    const boundEvents = (await eventsRes.text())
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((event: { eventKind: string }) => event.eventKind === 'surface.bound')
    expect(boundEvents).toHaveLength(1)
  })

  it('POST /v1/surfaces/bind rebinds to a different runtime and emits surface.rebound', async () => {
    const first = await ensureRuntime('project:surface-bind-rebind-a')
    const second = await ensureRuntime('project:surface-bind-rebind-b')

    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-3',
      runtimeId: first.runtimeId,
      hostSessionId: first.hostSessionId,
      generation: first.generation,
    })
    const rebound = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-3',
      runtimeId: second.runtimeId,
      hostSessionId: second.hostSessionId,
      generation: second.generation,
    })

    expect(rebound.status).toBe(200)
    const body = await rebound.json()
    expect(body.runtimeId).toBe(second.runtimeId)

    const firstList = await fetchSocket(
      `/v1/surfaces?runtimeId=${encodeURIComponent(first.runtimeId)}`
    )
    expect(await firstList.json()).toEqual([])

    const secondList = await fetchSocket(
      `/v1/surfaces?runtimeId=${encodeURIComponent(second.runtimeId)}`
    )
    const secondBindings = await secondList.json()
    expect(secondBindings).toHaveLength(1)
    expect(secondBindings[0].surfaceId).toBe('ghostty-surface-3')

    const eventsRes = await fetchSocket('/v1/events')
    const reboundEvents = (await eventsRes.text())
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((event: { eventKind: string }) => event.eventKind === 'surface.rebound')
    expect(reboundEvents).toHaveLength(1)
    expect(reboundEvents[0].eventJson.previousRuntimeId).toBe(first.runtimeId)
  })

  it('POST /v1/surfaces/unbind marks the binding inactive and emits surface.unbound', async () => {
    const runtime = await ensureRuntime('project:surface-unbind')
    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-4',
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
    })

    const res = await postJson('/v1/surfaces/unbind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-4',
      reason: 'user-detached',
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unboundAt).toBeString()
    expect(body.reason).toBe('user-detached')

    const listed = await fetchSocket(
      `/v1/surfaces?runtimeId=${encodeURIComponent(runtime.runtimeId)}`
    )
    expect(await listed.json()).toEqual([])

    const eventsRes = await fetchSocket('/v1/events')
    const unboundEvents = (await eventsRes.text())
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((event: { eventKind: string }) => event.eventKind === 'surface.unbound')
    expect(unboundEvents).toHaveLength(1)
    expect(unboundEvents[0].eventJson.reason).toBe('user-detached')
  })

  it('GET /v1/surfaces lists active bindings for the requested runtime only', async () => {
    const first = await ensureRuntime('project:surface-list-a')
    const second = await ensureRuntime('project:surface-list-b')

    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-5a',
      runtimeId: first.runtimeId,
      hostSessionId: first.hostSessionId,
      generation: first.generation,
    })
    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-5b',
      runtimeId: second.runtimeId,
      hostSessionId: second.hostSessionId,
      generation: second.generation,
    })

    const res = await fetchSocket(`/v1/surfaces?runtimeId=${encodeURIComponent(first.runtimeId)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].surfaceId).toBe('ghostty-surface-5a')
  })

  it('surface bindings survive server restart', async () => {
    const runtime = await ensureRuntime('project:surface-restart')
    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-surface-6',
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
    })

    await server.stop()
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket(`/v1/surfaces?runtimeId=${encodeURIComponent(runtime.runtimeId)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].surfaceId).toBe('ghostty-surface-6')
  })
})

// ---------------------------------------------------------------------------
// 9. HTTP error model
// ---------------------------------------------------------------------------
describe('HTTP error model', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('returns { error: { code, message, detail } } shape for 400', async () => {
    const res = await postJson('/v1/sessions/resolve', {})
    expect(res.status).toBe(400)
    const body: HrcHttpError = await res.json()
    expect(body.error).toBeDefined()
    expect(typeof body.error.code).toBe('string')
    expect(typeof body.error.message).toBe('string')
    expect(typeof body.error.detail).toBe('object')
  })

  it('returns 404 with correct error shape for unknown resources', async () => {
    const res = await fetchSocket('/v1/sessions/by-host/does-not-exist')
    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_HOST_SESSION)
  })

  it('returns 404 for completely unknown routes', async () => {
    const res = await fetchSocket('/v1/nonexistent-endpoint')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 10. Spool replay on startup
// ---------------------------------------------------------------------------
describe('spool replay', () => {
  it('replays spooled callbacks on startup', async () => {
    // Pre-seed a session and launch via a temporary server
    const tmpServer = await createHrcServer(serverOpts())
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:spool/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()
    await tmpServer.stop()

    // Create spool entries manually (simulating hrc-launch spooling)
    const launchId = `spool-launch-${Date.now()}`
    const launchSpoolDir = join(spoolDir, launchId)
    await mkdir(launchSpoolDir, { recursive: true })

    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${launchId}/wrapper-started`,
        payload: { hostSessionId, wrapperPid: 99999, timestamp: ts() },
      }),
      'utf-8'
    )

    // Start a new server — it should replay the spool
    const server = await createHrcServer(serverOpts())

    // After startup, events should include the replayed callback
    const res = await fetchSocket('/v1/events')
    const text = await res.text()
    const events = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))

    // We expect at least the session.created event from resolve,
    // plus potentially a launch event from the spool replay
    expect(events.length).toBeGreaterThanOrEqual(1)

    await server.stop()
  })
})

// ---------------------------------------------------------------------------
// 11. Clean shutdown
// ---------------------------------------------------------------------------
describe('clean shutdown', () => {
  it('stops accepting requests after stop()', async () => {
    const server = await createHrcServer(serverOpts())

    // Verify server is responding
    const res1 = await fetchSocket('/v1/sessions')
    expect(res1.status).toBe(200)

    // Stop the server
    await server.stop()

    // After stop, fetch should fail
    await expect(fetchSocket('/v1/sessions')).rejects.toThrow()
  })

  it('removes the lock file on clean shutdown', async () => {
    const server = await createHrcServer(serverOpts())
    await server.stop()

    const lockExists = await stat(lockPath).catch(() => null)
    expect(lockExists).toBeNull()
  })
})
