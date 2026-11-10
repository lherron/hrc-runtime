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
 *   - Client round-trip tests spin up a scratch native owner on a temp socket
 *   - Error parsing tests use a minimal Bun.serve stub that returns known error shapes
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { StatusResponse } from 'hrc-core'
import { HRC_API_VERSION } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
// ---------------------------------------------------------------------------
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const candidates = [
  join(repoRoot, 'crates/target/aarch64-apple-darwin/debug/rusthrc'),
  join(repoRoot, 'crates/target/debug/rusthrc'),
]
const binary = process.env['HRC_TEST_RUSTHRC'] ?? candidates.find(existsSync) ?? candidates[0]!
const hasBinary = existsSync(binary)
if (!hasBinary) {
  console.warn(
    `Skipping SDK diagnostics: no built rusthrc at ${binary}; run just cargo-check first`
  )
}

// A missing build is the only skip condition. Migration, boot and client failures
// fail the suite. verify-bun builds the native owner before running these cases.
describe.skipIf(!hasBinary)('Phase 6 diagnostics round-trip', () => {
  let tmpDir: string | undefined
  let socketPath: string
  let server: ReturnType<typeof Bun.spawn> | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp('/tmp/sdk-diag-')
    const runtimeRoot = join(tmpDir, 'run')
    const stateRoot = join(tmpDir, 'state')
    socketPath = join(runtimeRoot, 'hrc.sock')
    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })

    // Never pass this seat's identity, live ledger, launchd label or federation
    // config to the owner. Every owner root and external socket is private.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(HRC_|ASP_|AGENT|HARNESS|WRKQ|TMUX|CLAUDE|CODEX|ACP_|GIT_|XPC_SERVICE_NAME)/.test(key)
      )
    )
    Object.assign(env, {
      HRC_RUNTIME_DIR: runtimeRoot,
      HRC_STATE_DIR: stateRoot,
      HRC_PEER_CONFIG_FILE: join(tmpDir, 'federation.json'),
      HRC_WRKQ_DB: join(tmpDir, 'wrkq.sqlite'),
      WRKQ_DB: join(tmpDir, 'wrkq.sqlite'),
      HRC_ASPD_SOCKET: join(tmpDir, 'aspd.sock'),
      HRC_EVENT_INGEST_SOCKET: join(runtimeRoot, 'ingest.sock'),
      HRC_PROJECT_SEARCH_ROOTS: join(tmpDir, 'projects'),
      ASP_HOME: join(tmpDir, 'asp'),
      ASP_AGENTS_ROOT: join(tmpDir, 'agents'),
      HRC_LAUNCHD_LABEL: 'hrc.sdk-diagnostics.scratch',
    })
    const logPath = join(tmpDir, 'serve.log')
    const migrate = Bun.spawn([binary, 'store', 'migrate', join(stateRoot, 'state.sqlite')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      migrate.exited,
      new Response(migrate.stdout).text(),
      new Response(migrate.stderr).text(),
    ])
    if (code !== 0) throw new Error(`scratch migration failed (${code}): ${stdout}${stderr}`)
    server = Bun.spawn([binary, 'server', 'serve'], {
      env,
      cwd: process.cwd(),
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
    })
    const client = new HrcClient(socketPath)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) break
      try {
        await client.getHealth()
        return
      } catch {
        await Bun.sleep(50)
      }
    }
    throw new Error(`scratch rusthrc failed to become ready: ${await Bun.file(logPath).text()}`)
  }, 15000)

  afterAll(async () => {
    if (server) {
      server.kill('SIGTERM')
      const deadline = setTimeout(() => server?.kill('SIGKILL'), 5000)
      try {
        await server.exited
      } finally {
        clearTimeout(deadline)
      }
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it('getHealth returns { ok: true }', async () => {
    const client = new HrcClient(socketPath)
    // RED: getHealth does not exist on HrcClient
    const result = await (client as any).getHealth()
    expect(result).toEqual({ ok: true })
  })

  it('getStatus returns server status with uptime', async () => {
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
      ensureRuntime: false,
      dispatchTurn: true,
      inFlightInput: true,
      capture: true,
      attach: true,
      clearContext: true,
    })
    expect(result.capabilities.platform).toEqual({
      appOwnedSessions: false,
      appHarnessSessions: false,
      commandSessions: true,
      literalInput: true,
      surfaceBindings: true,
      legacyLocalBridges: [],
    })
    expect(result.capabilities.bridgeDelivery).toEqual({
      actualPtyInjection: false,
      enter: false,
      oobSuffix: false,
      freshnessFence: false,
    })
    expect(typeof result.capabilities.backend.tmux.available).toBe('boolean')
    if (result.capabilities.backend.tmux.available) {
      expect(typeof result.capabilities.backend.tmux.version).toBe('string')
    } else {
      expect(result.capabilities.backend.tmux.version).toBeUndefined()
    }
  })

  it('listRuntimes returns an array', async () => {
    const client = new HrcClient(socketPath)
    // RED: listRuntimes does not exist on HrcClient
    const result = await (client as any).listRuntimes()
    expect(Array.isArray(result)).toBe(true)
    // Prior tests in this suite may have created runtimes in the shared
    // server instance, so we only assert the shape, not the count.
  })

  it('listRuns returns an array', async () => {
    const client = new HrcClient(socketPath)
    const result = await client.listRuns({ limit: 1 })
    expect(Array.isArray(result)).toBe(true)
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
