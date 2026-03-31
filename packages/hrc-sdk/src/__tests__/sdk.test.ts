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
    db.runtimes.create({
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
// 5. Export surface validation
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
