/**
 * T-11441 gate 0 — the stage-1 kernel's read set is SIDE-EFFECT-FREE and
 * pinned (hrc-runtime.rust-migration §4.3).
 *
 * The Rust kernel reads HRC only through these six routes:
 * `/v1/events/page`, `/v1/events/bounded-stream` (as a wake),
 * `/v1/events/latest-by-session`, `/v1/presentation/runtimes` and
 * `/v1/sessions` and POST `/v1/presentation/seats/read`. Each is pinned here with the query shape the kernel sends.
 *
 * As in t07594-side-effect-free-reads, the seed is a broker runtime whose tmux
 * substrate is ABSENT, and the CONTROL proves the same seed IS marked dead
 * through `/v1/runtimes` — the reconciling route the kernel never calls — so a
 * pinned route leaving it untouched is a property of the route, not of a seed
 * nothing could kill. Both halves of "no side effect" are asserted: runtime
 * status and state (nothing reconciled) and the allocated ledger head (nothing
 * appended).
 *
 * The presentation row's additive `contextReading` (runtime-context-reading,
 * r3.2 F5) is pinned here too: copied exactly as stored, absent when none is
 * stored, and served without touching the runtime row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcEventPage, ListPresentationRuntimesResponse } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const HOST_SESSION_ID = 'hsid-11441-krs'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-11441:krs'
const RUNTIME_ID = 'rt-11441-krs'

let fixture: HrcServerTestFixture
let server: HrcServer

function withDb<T>(read: (db: HrcDatabase) => T): T {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return read(db)
  } finally {
    db.close()
  }
}

/** The runtime row as stored: status, state JSON and update time. */
function runtimeRow(): { status?: string; state?: string; updatedAt?: string } {
  return withDb((db) => {
    const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)
    return {
      status: runtime?.status,
      state: JSON.stringify(runtime?.runtimeStateJson ?? null),
      updatedAt: runtime?.updatedAt,
    }
  })
}

/** The allocated high-water: a read that appended anything moves it. */
function allocatedHead(): number {
  return withDb((db) => db.hrcEvents.allocatedHrcSeq())
}

function incarnation(): string {
  return withDb((db) => db.hrcEvents.ledgerIncarnationId())
}

async function expectUntouched(read: () => Promise<Response>): Promise<Response> {
  const rowBefore = runtimeRow()
  const headBefore = allocatedHead()
  const res = await read()
  expect(res.status).toBe(200)
  expect(runtimeRow()).toEqual(rowBefore)
  expect(runtimeRow().status).toBe('ready')
  expect(allocatedHead()).toBe(headBefore)
  return res
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t11441-krs-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  fixture.seedSession(HOST_SESSION_ID, SCOPE_REF)
  fixture.seedTmuxRuntime(HOST_SESSION_ID, SCOPE_REF, RUNTIME_ID, { status: 'ready' })
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

describe('§4.3 the pinned read set leaves runtime state and the ledger untouched', () => {
  it('GET /v1/events/page, discovering and then fenced', async () => {
    const discovered = await expectUntouched(() =>
      fixture.fetchSocket('/v1/events/page?afterSeq=0&limit=1')
    )
    const body = (await discovered.json()) as HrcEventPage
    expect(body.ledgerIncarnationId).toBe(incarnation())

    await expectUntouched(() =>
      fixture.fetchSocket(
        `/v1/events/page?ledgerIncarnationId=${body.ledgerIncarnationId}&afterSeq=0&limit=200`
      )
    )
  })

  it('GET /v1/events/bounded-stream, followed as a wake', async () => {
    await expectUntouched(async () => {
      const params = new URLSearchParams({
        ledgerIncarnationId: incarnation(),
        afterSeq: String(allocatedHead()),
        follow: 'true',
      })
      const res = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      // One read proves the route served; the stream is then abandoned.
      await reader.read()
      await reader.cancel()
      return new Response(null, { status: 200 })
    })
  })

  it('GET /v1/events/latest-by-session', async () => {
    await expectUntouched(() => fixture.fetchSocket('/v1/events/latest-by-session'))
  })

  it('POST /v1/presentation/seats/read is keyed, empty-safe and side-effect-free', async () => {
    fixture.seedSession('hsid-unrelated', 'agent:clod:project:unrelated')
    const res = await expectUntouched(() =>
      fixture.postJson('/v1/presentation/seats/read', {
        sessionRefs: [],
        runtimeIds: [RUNTIME_ID, RUNTIME_ID, 'missing'],
      })
    )
    const body = (await res.json()) as {
      sessions: Array<{ hostSessionId: string }>
      runtimes: Array<{ runtimeId: string }>
      events: unknown[]
    }
    expect(body.sessions.map((s) => s.hostSessionId)).toEqual([HOST_SESSION_ID])
    expect(body.runtimes.map((r) => r.runtimeId)).toEqual([RUNTIME_ID])
    const empty = await fixture.postJson('/v1/presentation/seats/read', {
      sessionRefs: [],
      runtimeIds: [],
    })
    expect(await empty.json()).toEqual({ sessions: [], runtimes: [], events: [] })
    const keyed = await fixture.postJson('/v1/presentation/seats/read', {
      sessionRefs: [`${SCOPE_REF}/lane:lane:default`],
      runtimeIds: [],
    })
    expect(await keyed.json()).toEqual(body)
  })

  it('keyed reads select the latest live generation and its own latest event', async () => {
    const now = fixture.now()
    withDb((db) => {
      const old = db.sessions.getByHostSessionId(HOST_SESSION_ID)!
      db.sessions.insert({
        ...old,
        hostSessionId: 'hsid-new',
        generation: 2,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      })
      db.runtimes.update(RUNTIME_ID, { hostSessionId: 'hsid-new', generation: 2 })
      for (const [hostSessionId, generation] of [
        [HOST_SESSION_ID, 1],
        ['hsid-new', 2],
      ] as const) {
        for (let n = 0; n < 2; n++)
          db.hrcEvents.append({
            ts: now,
            hostSessionId,
            generation,
            scopeRef: SCOPE_REF,
            laneRef: 'default',
            category: 'turn',
            eventKind: 'turn.tool_result',
            payload: { n },
          })
      }
    })
    const res = await expectUntouched(() =>
      fixture.postJson('/v1/presentation/seats/read', {
        sessionRefs: [],
        runtimeIds: [RUNTIME_ID],
      })
    )
    const body = (await res.json()) as {
      sessions: Array<{ hostSessionId: string; generation: number }>
      events: Array<{ hostSessionId: string; payload: unknown }>
    }
    expect(body.sessions.map((s) => [s.hostSessionId, s.generation])).toEqual([['hsid-new', 2]])
    expect(body.events.map((e) => [e.hostSessionId, e.payload])).toEqual([['hsid-new', { n: 1 }]])
    // A terminal runtime still names the seat, but must not appear as live.
    withDb((db) => db.runtimes.updateStatus(RUNTIME_ID, 'terminated', now))
    const inactive = await fixture.postJson('/v1/presentation/seats/read', {
      sessionRefs: [],
      runtimeIds: [RUNTIME_ID],
    })
    expect(((await inactive.json()) as { runtimes: unknown[] }).runtimes).toEqual([])
  })

  it('POST /v1/presentation/seats/read rejects malformed key lists', async () => {
    for (const body of [
      null,
      {},
      { sessionRefs: 'all', runtimeIds: [] },
      { sessionRefs: ['bad'], runtimeIds: [] },
      { sessionRefs: [], runtimeIds: [1] },
    ]) {
      expect((await fixture.postJson('/v1/presentation/seats/read', body)).status).toBe(400)
    }
  })

  it('GET /v1/presentation/runtimes', async () => {
    const res = await expectUntouched(() => fixture.fetchSocket('/v1/presentation/runtimes'))
    const body = (await res.json()) as ListPresentationRuntimesResponse
    expect(body.runtimes.map((row) => row.runtimeId)).toContain(RUNTIME_ID)
  })

  it('GET /v1/sessions with the live-set window and latest generation', async () => {
    const params = new URLSearchParams({
      updatedSince: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      latestGeneration: 'true',
    })
    const res = await expectUntouched(() => fixture.fetchSocket(`/v1/sessions?${params}`))
    const sessions = (await res.json()) as Array<{ hostSessionId: string }>
    expect(sessions.map((session) => session.hostSessionId)).toContain(HOST_SESSION_ID)
  })
})

describe('§4.3 control — the seed IS effective', () => {
  it('GET /v1/runtimes marks the same seed dead (outside the kernel read set)', async () => {
    expect(runtimeRow().status).toBe('ready')

    const res = await fixture.fetchSocket('/v1/runtimes')

    expect(runtimeRow().status).toBe('dead')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('runtime_unavailable')
  })
})

describe('§4.3 presentation rows carry the persisted contextReading', () => {
  async function presentationRow(): Promise<Record<string, unknown> | undefined> {
    const res = await fixture.fetchSocket('/v1/presentation/runtimes')
    const body = (await res.json()) as ListPresentationRuntimesResponse
    return body.runtimes.find((row) => row.runtimeId === RUNTIME_ID) as
      | Record<string, unknown>
      | undefined
  }

  function storeState(state: Record<string, unknown>): void {
    withDb((db) => db.runtimes.update(RUNTIME_ID, { runtimeStateJson: state }))
  }

  it('is absent when no reading is stored', async () => {
    const row = await presentationRow()
    expect(row).toBeDefined()
    expect('contextReading' in row!).toBe(false)
  })

  it('is copied exactly as stored, without touching the runtime row', async () => {
    const reading = {
      turnId: 'turn-11441',
      usedTokens: 41_234,
      windowTokens: 200_000,
      model: { id: 'claude-opus-5-5', source: 'provider-response' },
      observedAt: '2026-10-20T13:00:00.000Z',
    }
    storeState({ contextReading: reading, unrelated: { kept: true } })

    const row = await expectUntouched(() => fixture.fetchSocket('/v1/presentation/runtimes'))
      .then(async (res) => (await res.json()) as ListPresentationRuntimesResponse)
      .then((body) => body.runtimes.find((candidate) => candidate.runtimeId === RUNTIME_ID))

    expect(row?.contextReading).toEqual(reading)
    // Only the reading crosses; the rest of runtimeStateJson stays private.
    expect(JSON.stringify(row)).not.toContain('unrelated')
  })

  it('is not validated here: a malformed stored value passes through for the reader to judge', async () => {
    const malformed = { turnId: '', usedTokens: -1, observedAt: 'not-a-time' }
    storeState({ contextReading: malformed })

    expect((await presentationRow())?.contextReading).toEqual(malformed)
  })
})
