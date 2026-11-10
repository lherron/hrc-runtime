/**
 * RED/GREEN tests for HRC server surface binding endpoints (T-00970 / Phase 4)
 *
 * Tests the server-level surface binding surface:
 *   - POST /v1/surfaces/bind creates new binding + emits surface.bound
 *   - POST /v1/surfaces/bind same runtime is no-op (returns existing)
 *   - POST /v1/surfaces/bind different runtime => surface.rebound event
 *   - Stale fence on bind => 409 stale_context
 *   - Bindings survive daemon restart (DB persistence)
 *
 * Pass conditions for Larry (T-00970):
 *   1. POST /v1/surfaces/bind with new surface => 200 + binding record
 *   2. Events stream contains surface.bound with surfaceKind/surfaceId/runtimeId
 *   3. POST /v1/surfaces/bind with same runtimeId => 200 + same record (no-op)
 *   4. POST /v1/surfaces/bind with different runtimeId => 200 + surface.rebound event
 *   5. surface.rebound event includes previousRuntimeId/previousHostSessionId
 *   7. Events stream contains surface.unbound with runtimeId and reason
 *  11. Stale hostSessionId/generation on bind => 409 stale_context
 *  12. After server stop+restart, bindings are still queryable
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcHttpError, HrcSurfaceBindingRecord } from 'hrc-core'
import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

// RED GATE: These imports will fail until server surface endpoints are fully wired
import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'
import { createSocketScratch } from './fixtures/socket-scratch'

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

/**
 * Helper: resolve a session + ensure a runtime so we have valid IDs
 * for surface binding operations.
 */
async function ensureRuntime(scopeRef: string): Promise<{
  hostSessionId: string
  generation: number
  runtimeId: string
}> {
  const resolveRes = await postJson('/v1/sessions/resolve', {
    sessionRef: `agent:${scopeRef}/lane:default`,
    create: true,
  })
  const resolved = (await resolveRes.json()) as {
    hostSessionId: string
    generation: number
  }

  const runtimeId = `rt-test-${randomUUID()}`
  const now = ts()
  const db = openHrcDatabase(dbPath)
  db.runtimes.insert({
    runtimeId,
    hostSessionId: resolved.hostSessionId,
    scopeRef: `agent:${scopeRef}`,
    laneRef: 'default',
    generation: resolved.generation,
    transport: 'sdk',
    harness: 'agent-sdk',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    createdAt: now,
    updatedAt: now,
  })

  return {
    hostSessionId: resolved.hostSessionId,
    generation: resolved.generation,
    runtimeId,
  }
}

/**
 * Helper: fetch all events and return parsed envelopes.
 */
async function fetchEvents(): Promise<
  Array<{ hrcSeq: number; eventKind: string; payload: unknown }>
> {
  const res = await fetchSocket('/v1/events')
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

beforeEach(async () => {
  tmpDir = (await createSocketScratch('hrc-surface-')).root
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
// 1. POST /v1/surfaces/bind — new binding + surface.bound event
// ---------------------------------------------------------------------------
describe('POST /v1/surfaces/bind', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('creates a new binding and returns the record', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bind-test')

    const res = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-001',
      runtimeId,
      hostSessionId,
      generation,
    })

    expect(res.status).toBe(200)
    const binding = (await res.json()) as HrcSurfaceBindingRecord
    expect(binding.surfaceKind).toBe('operator-terminal')
    expect(binding.surfaceId).toBe('ghost-001')
    expect(binding.runtimeId).toBe(runtimeId)
    expect(binding.hostSessionId).toBe(hostSessionId)
    expect(binding.generation).toBe(generation)
    expect(binding.boundAt).toBeDefined()
    expect(binding.unboundAt).toBeUndefined()
  })

  it('emits a surface.bound event', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bound-event-test')

    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-evt',
      runtimeId,
      hostSessionId,
      generation,
    })

    const events = await fetchEvents()
    const boundEvent = events.find((e) => e.eventKind === 'surface.bound')
    expect(boundEvent).toBeDefined()
    const ej = boundEvent!.payload as Record<string, unknown>
    expect(ej['surfaceKind']).toBe('operator-terminal')
    expect(ej['surfaceId']).toBe('ghost-evt')
    expect(ej['runtimeId']).toBe(runtimeId)
  })

  it('returns existing binding as no-op when same runtime already bound', async () => {
    server = await createHrcServer(serverOpts())
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('noop-test')

    // Bind once
    const res1 = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-noop',
      runtimeId,
      hostSessionId,
      generation,
    })
    const binding1 = (await res1.json()) as HrcSurfaceBindingRecord

    // Bind again — same runtime — should be no-op
    const res2 = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-noop',
      runtimeId,
      hostSessionId,
      generation,
    })
    expect(res2.status).toBe(200)
    const binding2 = (await res2.json()) as HrcSurfaceBindingRecord

    expect(binding2.boundAt).toBe(binding1.boundAt)
    expect(binding2.runtimeId).toBe(binding1.runtimeId)

    // Only one surface.bound event should exist (no duplicate from no-op)
    const events = await fetchEvents()
    const boundEvents = events.filter(
      (e) =>
        (e.eventKind === 'surface.bound' || e.eventKind === 'surface.rebound') &&
        (e.payload as Record<string, unknown>)['surfaceId'] === 'ghost-noop'
    )
    expect(boundEvents.length).toBe(1)
  })

  it('emits surface.rebound when binding to a different runtime', async () => {
    server = await createHrcServer(serverOpts())
    const rt1 = await ensureRuntime('rebind-scope-1')
    const rt2 = await ensureRuntime('rebind-scope-2')

    // Bind to rt1
    await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-rebind',
      runtimeId: rt1.runtimeId,
      hostSessionId: rt1.hostSessionId,
      generation: rt1.generation,
    })

    // Rebind to rt2
    const res = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-rebind',
      runtimeId: rt2.runtimeId,
      hostSessionId: rt2.hostSessionId,
      generation: rt2.generation,
    })
    expect(res.status).toBe(200)
    const binding = (await res.json()) as HrcSurfaceBindingRecord
    expect(binding.runtimeId).toBe(rt2.runtimeId)

    // Should have surface.rebound event with previous* fields
    const events = await fetchEvents()
    const reboundEvent = events.find((e) => e.eventKind === 'surface.rebound')
    expect(reboundEvent).toBeDefined()
    const ej = reboundEvent!.payload as Record<string, unknown>
    expect(ej['previousRuntimeId']).toBe(rt1.runtimeId)
    expect(ej['previousHostSessionId']).toBe(rt1.hostSessionId)
    expect(ej['runtimeId']).toBe(rt2.runtimeId)
  })

  it('projects only the newest Ghostty surface for a controlling TTY', async () => {
    server = await createHrcServer(serverOpts())
    const first = await ensureRuntime('tty-binding-first')
    const second = await ensureRuntime('tty-binding-second')

    const firstResponse = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-first',
      clientTty: '/dev/ttys014',
      ...first,
    })
    expect(firstResponse.status).toBe(200)
    expect((await firstResponse.json()) as HrcSurfaceBindingRecord).toMatchObject({
      surfaceId: 'ghostty-first',
      clientTty: '/dev/ttys014',
    })

    const secondResponse = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'ghostty',
      surfaceId: 'ghostty-second',
      clientTty: '/dev/ttys014',
      ...second,
    })
    expect(secondResponse.status).toBe(200)

    const presentation = (await (await fetchSocket('/v1/presentation/runtimes')).json()) as {
      runtimes: Array<{
        runtimeId: string
        operatorSurfaces?: Array<{ surfaceId: string; clientTty: string }>
      }>
    }
    expect(
      presentation.runtimes.find((row) => row.runtimeId === first.runtimeId)?.operatorSurfaces
    ).toEqual([])
    expect(
      presentation.runtimes.find((row) => row.runtimeId === second.runtimeId)?.operatorSurfaces
    ).toEqual([{ surfaceId: 'ghostty-second', clientTty: '/dev/ttys014' }])

    const events = await fetchEvents()
    expect(
      events.some(
        (event) =>
          event.eventKind === 'surface.unbound' &&
          (event.payload as Record<string, unknown>)['surfaceId'] === 'ghostty-first'
      )
    ).toBe(true)
  })

  it('rejects bind with stale fence (409 stale_context)', async () => {
    server = await createHrcServer(serverOpts())
    const { runtimeId } = await ensureRuntime('stale-fence-test')

    const res = await postJson('/v1/surfaces/bind', {
      surfaceKind: 'operator-terminal',
      surfaceId: 'ghost-stale',
      runtimeId,
      hostSessionId: 'wrong-hsid',
      generation: 999,
    })

    expect(res.status).toBe(409)
    const err = (await res.json()) as { error: HrcHttpError }
    expect(err.error.code).toBe(HrcErrorCode.STALE_CONTEXT)
  })
})
