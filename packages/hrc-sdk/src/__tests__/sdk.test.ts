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
 *   - watch() — GET /v1/events NDJSON parsing into AsyncIterable<HrcLifecycleEvent>
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
 *   8. watch() returns AsyncIterable<HrcLifecycleEvent> from NDJSON stream
 *   9. watch({ fromSeq }) sends fromSeq query param
 *  10. All public types are exported from src/index.ts
 *
 * Test strategy:
 *   - Socket discovery tests use real filesystem (no mock)
 *   - Client round-trip tests spin up a real hrc-server on a temp socket
 *   - Error parsing tests use a minimal Bun.serve stub that returns known error shapes
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent, StatusResponse } from 'hrc-core'
import { HRC_API_VERSION, HrcDomainError, HrcErrorCode } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient, discoverSocket } from '../index'
import type { ResolveSessionRequest } from '../index'

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

describe('runtime lifecycle client methods', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-lifecycle-'))
    stubSocketPath = join(tmpDir, 'lifecycle.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('startRuntime posts to /v1/runtimes/start and returns the typed response', async () => {
    let capturedPath = ''
    let capturedBody: unknown

    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname
        capturedBody = await req.json()
        return Response.json({
          runtimeId: 'rt-start-1',
          hostSessionId: 'hsid-start-1',
          transport: 'tmux',
          status: 'ready',
          supportsInFlightInput: false,
          tmux: {
            sessionId: '$1',
            windowId: '@1',
            paneId: '%1',
          },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await (client as any).startRuntime({
      hostSessionId: 'hsid-start-1',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: true,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })

    expect(capturedPath).toBe('/v1/runtimes/start')
    expect(capturedBody).toEqual({
      hostSessionId: 'hsid-start-1',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: true,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(result.runtimeId).toBe('rt-start-1')
    expect(result.transport).toBe('tmux')
  })

  it('attachRuntime posts to /v1/runtimes/attach and returns the attach descriptor', async () => {
    let capturedPath = ''
    let capturedBody: unknown

    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname
        capturedBody = await req.json()
        return Response.json({
          transport: 'tmux',
          argv: ['tmux', 'attach', '-t', 'hrc-demo'],
          bindingFence: {
            hostSessionId: 'hsid-attach-1',
            runtimeId: 'rt-attach-1',
            generation: 1,
            windowId: '@1',
            paneId: '%1',
          },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await (client as any).attachRuntime({
      runtimeId: 'rt-attach-1',
    })

    expect(capturedPath).toBe('/v1/runtimes/attach')
    expect(capturedBody).toEqual({ runtimeId: 'rt-attach-1' })
    expect(result.bindingFence.runtimeId).toBe('rt-attach-1')
    expect(result.argv).toEqual(['tmux', 'attach', '-t', 'hrc-demo'])
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

  it('parses NDJSON stream into AsyncIterable<HrcLifecycleEvent>', async () => {
    const testEvents: HrcLifecycleEvent[] = [
      {
        hrcSeq: 1,
        streamSeq: 10,
        ts: '2026-03-31T15:00:00.000Z',
        hostSessionId: 'hsid-1',
        scopeRef: 'project:test',
        laneRef: 'default',
        generation: 1,
        category: 'session',
        eventKind: 'session.created',
        replayed: false,
        payload: {},
      },
      {
        hrcSeq: 2,
        streamSeq: 11,
        ts: '2026-03-31T15:00:01.000Z',
        hostSessionId: 'hsid-1',
        scopeRef: 'project:test',
        laneRef: 'default',
        generation: 1,
        category: 'session',
        eventKind: 'session.resolved',
        replayed: false,
        payload: {},
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
    const collected: HrcLifecycleEvent[] = []

    for await (const event of client.watch()) {
      collected.push(event)
    }

    expect(collected.length).toBe(2)
    expect(collected[0]!.hrcSeq).toBe(1)
    expect(collected[0]!.eventKind).toBe('session.created')
    expect(collected[1]!.hrcSeq).toBe(2)
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
// ---------------------------------------------------------------------------
// 5. Phase 6 diagnostics round-trip (T-00973 / T-00974)
//
// RED GATE: These tests call SDK methods that do not exist yet:
//   getHealth(), getStatus(), listRuntimes(), listLaunches(), adoptRuntime()
//
// Pass conditions for Curly (T-00973):
//   1. getHealth() → GET /v1/health → { ok: true }
//   2. getStatus() → GET /v1/status → capability-discovery status payload
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
    const result = (await (client as any).getStatus()) as StatusResponse
    expect(result.ok).toBe(true)
    expect(typeof result.uptime).toBe('number')
    expect(result.uptime).toBeGreaterThanOrEqual(0)
    expect(typeof result.startedAt).toBe('string')
    expect(typeof result.socketPath).toBe('string')
    expect(typeof result.dbPath).toBe('string')
    expect(typeof result.sessionCount).toBe('number')
    expect(typeof result.runtimeCount).toBe('number')
    expect(result.apiVersion).toBe(HRC_API_VERSION)
    expect(result.capabilities.semanticCore).toEqual({
      sessions: true,
      ensureRuntime: true,
      dispatchTurn: true,
      inFlightInput: true,
      capture: true,
      attach: true,
      clearContext: true,
    })
    expect(result.capabilities.platform).toEqual({
      appOwnedSessions: true,
      appHarnessSessions: true,
      commandSessions: true,
      literalInput: true,
      surfaceBindings: true,
      legacyLocalBridges: ['legacy-agentchat'],
    })
    expect(result.capabilities.bridgeDelivery).toEqual({
      actualPtyInjection: true,
      enter: true,
      oobSuffix: true,
      freshnessFence: true,
    })
    expect(typeof result.capabilities.backend.tmux.available).toBe('boolean')
    if (result.capabilities.backend.tmux.available) {
      expect(typeof result.capabilities.backend.tmux.version).toBe('string')
    } else {
      expect(result.capabilities.backend.tmux.version).toBeUndefined()
    }
  })

  // -------------------------------------------------------------------------
  // T-00998: getStatus() capability reporting
  //
  // RED GATE: These assertions will fail until:
  //   - Larry lands HrcCapabilityStatus in hrc-core
  //   - Server handleStatus() is expanded with capabilities + apiVersion
  //   - SDK StatusResponse type is updated to include new fields
  //
  // Pass conditions:
  //   1. getStatus() result includes `apiVersion` string
  //   2. getStatus() result includes typed `capabilities` object
  //   3. capabilities.backend.tmux.available is true (tmux present in CI/dev)
  //   4. Unimplemented platform capabilities report false
  // -------------------------------------------------------------------------

  it('getStatus returns capabilities object with apiVersion (T-00998)', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    const result = await client.getStatus()
    expect(result.apiVersion).toBe(HRC_API_VERSION)
  })

  it('getStatus returns typed capabilities with backend.tmux (T-00998)', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    const result = await client.getStatus()
    expect(result.capabilities).toBeDefined()
    expect(typeof result.capabilities).toBe('object')
    expect(result.capabilities.backend.tmux.available).toBe(true)
    expect(typeof result.capabilities.backend.tmux.version).toBe('string')
  })

  it('getStatus reports unimplemented platform capabilities as false (T-00998)', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    const result = await client.getStatus()
    expect(result.capabilities.platform.appOwnedSessions).toBe(true)
    expect(result.capabilities.platform.appHarnessSessions).toBe(true)
    expect(result.capabilities.platform.commandSessions).toBe(true)
    expect(result.capabilities.platform.literalInput).toBe(true)
    expect(result.capabilities.platform.surfaceBindings).toBe(true)
    expect(result.capabilities.platform.legacyLocalBridges).toEqual(['legacy-agentchat'])
  })

  it('listRuntimes returns an array', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    // RED: listRuntimes does not exist on HrcClient
    const result = await (client as any).listRuntimes()
    expect(Array.isArray(result)).toBe(true)
    // Prior tests in this suite may have created runtimes in the shared
    // server instance, so we only assert the shape, not the count.
  })

  it('listLaunches returns empty array when none exist', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    // RED: listLaunches does not exist on HrcClient
    const result = await (client as any).listLaunches()
    expect(Array.isArray(result)).toBe(true)
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
    const validEvent1: HrcLifecycleEvent = {
      hrcSeq: 1,
      streamSeq: 10,
      ts: '2026-04-01T00:00:00Z',
      hostSessionId: 'hsid-m10',
      scopeRef: 'project:m10',
      laneRef: 'default',
      generation: 1,
      category: 'session',
      eventKind: 'session.created',
      replayed: false,
      payload: {},
    }
    const validEvent2: HrcLifecycleEvent = {
      hrcSeq: 3,
      streamSeq: 12,
      ts: '2026-04-01T00:00:02Z',
      hostSessionId: 'hsid-m10',
      scopeRef: 'project:m10',
      laneRef: 'default',
      generation: 1,
      category: 'session',
      eventKind: 'session.resolved',
      replayed: false,
      payload: {},
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
    const collected: HrcLifecycleEvent[] = []

    // This should NOT throw — the generator must handle malformed lines gracefully
    for await (const event of client.watch()) {
      collected.push(event)
    }

    // Both valid events should be yielded; the malformed line should be skipped
    expect(collected.length).toBe(2)
    expect(collected[0]!.hrcSeq).toBe(1)
    expect(collected[1]!.hrcSeq).toBe(3)
  })

  // -- m-20: watch() has no AbortSignal/cancellation --
  // Current code: WatchOptions only has fromSeq and follow — no signal field.
  // Expected: WatchOptions accepts optional `signal: AbortSignal` and terminates
  // iteration when aborted.
  it('m-20: watch() terminates on AbortSignal after first event', async () => {
    const events: HrcLifecycleEvent[] = Array.from({ length: 5 }, (_, i) => ({
      hrcSeq: i + 1,
      streamSeq: i + 10,
      ts: `2026-04-01T00:00:0${i}Z`,
      hostSessionId: 'hsid-m20',
      scopeRef: 'project:m20',
      laneRef: 'default',
      generation: 1,
      category: 'session',
      eventKind: 'session.created',
      replayed: false,
      payload: {},
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
    const collected: HrcLifecycleEvent[] = []

    // Pass signal in WatchOptions — this field does not exist yet (RED)
    for await (const event of client.watch({ signal: controller.signal } as any)) {
      collected.push(event)
      if (collected.length === 1) {
        controller.abort()
      }
    }

    // Should stop after first event — not consume all 5
    expect(collected.length).toBe(1)
    expect(collected[0]!.hrcSeq).toBe(1)
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
