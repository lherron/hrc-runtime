import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcHttpError } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

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

function seedSession(hostSessionId: string, scopeRef: string) {
  const db = openHrcDatabase(dbPath)
  const now = ts()
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.close()
}

function seedTmuxRuntime(
  hostSessionId: string,
  scopeRef: string,
  runtimeId: string,
  patch: {
    status: string
    launchId?: string | undefined
    activeRunId?: string | undefined
    adopted?: boolean | undefined
  }
) {
  const db = openHrcDatabase(dbPath)
  const now = ts()
  db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: patch.status,
    tmuxJson: {
      socketPath: tmuxSocketPath,
      sessionName: 'hrc-missing-session',
      windowName: 'main',
      sessionId: '$dead',
      windowId: '@dead',
      paneId: '%dead',
    },
    supportsInflightInput: false,
    adopted: patch.adopted ?? false,
    ...(patch.launchId ? { launchId: patch.launchId } : {}),
    ...(patch.activeRunId ? { activeRunId: patch.activeRunId } : {}),
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  })
  db.close()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-server-reconcile-test-'))
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

describe('startup reconciliation', () => {
  let server: HrcServer | undefined

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
  })

  it('marks launches with dead wrapper pids as orphaned and their runtime stale on startup', async () => {
    const hostSessionId = 'hsid-orphan-startup'
    const scopeRef = 'project:phase6-orphan'
    const runtimeId = 'rt-orphan-startup'
    const launchId = 'launch-orphan-startup'
    const runId = 'run-orphan-startup'
    const deadPid = 2147483001

    seedSession(hostSessionId, scopeRef)
    seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, {
      status: 'busy',
      launchId,
      activeRunId: runId,
    })

    const db = openHrcDatabase(dbPath)
    const now = ts()
    db.runs.insert({
      runId,
      hostSessionId,
      runtimeId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId,
      hostSessionId,
      generation: 1,
      runtimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(runtimeRoot, 'launches', `${launchId}.json`),
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: 'hrc-missing-session',
        windowName: 'main',
        sessionId: '$dead',
        windowId: '@dead',
        paneId: '%dead',
      },
      wrapperPid: deadPid,
      wrapperStartedAt: now,
      status: 'wrapper_started',
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    server = await createHrcServer(serverOpts())

    const reloaded = openHrcDatabase(dbPath)
    const launch = reloaded.launches.getByLaunchId(launchId)
    const runtime = reloaded.runtimes.getByRuntimeId(runtimeId)
    const events = reloaded.events.listFromSeq(1, { hostSessionId })
    reloaded.close()

    expect(launch?.status).toBe('orphaned')
    expect(runtime?.status).toBe('stale')
    expect(events.some((event) => event.eventKind === 'launch.orphaned')).toBe(true)
    expect(events.some((event) => event.eventKind === 'runtime.stale')).toBe(true)
  })

  it('marks tmux runtimes dead when their backing session no longer exists on startup', async () => {
    const hostSessionId = 'hsid-dead-runtime'
    const scopeRef = 'project:phase6-dead'
    const runtimeId = 'rt-dead-runtime'

    seedSession(hostSessionId, scopeRef)
    seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, {
      status: 'ready',
    })

    server = await createHrcServer(serverOpts())

    const reloaded = openHrcDatabase(dbPath)
    const runtime = reloaded.runtimes.getByRuntimeId(runtimeId)
    const events = reloaded.events.listFromSeq(1, { hostSessionId })
    reloaded.close()

    expect(runtime?.status).toBe('dead')
    expect(events.some((event) => event.eventKind === 'runtime.dead')).toBe(true)
  })

  it('continues startup when a spooled callback cannot be replayed', async () => {
    const launchSpoolDir = join(spoolDir, 'launch-bad-entry')
    await mkdir(launchSpoolDir, { recursive: true })
    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: '/v1/internal/launches/launch-bad-entry/wrapper-started',
        payload: { hostSessionId: 'missing-host-session' },
      }),
      'utf-8'
    )

    server = await createHrcServer(serverOpts())

    const res = await fetchSocket('/v1/sessions')
    expect(res.status).toBe(200)
  })
})

describe('stale callback rejection', () => {
  let server: HrcServer | undefined

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
  })

  it('rejects a stale launch callback without mutating the active runtime', async () => {
    server = await createHrcServer(serverOpts())

    const hostSessionId = 'hsid-stale-callback'
    const scopeRef = 'project:phase6-callback'
    const runtimeId = 'rt-stale-callback'
    const oldLaunchId = 'launch-old'
    const newLaunchId = 'launch-new'

    seedSession(hostSessionId, scopeRef)

    const db = openHrcDatabase(dbPath)
    const now = ts()
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      launchId: newLaunchId,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: 'hrc-active-session',
        windowName: 'main',
        sessionId: '$live',
        windowId: '@live',
        paneId: '%live',
      },
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId: oldLaunchId,
      hostSessionId,
      generation: 1,
      runtimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(runtimeRoot, 'launches', `${oldLaunchId}.json`),
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId: newLaunchId,
      hostSessionId,
      generation: 1,
      runtimeId,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(runtimeRoot, 'launches', `${newLaunchId}.json`),
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    const res = await postJson(`/v1/internal/launches/${oldLaunchId}/wrapper-started`, {
      hostSessionId,
      wrapperPid: 12345,
      timestamp: ts(),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe(HrcErrorCode.STALE_CONTEXT)

    const reloaded = openHrcDatabase(dbPath)
    const runtime = reloaded.runtimes.getByRuntimeId(runtimeId)
    const oldLaunch = reloaded.launches.getByLaunchId(oldLaunchId)
    const events = reloaded.events.listFromSeq(1, { hostSessionId })
    reloaded.close()

    expect(runtime?.launchId).toBe(newLaunchId)
    expect(runtime?.status).toBe('ready')
    expect(runtime?.wrapperPid).toBeUndefined()
    expect(oldLaunch?.status).toBe('accepted')
    expect(events.some((event) => event.eventKind === 'launch.callback_rejected')).toBe(true)
  })
})
