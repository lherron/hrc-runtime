/**
 * RED/GREEN tests for command session lifecycle and literal input (T-01004 / Phase 4)
 *
 * Tests the Phase 4 command-session endpoints and behaviors:
 *   - Command ensure creates a PTY-backed runtime (not just a DB record)
 *   - lastAppliedSpec persists the command launch spec
 *   - POST /v1/app-sessions/literal-input sends text to a command session PTY
 *   - GET /v1/app-sessions/capture captures output by selector (appId + appSessionKey)
 *   - GET /v1/app-sessions/attach returns attach descriptor by selector
 *   - POST /v1/app-sessions/interrupt sends SIGINT by selector
 *   - POST /v1/app-sessions/terminate kills runtime by selector
 *   - Restart semantics: forceRestart on command session relaunches PTY
 *   - SESSION_KIND_MISMATCH guards on selector-keyed ops
 *   - GET /v1/status reports commandSessions=true and literalInput=true
 *
 * Pass conditions for Larry (T-01004):
 *   1.  Command ensure creates session AND launches a PTY runtime
 *   2.  Ensure response includes runtimeId for command sessions
 *   3.  lastAppliedSpec is persisted with command spec in the DB
 *   4.  POST /v1/app-sessions/literal-input delivers text to command PTY
 *   5.  GET /v1/app-sessions/capture returns { text } from command PTY
 *   6.  GET /v1/app-sessions/attach returns attach descriptor for command PTY
 *   7.  POST /v1/app-sessions/interrupt sends SIGINT to command PTY
 *   8.  POST /v1/app-sessions/terminate kills the command runtime
 *   9.  forceRestart on command session relaunches PTY (generation increments)
 *  10.  Selector-keyed ops on harness session return SESSION_KIND_MISMATCH (literal-input)
 *  11.  Selector-keyed ops on unknown session return UNKNOWN_APP_SESSION
 *  12.  GET /v1/status reports platform.commandSessions = true
 *  13.  GET /v1/status reports platform.literalInput = true
 *
 * Test strategy:
 *   - All tests spin up a real hrc-server on a temp socket (no mocks)
 *   - Command sessions use simple commands (echo, cat, sleep) for PTY validation
 *   - DB assertions confirm spec persistence via hrc-store-sqlite
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'

import type { CaptureResponse, EnsureAppSessionResponse, StatusResponse } from 'hrc-core'
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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-cmd-sess-'))
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

// Helper: create a command session and return the ensure response
async function ensureCommandSession(
  appId: string,
  appSessionKey: string,
  argv: string[] = ['/bin/cat'],
  extras: Record<string, unknown> = {}
): Promise<{ res: Response; body: EnsureAppSessionResponse }> {
  const res = await postJson('/v1/app-sessions/ensure', {
    selector: { appId, appSessionKey },
    spec: {
      kind: 'command',
      command: {
        launchMode: 'exec',
        argv,
      },
    },
    ...extras,
  })
  const body = (await res.json()) as EnsureAppSessionResponse
  return { res, body }
}

// Helper: create a harness session (for mismatch guard tests)
async function ensureHarnessSession(
  appId: string,
  appSessionKey: string
): Promise<EnsureAppSessionResponse> {
  const res = await postJson('/v1/app-sessions/ensure', {
    selector: { appId, appSessionKey },
    spec: {
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    },
  })
  return (await res.json()) as EnsureAppSessionResponse
}

// ---------------------------------------------------------------------------
// 1. Command ensure creates PTY-backed runtime
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/ensure — command session PTY launch', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('creates a command session AND launches a PTY runtime', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: command ensure currently creates DB record but no PTY runtime
    const { res, body } = await ensureCommandSession('workbench', 'log-tail', ['sleep', '60'])

    expect(res.status).toBe(200)
    expect(body.session.kind).toBe('command')
    expect(body.session.status).toBe('active')
    // Phase 4: ensure must return a runtimeId for command sessions
    expect(body.runtimeId).toBeDefined()
    expect(typeof body.runtimeId).toBe('string')
  })

  it('persists lastAppliedSpec with the command launch spec', async () => {
    server = await createHrcServer(serverOpts())

    const { res } = await ensureCommandSession('workbench', 'spec-persist', ['echo', 'hello'])
    expect(res.status).toBe(200)

    // RED GATE: verify the command spec is persisted in the DB via lastAppliedSpec
    const db = openHrcDatabase(dbPath)
    try {
      const record = db.appManagedSessions.findByKey('workbench', 'spec-persist')
      expect(record).not.toBeNull()
      expect(record!.lastAppliedSpec).toBeDefined()
      expect(record!.lastAppliedSpec!.kind).toBe('command')
      // Narrow to command spec and check argv
      const spec = record!.lastAppliedSpec as { kind: 'command'; command: { argv?: string[] } }
      expect(spec.command.argv).toEqual(['echo', 'hello'])
    } finally {
      db.close()
    }
  })

  it('forceRestart on command session relaunches PTY', async () => {
    server = await createHrcServer(serverOpts())

    // Create initial command session with a long-running process
    const first = await ensureCommandSession('workbench', 'restart-cmd', ['sleep', '300'])
    expect(first.res.status).toBe(200)
    // RED GATE: forceRestart should relaunch the command PTY
    const second = await ensureCommandSession('workbench', 'restart-cmd', ['sleep', '300'], {
      forceRestart: true,
    })
    expect(second.res.status).toBe(200)
    expect(second.body.status).toBe('restarted')
    // New runtimeId or same PTY reused depending on restartStyle, but restarted flag must be true
    expect(second.body.restarted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. POST /v1/app-sessions/literal-input — send text to command PTY
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/literal-input', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('delivers literal text to a command session PTY by selector', async () => {
    server = await createHrcServer(serverOpts())

    // Create a command session running cat (echoes input)
    await ensureCommandSession('workbench', 'input-test', ['/bin/cat'])

    // RED GATE: POST /v1/app-sessions/literal-input route does not exist
    const res = await postJson('/v1/app-sessions/literal-input', {
      selector: { appId: 'workbench', appSessionKey: 'input-test' },
      text: 'hello world',
      enter: true,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: true }
    expect(body.delivered).toBe(true)
  })

  it('returns UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: endpoint must exist and return 404 for unknown session
    const res = await postJson('/v1/app-sessions/literal-input', {
      selector: { appId: 'workbench', appSessionKey: 'ghost' },
      text: 'hello',
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })

  it('returns SESSION_KIND_MISMATCH when used on a harness session', async () => {
    server = await createHrcServer(serverOpts())

    await ensureHarnessSession('workbench', 'harness-no-literal')

    // RED GATE: literal-input on harness session must reject with kind mismatch
    const res = await postJson('/v1/app-sessions/literal-input', {
      selector: { appId: 'workbench', appSessionKey: 'harness-no-literal' },
      text: 'should fail',
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('session_kind_mismatch')
  })
})

// ---------------------------------------------------------------------------
// 3. GET /v1/app-sessions/capture — capture command PTY output by selector
// ---------------------------------------------------------------------------
describe('GET /v1/app-sessions/capture', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('captures PTY output by selector for a command session', async () => {
    server = await createHrcServer(serverOpts())

    await ensureCommandSession('workbench', 'capture-test', ['/bin/echo', 'captured-output'])
    // Allow time for the command to produce output
    await Bun.sleep(500)

    // RED GATE: GET /v1/app-sessions/capture route does not exist
    const res = await fetchSocket(
      '/v1/app-sessions/capture?appId=workbench&appSessionKey=capture-test'
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as CaptureResponse
    expect(body.text).toBeDefined()
    expect(typeof body.text).toBe('string')
  })

  it('returns UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/app-sessions/capture?appId=workbench&appSessionKey=ghost')

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 4. GET /v1/app-sessions/attach — attach descriptor by selector
// ---------------------------------------------------------------------------
describe('GET /v1/app-sessions/attach', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('returns attach descriptor by selector for a command session', async () => {
    server = await createHrcServer(serverOpts())

    await ensureCommandSession('workbench', 'attach-test', ['sleep', '60'])

    // RED GATE: GET /v1/app-sessions/attach route does not exist
    const res = await fetchSocket(
      '/v1/app-sessions/attach?appId=workbench&appSessionKey=attach-test'
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { transport: string; argv: string[] }
    expect(body.transport).toBe('tmux')
    expect(body.argv).toBeDefined()
    expect(Array.isArray(body.argv)).toBe(true)
  })

  it('returns UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/app-sessions/attach?appId=workbench&appSessionKey=ghost')

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 5. POST /v1/app-sessions/interrupt — send SIGINT by selector
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/interrupt', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('sends interrupt to command session PTY by selector', async () => {
    server = await createHrcServer(serverOpts())

    await ensureCommandSession('workbench', 'interrupt-test', ['sleep', '300'])

    // RED GATE: POST /v1/app-sessions/interrupt route does not exist
    const res = await postJson('/v1/app-sessions/interrupt', {
      selector: { appId: 'workbench', appSessionKey: 'interrupt-test' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: true; hostSessionId: string; runtimeId: string }
    expect(body.ok).toBe(true)
  })

  it('returns UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/interrupt', {
      selector: { appId: 'workbench', appSessionKey: 'ghost' },
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 6. POST /v1/app-sessions/terminate — kill runtime by selector
// ---------------------------------------------------------------------------
describe('POST /v1/app-sessions/terminate', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('terminates command session runtime by selector', async () => {
    server = await createHrcServer(serverOpts())

    await ensureCommandSession('workbench', 'term-test', ['sleep', '300'])

    // RED GATE: POST /v1/app-sessions/terminate route does not exist
    const res = await postJson('/v1/app-sessions/terminate', {
      selector: { appId: 'workbench', appSessionKey: 'term-test' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: true; hostSessionId: string; runtimeId: string }
    expect(body.ok).toBe(true)
  })

  it('returns UNKNOWN_APP_SESSION for non-existent selector', async () => {
    server = await createHrcServer(serverOpts())

    const res = await postJson('/v1/app-sessions/terminate', {
      selector: { appId: 'workbench', appSessionKey: 'ghost' },
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe('unknown_app_session')
  })
})

// ---------------------------------------------------------------------------
// 7. GET /v1/status — capability flags for Phase 4
// ---------------------------------------------------------------------------
describe('GET /v1/status — Phase 4 capability flags', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('reports platform.commandSessions = true', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: currently reports false, must be flipped to true
    const res = await fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatusResponse
    expect(body.capabilities.platform.commandSessions).toBe(true)
  })

  it('reports platform.literalInput = true', async () => {
    server = await createHrcServer(serverOpts())

    // RED GATE: currently reports false, must be flipped to true
    const res = await fetchSocket('/v1/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatusResponse
    expect(body.capabilities.platform.literalInput).toBe(true)
  })
})
