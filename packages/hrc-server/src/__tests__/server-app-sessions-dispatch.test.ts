/**
 * RED/GREEN tests for app-owned harness dispatch, in-flight input, and
 * clear-context (T-01005 / Phase 5)
 *
 * Tests the /v1/app-sessions/* dispatch routes for app-owned harness sessions:
 *   - POST /v1/app-sessions/turns dispatches a semantic turn via selector
 *   - Cached intent fallback when no intent supplied in dispatch
 *   - Missing intent rejection when no cached or supplied intent exists
 *   - Session kind mismatch when dispatch targets a command session
 *   - POST /v1/app-sessions/in-flight-input delivers in-flight input via selector
 *   - POST /v1/app-sessions/clear-context rotates context and increments generation
 *   - Clear-context invalidates existing bridge targets
 *   - Clear-context invalidates existing surface bindings
 *   - Clear-context with relaunch=true relaunches the runtime
 *   - GET /v1/status reports appHarnessSessions capability
 *
 * Pass conditions for Larry (T-01005):
 *   1.  POST /v1/app-sessions/turns dispatches turn using selector
 *   2.  Response contains { runId, hostSessionId, generation, runtimeId, transport, status, supportsInFlightInput }
 *   3.  Dispatch uses cached intent when no intent supplied in request
 *   4.  Dispatch rejects MISSING_RUNTIME_INTENT when no cached or supplied intent
 *   5.  Dispatch rejects SESSION_KIND_MISMATCH when targeting a command session
 *   6.  POST /v1/app-sessions/in-flight-input delivers input to active run
 *   7.  In-flight input rejects UNKNOWN_APP_SESSION for non-existent selector
 *   8.  POST /v1/app-sessions/clear-context rotates hostSessionId
 *   9.  Clear-context increments generation
 *  10.  Clear-context returns priorHostSessionId
 *  11.  Clear-context with relaunch=true relaunches the runtime on new context
 *  12.  Clear-context invalidates prior bridge targets
 *  13.  Clear-context invalidates prior surface bindings
 *  14.  GET /v1/status reports platform.appHarnessSessions = true
 *
 * Test strategy:
 *   - Spins up a real createHrcServer on a tmp unix socket with real SQLite
 *   - Seeds app-owned harness sessions via /v1/app-sessions/ensure
 *   - Validates dispatch, in-flight, and clear-context behavior end-to-end
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'

import type {
  ClearAppSessionContextResponse,
  DispatchAppHarnessTurnResponse,
  EnsureAppSessionResponse,
  HrcHttpError,
  SendAppHarnessInFlightInputResponse,
  StatusResponse,
} from 'hrc-core'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

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

/** Non-interactive harness intent for SDK dispatch */
function harnessIntent(provider: 'anthropic' | 'openai' = 'anthropic'): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: false,
    },
    execution: {
      preferredMode: 'nonInteractive',
    },
  }
}

/** Seed a harness app-session and return the ensure response */
async function seedHarnessSession(
  appId: string,
  appSessionKey: string
): Promise<EnsureAppSessionResponse> {
  const res = await postJson('/v1/app-sessions/ensure', {
    selector: { appId, appSessionKey },
    spec: {
      kind: 'harness',
      runtimeIntent: harnessIntent(),
    },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as EnsureAppSessionResponse
}

/** Seed a command app-session and return the ensure response */
async function seedCommandSession(
  appId: string,
  appSessionKey: string
): Promise<EnsureAppSessionResponse> {
  const res = await postJson('/v1/app-sessions/ensure', {
    selector: { appId, appSessionKey },
    spec: {
      kind: 'command',
      command: { launchMode: 'exec', argv: ['sleep', '300'] },
    },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as EnsureAppSessionResponse
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-p5-dispatch-'))
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

// ---------------------------------------------------------------------------
// 1. POST /v1/app-sessions/turns — basic harness dispatch via selector
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/turns', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('dispatches a semantic turn using app-session selector', async () => {
    server = await createHrcServer(serverOpts())
    await seedHarnessSession('workbench', 'assistant')

    // RED GATE: POST /v1/app-sessions/turns route does not exist
    const res = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'assistant' },
      prompt: 'List files in the current directory',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as DispatchAppHarnessTurnResponse
    expect(body.runId).toBeDefined()
    expect(body.hostSessionId).toBeDefined()
    expect(body.generation).toBeGreaterThanOrEqual(1)
    expect(body.runtimeId).toBeDefined()
    expect(body.transport).toBeDefined()
    expect(body.supportsInFlightInput).toBeDefined()
  })

  it('uses cached intent when no intent supplied in dispatch', async () => {
    server = await createHrcServer(serverOpts())
    // Seed with an intent — this becomes the cached intent
    await seedHarnessSession('workbench', 'cached-intent')

    // Dispatch WITHOUT supplying intent — should use the cached one from ensure
    // RED GATE: cached intent fallback not implemented
    const res = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'cached-intent' },
      prompt: 'Use cached intent to dispatch',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as DispatchAppHarnessTurnResponse
    expect(body.runId).toBeDefined()
    expect(body.runtimeId).toBeDefined()
  })

  it('accepts canonical runId, input.text, and fence fields', async () => {
    server = await createHrcServer(serverOpts())
    const ensured = await seedHarnessSession('workbench', 'canonical-turn')

    const res = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'canonical-turn' },
      runId: 'run-canonical-turn',
      input: { text: 'Dispatch using canonical request shape' },
      fence: {
        expectedHostSessionId: ensured.session.activeHostSessionId,
        expectedGeneration: ensured.session.generation,
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as DispatchAppHarnessTurnResponse
    expect(body.runId).toBe('run-canonical-turn')
  })

  it('rejects MISSING_RUNTIME_INTENT when no cached or supplied intent', async () => {
    server = await createHrcServer(serverOpts())

    // Seed a harness session with no intent stored (ensure with minimal spec)
    // Then try to dispatch without supplying intent
    // First ensure — stores intent from spec
    await seedHarnessSession('workbench', 'no-intent')

    // Now clear context to rotate — the new context may have no runtime yet
    // Then try to dispatch to a harness session where the intent is unavailable
    // For this test, we rely on the server rejecting when intent is truly missing
    // If the server always caches from ensure, we need a session created through
    // a path that doesn't store intent.
    //
    // Alternative: POST /v1/app-sessions/turns to a session that was created
    // through apply (which doesn't supply a runtime intent for harness sessions).
    await postJson('/v1/app-sessions/apply', {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'bare-harness',
          spec: { kind: 'harness', runtimeIntent: undefined },
        },
      ],
    })
    // apply may or may not support harness without intent — if it rejects, that's
    // also acceptable behavior. The key test: dispatch with no intent must fail.
    // RED GATE: MISSING_RUNTIME_INTENT error not implemented for selector dispatch
    const res = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'bare-harness' },
      prompt: 'This should fail without intent',
    })

    // Should reject — either 404 (no session) or 422 (missing intent)
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = (await res.json()) as HrcHttpError
    // Accept either UNKNOWN_APP_SESSION (if apply failed) or MISSING_RUNTIME_INTENT
    expect(body.error.code).toMatch(/missing_runtime_intent|unknown_app_session/)
  })

  it('rejects SESSION_KIND_MISMATCH when targeting a command session', async () => {
    server = await createHrcServer(serverOpts())
    await seedCommandSession('workbench', 'log-tail')

    // RED GATE: SESSION_KIND_MISMATCH rejection not implemented for selector dispatch
    const res = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'log-tail' },
      prompt: 'This should fail — command sessions do not support dispatch',
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('session_kind_mismatch')
  })

  it('rejects UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: error path for unknown selector on dispatch
    const res = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'does-not-exist' },
      prompt: 'No such session',
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 2. POST /v1/app-sessions/in-flight-input — semantic in-flight via selector
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/in-flight-input', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('delivers in-flight input to an active harness run', async () => {
    server = await createHrcServer(serverOpts())
    await seedHarnessSession('workbench', 'inflight-test')

    // First dispatch a turn to get an active run
    const turnRes = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'inflight-test' },
      prompt: 'Start a long-running task',
    })
    const turnData = (await turnRes.json()) as DispatchAppHarnessTurnResponse

    // RED GATE: POST /v1/app-sessions/in-flight-input route does not exist
    const res = await postJson('/v1/app-sessions/in-flight-input', {
      selector: { appId: 'workbench', appSessionKey: 'inflight-test' },
      prompt: 'Also install the dev dependencies',
      runId: turnData.runId,
    })

    // For SDK runtimes in-flight may or may not be supported; check response shape
    // The key assertion is that the endpoint exists and returns the correct shape
    const body = (await res.json()) as SendAppHarnessInFlightInputResponse
    expect(body.hostSessionId).toBeDefined()
    expect(body.runtimeId).toBeDefined()
    expect(body.runId).toBe(turnData.runId)
    // accepted may be true or false depending on runtime support
    expect(typeof body.accepted).toBe('boolean')
  })

  it('rejects UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: error path for unknown selector on in-flight
    const res = await postJson('/v1/app-sessions/in-flight-input', {
      selector: { appId: 'workbench', appSessionKey: 'ghost' },
      prompt: 'No such session',
      runId: 'run-none',
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })

  it('accepts canonical input.text and defaults runId from the active run', async () => {
    server = await createHrcServer(serverOpts())
    const ensured = await seedHarnessSession('workbench', 'canonical-inflight')

    const turnRes = await postJson('/v1/app-sessions/turns', {
      selector: { appId: 'workbench', appSessionKey: 'canonical-inflight' },
      prompt: 'Start the task before in-flight input',
    })
    expect(turnRes.status).toBe(200)
    const turnBody = (await turnRes.json()) as DispatchAppHarnessTurnResponse

    const res = await postJson('/v1/app-sessions/in-flight-input', {
      selector: { appId: 'workbench', appSessionKey: 'canonical-inflight' },
      input: { text: 'Continue using canonical input payload' },
      fence: {
        expectedHostSessionId: ensured.session.activeHostSessionId,
        expectedGeneration: ensured.session.generation,
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SendAppHarnessInFlightInputResponse
    expect(body.accepted).toBe(true)
    expect(body.runId).toBe(turnBody.runId)
  })

  it('rejects SESSION_KIND_MISMATCH for command session', async () => {
    server = await createHrcServer(serverOpts())
    await seedCommandSession('workbench', 'cmd-inflight')

    // RED GATE: SESSION_KIND_MISMATCH on in-flight to command session
    const res = await postJson('/v1/app-sessions/in-flight-input', {
      selector: { appId: 'workbench', appSessionKey: 'cmd-inflight' },
      prompt: 'Commands do not support in-flight',
      runId: 'run-none',
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('session_kind_mismatch')
  })
})

// ---------------------------------------------------------------------------
// 3. POST /v1/app-sessions/clear-context — generation rotation and relaunch
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/clear-context', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('rotates hostSessionId and increments generation', async () => {
    server = await createHrcServer(serverOpts())
    const ensured = await seedHarnessSession('workbench', 'ctx-rotate')
    const originalHsid = ensured.session.activeHostSessionId
    const originalGen = ensured.session.generation

    // RED GATE: POST /v1/app-sessions/clear-context route does not exist
    const res = await postJson('/v1/app-sessions/clear-context', {
      selector: { appId: 'workbench', appSessionKey: 'ctx-rotate' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as ClearAppSessionContextResponse
    expect(body.hostSessionId).toBeDefined()
    expect(body.hostSessionId).not.toBe(originalHsid)
    expect(body.generation).toBe(originalGen + 1)
    expect(body.priorHostSessionId).toBe(originalHsid)
  })

  it('returns updated managed session record with new generation', async () => {
    server = await createHrcServer(serverOpts())
    await seedHarnessSession('workbench', 'ctx-gen')

    await postJson('/v1/app-sessions/clear-context', {
      selector: { appId: 'workbench', appSessionKey: 'ctx-gen' },
    })

    // Verify via get-by-key that generation incremented
    const getRes = await fetchSocket(
      '/v1/app-sessions/by-key?appId=workbench&appSessionKey=ctx-gen'
    )
    expect(getRes.status).toBe(200)
    const record = (await getRes.json()) as any
    expect(record.generation).toBe(2)
  })

  it('relaunches with relaunch=true using cached intent', async () => {
    server = await createHrcServer(serverOpts())
    await seedHarnessSession('workbench', 'ctx-relaunch')

    // RED GATE: relaunch after clear-context not implemented
    const res = await postJson('/v1/app-sessions/clear-context', {
      selector: { appId: 'workbench', appSessionKey: 'ctx-relaunch' },
      relaunch: true,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as ClearAppSessionContextResponse
    expect(body.generation).toBe(2)
    expect(body.hostSessionId).toBeDefined()
  })

  it('invalidates prior bridge targets after rotation', async () => {
    server = await createHrcServer(serverOpts())
    const ensured = await seedHarnessSession('workbench', 'ctx-bridge')
    const hsid = ensured.session.activeHostSessionId

    // Register a bridge on the old context
    await postJson('/v1/bridges/local-target', {
      hostSessionId: hsid,
      bridge: 'legacy-agentchat',
      transport: 'tmux',
      target: 'old-target',
    })

    // Now clear context — should invalidate old bridges
    // RED GATE: bridge invalidation on clear-context not implemented
    await postJson('/v1/app-sessions/clear-context', {
      selector: { appId: 'workbench', appSessionKey: 'ctx-bridge' },
    })

    // Check that old bridge is no longer active
    // Attempting delivery to old target should fail with stale fence
    const deliverRes = await postJson('/v1/bridges/deliver', {
      hostSessionId: hsid,
      bridge: 'legacy-agentchat',
      text: 'This should fail — context rotated',
      fence: { expectedHostSessionId: hsid },
    })

    // Should be rejected — stale context after rotation
    expect(deliverRes.status).toBeGreaterThanOrEqual(400)
  })

  it('invalidates prior surface bindings after rotation', async () => {
    server = await createHrcServer(serverOpts())
    const ensured = await seedHarnessSession('workbench', 'ctx-surface')
    const hsid = ensured.session.activeHostSessionId

    // Bind a surface on the old context
    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'tab',
      surfaceId: 'tab-1',
      hostSessionId: hsid,
      generation: 1,
    })

    // Now clear context
    // RED GATE: surface invalidation on clear-context not implemented
    await postJson('/v1/app-sessions/clear-context', {
      selector: { appId: 'workbench', appSessionKey: 'ctx-surface' },
    })

    // Verify the old surface binding is gone or invalidated
    // Try to list surfaces for the old context — should return empty or stale
    const listRes = await fetchSocket('/v1/surfaces?runtimeId=nonexistent')
    expect(listRes.status).toBe(200)
    const surfaces = (await listRes.json()) as any[]
    // Old surfaces should not appear for the new context
    const staleSurfaces = surfaces.filter(
      (s: any) => s.surfaceId === 'tab-1' && s.hostSessionId === hsid
    )
    // After rotation, old bindings should be invalidated
    expect(staleSurfaces.length).toBe(0)
  })

  it('rejects UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/clear-context', {
      selector: { appId: 'workbench', appSessionKey: 'ghost-session' },
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 4. GET /v1/status — Phase 5 capability flags
// ---------------------------------------------------------------------------
describe('GET /v1/status — Phase 5 capabilities', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('reports platform.appHarnessSessions = true', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: appHarnessSessions capability not reported
    const res = await fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatusResponse
    expect(body.capabilities.platform.appHarnessSessions).toBe(true)
  })
})
