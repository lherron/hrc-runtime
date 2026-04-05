/**
 * RED/GREEN tests for hrc-server Slice 1B — tmux manager + runtime endpoints (T-00961 / T-00959)
 *
 * Tests the Slice 1B interactive runtime path:
 *   - TmuxManager: version check, session create/reuse, capture, attach, interrupt, terminate
 *   - POST /v1/runtimes/ensure: creates runtime record with tmux session
 *   - GET /v1/capture: returns pane text via tmux capture-pane
 *   - GET /v1/attach: returns tmux attach argv descriptor
 *   - reuse_pty vs fresh_pty restart styles
 *
 * Pass conditions for Larry (T-00959):
 *   1. TmuxManager.checkVersion() succeeds when tmux >= 3.2
 *   2. TmuxManager.checkVersion() throws when tmux < 3.2 or missing
 *   3. TmuxManager.createSession(hostSessionId) returns { sessionId, windowId, paneId }
 *   4. TmuxManager.capture(paneId) returns string content from the pane
 *   5. TmuxManager.getAttachDescriptor(sessionName) returns { argv: ['tmux', '-S', socketPath, 'attach-session', '-t', sessionName] }
 *   6. TmuxManager.interrupt(paneId) sends C-c to the pane (no throw on success)
 *   7. TmuxManager.terminate(sessionName) kills the tmux session (no throw on success)
 *   8. POST /v1/runtimes/ensure with interactive harness intent creates a runtime record with status 'ready'
 *   9. POST /v1/runtimes/ensure returns { runtimeId, hostSessionId, transport: 'tmux', status: 'ready', tmux: { sessionId, windowId, paneId } }
 *  10. GET /v1/capture?runtimeId=<id> returns { text: string } from tmux capture-pane
 *  11. GET /v1/attach?runtimeId=<id> returns { argv: string[], transport: 'tmux' }
 *  12. POST /v1/runtimes/ensure with restartStyle='reuse_pty' reuses existing tmux session
 *  13. POST /v1/runtimes/ensure with restartStyle='fresh_pty' creates a new tmux session
 *  14. POST /v1/interrupt with runtimeId sends C-c to the runtime's pane
 *  15. POST /v1/terminate with runtimeId kills the runtime's tmux session and marks it terminated
 *  16. POST /v1/runtimes/ensure returns 404 for unknown hostSessionId
 *  17. GET /v1/capture returns 404 for unknown runtimeId
 *  18. GET /v1/attach returns 404 for unknown runtimeId
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcHttpError } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'

// RED GATE: These imports will fail until Larry implements TmuxManager and runtime endpoints
import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions, TmuxManager } from '../index'

// RED GATE: TmuxManager is not yet exported from hrc-server
import { createTmuxManager } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-tmux-test-'))
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
// 1. TmuxManager — version check
// ---------------------------------------------------------------------------
describe('TmuxManager version check', () => {
  it('succeeds when system tmux >= 3.2', async () => {
    // Real tmux is available on this system (3.6a); checkVersion should not throw
    const mgr = createTmuxManager({ socketPath: tmuxSocketPath })
    await expect(mgr.checkVersion()).resolves.toBeUndefined()
  })

  it('throws when tmux binary is missing', async () => {
    // Point to a nonexistent binary to simulate missing tmux
    const mgr = createTmuxManager({
      socketPath: tmuxSocketPath,
      tmuxBin: '/nonexistent/tmux',
    })
    await expect(mgr.checkVersion()).rejects.toThrow(/tmux.*not found|missing|unavailable/i)
  })

  it('throws when tmux version is below 3.2', async () => {
    // Create a shim that reports a low version
    const shimPath = join(tmpDir, 'tmux-old')
    await writeFile(shimPath, '#!/bin/sh\necho "tmux 2.9a"', { mode: 0o755 })

    const mgr = createTmuxManager({
      socketPath: tmuxSocketPath,
      tmuxBin: shimPath,
    })
    await expect(mgr.checkVersion()).rejects.toThrow(/version.*3\.2|unsupported.*version/i)
  })
})

// ---------------------------------------------------------------------------
// 2. TmuxManager — session creation
// ---------------------------------------------------------------------------
describe('TmuxManager session creation', () => {
  let mgr: TmuxManager

  beforeEach(() => {
    mgr = createTmuxManager({ socketPath: tmuxSocketPath })
  })

  afterEach(async () => {
    // Clean up any tmux sessions we created
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine if no server to kill
    }
  })

  it('creates a tmux session and returns sessionId, windowId, paneId', async () => {
    const hostSessionId = `hsid-test-${Date.now()}`
    const result = await mgr.createSession(hostSessionId)

    expect(result.sessionId).toBeString()
    expect(result.windowId).toBeString()
    expect(result.paneId).toBeString()
    // tmux session name should follow hrc-<short> convention
    expect(result.sessionName).toMatch(/^hrc-/)
  })

  it('creates distinct sessions for different hostSessionIds', async () => {
    const r1 = await mgr.createSession(`hsid-a-${Date.now()}`)
    const r2 = await mgr.createSession(`hsid-b-${Date.now()}`)

    expect(r1.sessionId).not.toBe(r2.sessionId)
    expect(r1.paneId).not.toBe(r2.paneId)
  })
})

// ---------------------------------------------------------------------------
// 3. TmuxManager — capture
// ---------------------------------------------------------------------------
describe('TmuxManager capture', () => {
  let mgr: TmuxManager

  beforeEach(() => {
    mgr = createTmuxManager({ socketPath: tmuxSocketPath })
  })

  afterEach(async () => {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('returns pane text content', async () => {
    const hostSessionId = `hsid-cap-${Date.now()}`
    const { paneId } = await mgr.createSession(hostSessionId)

    // Send some text to the pane so capture has something to return
    await mgr.sendKeys(paneId, 'echo "SMOKEY_CAPTURE_TEST"')

    // Give the shell a moment to process
    await new Promise((r) => setTimeout(r, 300))

    const text = await mgr.capture(paneId)
    expect(typeof text).toBe('string')
    // The captured text should contain what we sent
    expect(text).toContain('SMOKEY_CAPTURE_TEST')
  })
})

// ---------------------------------------------------------------------------
// 4. TmuxManager — attach descriptor
// ---------------------------------------------------------------------------
describe('TmuxManager attach descriptor', () => {
  let mgr: TmuxManager

  beforeEach(() => {
    mgr = createTmuxManager({ socketPath: tmuxSocketPath })
  })

  afterEach(async () => {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('returns argv with correct tmux attach shape', async () => {
    const hostSessionId = `hsid-att-${Date.now()}`
    const { sessionName } = await mgr.createSession(hostSessionId)

    const descriptor = mgr.getAttachDescriptor(sessionName)
    expect(descriptor.argv).toBeArray()
    // Must include tmux binary, socket path, and session target
    expect(descriptor.argv).toContain('-S')
    expect(descriptor.argv).toContain(tmuxSocketPath)
    expect(descriptor.argv).toContain('attach-session')
    expect(descriptor.argv).toContain('-t')
    expect(descriptor.argv).toContain(sessionName)
  })
})

// ---------------------------------------------------------------------------
// 5. TmuxManager — interrupt (C-c)
// ---------------------------------------------------------------------------
describe('TmuxManager interrupt', () => {
  let mgr: TmuxManager

  beforeEach(() => {
    mgr = createTmuxManager({ socketPath: tmuxSocketPath })
  })

  afterEach(async () => {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('sends C-c to the target pane without error', async () => {
    const hostSessionId = `hsid-int-${Date.now()}`
    const { paneId } = await mgr.createSession(hostSessionId)

    // interrupt should not throw
    await expect(mgr.interrupt(paneId)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. TmuxManager — terminate
// ---------------------------------------------------------------------------
describe('TmuxManager terminate', () => {
  let mgr: TmuxManager

  beforeEach(() => {
    mgr = createTmuxManager({ socketPath: tmuxSocketPath })
  })

  afterEach(async () => {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('kills the tmux session', async () => {
    const hostSessionId = `hsid-term-${Date.now()}`
    const { sessionName } = await mgr.createSession(hostSessionId)

    await mgr.terminate(sessionName)

    // Verify session no longer exists by trying to list it
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'has-session', '-t', sessionName], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await exited
    expect(exitCode).not.toBe(0) // session should not exist
  })
})

// ---------------------------------------------------------------------------
// 7. POST /v1/runtimes/ensure — creates runtime record
// ---------------------------------------------------------------------------
describe('POST /v1/runtimes/ensure', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    // Clean up tmux
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('creates a runtime with tmux session for interactive harness', async () => {
    // First resolve a session
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:tmux-test/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    // Ensure runtime with interactive claude-code intent
    const res = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runtimeId).toBeString()
    expect(body.hostSessionId).toBe(hostSessionId)
    expect(body.transport).toBe('tmux')
    expect(body.status).toBe('ready')
    expect(body.tmux).toBeDefined()
    expect(body.tmux.sessionId).toBeString()
    expect(body.tmux.windowId).toBeString()
    expect(body.tmux.paneId).toBeString()
  })

  it('returns 404 for unknown hostSessionId', async () => {
    const res = await postJson('/v1/runtimes/ensure', {
      hostSessionId: 'nonexistent-hsid',
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })

    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_HOST_SESSION)
  })

  it('reuses existing runtime for reuse_pty restart style', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:reuse-test/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    // First ensure
    const res1 = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
      restartStyle: 'reuse_pty',
    })
    const body1 = await res1.json()

    // Second ensure with reuse_pty — should reuse the same tmux session
    const res2 = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
      restartStyle: 'reuse_pty',
    })
    const body2 = await res2.json()

    expect(body2.runtimeId).toBe(body1.runtimeId)
    expect(body2.tmux.sessionId).toBe(body1.tmux.sessionId)
    expect(body2.tmux.paneId).toBe(body1.tmux.paneId)
  })

  it('does not reuse a ready runtime when its tmux session has disappeared', async () => {
    // T-01023: reproduce stale runtime reuse when the tmux server/session is gone
    // but the DB still points at a ready tmux runtime.
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:reuse-stale-test/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    const res1 = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
      restartStyle: 'reuse_pty',
    })
    const body1 = await res1.json()

    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited

    const res2 = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'interactive' },
      },
      restartStyle: 'reuse_pty',
    })
    const body2 = await res2.json()

    expect(body2.runtimeId).not.toBe(body1.runtimeId)

    const runtimesRes = await fetchSocket(
      `/v1/runtimes?hostSessionId=${encodeURIComponent(hostSessionId)}`
    )
    expect(runtimesRes.status).toBe(200)
    const runtimes = (await runtimesRes.json()) as Array<{ runtimeId: string; status: string }>
    expect(runtimes).toHaveLength(2)
    expect(runtimes.find((runtime) => runtime.runtimeId === body1.runtimeId)?.status).toBe(
      'terminated'
    )
    expect(runtimes.find((runtime) => runtime.runtimeId === body2.runtimeId)?.status).toBe('ready')
  })

  it('creates a new tmux session for fresh_pty restart style', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:fresh-test/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    // First ensure
    const res1 = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })
    const body1 = await res1.json()

    // Second ensure with fresh_pty — should create new tmux session
    const res2 = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
      restartStyle: 'fresh_pty',
    })
    const body2 = await res2.json()

    // New runtime with different tmux session
    expect(body2.runtimeId).not.toBe(body1.runtimeId)
    expect(body2.tmux.sessionId).not.toBe(body1.tmux.sessionId)
  })

  it('appends runtime.created event', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:evt-test/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })

    // Check events
    const eventsRes = await fetchSocket('/v1/events')
    const text = await eventsRes.text()
    const events = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))

    const runtimeEvents = events.filter(
      (e: { eventKind: string }) =>
        e.eventKind === 'runtime.created' || e.eventKind === 'runtime.ensured'
    )
    expect(runtimeEvents.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 8. GET /v1/capture — returns pane text
// ---------------------------------------------------------------------------
describe('GET /v1/capture', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('returns captured text for a valid runtime', async () => {
    // Setup: resolve session + ensure runtime
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:cap-ep/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })
    const { runtimeId } = await ensureRes.json()

    const res = await fetchSocket(`/v1/capture?runtimeId=${runtimeId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.text).toBe('string')
  })

  it('returns 404 for unknown runtimeId', async () => {
    const res = await fetchSocket('/v1/capture?runtimeId=nonexistent')
    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_RUNTIME)
  })
})

// ---------------------------------------------------------------------------
// 9. GET /v1/attach — returns attach descriptor
// ---------------------------------------------------------------------------
describe('GET /v1/attach', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('returns attach descriptor with tmux argv for a valid runtime', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:att-ep/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })
    const { runtimeId } = await ensureRes.json()

    const res = await fetchSocket(`/v1/attach?runtimeId=${runtimeId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.transport).toBe('tmux')
    expect(body.argv).toBeArray()
    expect(body.argv.length).toBeGreaterThan(0)
    // argv should include tmux attach components
    expect(body.argv).toContain('attach-session')
  })

  it('returns 404 for unknown runtimeId', async () => {
    const res = await fetchSocket('/v1/attach?runtimeId=nonexistent')
    expect(res.status).toBe(404)
    const body: HrcHttpError = await res.json()
    expect(body.error.code).toBe(HrcErrorCode.UNKNOWN_RUNTIME)
  })
})

// ---------------------------------------------------------------------------
// 10. POST /v1/interrupt — sends C-c to runtime pane
// ---------------------------------------------------------------------------
describe('POST /v1/interrupt', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('sends interrupt to the runtime pane', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:int-ep/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })
    const { runtimeId } = await ensureRes.json()

    const res = await postJson('/v1/interrupt', { runtimeId })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
  })

  it('returns 404 for unknown runtimeId', async () => {
    const res = await postJson('/v1/interrupt', { runtimeId: 'nonexistent' })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 11. POST /v1/terminate — kills runtime tmux session
// ---------------------------------------------------------------------------
describe('POST /v1/terminate', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    try {
      const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine
    }
  })

  it('terminates the runtime and marks it as terminated', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:term-ep/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })
    const { runtimeId } = await ensureRes.json()

    const res = await postJson('/v1/terminate', { runtimeId })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)

    // Verify runtime status is now terminated
    // Attempting capture on terminated runtime should fail
    const capRes = await fetchSocket(`/v1/capture?runtimeId=${runtimeId}`)
    // Should either 404 (runtime gone) or return an error indicating terminated
    expect(capRes.status).toBeGreaterThanOrEqual(400)
  })

  it('appends runtime.terminated event', async () => {
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:term-evt/lane:default',
    })
    const { hostSessionId } = await resolveRes.json()

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: {
        placement: { targetName: 'dev', targetDir: tmpDir },
        harness: { provider: 'anthropic', interactive: true },
      },
    })
    const { runtimeId } = await ensureRes.json()

    await postJson('/v1/terminate', { runtimeId })

    const eventsRes = await fetchSocket('/v1/events')
    const text = await eventsRes.text()
    const events = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))

    const termEvents = events.filter(
      (e: { eventKind: string }) => e.eventKind === 'runtime.terminated'
    )
    expect(termEvents.length).toBeGreaterThanOrEqual(1)
  })
})
