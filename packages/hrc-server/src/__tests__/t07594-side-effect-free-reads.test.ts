/**
 * T-07594 §5.4 — the presentation consumer's read set is SIDE-EFFECT-FREE.
 *
 * "Read-only" here means side-effect-free, not merely `GET`. Two of hrc's
 * `GET` routes reconcile tmux liveness as a side effect of reading and can mark
 * a runtime dead (`/v1/runtimes`, `/v1/attach`), which would let a cosmetic
 * viewer process change runtime state. The sidecar is therefore permitted
 * exactly five routes, and each one is pinned here.
 *
 * The seed is a broker runtime whose tmux substrate is ABSENT. That is what
 * makes the test meaningful rather than tautological: the CONTROL at the bottom
 * proves the very same seed IS marked dead through `/v1/runtimes`, so a
 * permitted route leaving it untouched is a property of the route, not of a
 * seed that nothing could kill.
 *
 * Both halves of "no side effect" are asserted: runtime status (nothing was
 * reconciled) and ledger head (nothing was appended).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcEventTail, ListPresentationRuntimesResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const HOST_SESSION_ID = 'hsid-07594-sef'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07594:sef'
const RUNTIME_ID = 'rt-07594-sef'

let fixture: HrcServerTestFixture
let server: HrcServer

/** The runtime's tmux session does not exist on the fixture socket. */
function seedDeadSubstrateRuntime(): void {
  fixture.seedSession(HOST_SESSION_ID, SCOPE_REF)
  fixture.seedTmuxRuntime(HOST_SESSION_ID, SCOPE_REF, RUNTIME_ID, { status: 'ready' })
}

function runtimeStatus(): string | undefined {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(RUNTIME_ID)?.status
  } finally {
    db.close()
  }
}

async function tail(): Promise<HrcEventTail> {
  return (await (await fixture.fetchSocket('/v1/events/tail?limit=1')).json()) as HrcEventTail
}

async function ledgerHead(): Promise<number> {
  return (await tail()).headHrcSeq
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07594-sef-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  seedDeadSubstrateRuntime()
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

describe('§5.4 permitted routes leave runtime status and the ledger untouched', () => {
  it('GET /v1/events/tail', async () => {
    const headBefore = await ledgerHead()

    const res = await fixture.fetchSocket('/v1/events/tail?limit=50')

    expect(res.status).toBe(200)
    expect(runtimeStatus()).toBe('ready')
    expect(await ledgerHead()).toBe(headBefore)
  })

  it('GET /v1/events/bounded-stream', async () => {
    const before = await tail()

    const params = new URLSearchParams({
      ledgerIncarnationId: before.ledgerIncarnationId,
      afterSeq: '0',
      follow: 'true',
    })
    const res = await fixture.fetchSocket(`/v1/events/bounded-stream?${params}`)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    // One read proves the route served; the stream is then abandoned.
    await reader.read()
    await reader.cancel()

    expect(runtimeStatus()).toBe('ready')
    expect(await ledgerHead()).toBe(before.headHrcSeq)
  })

  it('GET /v1/events/latest-by-session', async () => {
    const headBefore = await ledgerHead()

    const res = await fixture.fetchSocket('/v1/events/latest-by-session')

    expect(res.status).toBe(200)
    expect(runtimeStatus()).toBe('ready')
    expect(await ledgerHead()).toBe(headBefore)
  })

  it('GET /v1/presentation/runtimes', async () => {
    const headBefore = await ledgerHead()

    const res = await fixture.fetchSocket('/v1/presentation/runtimes')

    expect(res.status).toBe(200)
    const body = (await res.json()) as ListPresentationRuntimesResponse
    expect(body.runtimes.map((row) => row.runtimeId)).toContain(RUNTIME_ID)
    expect(runtimeStatus()).toBe('ready')
    expect(await ledgerHead()).toBe(headBefore)
  })

  it('GET /v1/health', async () => {
    const headBefore = await ledgerHead()

    const res = await fixture.fetchSocket('/v1/health')

    expect(res.status).toBe(200)
    expect(runtimeStatus()).toBe('ready')
    expect(await ledgerHead()).toBe(headBefore)
  })
})

describe('§5.4 control — the seed IS effective', () => {
  it('GET /v1/runtimes marks the same seed dead (a forbidden route for the sidecar)', async () => {
    expect(runtimeStatus()).toBe('ready')

    const res = await fixture.fetchSocket('/v1/runtimes')

    // The list route reconciles liveness while reading, finds the substrate
    // gone, and marks the row dead — here loudly enough that the read itself
    // fails with the reason code. The status transition is the fact that
    // matters; the 503 is how this build surfaces it.
    expect(runtimeStatus()).toBe('dead')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('runtime_unavailable')
  })
})

describe('§5.3 read model shape', () => {
  it('reports a record-less generation as absent rather than defaulting it (§5.5)', async () => {
    const res = await fixture.fetchSocket('/v1/presentation/runtimes')
    const body = (await res.json()) as ListPresentationRuntimesResponse
    const row = body.runtimes.find((candidate) => candidate.runtimeId === RUNTIME_ID)

    expect(row).toBeDefined()
    expect('presentation' in row!).toBe(false)
    expect(row!.scopeRef).toBe(`agent:${SCOPE_REF}`.replace('agent:agent:', 'agent:'))
    expect(row!.status).toBe('ready')
  })

  it('serves the persisted record and the session title once they exist', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.update(RUNTIME_ID, {
        presentation: {
          operatorAttachable: true,
          viewerRequested: true,
          viewerWindow: 'headless-sessions',
        },
      })
      db.sessionTitles.upsert({
        hostSessionId: HOST_SESSION_ID,
        title: 'sidecar reads',
        source: 'manual',
        createdAt: fixture.now(),
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    const res = await fixture.fetchSocket('/v1/presentation/runtimes')
    const body = (await res.json()) as ListPresentationRuntimesResponse
    const row = body.runtimes.find((candidate) => candidate.runtimeId === RUNTIME_ID)

    expect(row?.presentation).toEqual({
      operatorAttachable: true,
      viewerRequested: true,
      viewerWindow: 'headless-sessions',
    })
    expect(row?.title).toBe('sidecar reads')
    expect(runtimeStatus()).toBe('ready')
  })

  it('excludes terminal runtimes', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.updateStatus(RUNTIME_ID, 'terminated', fixture.now())
    } finally {
      db.close()
    }

    const res = await fixture.fetchSocket('/v1/presentation/runtimes')
    const body = (await res.json()) as ListPresentationRuntimesResponse

    expect(body.runtimes.map((row) => row.runtimeId)).not.toContain(RUNTIME_ID)
  })
})
