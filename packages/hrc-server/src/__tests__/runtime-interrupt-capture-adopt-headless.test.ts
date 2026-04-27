import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcHttpError, HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-runtime-actions-headless-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

type SeedRuntimeOptions = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  transport: 'headless' | 'sdk'
  status?: string | undefined
  activeRunId?: string | undefined
}

async function setupTmuxRuntime(label: string, runtimeId: string, status = 'ready') {
  const tmux = new TmuxManager(fixture.tmuxSocketPath)
  await tmux.initialize()
  const { hostSessionId } = await fixture.resolveSession(label)
  const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')

  fixture.seedTmuxRuntime(hostSessionId, label, runtimeId, { status })
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.runtimes.update(runtimeId, {
      tmuxJson: pane,
      updatedAt: fixture.now(),
    })
  } finally {
    db.close()
  }

  return { tmux, hostSessionId, pane }
}

function seedHeadlessRuntime(options: SeedRuntimeOptions): void {
  fixture.seedSession(options.hostSessionId, options.scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const scopeRef = options.scopeRef.startsWith('agent:')
    ? options.scopeRef
    : `agent:${options.scopeRef}`

  try {
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: options.transport,
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: options.status ?? (options.activeRunId ? 'busy' : 'ready'),
      supportsInflightInput: false,
      adopted: false,
      ...(options.activeRunId ? { activeRunId: options.activeRunId } : {}),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    if (options.activeRunId) {
      db.runs.insert({
        runId: options.activeRunId,
        hostSessionId: options.hostSessionId,
        runtimeId: options.runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: options.transport,
        status: 'running',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
      })
    }
  } finally {
    db.close()
  }
}

function listInterruptedEvents(runtimeId: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'runtime.interrupted' && event.runtimeId === runtimeId)
  } finally {
    db.close()
  }
}

async function interrupt(runtimeId: string): Promise<Response> {
  return await fixture.postJson('/v1/interrupt', { runtimeId })
}

async function capture(runtimeId: string): Promise<Response> {
  return await fixture.fetchSocket(`/v1/capture?runtimeId=${encodeURIComponent(runtimeId)}`)
}

async function adopt(runtimeId: string): Promise<Response> {
  return await fixture.postJson('/v1/runtimes/adopt', { runtimeId })
}

describe('runtime interrupt transport branching', () => {
  it('keeps the tmux interrupt path working', async () => {
    await setupTmuxRuntime('interrupt-tmux', 'rt-interrupt-tmux')

    const res = await interrupt('rt-interrupt-tmux')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      runtimeId: 'rt-interrupt-tmux',
    })

    const events = listInterruptedEvents('rt-interrupt-tmux')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('tmux')
    expect(events[0]?.payload).toMatchObject({ transport: 'tmux' })
  })

  it('cancels an active headless run and clears active_run_id', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-interrupt-headless-active',
      hostSessionId: 'hsid-interrupt-headless-active',
      scopeRef: 'interrupt-headless-active',
      transport: 'headless',
      activeRunId: 'run-interrupt-headless-active',
    })

    const res = await interrupt('rt-interrupt-headless-active')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      hostSessionId: 'hsid-interrupt-headless-active',
      runtimeId: 'rt-interrupt-headless-active',
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.getByRunId('run-interrupt-headless-active')?.status).toBe('cancelled')
      expect(
        db.runtimes.getByRuntimeId('rt-interrupt-headless-active')?.activeRunId
      ).toBeUndefined()
    } finally {
      db.close()
    }

    const events = listInterruptedEvents('rt-interrupt-headless-active')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('headless')
    expect(events[0]?.payload).toMatchObject({
      transport: 'headless',
      runId: 'run-interrupt-headless-active',
    })
  })

  it('no-ops headless interrupt without an active run', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-interrupt-headless-ready',
      hostSessionId: 'hsid-interrupt-headless-ready',
      scopeRef: 'interrupt-headless-ready',
      transport: 'headless',
    })

    const res = await interrupt('rt-interrupt-headless-ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      runtimeId: 'rt-interrupt-headless-ready',
      warning: 'no active run to interrupt',
    })
    expect(listInterruptedEvents('rt-interrupt-headless-ready')).toHaveLength(0)
  })
})

describe('runtime capture transport branching', () => {
  it('keeps the tmux capture path working', async () => {
    const { tmux, pane } = await setupTmuxRuntime('capture-tmux', 'rt-capture-tmux')
    await tmux.sendLiteral(pane.paneId, 'CAPTURE_TMUX_MARKER')

    let body: { text?: string } = {}
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await capture('rt-capture-tmux')
      expect(res.status).toBe(200)
      body = (await res.json()) as { text?: string }
      if (body.text?.includes('CAPTURE_TMUX_MARKER')) break
      await Bun.sleep(50)
    }

    expect(body).toMatchObject({
      text: expect.stringContaining('CAPTURE_TMUX_MARKER'),
    })
  })

  it('refuses headless capture with event-stream guidance', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-capture-headless',
      hostSessionId: 'hsid-capture-headless',
      scopeRef: 'capture-headless',
      transport: 'headless',
    })

    const res = await capture('rt-capture-headless')
    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toContain('use the runtime event stream')
    expect(body.error.detail).toMatchObject({
      runtimeId: 'rt-capture-headless',
      transport: 'headless',
    })
  })
})

describe('runtime adopt transport branching', () => {
  it('keeps the tmux adopt path working', async () => {
    fixture.seedSession('hsid-adopt-tmux', 'adopt-tmux')
    fixture.seedTmuxRuntime('hsid-adopt-tmux', 'adopt-tmux', 'rt-adopt-tmux', { status: 'dead' })

    const res = await adopt('rt-adopt-tmux')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      runtimeId: 'rt-adopt-tmux',
      status: 'adopted',
      adopted: true,
    })
  })

  it('refuses headless adopt', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-adopt-headless',
      hostSessionId: 'hsid-adopt-headless',
      scopeRef: 'adopt-headless',
      transport: 'headless',
      status: 'dead',
    })

    const res = await adopt('rt-adopt-headless')
    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toBe(
      'cannot adopt a non-tmux runtime: no attachable pane/process exists'
    )
    expect(body.error.detail).toMatchObject({
      runtimeId: 'rt-adopt-headless',
      transport: 'headless',
    })
  })

  it('refuses sdk adopt', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-adopt-sdk',
      hostSessionId: 'hsid-adopt-sdk',
      scopeRef: 'adopt-sdk',
      transport: 'sdk',
      status: 'dead',
    })

    const res = await adopt('rt-adopt-sdk')
    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toBe(
      'cannot adopt a non-tmux runtime: no attachable pane/process exists'
    )
    expect(body.error.detail).toMatchObject({
      runtimeId: 'rt-adopt-sdk',
      transport: 'sdk',
    })
  })
})
