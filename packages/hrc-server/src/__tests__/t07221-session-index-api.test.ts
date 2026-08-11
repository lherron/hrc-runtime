import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { createHrcServer } from '../index.js'
import type { SessionFacetsResponse, SessionPageResponse } from '../session-index-handlers.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  FEDERATION_TEST_MODE_ENV,
  createFederationTestServer,
  federationTestHost,
} from './fixtures/live-tailnet-test.js'

function seedCurrent(
  fixture: HrcServerTestFixture,
  input: { id: string; agent?: string | undefined; project?: string | undefined; ts: string }
) {
  const db = openHrcDatabase(fixture.dbPath)
  const agent = input.agent ?? 'cody'
  const project = input.project ?? 'hrc-runtime'
  const scopeRef = `agent:${agent}:project:${project}:task:${input.id}`
  const hostSessionId = `hsid-${input.id}`
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: input.ts,
      updatedAt: input.ts,
      ancestorScopeRefs: [],
    })
    db.continuities.upsert({
      scopeRef,
      laneRef: 'main',
      activeHostSessionId: hostSessionId,
      updatedAt: input.ts,
    })
  } finally {
    db.close()
  }
  return { hostSessionId, scopeRef }
}

async function page(fixture: HrcServerTestFixture, path: string): Promise<SessionPageResponse> {
  const response = await fixture.fetchSocket(path)
  expect(response.status).toBe(200)
  return (await response.json()) as SessionPageResponse
}

describe('T-07221 local session page and facets API', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('walks exactly once in projection order, preserves cut rows, and binds cursor to filters', async () => {
    const fixture = await createHrcTestFixture('hrc-t07221-local-')
    fixtures.push(fixture)
    for (const [id, ts] of [
      ['a', '2026-08-11T12:00:00.000Z'],
      ['b', '2026-08-11T12:00:00.000Z'],
      ['c', '2026-08-11T11:00:00.000Z'],
      ['d', '2026-08-11T10:00:00.000Z'],
      ['e', '2026-08-11T09:00:00.000Z'],
    ] as const) {
      seedCurrent(fixture, { id, ts })
    }
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const response = await page(
          fixture,
          `/v1/sessions/page?nodes=local&limit=2${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
        )
        expect(response.complete).toBe(true)
        expect(Object.values(response.eventHighWater)).toEqual([0])
        seen.push(...response.items.map((item) => item.hostSessionId))
        cursor = response.nextCursor
      } while (cursor !== undefined)
      expect(seen).toEqual(['hsid-b', 'hsid-a', 'hsid-c', 'hsid-d', 'hsid-e'])
      expect(new Set(seen).size).toBe(seen.length)

      const first = await page(fixture, '/v1/sessions/page?nodes=local&limit=1&agentId=cody')
      const mismatch = await fixture.fetchSocket(
        `/v1/sessions/page?nodes=local&limit=1&agentId=mable&cursor=${encodeURIComponent(first.nextCursor!)}`
      )
      expect(mismatch.status).toBe(400)

      const malformed = await fixture.fetchSocket('/v1/sessions/page?nodes=local&cursor=not-base64')
      expect(malformed.status).toBe(400)
      const unknown = await fixture.fetchSocket('/v1/sessions/page?nodes=missing')
      expect(unknown.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test('concurrent recency movement produces no duplicates and is recovered at the fresh head', async () => {
    const fixture = await createHrcTestFixture('hrc-t07221-concurrent-')
    fixtures.push(fixture)
    const identities = [
      seedCurrent(fixture, { id: 'a', ts: '2026-08-11T12:00:00.000Z' }),
      seedCurrent(fixture, { id: 'b', ts: '2026-08-11T11:00:00.000Z' }),
      seedCurrent(fixture, { id: 'c', ts: '2026-08-11T10:00:00.000Z' }),
      seedCurrent(fixture, { id: 'd', ts: '2026-08-11T09:00:00.000Z' }),
    ]
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      const first = await page(fixture, '/v1/sessions/page?nodes=local&limit=2')
      expect(Object.values(first.eventHighWater)).toEqual([0])
      const moved = identities[3]!
      const db = openHrcDatabase(fixture.dbPath)
      try {
        db.hrcEvents.append({
          ts: '2026-08-11T13:00:00.000Z',
          hostSessionId: moved.hostSessionId,
          scopeRef: moved.scopeRef,
          laneRef: 'main',
          generation: 1,
          category: 'turn',
          eventKind: 'turn.progress',
          payload: {},
        })
      } finally {
        db.close()
      }

      const walk = [...first.items]
      let cursor = first.nextCursor
      while (cursor !== undefined) {
        const response = await page(
          fixture,
          `/v1/sessions/page?nodes=local&limit=2&cursor=${encodeURIComponent(cursor)}`
        )
        walk.push(...response.items)
        cursor = response.nextCursor
      }
      const walkIds = walk.map((item) => item.hostSessionId)
      expect(new Set(walkIds).size).toBe(walkIds.length)
      expect(walkIds).not.toContain(moved.hostSessionId)

      const refresh = await page(fixture, '/v1/sessions/page?nodes=local&limit=2')
      expect(Object.values(refresh.eventHighWater)).toEqual([1])
      expect(refresh.items[0]?.hostSessionId).toBe(moved.hostSessionId)
      expect(new Set([...walkIds, ...refresh.items.map((item) => item.hostSessionId)])).toEqual(
        new Set(identities.map((identity) => identity.hostSessionId))
      )
    } finally {
      await server.stop()
    }
  })

  test('returns full self-excluding local facets from projection-only queries', async () => {
    const fixture = await createHrcTestFixture('hrc-t07221-facets-')
    fixtures.push(fixture)
    seedCurrent(fixture, { id: 'a', agent: 'cody', ts: '2026-08-11T12:00:00.000Z' })
    seedCurrent(fixture, { id: 'b', agent: 'mable', ts: '2026-08-11T11:00:00.000Z' })
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      const response = await fixture.fetchSocket(
        '/v1/sessions/facets?nodes=local&agentId=cody&effectiveStatus=inactive&executionMode=nonInteractive'
      )
      expect(response.status).toBe(200)
      const facets = (await response.json()) as SessionFacetsResponse
      expect(facets).toMatchObject({
        total: 1,
        byAgentId: { cody: 1, mable: 1 },
        byEffectiveStatus: { inactive: 1 },
        byExecutionMode: { nonInteractive: 1 },
        complete: true,
      })
      expect(Object.values(facets.byNodeId)).toEqual([1])
    } finally {
      await server.stop()
    }
  })
})

describe('T-07221 federated session traversal', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('pairs peer-down degradation with recovery so frozen rows arrive late but are never lost', async () => {
    const priorMode = process.env[FEDERATION_TEST_MODE_ENV]
    process.env[FEDERATION_TEST_MODE_ENV] = 'loopback'
    const host = federationTestHost(undefined)
    if (host === undefined) throw new Error('loopback federation host unavailable')
    const svc = await createHrcTestFixture('hrc-t07221-svc-')
    const lab = await createHrcTestFixture('hrc-t07221-lab-')
    fixtures.push(svc, lab)
    const probes = [0, 1].map(() =>
      Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
    )
    const [svcPort, labPort] = probes.map((probe) => probe.port)
    for (const probe of probes) probe.stop(true)
    const svcBind = `http://${host}:${svcPort}`
    const labBind = `http://${host}:${labPort}`
    const token = 't07221-session-page-token'
    await writeFile(
      `${svc.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'svc',
        peers: { lab: { endpoint: labBind, token } },
        peerListener: { bind: svcBind },
      }),
      { mode: 0o600 }
    )
    await writeFile(
      `${lab.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'lab',
        peers: { svc: { endpoint: svcBind, token } },
        peerListener: { bind: labBind },
      }),
      { mode: 0o600 }
    )
    seedCurrent(svc, { id: 'svc-a', ts: '2026-08-11T12:00:00.000Z' })
    seedCurrent(svc, { id: 'svc-b', ts: '2026-08-11T10:00:00.000Z' })
    seedCurrent(lab, { id: 'lab-a', ts: '2026-08-11T11:00:00.000Z' })
    seedCurrent(lab, { id: 'lab-b', ts: '2026-08-11T09:00:00.000Z' })

    let svcServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
    let labServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
    try {
      svcServer = await createFederationTestServer(svc, { otelListenerEnabled: false })
      labServer = await createFederationTestServer(lab, { otelListenerEnabled: false })

      const first = await page(svc, '/v1/sessions/page?limit=1')
      expect(first).toMatchObject({ complete: true, items: [{ nodeId: 'svc' }] })
      expect(first.eventHighWater).toEqual({ lab: 0, svc: 0 })
      const cursorBody = JSON.parse(
        Buffer.from(first.nextCursor!, 'base64url').toString('utf8')
      ) as { n: Record<string, unknown> }
      expect(Object.keys(cursorBody.n)).toEqual(['svc'])

      await labServer.stop()
      labServer = undefined
      const degraded = await page(
        svc,
        `/v1/sessions/page?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`
      )
      expect(degraded).toMatchObject({
        complete: false,
        items: [{ nodeId: 'svc', hostSessionId: 'hsid-svc-b' }],
        peerStatus: { lab: { state: 'unreachable' } },
      })
      expect(degraded.eventHighWater).toEqual({ svc: 0 })
      expect(degraded.nextCursor).toEqual(expect.any(String))

      labServer = await createFederationTestServer(lab, { otelListenerEnabled: false })
      const recovered: SessionPageResponse['items'] = []
      let cursor = degraded.nextCursor
      while (cursor !== undefined) {
        const response = await page(
          svc,
          `/v1/sessions/page?limit=1&cursor=${encodeURIComponent(cursor)}`
        )
        expect(response.complete).toBe(true)
        expect(response.eventHighWater).toEqual({ lab: 0, svc: 0 })
        recovered.push(...response.items)
        cursor = response.nextCursor
      }
      expect(recovered.map((item) => item.hostSessionId)).toEqual(['hsid-lab-a', 'hsid-lab-b'])
      expect(new Set(recovered.map((item) => item.hostSessionId)).size).toBe(recovered.length)

      const exact = await page(svc, '/v1/sessions/page?nodes=lab&limit=10')
      expect(exact.items.every((item) => item.nodeId === 'lab')).toBe(true)
      const facetsResponse = await svc.fetchSocket('/v1/sessions/facets?nodes=svc')
      const facets = (await facetsResponse.json()) as SessionFacetsResponse
      expect(facets.total).toBe(2)
      expect(facets.byNodeId).toEqual({ lab: 2, svc: 2 })
    } finally {
      await labServer?.stop()
      await svcServer?.stop()
      if (priorMode === undefined) delete process.env[FEDERATION_TEST_MODE_ENV]
      else process.env[FEDERATION_TEST_MODE_ENV] = priorMode
    }
  }, 15_000)
})
