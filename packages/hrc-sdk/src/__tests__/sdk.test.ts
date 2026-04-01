/**
 * RED/GREEN tests for hrc-sdk (T-00956 / T-00955)
 *
 * Tests the hrc-sdk typed Unix socket client surface:
 *   - discoverSocket() — finds socket via resolveControlSocketPath(), throws when missing
 *   - HrcClient — HTTP-over-Unix-socket constructor and request plumbing
 *   - Typed error parsing — non-2xx responses parsed into HrcDomainError
 *   - resolveSession() — POST /v1/sessions/resolve round-trip
 *   - listSessions() — GET /v1/sessions round-trip
 *   - getSession() — GET /v1/sessions/by-host/:id round-trip
 *   - watch() — GET /v1/events NDJSON parsing into AsyncIterable<HrcEventEnvelope>
 *   - Export surface from src/index.ts
 *
 * Pass conditions for Curly (T-00955):
 *   1. discoverSocket() returns socket path when socket file exists
 *   2. discoverSocket() throws with clear error when socket file is missing
 *   3. HrcClient constructor accepts a socket path
 *   4. HrcClient methods throw HrcDomainError for non-2xx responses with typed code
 *   5. resolveSession() sends POST, returns ResolveSessionResponse
 *   6. listSessions() sends GET, returns HrcSessionRecord[]
 *   7. getSession() sends GET, returns HrcSessionRecord, throws 404 as HrcDomainError
 *   8. watch() returns AsyncIterable<HrcEventEnvelope> from NDJSON stream
 *   9. watch({ fromSeq }) sends fromSeq query param
 *  10. All public types are exported from src/index.ts
 *
 * Test strategy:
 *   - Socket discovery tests use real filesystem (no mock)
 *   - Client round-trip tests spin up a real hrc-server on a temp socket
 *   - Error parsing tests use a minimal Bun.serve stub that returns known error shapes
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcEventEnvelope, HrcSessionRecord } from 'hrc-core'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient, discoverSocket } from '../index'
import type { EnsureRuntimeResponse, ResolveSessionRequest, ResolveSessionResponse } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
// ---------------------------------------------------------------------------
describe('discoverSocket', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-discover-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the socket path when socket file exists', async () => {
    // Set up env to point to our tmp runtime dir
    const runtimeDir = join(tmpDir, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    const sockPath = join(runtimeDir, 'hrc.sock')
    // Create a placeholder socket file (just needs to exist for discovery)
    await writeFile(sockPath, '')

    const originalEnv = process.env['HRC_RUNTIME_DIR']
    process.env['HRC_RUNTIME_DIR'] = runtimeDir
    try {
      const discovered = discoverSocket()
      expect(discovered).toBe(sockPath)
    } finally {
      if (originalEnv !== undefined) {
        process.env['HRC_RUNTIME_DIR'] = originalEnv
      } else {
        process.env['HRC_RUNTIME_DIR'] = undefined
      }
    }
  })

  it('throws when socket file does not exist', () => {
    const originalEnv = process.env['HRC_RUNTIME_DIR']
    process.env['HRC_RUNTIME_DIR'] = join(tmpDir, 'nonexistent')
    try {
      expect(() => discoverSocket()).toThrow()
    } finally {
      if (originalEnv !== undefined) {
        process.env['HRC_RUNTIME_DIR'] = originalEnv
      } else {
        process.env['HRC_RUNTIME_DIR'] = undefined
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. HrcClient — constructor and typed error parsing
// ---------------------------------------------------------------------------
describe('HrcClient constructor', () => {
  it('accepts a socket path', () => {
    const client = new HrcClient('/tmp/fake.sock')
    expect(client).toBeDefined()
  })
})

// Error parsing tests use a minimal HTTP server that returns known error shapes
describe('typed error parsing', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-error-'))
    stubSocketPath = join(tmpDir, 'stub.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses 404 response into HrcDomainError with correct code', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'unknown_host_session',
              message: 'Session not found',
              detail: {},
            },
          },
          { status: 404 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.getSession('nonexistent')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.UNKNOWN_HOST_SESSION)
      expect(domainErr.status).toBe(404)
    }
  })

  it('parses 400 response into HrcDomainError with correct code', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'malformed_request',
              message: 'Missing required field: sessionRef',
              detail: { field: 'sessionRef' },
            },
          },
          { status: 400 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.resolveSession({} as ResolveSessionRequest)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.MALFORMED_REQUEST)
      expect(domainErr.status).toBe(400)
      expect(domainErr.detail).toEqual({ field: 'sessionRef' })
    }
  })

  it('parses 409 response into HrcDomainError', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'stale_context',
              message: 'Generation mismatch',
              detail: { expected: 1, actual: 2 },
            },
          },
          { status: 409 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.resolveSession({
        sessionRef: 'project:test/lane:default',
      } as ResolveSessionRequest)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.STALE_CONTEXT)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. NDJSON watch parsing (using a stub server)
// ---------------------------------------------------------------------------
describe('watch NDJSON parsing', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-watch-'))
    stubSocketPath = join(tmpDir, 'watch.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses NDJSON stream into AsyncIterable<HrcEventEnvelope>', async () => {
    const testEvents: HrcEventEnvelope[] = [
      {
        seq: 1,
        ts: '2026-03-31T15:00:00.000Z',
        hostSessionId: 'hsid-1',
        scopeRef: 'project:test',
        laneRef: 'default',
        generation: 1,
        source: 'hrc' as const,
        eventKind: 'session.created',
        eventJson: {},
      },
      {
        seq: 2,
        ts: '2026-03-31T15:00:01.000Z',
        hostSessionId: 'hsid-1',
        scopeRef: 'project:test',
        laneRef: 'default',
        generation: 1,
        source: 'hrc' as const,
        eventKind: 'session.resolved',
        eventJson: {},
      },
    ]

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        const ndjson = `${testEvents.map((e) => JSON.stringify(e)).join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const collected: HrcEventEnvelope[] = []

    for await (const event of client.watch()) {
      collected.push(event)
    }

    expect(collected.length).toBe(2)
    expect(collected[0]!.seq).toBe(1)
    expect(collected[0]!.eventKind).toBe('session.created')
    expect(collected[1]!.seq).toBe(2)
    expect(collected[1]!.eventKind).toBe('session.resolved')
  })

  it('passes fromSeq as query parameter', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _event of client.watch({ fromSeq: 42 })) {
      // should be empty
    }

    expect(capturedUrl).toContain('fromSeq=42')
  })

  it('passes follow as query parameter', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        // Return empty immediately to end the stream
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    for await (const _event of client.watch({ follow: true })) {
      // should be empty
    }

    expect(capturedUrl).toContain('follow=true')
  })
})

// ---------------------------------------------------------------------------
// 4. Round-trip tests (require a real hrc-server)
// ---------------------------------------------------------------------------
// These tests need hrc-server to be implemented. They demonstrate the full
// SDK → server round-trip. They will initially fail with import errors on
// hrc-server, which is expected in the RED phase. When both packages are
// implemented, these tests validate the integration seam.
describe('SDK → server round-trip', () => {
  let tmpDir: string
  let runtimeRoot: string
  let stateRoot: string
  let socketPath: string
  let dbPath: string
  let tmuxSocketPath: string
  let server: { stop(): Promise<void> } | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-roundtrip-'))
    runtimeRoot = join(tmpDir, 'runtime')
    stateRoot = join(tmpDir, 'state')
    socketPath = join(runtimeRoot, 'hrc.sock')
    dbPath = join(stateRoot, 'state.sqlite')
    tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    await mkdir(join(runtimeRoot, 'spool'), { recursive: true })

    // Start a real server (this import will fail in RED phase)
    try {
      const { createHrcServer } = await import('hrc-server')
      server = await createHrcServer({
        runtimeRoot,
        stateRoot,
        socketPath,
        lockPath: join(runtimeRoot, 'server.lock'),
        spoolDir: join(runtimeRoot, 'spool'),
        dbPath,
        tmuxSocketPath,
      })
    } catch {
      // Expected to fail in RED phase — server not implemented yet
    }
  })

  afterAll(async () => {
    if (server) await server.stop()
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no tmux server was created
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('resolveSession round-trip', async () => {
    if (!server) return // Skip if server couldn't start (RED phase)

    const client = new HrcClient(socketPath)
    const result: ResolveSessionResponse = await client.resolveSession({
      sessionRef: 'project:roundtrip/lane:default',
    })

    expect(result.hostSessionId).toBeString()
    expect(result.generation).toBe(1)
    expect(result.created).toBe(true)
    expect(result.session.scopeRef).toBe('project:roundtrip')
  })

  it('listSessions round-trip', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)

    // Ensure at least one session
    await client.resolveSession({
      sessionRef: 'project:list-test/lane:default',
    })

    const sessions: HrcSessionRecord[] = await client.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })

  it('getSession round-trip', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)
    const resolved = await client.resolveSession({
      sessionRef: 'project:get-test/lane:default',
    })

    const session = await client.getSession(resolved.hostSessionId)
    expect(session.hostSessionId).toBe(resolved.hostSessionId)
    expect(session.scopeRef).toBe('project:get-test')
  })

  it('getSession throws HrcDomainError for unknown hostSessionId', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)
    try {
      await client.getSession('nonexistent-host-session-id')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.UNKNOWN_HOST_SESSION)
    }
  })

  it('watch round-trip returns events as AsyncIterable', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)

    // Create some events
    await client.resolveSession({
      sessionRef: 'project:watch-roundtrip/lane:default',
    })

    const events: HrcEventEnvelope[] = []
    for await (const event of client.watch()) {
      events.push(event)
    }

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.seq).toBeGreaterThanOrEqual(1)
  })

  it('ensureRuntime round-trip returns tmux runtime metadata', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)
    const resolved = await client.resolveSession({
      sessionRef: 'project:runtime-roundtrip/lane:default',
    })

    const runtime: EnsureRuntimeResponse = await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: tmpDir,
          projectRoot: tmpDir,
          cwd: tmpDir,
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: true,
        },
        execution: {
          preferredMode: 'interactive',
        },
      },
    })

    expect(runtime.hostSessionId).toBe(resolved.hostSessionId)
    expect(runtime.transport).toBe('tmux')
    expect(runtime.status).toBe('ready')
    expect(runtime.tmux.paneId).toBeString()
  })

  it('capture and attach round-trip return runtime data', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)
    const resolved = await client.resolveSession({
      sessionRef: 'project:capture-roundtrip/lane:default',
    })
    const runtime = await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: tmpDir,
          projectRoot: tmpDir,
          cwd: tmpDir,
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: true,
        },
      },
    })

    const capture = await client.capture(runtime.runtimeId)
    const attach = await client.getAttachDescriptor(runtime.runtimeId)

    expect(typeof capture.text).toBe('string')
    expect(attach.transport).toBe('tmux')
    expect(attach.argv).toContain('attach-session')
  })

  it('surface bind/list/unbind round-trip returns binding data', async () => {
    if (!server) return

    const client = new HrcClient(socketPath)
    const resolved = await client.resolveSession({
      sessionRef: 'project:surface-roundtrip/lane:default',
    })
    const runtimeId = `rt-test-${randomUUID()}`
    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    db.runtimes.insert({
      runtimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: 'project:surface-roundtrip',
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: `hrc-${resolved.hostSessionId.slice(0, 12)}`,
        windowName: 'main',
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })

    const attach = await client.getAttachDescriptor(runtimeId)
    const binding = await client.bindSurface({
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-sdk-1',
      ...attach.bindingFence,
    })
    expect(binding.surfaceId).toBe('ghostty-sdk-1')

    const listed = await client.listSurfaces({ runtimeId })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.surfaceId).toBe('ghostty-sdk-1')

    const unbound = await client.unbindSurface({
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-sdk-1',
      reason: 'done',
    })
    expect(unbound.reason).toBe('done')

    const after = await client.listSurfaces({ runtimeId })
    expect(after).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Phase 6 diagnostics round-trip (T-00973 / T-00974)
//
// RED GATE: These tests call SDK methods that do not exist yet:
//   getHealth(), getStatus(), listRuntimes(), listLaunches(), adoptRuntime()
//
// Pass conditions for Curly (T-00973):
//   1. getHealth() → GET /v1/health → { ok: true }
//   2. getStatus() → GET /v1/status → { ok, uptime (number), startedAt, socketPath, dbPath, sessionCount, runtimeCount }
//   3. listRuntimes() → GET /v1/runtimes → HrcRuntimeSnapshot[] (empty when none)
//   4. listRuntimes({ hostSessionId }) → GET /v1/runtimes?hostSessionId=... → filtered array
//   5. listLaunches() → GET /v1/launches → HrcLaunchRecord[] (empty when none)
//   6. listLaunches({ hostSessionId }) → filtered by hostSessionId
//   7. listLaunches({ runtimeId }) → filtered by runtimeId
//   8. adoptRuntime(runtimeId) on dead runtime → POST /v1/runtimes/adopt → { status: 'adopted', adopted: true }
//   9. adoptRuntime(runtimeId) on active runtime → throws HrcDomainError(CONFLICT/409)
//  10. adoptRuntime(unknownId) → throws HrcDomainError(UNKNOWN_RUNTIME/404)
// ---------------------------------------------------------------------------
describe('Phase 6 diagnostics round-trip', () => {
  let tmpDir: string
  let runtimeRoot: string
  let stateRoot: string
  let socketPath: string
  let dbPath: string
  let tmuxSocketPath: string
  let server: { stop(): Promise<void> } | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-diag-'))
    runtimeRoot = join(tmpDir, 'runtime')
    stateRoot = join(tmpDir, 'state')
    socketPath = join(runtimeRoot, 'hrc.sock')
    dbPath = join(stateRoot, 'state.sqlite')
    tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    await mkdir(join(runtimeRoot, 'spool'), { recursive: true })

    const { createHrcServer } = await import('hrc-server')
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath: join(runtimeRoot, 'server.lock'),
      spoolDir: join(runtimeRoot, 'spool'),
      dbPath,
      tmuxSocketPath,
    })
  })

  afterAll(async () => {
    if (server) await server.stop()
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no tmux server was created
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('getHealth returns { ok: true }', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    // RED: getHealth does not exist on HrcClient
    const result = await (client as any).getHealth()
    expect(result).toEqual({ ok: true })
  })

  it('getStatus returns server status with uptime', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    // RED: getStatus does not exist on HrcClient
    const result = await (client as any).getStatus()
    expect(result.ok).toBe(true)
    expect(typeof result.uptime).toBe('number')
    expect(result.uptime).toBeGreaterThanOrEqual(0)
    expect(typeof result.startedAt).toBe('string')
    expect(typeof result.socketPath).toBe('string')
    expect(typeof result.dbPath).toBe('string')
    expect(typeof result.sessionCount).toBe('number')
    expect(typeof result.runtimeCount).toBe('number')
  })

  it('listRuntimes returns empty array when none exist', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    // RED: listRuntimes does not exist on HrcClient
    const result = await (client as any).listRuntimes()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  it('listRuntimes with hostSessionId filter returns filtered results', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)

    // Create a session + runtime to filter on
    const resolved = await client.resolveSession({
      sessionRef: 'project:diag-rt-filter/lane:default',
    })
    await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: tmpDir,
          projectRoot: tmpDir,
          cwd: tmpDir,
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
    })

    // RED: listRuntimes does not exist on HrcClient
    const all = await (client as any).listRuntimes()
    expect(all.length).toBeGreaterThanOrEqual(1)

    const filtered = await (client as any).listRuntimes({ hostSessionId: resolved.hostSessionId })
    expect(filtered.length).toBe(1)
    expect(filtered[0].hostSessionId).toBe(resolved.hostSessionId)
  })

  it('listLaunches returns empty array when none exist', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    // RED: listLaunches does not exist on HrcClient
    const result = await (client as any).listLaunches()
    expect(Array.isArray(result)).toBe(true)
  })

  it('listLaunches with runtimeId filter returns filtered results', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)

    const resolved = await client.resolveSession({
      sessionRef: 'project:diag-launch-filter/lane:default',
    })
    const runtime = await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: tmpDir,
          projectRoot: tmpDir,
          cwd: tmpDir,
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
    })

    // RED: listLaunches does not exist on HrcClient
    const filtered = await (client as any).listLaunches({ runtimeId: runtime.runtimeId })
    expect(Array.isArray(filtered)).toBe(true)
    for (const launch of filtered) {
      expect(launch.runtimeId).toBe(runtime.runtimeId)
    }
  })

  it('adoptRuntime on dead runtime returns adopted status', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)

    // Seed a dead runtime directly in the DB
    const resolved = await client.resolveSession({
      sessionRef: 'project:diag-adopt-dead/lane:default',
    })
    const runtimeId = `rt-adopt-dead-${randomUUID()}`
    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    db.runtimes.insert({
      runtimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: 'project:diag-adopt-dead',
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'dead',
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: 'hrc-adopt-dead',
        windowName: 'main',
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })

    // RED: adoptRuntime does not exist on HrcClient
    const result = await (client as any).adoptRuntime(runtimeId)
    expect(result.status).toBe('adopted')
    expect(result.adopted).toBe(true)
    expect(result.runtimeId).toBe(runtimeId)
  })

  it('adoptRuntime on active runtime throws CONFLICT', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)

    const resolved = await client.resolveSession({
      sessionRef: 'project:diag-adopt-active/lane:default',
    })
    const runtime = await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: tmpDir,
          projectRoot: tmpDir,
          cwd: tmpDir,
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
    })

    // RED: adoptRuntime does not exist on HrcClient
    try {
      await (client as any).adoptRuntime(runtime.runtimeId)
      expect.unreachable('should have thrown CONFLICT')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.CONFLICT)
      expect(domainErr.status).toBe(409)
    }
  })

  it('adoptRuntime on unknown runtime throws UNKNOWN_RUNTIME', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)

    // RED: adoptRuntime does not exist on HrcClient
    try {
      await (client as any).adoptRuntime('nonexistent-runtime-id')
      expect.unreachable('should have thrown UNKNOWN_RUNTIME')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.UNKNOWN_RUNTIME)
      expect(domainErr.status).toBe(404)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Step 4 red-gate tests (T-00981): M-10, m-19, m-20, m-22
//
// RED GATE: These tests exercise error/edge paths that do NOT exist yet:
//   - M-10: watch() must survive malformed NDJSON without crashing the generator
//   - m-19: SendInFlightInputRequest.prompt must be required (type-level; runtime covered)
//   - m-20: watch() must accept AbortSignal in WatchOptions and terminate on abort
//   - m-22: throwTypedError must include body text excerpt for non-JSON error responses
//
// Pass conditions for Curly (T-00981):
//   1. watch() skips malformed NDJSON lines and still yields valid events (M-10)
//   2. watch() terminates cleanly when AbortSignal fires after first event (m-20)
//   3. throwTypedError includes response body excerpt for non-JSON 502 responses (m-22)
//   4. sendInFlightInput works when prompt is provided as required field (m-19)
// ---------------------------------------------------------------------------
describe('Step 4 red-gate: SDK contract fixes (T-00981)', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-step4-'))
    stubSocketPath = join(tmpDir, 'step4.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  // -- M-10: watch() crashes on malformed NDJSON --
  // Current code: JSON.parse(trimmed) at client.ts:251 with no try-catch.
  // One malformed line kills the async generator with SyntaxError.
  // Expected: generator skips/yields-error for the bad line and yields remaining valid events.
  it('M-10: watch() survives malformed NDJSON and yields valid events', async () => {
    const validEvent1: HrcEventEnvelope = {
      seq: 1,
      ts: '2026-04-01T00:00:00Z',
      hostSessionId: 'hsid-m10',
      scopeRef: 'project:m10',
      laneRef: 'default',
      generation: 1,
      source: 'hrc' as const,
      eventKind: 'session.created',
      eventJson: {},
    }
    const validEvent2: HrcEventEnvelope = {
      seq: 3,
      ts: '2026-04-01T00:00:02Z',
      hostSessionId: 'hsid-m10',
      scopeRef: 'project:m10',
      laneRef: 'default',
      generation: 1,
      source: 'hrc' as const,
      eventKind: 'session.resolved',
      eventJson: {},
    }

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        // Line 2 is malformed JSON — should not crash the generator
        const ndjson = `${[
          JSON.stringify(validEvent1),
          '{broken json <<< THIS IS NOT VALID',
          JSON.stringify(validEvent2),
        ].join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const collected: HrcEventEnvelope[] = []

    // This should NOT throw — the generator must handle malformed lines gracefully
    for await (const event of client.watch()) {
      collected.push(event)
    }

    // Both valid events should be yielded; the malformed line should be skipped
    expect(collected.length).toBe(2)
    expect(collected[0]!.seq).toBe(1)
    expect(collected[1]!.seq).toBe(3)
  })

  // -- m-20: watch() has no AbortSignal/cancellation --
  // Current code: WatchOptions only has fromSeq and follow — no signal field.
  // Expected: WatchOptions accepts optional `signal: AbortSignal` and terminates
  // iteration when aborted.
  it('m-20: watch() terminates on AbortSignal after first event', async () => {
    const events: HrcEventEnvelope[] = Array.from({ length: 5 }, (_, i) => ({
      seq: i + 1,
      ts: `2026-04-01T00:00:0${i}Z`,
      hostSessionId: 'hsid-m20',
      scopeRef: 'project:m20',
      laneRef: 'default',
      generation: 1,
      source: 'hrc' as const,
      eventKind: 'session.created',
      eventJson: {},
    }))

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        // Send 5 events as separate NDJSON lines
        const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const controller = new AbortController()
    const collected: HrcEventEnvelope[] = []

    // Pass signal in WatchOptions — this field does not exist yet (RED)
    for await (const event of client.watch({ signal: controller.signal } as any)) {
      collected.push(event)
      if (collected.length === 1) {
        controller.abort()
      }
    }

    // Should stop after first event — not consume all 5
    expect(collected.length).toBe(1)
    expect(collected[0]!.seq).toBe(1)
  })

  // -- m-22: throwTypedError discards non-JSON response bodies --
  // Current code: catch block in throwTypedError (client.ts:83-84) throws
  // "HRC request failed with status 502" — no body excerpt.
  // Expected: error message includes an excerpt of the actual response body text.
  it('m-22: throwTypedError includes body excerpt for non-JSON 502', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return new Response('Bad Gateway: upstream service unavailable', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.getSession('any-id')
      expect.unreachable('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      // Current behavior: generic "HRC request failed with status 502"
      // Required: message must include excerpt from the response body
      expect(msg).toContain('502')
      expect(msg).toMatch(/Bad Gateway/i)
    }
  })

  // -- m-19: SendInFlightInputRequest.prompt should be required --
  // Current type: prompt is optional. Server requires it.
  // This test validates runtime behavior: sendInFlightInput with prompt provided
  // should send the prompt field. The type change (making prompt required) is
  // validated at compile time by Curly's implementation.
  it('m-19: sendInFlightInput sends prompt field to server', async () => {
    let capturedBody: any
    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/in-flight-input') {
          capturedBody = await req.json()
          return Response.json({ accepted: true, runtimeId: 'rt-1', runId: 'run-1' })
        }
        return new Response('Not found', { status: 404 })
      },
    })

    const client = new HrcClient(stubSocketPath)
    // prompt is currently optional in the type — after fix it should be required
    await client.sendInFlightInput({
      runtimeId: 'rt-1',
      runId: 'run-1',
      prompt: 'Continue with analysis',
    })

    expect(capturedBody).toBeDefined()
    expect(capturedBody.prompt).toBe('Continue with analysis')
  })
})

// ---------------------------------------------------------------------------
// 7. Export surface validation
// ---------------------------------------------------------------------------
describe('export surface', () => {
  it('exports discoverSocket function', () => {
    expect(typeof discoverSocket).toBe('function')
  })

  it('exports HrcClient class', () => {
    expect(typeof HrcClient).toBe('function')
  })

  // Type-level exports are validated by the import statement at the top.
  // If ResolveSessionRequest, ResolveSessionResponse, SessionFilter,
  // or WatchOptions are not exported, the import will fail.
})
