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
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StatusResponse } from 'hrc-core'
import { HRC_API_VERSION, HrcDomainError, HrcErrorCode } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
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
    expect(result.cwd).toBe(process.cwd())
    expect(typeof result.binaryPath).toBe('string')
    expect(typeof result.packagePath).toBe('string')
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

  it('listRuns returns an array', async () => {
    if (!server) return
    const client = new HrcClient(socketPath)
    const result = await client.listRuns({ limit: 1 })
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
