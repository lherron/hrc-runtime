/** T-06617 — real two-isolated-daemon peer listener round trip. */

import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { PEER_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION_HEADER } from '../federation/peer-protocol.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const TOKEN = 'two-isolated-daemon-peer-token'
const PARENT_SCOPE = 'agent:mable:project:hrc-runtime:task:T-06617'
const CHILD_SCOPE = 'agent:larry:project:hrc-runtime:task:T-06617'

function localTailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function peerHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    [PEER_PROTOCOL_VERSION_HEADER]: PEER_PROTOCOL_VERSION,
  }
}

async function reserveTwoPorts(hostname: string): Promise<[number, number]> {
  const first = Bun.serve({ hostname, port: 0, fetch: () => new Response('probe') })
  const second = Bun.serve({ hostname, port: 0, fetch: () => new Response('probe') })
  const ports: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return ports
}

describe('T-06617 two isolated daemons', () => {
  const fixtures: HrcServerTestFixture[] = []

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  })

  const tailnetIp = localTailnetIpv4()
  const liveTailnetTest = selectLiveTailnetTest(import.meta.path, tailnetIp)

  liveTailnetTest('auth, locate, and health cross the narrow tailnet listeners', async () => {
    if (tailnetIp === undefined) throw new Error('tailnet IPv4 unavailable')
    const svc = await createHrcTestFixture('hrc-t06617-svc-')
    const lab = await createHrcTestFixture('hrc-t06617-lab-')
    fixtures.push(svc, lab)

    const [svcPort, labPort] = await reserveTwoPorts(tailnetIp)
    const svcBind = `http://${tailnetIp}:${svcPort}`
    const labBind = `http://${tailnetIp}:${labPort}`

    await writeFile(
      `${svc.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'svc-test',
        peers: {
          'lab-test': { endpoint: labBind, token: TOKEN },
        },
        peerListener: { bind: svcBind },
      }),
      { mode: 0o600 }
    )
    await writeFile(
      `${lab.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'lab-test',
        peers: {
          'svc-test': { endpoint: svcBind, token: TOKEN },
        },
        peerListener: { bind: labBind },
      }),
      { mode: 0o600 }
    )

    const labDb = openHrcDatabase(lab.dbPath)
    try {
      const ledger = createPlacementLedgerRepository(labDb.sqlite)
      ledger.installActive({
        scopeRef: PARENT_SCOPE,
        homeNodeId: 'lab-test',
        placementEpoch: 4,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: '2026-07-20T00:00:00.000Z',
      })
      ledger.installActive({
        scopeRef: CHILD_SCOPE,
        homeNodeId: 'lab-test',
        placementEpoch: 4,
        birthClass: 'mechanism-born',
        authorityProvenance: {
          kind: 'child-birth',
          parentScopeRef: PARENT_SCOPE,
          parentRuntimeId: 'rt-parent',
          parentRunId: 'run-parent',
        },
        establishmentProvenance: 'explicit_local',
        updatedAt: '2026-07-20T00:00:00.000Z',
      })
    } finally {
      labDb.close()
    }

    const svcServer = await createHrcServer(svc.serverOpts({ otelListenerEnabled: false }))
    const labServer = await createHrcServer(lab.serverOpts({ otelListenerEnabled: false }))
    try {
      expect(svcServer.federationPeerEndpoint).toBe(`${svcBind}/`)
      expect(labServer.federationPeerEndpoint).toBe(`${labBind}/`)

      for (const endpoint of [svcBind, labBind]) {
        const health = await fetch(`${endpoint}/v1/federation/health`, {
          headers: peerHeaders(),
        })
        expect(health.status).toBe(200)
        expect(await health.json()).toMatchObject({
          ok: true,
          protocolVersion: PEER_PROTOCOL_VERSION,
          capabilities: { accept: true, locate: true, health: true },
        })
      }

      const missing = await fetch(`${labBind}/v1/federation/health`, {
        headers: { [PEER_PROTOCOL_VERSION_HEADER]: PEER_PROTOCOL_VERSION },
      })
      expect(missing.status).toBe(401)
      const wrong = await fetch(`${labBind}/v1/federation/health`, {
        headers: {
          authorization: 'Bearer wrong-token',
          [PEER_PROTOCOL_VERSION_HEADER]: PEER_PROTOCOL_VERSION,
        },
      })
      expect(wrong.status).toBe(401)

      const located = await fetch(`${labBind}/v1/federation/locate`, {
        method: 'POST',
        headers: peerHeaders(),
        body: JSON.stringify({ scopeRef: CHILD_SCOPE, ignoredFutureField: { value: true } }),
      })
      expect(located.status).toBe(200)
      expect(await located.json()).toMatchObject({
        ok: true,
        location: {
          authority: {
            state: 'bound',
            record: {
              homeNodeId: 'lab-test',
              placementEpoch: 4,
              birthClass: 'mechanism-born',
            },
          },
          observed: { nodeId: 'lab-test' },
          birthChain: {
            state: 'resolved',
            ancestor: { scopeRef: PARENT_SCOPE, birthClass: 'policy-born' },
          },
        },
      })

      const incompatible = await fetch(`${svcBind}/v1/federation/health`, {
        headers: { authorization: `Bearer ${TOKEN}`, [PEER_PROTOCOL_VERSION_HEADER]: '9.0' },
      })
      expect(incompatible.status).toBe(426)

      const fullApiLeak = await fetch(`${labBind}/v1/status`, { headers: peerHeaders() })
      expect(fullApiLeak.status).toBe(404)
    } finally {
      await labServer.stop()
      await svcServer.stop()
    }
  })

  test('wildcard peer bind is rejected during isolated-daemon startup', async () => {
    const fixture = await createHrcTestFixture('hrc-t06617-wildcard-')
    fixtures.push(fixture)
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'lab-test',
        peers: {
          'svc-test': { endpoint: 'http://svc.example.ts.net:18490', token: TOKEN },
        },
        peerListener: { bind: 'http://0.0.0.0:18490' },
      }),
      { mode: 0o600 }
    )

    await expect(
      createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    ).rejects.toThrow(/peerListener bind must name a specific tailnet host/)
  })

  test('peer listener without an authenticated peer is rejected before bind', async () => {
    const fixture = await createHrcTestFixture('hrc-t06617-no-peers-')
    fixtures.push(fixture)
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'lab-test',
        peers: {},
        peerListener: { bind: 'http://lab.example.ts.net:18490' },
      }),
      { mode: 0o600 }
    )

    await expect(
      createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    ).rejects.toThrow(/peer listener requires at least one configured peer/)
  })
})
