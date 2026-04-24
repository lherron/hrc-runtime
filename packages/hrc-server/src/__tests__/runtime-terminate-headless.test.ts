import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type { HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-terminate-headless-')
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
  activeRunId?: string | undefined
  continuationKey?: string | undefined
}

function seedRuntime(options: SeedRuntimeOptions): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const scopeRef = options.scopeRef.startsWith('agent:')
    ? options.scopeRef
    : `agent:${options.scopeRef}`

  try {
    if (options.continuationKey) {
      db.sessions.updateContinuation(
        options.hostSessionId,
        { provider: 'anthropic', key: options.continuationKey },
        now
      )
    }

    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: options.transport,
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: options.activeRunId ? 'busy' : 'ready',
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

function readContinuationJson(hostSessionId: string): string | null {
  const db = new Database(fixture.dbPath)
  try {
    return (
      db
        .query<{ continuation_json: string | null }, [string]>(
          'SELECT continuation_json FROM sessions WHERE host_session_id = ?'
        )
        .get(hostSessionId)?.continuation_json ?? null
    )
  } finally {
    db.close()
  }
}

function listTerminatedEvents(runtimeId: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'runtime.terminated' && event.runtimeId === runtimeId)
  } finally {
    db.close()
  }
}

async function terminate(runtimeId: string, dropContinuation?: boolean): Promise<any> {
  const res = await fixture.postJson('/v1/terminate', {
    runtimeId,
    ...(dropContinuation !== undefined ? { dropContinuation } : {}),
  })
  expect(res.status).toBe(200)
  return await res.json()
}

describe('POST /v1/terminate transport branching', () => {
  it('keeps the tmux terminate path working without dropping continuation', async () => {
    fixture.seedSession('hsid-tmux', 'terminate-tmux')
    fixture.seedTmuxRuntime('hsid-tmux', 'terminate-tmux', 'rt-tmux', { status: 'ready' })

    const body = await terminate('rt-tmux')

    expect(body).toMatchObject({
      ok: true,
      hostSessionId: 'hsid-tmux',
      runtimeId: 'rt-tmux',
      droppedContinuation: false,
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId('rt-tmux')?.status).toBe('terminated')
    } finally {
      db.close()
    }

    const events = listTerminatedEvents('rt-tmux')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('tmux')
    expect(events[0]?.payload).toMatchObject({
      transport: 'tmux',
      sessionName: 'hrc-missing-session',
      droppedContinuation: false,
    })
  })

  it('terminates headless runtimes without active runs without dropping by default', async () => {
    fixture.seedSession('hsid-headless-ready', 'terminate-headless-ready')
    seedRuntime({
      runtimeId: 'rt-headless-ready',
      hostSessionId: 'hsid-headless-ready',
      scopeRef: 'terminate-headless-ready',
      transport: 'headless',
      continuationKey: 'cont-ready',
    })

    const body = await terminate('rt-headless-ready')

    expect(body.droppedContinuation).toBe(false)
    expect(readContinuationJson('hsid-headless-ready')).not.toBeNull()

    const events = listTerminatedEvents('rt-headless-ready')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('headless')
    expect(events[0]?.payload).toMatchObject({
      transport: 'headless',
      droppedContinuation: false,
    })
  })

  it('drops continuation by default for busy headless runtimes', async () => {
    fixture.seedSession('hsid-headless-busy', 'terminate-headless-busy')
    seedRuntime({
      runtimeId: 'rt-headless-busy',
      hostSessionId: 'hsid-headless-busy',
      scopeRef: 'terminate-headless-busy',
      transport: 'headless',
      activeRunId: 'run-headless-busy',
      continuationKey: 'cont-busy',
    })

    const body = await terminate('rt-headless-busy')

    expect(body.droppedContinuation).toBe(true)
    expect(readContinuationJson('hsid-headless-busy')).toBeNull()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId('rt-headless-busy')?.status).toBe('terminated')
      expect(db.runtimes.getByRuntimeId('rt-headless-busy')?.activeRunId).toBeUndefined()
      expect(db.runs.getByRunId('run-headless-busy')?.status).toBe('failed')
    } finally {
      db.close()
    }
  })

  it('honors explicit no-drop-continuation for busy headless runtimes', async () => {
    fixture.seedSession('hsid-headless-no-drop', 'terminate-headless-no-drop')
    seedRuntime({
      runtimeId: 'rt-headless-no-drop',
      hostSessionId: 'hsid-headless-no-drop',
      scopeRef: 'terminate-headless-no-drop',
      transport: 'headless',
      activeRunId: 'run-headless-no-drop',
      continuationKey: 'cont-no-drop',
    })

    const body = await terminate('rt-headless-no-drop', false)

    expect(body.droppedContinuation).toBe(false)
    expect(readContinuationJson('hsid-headless-no-drop')).not.toBeNull()
  })

  it('treats sdk runtimes like headless runtimes', async () => {
    fixture.seedSession('hsid-sdk-busy', 'terminate-sdk-busy')
    seedRuntime({
      runtimeId: 'rt-sdk-busy',
      hostSessionId: 'hsid-sdk-busy',
      scopeRef: 'terminate-sdk-busy',
      transport: 'sdk',
      activeRunId: 'run-sdk-busy',
      continuationKey: 'cont-sdk',
    })

    const body = await terminate('rt-sdk-busy')

    expect(body.droppedContinuation).toBe(true)
    expect(readContinuationJson('hsid-sdk-busy')).toBeNull()

    const events = listTerminatedEvents('rt-sdk-busy')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('sdk')
    expect(events[0]?.payload).toMatchObject({
      transport: 'sdk',
      droppedContinuation: true,
    })
  })

  it('emits one runtime.terminated event per headless terminate call', async () => {
    fixture.seedSession('hsid-headless-event', 'terminate-headless-event')
    seedRuntime({
      runtimeId: 'rt-headless-event',
      hostSessionId: 'hsid-headless-event',
      scopeRef: 'terminate-headless-event',
      transport: 'headless',
      activeRunId: 'run-headless-event',
      continuationKey: 'cont-event',
    })

    await terminate('rt-headless-event')

    const events = listTerminatedEvents('rt-headless-event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      hostSessionId: 'hsid-headless-event',
      runtimeId: 'rt-headless-event',
      transport: 'headless',
    })
    expect(events[0]?.payload).toMatchObject({
      transport: 'headless',
      droppedContinuation: true,
    })
  })
})
