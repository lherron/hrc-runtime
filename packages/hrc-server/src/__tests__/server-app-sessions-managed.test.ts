/**
 * RED/GREEN tests for managed app-session registry API (T-01001 / Phase 3)
 *
 * Tests the /v1/app-sessions/* endpoints for app-owned managed sessions:
 *   - POST /v1/app-sessions/ensure creates managed session + host context
 *   - Idempotent ensure returns existing session
 *   - forceRestart triggers runtime restart
 *   - GET /v1/app-sessions filters by appId/kind/status
 *   - GET /v1/app-sessions/by-key returns record or 404 UNKNOWN_APP_SESSION
 *   - POST /v1/app-sessions/remove marks removed and cleans up runtime, bridges, surfaces
 *   - POST /v1/app-sessions/apply bulk create/update + pruneMissing removal
 *   - Invalid operations return new error codes
 *   - GET /v1/status reports platform.appOwnedSessions = true
 *
 * Pass conditions for Curly (T-01003):
 *   1.  POST /v1/app-sessions/ensure creates a managed session with activeHostSessionId
 *   2.  Ensure response contains { session, runtimeId?, status }
 *   3.  Second ensure with same selector is idempotent (same session returned)
 *   4.  Ensure with forceRestart=true triggers runtime restart
 *   5.  GET /v1/app-sessions returns array filtered by appId
 *   6.  GET /v1/app-sessions filters by kind ('harness' | 'command')
 *   7.  GET /v1/app-sessions filters by status ('active' | 'removed')
 *   8.  GET /v1/app-sessions/by-key returns record for existing key
 *   9.  GET /v1/app-sessions/by-key returns 404 UNKNOWN_APP_SESSION for missing key
 *  10.  POST /v1/app-sessions/remove marks session removed
 *  11.  Remove terminates active runtime by default
 *  12.  Remove closes active bridges for the host session
 *  13.  Remove unbinds active surfaces for the host session
 *  14.  POST /v1/app-sessions/apply bulk creates/updates sessions
 *  15.  Apply with pruneMissing=true removes sessions not in payload
 *  16.  Invalid selector returns MALFORMED_REQUEST
 *  17.  Ensure on removed session returns APP_SESSION_REMOVED
 *  18.  Kind mismatch on ensure returns SESSION_KIND_MISMATCH
 *  19.  GET /v1/status reports platform.appOwnedSessions = true
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

// RED GATE: server must handle /v1/app-sessions/* routes
import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'

// RED GATE: these types do not exist yet in hrc-core
import type { EnsureAppSessionResponse, StatusResponse } from 'hrc-core'
import type { HrcManagedSessionRecord } from 'hrc-core'
import type { HrcHttpError } from 'hrc-core'

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

function interactiveHarnessIntent(targetDir: string): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      targetDir,
    },
    harness: {
      provider: 'anthropic',
      interactive: true,
    },
  }
}

const DEAD_PID = 2147483001

async function markLatestLaunchStarted(hostSessionId: string, pid: number): Promise<void> {
  let launchId: string | undefined
  const db = openHrcDatabase(dbPath)
  try {
    const launches = db.launches.listByHostSessionId(hostSessionId)
    const latestLaunch = launches.at(-1)
    expect(latestLaunch).toBeDefined()
    launchId = latestLaunch!.launchId
  } finally {
    db.close()
  }

  const res = await postJson(`/v1/internal/launches/${launchId}/wrapper-started`, {
    hostSessionId,
    wrapperPid: pid,
  })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-ms-test-'))
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
// 1. POST /v1/app-sessions/ensure — create managed session + host context
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/ensure', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('creates a new managed session with host context', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: POST /v1/app-sessions/ensure route does not exist
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'assistant' },
      sessionRef: 'agent:test:project:ms-test/lane:assistant',
      label: 'Main assistant',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse
    expect(body.session).toBeDefined()
    expect(body.session.appId).toBe('workbench')
    expect(body.session.appSessionKey).toBe('assistant')
    expect(body.session.kind).toBe('harness')
    expect(body.session.status).toBe('active')
    expect(body.session.activeHostSessionId).toBeDefined()
    expect(body.status).toBeDefined()
  })

  it('is idempotent — returns same session on second ensure', async () => {
    server = await createHrcServer(serverOpts())

    const ensurePayload = {
      selector: { appId: 'workbench', appSessionKey: 'idem-test' },
      sessionRef: 'agent:test:project:ms-test/lane:idem-test',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    }

    const res1 = await postJson('/v1/app-sessions/ensure', ensurePayload)
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as EnsureAppSessionResponse

    const res2 = await postJson('/v1/app-sessions/ensure', ensurePayload)
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as EnsureAppSessionResponse

    expect(body2.session.appId).toBe(body1.session.appId)
    expect(body2.session.appSessionKey).toBe(body1.session.appSessionKey)
    expect(body2.session.activeHostSessionId).toBe(body1.session.activeHostSessionId)
    expect(body2.session.createdAt).toBe(body1.session.createdAt)
  })

  // T-01077: command kind is evicted from app-managed sessions (Phase 3a).
  // This test was: 'creates a command-kind managed session'.
  // After the split, command sessions go through /v1/windows/ensure.
  it('rejects command-kind on managed session ensure', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'log-tail' },
      sessionRef: 'agent:test:project:ms-test/lane:log-tail',
      spec: {
        kind: 'command',
        command: {
          launchMode: 'exec',
          argv: ['tail', '-f', '/var/log/app.log'],
        },
      },
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unsupported_capability')
  })

  it('accepts initialPrompt on ensure and persists it into the harness runtime intent', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-seed' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-seed',
      initialPrompt: 'Investigate the failing smoke test',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse
    expect(body.session.appId).toBe('workbench')
    expect(body.session.appSessionKey).toBe('prompt-seed')

    const db = openHrcDatabase(dbPath)
    try {
      const record = db.appManagedSessions.findByKey('workbench', 'prompt-seed')
      expect(record).not.toBeNull()
      expect(record!.lastAppliedSpec).toBeDefined()
      expect(record!.lastAppliedSpec!.kind).toBe('harness')
      const runtimeIntent = (
        record!.lastAppliedSpec as {
          kind: 'harness'
          runtimeIntent: { initialPrompt?: string | undefined }
        }
      ).runtimeIntent
      expect(runtimeIntent.initialPrompt).toBe('Investigate the failing smoke test')
    } finally {
      db.close()
    }
  })

  it('does not auto-dispatch a non-interactive harness ensure even when initialPrompt is provided', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-seed-noninteractive' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-seed-ni',
      initialPrompt: 'Investigate the failing smoke test',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse

    const launchesRes = await fetchSocket(
      `/v1/launches?hostSessionId=${encodeURIComponent(body.session.activeHostSessionId)}`
    )
    expect(launchesRes.status).toBe(200)
    const launches = (await launchesRes.json()) as Array<unknown>
    expect(launches).toHaveLength(0)
  })

  it('does not synthesize initialPrompt when ensure omits it', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-absent' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-absent',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(200)

    const db = openHrcDatabase(dbPath)
    try {
      const record = db.appManagedSessions.findByKey('workbench', 'prompt-absent')
      expect(record).not.toBeNull()
      expect(record!.lastAppliedSpec).toBeDefined()
      expect(record!.lastAppliedSpec!.kind).toBe('harness')
      const runtimeIntent = (
        record!.lastAppliedSpec as {
          kind: 'harness'
          runtimeIntent: { initialPrompt?: string | undefined }
        }
      ).runtimeIntent
      expect(runtimeIntent.initialPrompt).toBeUndefined()
      expect(Object.hasOwn(runtimeIntent, 'initialPrompt')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('auto-dispatches the first harness turn when ensure includes initialPrompt', async () => {
    server = await createHrcServer(serverOpts())

    /**
     * T-01021 RED gate:
     * ensureAppSession currently persists initialPrompt and creates the tmux
     * runtime, but it returns before dispatching the first harness turn.
     *
     * Pass condition for GREEN:
     *   - ensure returns 200 for an interactive harness session
     *   - one runtime exists for the managed host session
     *   - exactly one launch record exists for that host session
     */
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-autostart' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-autostart',
      initialPrompt: 'Investigate the failing smoke test',
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse

    const runtimesRes = await fetchSocket(
      `/v1/runtimes?hostSessionId=${encodeURIComponent(body.session.activeHostSessionId)}`
    )
    expect(runtimesRes.status).toBe(200)
    const runtimes = (await runtimesRes.json()) as Array<{ runtimeId: string }>
    expect(runtimes).toHaveLength(1)

    const launchesRes = await fetchSocket(
      `/v1/launches?hostSessionId=${encodeURIComponent(body.session.activeHostSessionId)}`
    )
    expect(launchesRes.status).toBe(200)
    const launches = (await launchesRes.json()) as Array<{ runtimeId: string }>
    expect(launches).toHaveLength(1)
    expect(launches[0]?.runtimeId).toBe(runtimes[0]?.runtimeId)
  })

  it('auto-dispatches the first harness turn even when ensure omits initialPrompt', async () => {
    server = await createHrcServer(serverOpts())

    /**
     * T-01023 RED gate:
     * interactive ensure should launch the harness even without a prompt so
     * attach works immediately, but the persisted intent must still omit
     * initialPrompt.
     */
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-no-autostart' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-no-autostart',
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse

    const runtimesRes = await fetchSocket(
      `/v1/runtimes?hostSessionId=${encodeURIComponent(body.session.activeHostSessionId)}`
    )
    expect(runtimesRes.status).toBe(200)
    const runtimes = (await runtimesRes.json()) as Array<{ runtimeId: string }>
    expect(runtimes).toHaveLength(1)

    const launchesRes = await fetchSocket(
      `/v1/launches?hostSessionId=${encodeURIComponent(body.session.activeHostSessionId)}`
    )
    expect(launchesRes.status).toBe(200)
    const launches = (await launchesRes.json()) as Array<{ runtimeId: string }>
    expect(launches).toHaveLength(1)
    expect(launches[0]?.runtimeId).toBe(runtimes[0]?.runtimeId)

    const db = openHrcDatabase(dbPath)
    try {
      const record = db.appManagedSessions.findByKey('workbench', 'prompt-no-autostart')
      expect(record).not.toBeNull()
      const runtimeIntent = (
        record!.lastAppliedSpec as {
          kind: 'harness'
          runtimeIntent: { initialPrompt?: string | undefined }
        }
      ).runtimeIntent
      expect(runtimeIntent.initialPrompt).toBeUndefined()
      expect(Object.hasOwn(runtimeIntent, 'initialPrompt')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('auto-dispatches after forceRestart when an existing harness session is re-ensured with initialPrompt', async () => {
    server = await createHrcServer(serverOpts())

    /**
     * T-01021 restart-path guard:
     * existing managed harness sessions must also dispatch the first turn when
     * forceRestart creates a fresh runtime and initialPrompt is supplied.
     */
    const firstRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-restart-autostart' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-restart-autostart',
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })
    expect(firstRes.status).toBe(200)
    const firstBody = (await firstRes.json()) as EnsureAppSessionResponse

    const secondRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'prompt-restart-autostart' },
      sessionRef: 'agent:test:project:ms-test/lane:prompt-restart-autostart',
      initialPrompt: 'Re-dispatch after restart',
      forceRestart: true,
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })

    expect(secondRes.status).toBe(200)
    const secondBody = (await secondRes.json()) as EnsureAppSessionResponse
    expect(secondBody.restarted).toBe(true)
    expect(secondBody.status).toBe('restarted')
    expect(secondBody.session.activeHostSessionId).toBe(firstBody.session.activeHostSessionId)

    const launchesRes = await fetchSocket(
      `/v1/launches?hostSessionId=${encodeURIComponent(secondBody.session.activeHostSessionId)}`
    )
    expect(launchesRes.status).toBe(200)
    const launches = (await launchesRes.json()) as Array<{ runtimeId: string }>
    // T-01024: first ensure now auto-dispatches even without initialPrompt,
    // so there are 2 launches total (one per ensure)
    expect(launches).toHaveLength(2)
    expect(launches[1]?.runtimeId).toBe(secondBody.runtimeId)
  })

  it('with forceRestart=true restarts the runtime', async () => {
    server = await createHrcServer(serverOpts())

    // First ensure to create the session
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'restart-test' },
      sessionRef: 'agent:test:project:ms-test/lane:restart-test',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    // Second ensure with forceRestart
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'restart-test' },
      sessionRef: 'agent:test:project:ms-test/lane:restart-test',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
      forceRestart: true,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse
    expect(body.session.appSessionKey).toBe('restart-test')
    expect(body.session.status).toBe('active')
  })

  it('reuses the same interactive runtime when the tracked launch process is still live', async () => {
    server = await createHrcServer(serverOpts())

    /**
     * T-01026 RED gate:
     * re-ensuring an existing interactive managed harness session should
     * preserve the current runtime when the tracked launch process is still
     * alive. A live process should not be treated like an implicit restart.
     */
    const ensurePayload = {
      selector: { appId: 'workbench', appSessionKey: 'reattach-live-runtime' },
      sessionRef: 'agent:test:project:ms-test/lane:reattach-live-runtime',
      spec: {
        kind: 'harness' as const,
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    }

    const firstRes = await postJson('/v1/app-sessions/ensure', ensurePayload)
    expect(firstRes.status).toBe(200)
    const firstBody = (await firstRes.json()) as EnsureAppSessionResponse
    expect(firstBody.runtimeId).toBeDefined()

    await markLatestLaunchStarted(firstBody.session.activeHostSessionId, process.pid)

    const secondRes = await postJson('/v1/app-sessions/ensure', ensurePayload)
    expect(secondRes.status).toBe(200)
    const secondBody = (await secondRes.json()) as EnsureAppSessionResponse

    expect(secondBody.runtimeId).toBe(firstBody.runtimeId)
    expect(secondBody.restarted).toBe(false)
    expect(secondBody.status).toBe('ensured')

    const runtimesRes = await fetchSocket(
      `/v1/runtimes?hostSessionId=${encodeURIComponent(firstBody.session.activeHostSessionId)}`
    )
    expect(runtimesRes.status).toBe(200)
    const runtimes = (await runtimesRes.json()) as Array<{ runtimeId: string }>
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0]?.runtimeId).toBe(firstBody.runtimeId)
  })

  it('replaces the interactive runtime when the tracked launch process is dead', async () => {
    server = await createHrcServer(serverOpts())

    /**
     * T-01026 RED gate:
     * if the launch-tracked process is dead, re-ensure must create a fresh
     * runtime even when the tmux session metadata is still present.
     */
    const ensurePayload = {
      selector: { appId: 'workbench', appSessionKey: 'reattach-dead-runtime' },
      sessionRef: 'agent:test:project:ms-test/lane:reattach-dead-runtime',
      spec: {
        kind: 'harness' as const,
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    }

    const firstRes = await postJson('/v1/app-sessions/ensure', ensurePayload)
    expect(firstRes.status).toBe(200)
    const firstBody = (await firstRes.json()) as EnsureAppSessionResponse
    expect(firstBody.runtimeId).toBeDefined()

    await markLatestLaunchStarted(firstBody.session.activeHostSessionId, DEAD_PID)

    const secondRes = await postJson('/v1/app-sessions/ensure', ensurePayload)
    expect(secondRes.status).toBe(200)
    const secondBody = (await secondRes.json()) as EnsureAppSessionResponse

    expect(secondBody.runtimeId).toBeDefined()
    expect(secondBody.runtimeId).not.toBe(firstBody.runtimeId)
    expect(secondBody.restarted).toBe(false)
    expect(secondBody.status).toBe('ensured')
  })

  it('forceRestart still replaces the interactive runtime even when the tracked process is live', async () => {
    server = await createHrcServer(serverOpts())

    /**
     * T-01026 guard:
     * forceRestart must continue to replace the runtime explicitly, even when
     * the current tracked process is live and otherwise reusable.
     */
    const firstRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'reattach-force-restart' },
      sessionRef: 'agent:test:project:ms-test/lane:reattach-force-restart',
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })
    expect(firstRes.status).toBe(200)
    const firstBody = (await firstRes.json()) as EnsureAppSessionResponse
    expect(firstBody.runtimeId).toBeDefined()

    await markLatestLaunchStarted(firstBody.session.activeHostSessionId, process.pid)

    const secondRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'reattach-force-restart' },
      sessionRef: 'agent:test:project:ms-test/lane:reattach-force-restart',
      forceRestart: true,
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })

    expect(secondRes.status).toBe(200)
    const secondBody = (await secondRes.json()) as EnsureAppSessionResponse
    expect(secondBody.runtimeId).toBeDefined()
    expect(secondBody.runtimeId).not.toBe(firstBody.runtimeId)
    expect(secondBody.restarted).toBe(true)
    expect(secondBody.status).toBe('restarted')
  })
})

// ---------------------------------------------------------------------------
// 2. GET /v1/app-sessions — list with filters
// ---------------------------------------------------------------------------
describe('GET /v1/app-sessions', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns sessions filtered by appId', async () => {
    server = await createHrcServer(serverOpts())

    // Create sessions for two apps
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'app-a', appSessionKey: 'a-1' },
      sessionRef: 'agent:test:project:ms-test/lane:a-1',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'app-b', appSessionKey: 'b-1' },
      sessionRef: 'agent:test:project:ms-test/lane:b-1',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    // RED GATE: GET /v1/app-sessions route does not exist
    const res = await fetchSocket('/v1/app-sessions?appId=app-a')
    expect(res.status).toBe(200)
    const records = (await res.json()) as HrcManagedSessionRecord[]
    expect(records.length).toBe(1)
    expect(records[0].appId).toBe('app-a')
  })

  it('filters by kind', async () => {
    server = await createHrcServer(serverOpts())

    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'harness-1' },
      sessionRef: 'agent:test:project:ms-test/lane:harness-1',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'cmd-1' },
      sessionRef: 'agent:test:project:ms-test/lane:cmd-1',
      spec: {
        kind: 'command',
        command: { argv: ['/bin/sh'] },
      },
    })

    const res = await fetchSocket('/v1/app-sessions?appId=workbench&kind=harness')
    expect(res.status).toBe(200)
    const records = (await res.json()) as HrcManagedSessionRecord[]
    expect(records.length).toBe(1)
    expect(records[0].kind).toBe('harness')
  })

  it('filters by status', async () => {
    server = await createHrcServer(serverOpts())

    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'active-1' },
      sessionRef: 'agent:test:project:ms-test/lane:active-1',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'to-remove' },
      sessionRef: 'agent:test:project:ms-test/lane:to-remove',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    // Remove one
    await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'workbench', appSessionKey: 'to-remove' },
    })

    const res = await fetchSocket('/v1/app-sessions?appId=workbench&status=active')
    expect(res.status).toBe(200)
    const records = (await res.json()) as HrcManagedSessionRecord[]
    expect(records.length).toBe(1)
    expect(records[0].appSessionKey).toBe('active-1')
  })
})

// ---------------------------------------------------------------------------
// 3. GET /v1/app-sessions/by-key — lookup or 404
// ---------------------------------------------------------------------------
describe('GET /v1/app-sessions/by-key', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns record for existing key', async () => {
    server = await createHrcServer(serverOpts())

    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'findable' },
      sessionRef: 'agent:test:project:ms-test/lane:findable',
      label: 'Findable session',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    // RED GATE: GET /v1/app-sessions/by-key route does not exist
    const res = await fetchSocket('/v1/app-sessions/by-key?appId=workbench&appSessionKey=findable')
    expect(res.status).toBe(200)
    const record = (await res.json()) as HrcManagedSessionRecord
    expect(record.appId).toBe('workbench')
    expect(record.appSessionKey).toBe('findable')
    expect(record.label).toBe('Findable session')
  })

  it('returns 404 UNKNOWN_APP_SESSION for missing key', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/app-sessions/by-key?appId=workbench&appSessionKey=ghost')
    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })

  it('returns 400 when appId is missing', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/app-sessions/by-key?appSessionKey=whatever')
    expect(res.status).toBe(400)
  })

  it('returns 400 when appSessionKey is missing', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/app-sessions/by-key?appId=workbench')
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 4. POST /v1/app-sessions/remove — marks removed + cleanup
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/remove', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('marks session as removed', async () => {
    server = await createHrcServer(serverOpts())

    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'rm-test' },
      sessionRef: 'agent:test:project:ms-test/lane:rm-test',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    // RED GATE: POST /v1/app-sessions/remove route does not exist
    const res = await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'workbench', appSessionKey: 'rm-test' },
    })

    expect(res.status).toBe(200)

    // Verify via by-key — should show removed status
    const checkRes = await fetchSocket(
      '/v1/app-sessions/by-key?appId=workbench&appSessionKey=rm-test'
    )
    // Could be 404 or 200 with status=removed depending on implementation
    // The key assertion: the session is no longer active
    if (checkRes.status === 200) {
      const record = (await checkRes.json()) as HrcManagedSessionRecord
      expect(record.status).toBe('removed')
      expect(record.removedAt).toBeDefined()
    }
  })

  it('cleans up active bridges for the host session', async () => {
    server = await createHrcServer(serverOpts())

    // Create managed session
    const ensureRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'bridge-cleanup' },
      sessionRef: 'agent:test:project:ms-test/lane:bridge-cleanup',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    const ensured = (await ensureRes.json()) as EnsureAppSessionResponse
    const hostSessionId = ensured.session.activeHostSessionId

    // Seed a bridge for this host session directly in the DB
    const db = openHrcDatabase(dbPath)
    try {
      db.localBridges.create({
        bridgeId: 'br-cleanup-test',
        hostSessionId,
        transport: 'test',
        target: 'test-target',
        createdAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    // Remove the managed session — should close the bridge
    await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'workbench', appSessionKey: 'bridge-cleanup' },
    })

    // Verify bridge was closed
    const db2 = openHrcDatabase(dbPath)
    try {
      const bridge = db2.localBridges.findById('br-cleanup-test')
      expect(bridge).not.toBeNull()
      expect(bridge!.closedAt).toBeDefined()
    } finally {
      db2.close()
    }
  })

  it('unbinds active surfaces for the host session', async () => {
    server = await createHrcServer(serverOpts())

    // Create managed session
    const ensureRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'surface-cleanup' },
      sessionRef: 'agent:test:project:ms-test/lane:surface-cleanup',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    const ensured = (await ensureRes.json()) as EnsureAppSessionResponse
    const hostSessionId = ensured.session.activeHostSessionId

    // Seed a runtime record so the surface binding FK is satisfied,
    // then bind a surface to it.
    const seedRuntimeId = `rt-surface-test-${Date.now()}`
    const db = openHrcDatabase(dbPath)
    try {
      db.runtimes.insert({
        runtimeId: seedRuntimeId,
        hostSessionId,
        scopeRef: 'agent:test:project:ms-test',
        laneRef: 'default',
        generation: ensured.session.generation,
        transport: 'sdk',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      db.surfaceBindings.bind({
        surfaceKind: 'vscode-tab',
        surfaceId: 'tab-cleanup-test',
        hostSessionId,
        runtimeId: seedRuntimeId,
        generation: ensured.session.generation,
        boundAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    // Remove the managed session — should unbind the surface
    await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'workbench', appSessionKey: 'surface-cleanup' },
    })

    // Verify surface was unbound
    const db2 = openHrcDatabase(dbPath)
    try {
      const binding = db2.surfaceBindings.findBySurface('vscode-tab', 'tab-cleanup-test')
      expect(binding).not.toBeNull()
      expect(binding!.unboundAt).toBeDefined()
    } finally {
      db2.close()
    }
  })

  it('returns 404 UNKNOWN_APP_SESSION for non-existent session', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'workbench', appSessionKey: 'ghost' },
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 5. POST /v1/app-sessions/apply — bulk create/update + pruneMissing
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/apply', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('bulk creates multiple managed sessions', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: POST /v1/app-sessions/apply route does not exist
    const res = await postJson('/v1/app-sessions/apply', {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'ws-1',
          sessionRef: 'agent:test:project:ms-test/lane:ws-1',
          label: 'Workspace 1',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
        {
          appSessionKey: 'ws-2',
          sessionRef: 'agent:test:project:ms-test/lane:ws-2',
          label: 'Workspace 2',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
      ],
    })

    expect(res.status).toBe(200)

    // Verify both sessions exist
    const listRes = await fetchSocket('/v1/app-sessions?appId=workbench')
    const records = (await listRes.json()) as HrcManagedSessionRecord[]
    expect(records.length).toBe(2)
    expect(records.map((r) => r.appSessionKey).sort()).toEqual(['ws-1', 'ws-2'])
  })

  it('with pruneMissing=true removes sessions not in payload', async () => {
    server = await createHrcServer(serverOpts())

    // Create three sessions
    await postJson('/v1/app-sessions/apply', {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'keep-1',
          sessionRef: 'agent:test:project:ms-test/lane:keep-1',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
        {
          appSessionKey: 'keep-2',
          sessionRef: 'agent:test:project:ms-test/lane:keep-2',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
        {
          appSessionKey: 'drop-1',
          sessionRef: 'agent:test:project:ms-test/lane:drop-1',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
      ],
    })

    // Re-apply with only two sessions and pruneMissing
    const res = await postJson('/v1/app-sessions/apply', {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'keep-1',
          sessionRef: 'agent:test:project:ms-test/lane:keep-1',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
        {
          appSessionKey: 'keep-2',
          sessionRef: 'agent:test:project:ms-test/lane:keep-2',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
      ],
      pruneMissing: true,
    })

    expect(res.status).toBe(200)

    // Verify only two active sessions remain
    const listRes = await fetchSocket('/v1/app-sessions?appId=workbench&status=active')
    const records = (await listRes.json()) as HrcManagedSessionRecord[]
    expect(records.length).toBe(2)
    expect(records.map((r) => r.appSessionKey).sort()).toEqual(['keep-1', 'keep-2'])
  })

  it('without pruneMissing does not remove existing sessions', async () => {
    server = await createHrcServer(serverOpts())

    // Create initial sessions
    await postJson('/v1/app-sessions/apply', {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'original',
          sessionRef: 'agent:test:project:ms-test/lane:original',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
      ],
    })

    // Apply with different set but no pruneMissing
    await postJson('/v1/app-sessions/apply', {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'new-one',
          sessionRef: 'agent:test:project:ms-test/lane:new-one',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: { provider: 'anthropic', interactive: false },
            },
          },
        },
      ],
    })

    // Both should exist
    const listRes = await fetchSocket('/v1/app-sessions?appId=workbench')
    const records = (await listRes.json()) as HrcManagedSessionRecord[]
    expect(records.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 6. Error codes for invalid operations
// ---------------------------------------------------------------------------
describe('Managed session error codes', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns MALFORMED_REQUEST for missing selector', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/ensure', {
      // no selector
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('malformed_request')
  })

  it('returns MALFORMED_REQUEST for missing spec', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'no-spec' },
      sessionRef: 'agent:test:project:ms-test/lane:no-spec',
      // no spec
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('malformed_request')
  })

  // T-01077: kind-mismatch test updated — command kind is now rejected as
  // unsupported_capability before reaching the kind-mismatch check.
  // After the split, only 'harness' is valid on app-managed sessions.
  it('returns UNSUPPORTED_CAPABILITY when ensure attempts command kind on existing harness session', async () => {
    server = await createHrcServer(serverOpts())

    // Create as harness
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'kind-mismatch' },
      sessionRef: 'agent:test:project:ms-test/lane:kind-mismatch',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    // Try to ensure as command — rejected because command is no longer valid
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'kind-mismatch' },
      sessionRef: 'agent:test:project:ms-test/lane:kind-mismatch',
      spec: {
        kind: 'command',
        command: { argv: ['/bin/sh'] },
      },
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unsupported_capability')
  })

  it('returns APP_SESSION_REMOVED when ensuring a removed session', async () => {
    server = await createHrcServer(serverOpts())

    // Create then remove
    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'removed-ensure' },
      sessionRef: 'agent:test:project:ms-test/lane:removed-ensure',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'workbench', appSessionKey: 'removed-ensure' },
      sessionRef: 'agent:test:project:ms-test/lane:removed-ensure',
    })

    // Try to ensure again — should fail
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'removed-ensure' },
      sessionRef: 'agent:test:project:ms-test/lane:removed-ensure',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('app_session_removed')
  })
})

// ---------------------------------------------------------------------------
// 7. GET /v1/status — capability flag
// ---------------------------------------------------------------------------
describe('GET /v1/status — appOwnedSessions capability', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('reports platform.appOwnedSessions = true', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: appOwnedSessions is currently false, must be flipped to true
    const res = await fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatusResponse
    expect(body.capabilities.platform.appOwnedSessions).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dry-run mode for POST /v1/app-sessions/ensure
// ---------------------------------------------------------------------------
import type { EnsureAppSessionDryRunPlan } from 'hrc-core'

describe('POST /v1/app-sessions/ensure — dryRun mode', () => {
  let server: HrcServer
  let targetDir: string

  beforeEach(async () => {
    targetDir = join(tmpDir, 'target-dryrun')
    await mkdir(targetDir, { recursive: true })
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns action=create and sessionExists=false when no session exists', async () => {
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'test', appSessionKey: 'dry-run-new' },
      sessionRef: 'agent:test:project:ms-test/lane:dry-run-new',
      spec: { kind: 'harness', runtimeIntent: interactiveHarnessIntent(targetDir) },
      dryRun: true,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { dryRun: EnsureAppSessionDryRunPlan }
    expect(body.dryRun).toBeDefined()
    expect(body.dryRun.action).toBe('create')
    expect(body.dryRun.sessionExists).toBe(false)
  })

  it('does not create a session when dryRun is true', async () => {
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'test', appSessionKey: 'dry-run-noop' },
      sessionRef: 'agent:test:project:ms-test/lane:dry-run-noop',
      spec: { kind: 'harness', runtimeIntent: interactiveHarnessIntent(targetDir) },
      dryRun: true,
    })
    expect(res.status).toBe(200)

    // Verify session was NOT created
    const lookupRes = await fetchSocket(
      '/v1/app-sessions/by-key?appId=test&appSessionKey=dry-run-noop'
    )
    expect(lookupRes.status).toBe(404)
  })

  it('returns action=create with prior runtime info when session exists but runtime is dead', async () => {
    // Create a real session first
    const createRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'test', appSessionKey: 'dry-run-dead' },
      sessionRef: 'agent:test:project:ms-test/lane:dry-run-dead',
      spec: { kind: 'harness', runtimeIntent: interactiveHarnessIntent(targetDir) },
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as EnsureAppSessionResponse
    expect(created.runtimeId).toBeDefined()

    // Mark the launch started with a dead PID so the liveness check sees a dead process
    await markLatestLaunchStarted(created.session.activeHostSessionId, DEAD_PID)

    // Now dry-run — should see the session exists but runtime is dead
    const dryRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'test', appSessionKey: 'dry-run-dead' },
      sessionRef: 'agent:test:project:ms-test/lane:dry-run-dead',
      spec: { kind: 'harness', runtimeIntent: interactiveHarnessIntent(targetDir) },
      dryRun: true,
    })
    expect(dryRes.status).toBe(200)
    const plan = (await dryRes.json()) as { dryRun: EnsureAppSessionDryRunPlan }
    expect(plan.dryRun.action).toBe('create')
    expect(plan.dryRun.sessionExists).toBe(true)
    expect(plan.dryRun.runtimeId).toBeDefined()
  })

  it('returns action=reattach when session exists and runtime is live', async () => {
    // Create a real session
    const createRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'test', appSessionKey: 'dry-run-live' },
      sessionRef: 'agent:test:project:ms-test/lane:dry-run-live',
      spec: { kind: 'harness', runtimeIntent: interactiveHarnessIntent(targetDir) },
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as EnsureAppSessionResponse

    // Mark the launch started with OUR OWN PID (guaranteed alive)
    await markLatestLaunchStarted(created.session.activeHostSessionId, process.pid)

    // Dry-run should detect the runtime as live
    const dryRes = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'test', appSessionKey: 'dry-run-live' },
      sessionRef: 'agent:test:project:ms-test/lane:dry-run-live',
      spec: { kind: 'harness', runtimeIntent: interactiveHarnessIntent(targetDir) },
      dryRun: true,
    })
    expect(dryRes.status).toBe(200)
    const plan = (await dryRes.json()) as { dryRun: EnsureAppSessionDryRunPlan }
    expect(plan.dryRun.action).toBe('reattach')
    expect(plan.dryRun.sessionExists).toBe(true)
    expect(plan.dryRun.runtimeId).toBe(created.runtimeId)
    expect(plan.dryRun.runtimePid).toBe(process.pid)
    expect(plan.dryRun.tmuxSession).toBeString()
  })
})

// ===========================================================================
// T-01077 SCOPEREF_CLEANUP Phase 3/5: Canonical sessionRef on ensure,
// alias reuse, conflict detection, shared-alias lifecycle
//
// RED GATE: These tests require:
//   - EnsureAppSessionRequest.sessionRef (Phase 3)
//   - Canonical continuity reuse (Phase 5b)
//   - 409 conflict on sessionRef mismatch (Phase 5c)
//   - Shared-alias lifecycle (Phase 5d)
//   - Rejection of kind: 'command' on ensure (Phase 3a/5e)
// ===========================================================================

describe('POST /v1/app-sessions/ensure — sessionRef required (T-01077)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('accepts ensure with a canonical sessionRef and returns it on the session record', async () => {
    server = await createHrcServer(serverOpts())

    // RED: sessionRef field does not exist on EnsureAppSessionRequest yet
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'canonical-test' },
      sessionRef: 'agent:rex:project:agent-spaces:task:T-00100/lane:main',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as EnsureAppSessionResponse
    expect(body.session).toBeDefined()
    expect(body.session.appSessionKey).toBe('canonical-test')

    // The underlying host session must carry the canonical scopeRef/laneRef
    const sessionsRes = await fetchSocket(
      `/v1/sessions?hostSessionId=${encodeURIComponent(body.session.activeHostSessionId)}`
    )
    expect(sessionsRes.status).toBe(200)
  })

  it('rejects ensure without sessionRef with 400', async () => {
    server = await createHrcServer(serverOpts())

    // RED: currently ensure succeeds without sessionRef
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'no-ref' },
      // sessionRef intentionally omitted
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('malformed_request')
  })

  it('rejects ensure with non-canonical sessionRef with 400', async () => {
    server = await createHrcServer(serverOpts())

    // RED: splitSessionRef does not validate canonical forms yet
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'bad-scope' },
      sessionRef: 'app:hrc-cli/lane:main',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    // Non-canonical sessionRef should fail with invalid_selector (via validateScopeRef)
    // RED: currently server rejects at the malformed_request level before
    // reaching canonical validation. Once Phase 5 wires splitSessionRef
    // into the ensure handler, this should be invalid_selector.
    expect(body.error.code).toBe('invalid_selector')
  })
})

describe('POST /v1/app-sessions/ensure — canonical alias reuse (T-01077 Phase 5b)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('reuses existing host session when another alias already owns the same sessionRef', async () => {
    server = await createHrcServer(serverOpts())

    const sessionRef = 'agent:rex:project:agent-spaces:task:T-00200/lane:main'

    // First app creates a managed session for this sessionRef
    const res1 = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'app-alpha', appSessionKey: 'rex-task-200' },
      sessionRef,
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as EnsureAppSessionResponse

    // Second app creates a managed session for the SAME sessionRef
    // RED: currently creates a brand new host session instead of reusing
    const res2 = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'app-beta', appSessionKey: 'rex-task-200' },
      sessionRef,
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as EnsureAppSessionResponse

    // Both aliases must point at the same host session — canonical continuity
    expect(body2.session.activeHostSessionId).toBe(body1.session.activeHostSessionId)
  })
})

describe('POST /v1/app-sessions/ensure — sessionRef conflict 409 (T-01077 Phase 5c)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns 409 when re-ensuring an alias with a different sessionRef', async () => {
    server = await createHrcServer(serverOpts())

    // Create alias with sessionRef A
    const res1 = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'mutable-alias' },
      sessionRef: 'agent:rex:project:agent-spaces:task:T-00300/lane:main',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })
    expect(res1.status).toBe(200)

    // Re-ensure the same alias with sessionRef B
    // RED: currently the server ignores sessionRef entirely
    const res2 = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'mutable-alias' },
      sessionRef: 'agent:larry:project:agent-spaces:task:T-00400/lane:main',
      spec: {
        kind: 'harness',
        runtimeIntent: {
          placement: 'workspace',
          harness: { provider: 'anthropic', interactive: false },
        },
      },
    })

    expect(res2.status).toBe(409)
  })
})

describe('POST /v1/app-sessions/ensure — command kind rejected (T-01077 Phase 3a)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('rejects kind: command on app-session ensure after the split', async () => {
    server = await createHrcServer(serverOpts())

    // RED: currently command kind is accepted
    const res = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'workbench', appSessionKey: 'log-tail' },
      sessionRef: 'agent:rex:project:agent-spaces/lane:main',
      spec: {
        kind: 'command',
        command: {
          launchMode: 'exec',
          argv: ['tail', '-f', '/var/log/app.log'],
        },
      },
    })

    // After the split, command sessions go through /v1/windows/ensure
    expect(res.status).toBe(422)
  })
})

describe('Shared-alias lifecycle (T-01077 Phase 5d)', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('remove with remaining aliases preserves the runtime', async () => {
    server = await createHrcServer(serverOpts())

    const sessionRef = 'agent:rex:project:agent-spaces:task:T-00500/lane:main'

    // Two apps alias the same canonical session
    const res1 = await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'app-alpha', appSessionKey: 'shared-session' },
      sessionRef,
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as EnsureAppSessionResponse
    const hostSessionId = body1.session.activeHostSessionId

    await postJson('/v1/app-sessions/ensure', {
      selector: { appId: 'app-beta', appSessionKey: 'shared-session' },
      sessionRef,
      spec: {
        kind: 'harness',
        runtimeIntent: interactiveHarnessIntent(tmpDir),
      },
    })

    // Remove app-alpha's alias — app-beta still active
    // RED: currently remove tears down the runtime unconditionally
    const removeRes = await postJson('/v1/app-sessions/remove', {
      selector: { appId: 'app-alpha', appSessionKey: 'shared-session' },
    })
    expect(removeRes.status).toBe(200)

    // Runtime should still be accessible for the remaining alias
    const runtimesRes = await fetchSocket(
      `/v1/runtimes?hostSessionId=${encodeURIComponent(hostSessionId)}`
    )
    expect(runtimesRes.status).toBe(200)
    const runtimes = (await runtimesRes.json()) as Array<{ runtimeId: string }>
    // Runtime must still exist because app-beta still holds an active alias
    expect(runtimes.length).toBeGreaterThanOrEqual(1)
  })
})
