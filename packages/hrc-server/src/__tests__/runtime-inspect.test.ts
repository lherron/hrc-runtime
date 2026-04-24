import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type { InspectRuntimeResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-runtime-inspect-')
  server = await createHrcServer(fixture.serverOpts({ staleGenerationThresholdSec: 60 * 60 }))
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
  transport: 'tmux' | 'headless' | 'sdk'
  harness?: 'claude-code' | 'agent-sdk' | 'codex-cli' | undefined
  provider?: 'anthropic' | 'openai' | undefined
  status?: string | undefined
  generation?: number | undefined
  activeRunId?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  continuationKey?: string | undefined
  createdAt?: string | undefined
  lastActivityAt?: string | undefined
}

function seedRuntime(options: SeedRuntimeOptions): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const scopeRef = options.scopeRef.startsWith('agent:')
    ? options.scopeRef
    : `agent:${options.scopeRef}`
  const continuation = options.continuationKey
    ? { provider: options.provider ?? 'anthropic', key: options.continuationKey }
    : undefined

  try {
    if (continuation) {
      db.sessions.updateContinuation(options.hostSessionId, continuation, now)
    }

    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: options.generation ?? 1,
      transport: options.transport,
      harness: options.harness ?? (options.transport === 'tmux' ? 'claude-code' : 'agent-sdk'),
      provider: options.provider ?? 'anthropic',
      status: options.status ?? 'ready',
      ...(options.activeRunId ? { activeRunId: options.activeRunId } : {}),
      ...(options.wrapperPid !== undefined ? { wrapperPid: options.wrapperPid } : {}),
      ...(options.childPid !== undefined ? { childPid: options.childPid } : {}),
      ...(continuation ? { continuation } : {}),
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: options.lastActivityAt ?? now,
      createdAt: options.createdAt ?? now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function setSessionCreatedAt(hostSessionId: string, createdAt: string): void {
  const db = new Database(fixture.dbPath)
  try {
    db.query('UPDATE sessions SET created_at = ?, updated_at = ? WHERE host_session_id = ?').run(
      createdAt,
      createdAt,
      hostSessionId
    )
  } finally {
    db.close()
  }
}

async function inspectRuntime(runtimeId: string): Promise<Response> {
  return await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
}

async function inspectRuntimeJson(runtimeId: string): Promise<InspectRuntimeResponse> {
  const res = await inspectRuntime(runtimeId)
  expect(res.status).toBe(200)
  return (await res.json()) as InspectRuntimeResponse
}

describe('POST /v1/runtimes/inspect', () => {
  it('returns tmux runtime process fields when present', async () => {
    fixture.seedSession('hsid-inspect-tmux', 'inspect-tmux')
    seedRuntime({
      runtimeId: 'rt-inspect-tmux',
      hostSessionId: 'hsid-inspect-tmux',
      scopeRef: 'inspect-tmux',
      transport: 'tmux',
      wrapperPid: 32101,
      childPid: 32102,
    })

    const body = await inspectRuntimeJson('rt-inspect-tmux')

    expect(body).toMatchObject({
      runtimeId: 'rt-inspect-tmux',
      hostSessionId: 'hsid-inspect-tmux',
      scopeRef: 'agent:inspect-tmux',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      wrapperPid: 32101,
      childPid: 32102,
      activeRunId: null,
      continuationKey: null,
      continuationStale: false,
    })
  })

  it('returns null process fields for a headless runtime', async () => {
    fixture.seedSession('hsid-inspect-headless', 'inspect-headless')
    seedRuntime({
      runtimeId: 'rt-inspect-headless',
      hostSessionId: 'hsid-inspect-headless',
      scopeRef: 'inspect-headless',
      transport: 'headless',
      activeRunId: 'run-inspect-headless',
    })

    const body = await inspectRuntimeJson('rt-inspect-headless')

    expect(body).toMatchObject({
      runtimeId: 'rt-inspect-headless',
      transport: 'headless',
      wrapperPid: null,
      childPid: null,
      activeRunId: 'run-inspect-headless',
    })
  })

  it('reports continuationKey and continuationStale using the stale-generation threshold', async () => {
    const staleCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const freshCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    fixture.seedSession('hsid-inspect-stale', 'inspect-stale')
    fixture.seedSession('hsid-inspect-fresh', 'inspect-fresh')
    setSessionCreatedAt('hsid-inspect-stale', staleCreatedAt)
    setSessionCreatedAt('hsid-inspect-fresh', freshCreatedAt)
    seedRuntime({
      runtimeId: 'rt-inspect-stale',
      hostSessionId: 'hsid-inspect-stale',
      scopeRef: 'inspect-stale',
      transport: 'headless',
      continuationKey: 'cont-stale',
      createdAt: staleCreatedAt,
      lastActivityAt: staleCreatedAt,
    })
    seedRuntime({
      runtimeId: 'rt-inspect-fresh',
      hostSessionId: 'hsid-inspect-fresh',
      scopeRef: 'inspect-fresh',
      transport: 'headless',
      continuationKey: 'cont-fresh',
      createdAt: freshCreatedAt,
      lastActivityAt: freshCreatedAt,
    })

    const stale = await inspectRuntimeJson('rt-inspect-stale')
    const fresh = await inspectRuntimeJson('rt-inspect-fresh')

    expect(stale.continuationKey).toBe('cont-stale')
    expect(stale.continuation).toEqual({ provider: 'anthropic', key: 'cont-stale' })
    expect(stale.continuationStale).toBe(true)
    expect(fresh.continuationKey).toBe('cont-fresh')
    expect(fresh.continuationStale).toBe(false)
  })

  it('returns a not-found error for an unknown runtimeId', async () => {
    const res = await inspectRuntime('rt-does-not-exist')
    const text = await res.text()

    expect(res.status).toBe(404)
    expect(text).toContain('rt-does-not-exist')
  })

  it('returns top-level age fields that increase monotonically', async () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString()
    const lastActivityAt = new Date(Date.now() - 10_000).toISOString()
    fixture.seedSession('hsid-inspect-age', 'inspect-age')
    seedRuntime({
      runtimeId: 'rt-inspect-age',
      hostSessionId: 'hsid-inspect-age',
      scopeRef: 'inspect-age',
      transport: 'headless',
      createdAt,
      lastActivityAt,
    })

    const first = await inspectRuntimeJson('rt-inspect-age')
    await Bun.sleep(25)
    const second = await inspectRuntimeJson('rt-inspect-age')

    expect(first.createdAt).toBe(createdAt)
    expect(first.lastActivityAt).toBe(lastActivityAt)
    expect(first.createdAgeSec).toBeGreaterThanOrEqual(0)
    expect(first.lastActivityAgeSec).toBeGreaterThanOrEqual(0)
    expect(second.createdAgeSec).toBeGreaterThanOrEqual(first.createdAgeSec)
    expect(second.lastActivityAgeSec).toBeGreaterThanOrEqual(first.lastActivityAgeSec)
  })
})
