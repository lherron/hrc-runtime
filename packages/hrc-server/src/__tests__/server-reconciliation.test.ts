import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcHttpError } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-server-reconcile-test-')
})

afterEach(async () => {
  await fixture.cleanup()
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

    fixture.seedSession(hostSessionId, scopeRef)
    fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, {
      status: 'busy',
      launchId,
      activeRunId: runId,
    })

    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
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
      launchArtifactPath: join(fixture.runtimeRoot, 'launches', `${launchId}.json`),
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
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

    server = await createHrcServer(fixture.serverOpts())

    const reloaded = openHrcDatabase(fixture.dbPath)
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

    fixture.seedSession(hostSessionId, scopeRef)
    fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, {
      status: 'ready',
    })

    server = await createHrcServer(fixture.serverOpts())

    const reloaded = openHrcDatabase(fixture.dbPath)
    const runtime = reloaded.runtimes.getByRuntimeId(runtimeId)
    const events = reloaded.events.listFromSeq(1, { hostSessionId })
    reloaded.close()

    expect(runtime?.status).toBe('dead')
    expect(events.some((event) => event.eventKind === 'runtime.dead')).toBe(true)
  })

  it('continues startup when a spooled callback cannot be replayed', async () => {
    const launchSpoolDir = join(fixture.spoolDir, 'launch-bad-entry')
    await mkdir(launchSpoolDir, { recursive: true })
    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: '/v1/internal/launches/launch-bad-entry/wrapper-started',
        payload: { hostSessionId: 'missing-host-session' },
      }),
      'utf-8'
    )

    server = await createHrcServer(fixture.serverOpts())

    const res = await fixture.fetchSocket('/v1/sessions')
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
    server = await createHrcServer(fixture.serverOpts())

    const hostSessionId = 'hsid-stale-callback'
    const scopeRef = 'project:phase6-callback'
    const runtimeId = 'rt-stale-callback'
    const oldLaunchId = 'launch-old'
    const newLaunchId = 'launch-new'

    fixture.seedSession(hostSessionId, scopeRef)

    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
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
        socketPath: fixture.tmuxSocketPath,
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
      launchArtifactPath: join(fixture.runtimeRoot, 'launches', `${oldLaunchId}.json`),
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
      launchArtifactPath: join(fixture.runtimeRoot, 'launches', `${newLaunchId}.json`),
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    db.close()

    const res = await fixture.postJson(`/v1/internal/launches/${oldLaunchId}/wrapper-started`, {
      hostSessionId,
      wrapperPid: 12345,
      timestamp: fixture.now(),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.code).toBe(HrcErrorCode.STALE_CONTEXT)

    const reloaded = openHrcDatabase(fixture.dbPath)
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
