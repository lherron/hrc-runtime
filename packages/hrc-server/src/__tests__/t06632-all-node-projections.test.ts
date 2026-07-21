import { afterEach, describe, expect } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import type {
  FederationPeerHealthObservation,
  FederationRuntimeProjectionReport,
  ScopeLocation,
} from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const LAB_TOKEN = 't06632-svc-lab-token'
const MAX3_TOKEN = 't06632-svc-max3-token'
const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06632-live'

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePorts(host: string): [number, number, number] {
  const servers = Array.from({ length: 3 }, () =>
    Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  )
  const ports = servers.map((server) => server.port) as [number, number, number]
  for (const server of servers) server.stop(true)
  return ports
}

function installPlacement(fixture: HrcServerTestFixture, homeNodeId: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId,
      placementEpoch: 3,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
      updatedAt: new Date().toISOString(),
    })
  } finally {
    db.close()
  }
}

function seedSdkRuntime(fixture: HrcServerTestFixture, scopeRef: string, runtimeId: string): void {
  const hostSessionId = `hs-${runtimeId}`
  fixture.seedSession(hostSessionId, scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  const timestamp = new Date().toISOString()
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }
}

describe('T-06632 all-node runtime projections and peer health', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = tailnetIpv4()
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  liveTest(
    'three nodes: remote locate, peer health, and one down without a hang',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const svc = await createHrcTestFixture('hrc-t06632-svc-')
      const lab = await createHrcTestFixture('hrc-t06632-lab-')
      fixtures.push(svc, lab)
      const [svcPort, labPort, max3Port] = reservePorts(host)
      const svcBind = `http://${host}:${svcPort}`
      const labBind = `http://${host}:${labPort}`
      const max3Bind = `http://${host}:${max3Port}`

      await writeFile(
        `${svc.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
        JSON.stringify({
          nodeId: 'svc-test',
          peers: {
            'lab-test': { endpoint: labBind, token: LAB_TOKEN },
            'max3-test': { endpoint: max3Bind, token: MAX3_TOKEN },
          },
          peerListener: { bind: svcBind },
          gate: { mode: 'enforce', registryHost: 'lab-test' },
        }),
        { mode: 0o600 }
      )
      await writeFile(
        `${lab.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
        JSON.stringify({
          nodeId: 'lab-test',
          peers: { 'svc-test': { endpoint: svcBind, token: LAB_TOKEN } },
          peerListener: { bind: labBind },
          gate: { mode: 'enforce', registryHost: 'svc-test' },
        }),
        { mode: 0o600 }
      )

      const labRuntimeId = 'rt-t06632-lab'
      seedSdkRuntime(lab, SCOPE, labRuntimeId)
      installPlacement(svc, 'lab-test')
      installPlacement(lab, 'lab-test')

      const svcServer = await createHrcServer(svc.serverOpts({ otelListenerEnabled: false }))
      let labServer: Awaited<ReturnType<typeof createHrcServer>> | undefined =
        await createHrcServer(lab.serverOpts({ otelListenerEnabled: false }))
      try {
        const statusResponse = await svc.fetchSocket(
          '/v1/status?includeSessions=false&includePeerHealth=true'
        )
        expect(statusResponse.status).toBe(200)
        const status = (await statusResponse.json()) as {
          peerHealth: FederationPeerHealthObservation[]
        }
        expect(status.peerHealth).toEqual([
          expect.objectContaining({ nodeId: 'lab-test', state: 'healthy' }),
          expect.objectContaining({ nodeId: 'max3-test', state: 'unreachable' }),
        ])

        const locateStartedAt = performance.now()
        const locateResponse = await svc.fetchSocket(
          `/v1/federation/locate?scopeRef=${encodeURIComponent(SCOPE)}`
        )
        expect(performance.now() - locateStartedAt).toBeLessThan(2_500)
        const location = (await locateResponse.json()) as ScopeLocation
        expect(location.authority).toMatchObject({
          state: 'bound',
          record: { homeNodeId: 'lab-test', placementEpoch: 3 },
        })
        expect(location.peerResolution).toMatchObject({
          nodeId: 'lab-test',
          state: 'answered',
          location: {
            localNodeId: 'lab-test',
            observed: { nodeId: 'lab-test', runtimeCount: 1 },
          },
        })

        const firstProjectionResponse = await svc.fetchSocket('/v1/federation/runtimes')
        const firstProjection =
          (await firstProjectionResponse.json()) as FederationRuntimeProjectionReport
        expect(firstProjection.nodes).toEqual([
          expect.objectContaining({ nodeId: 'svc-test', state: 'answered' }),
          expect.objectContaining({
            nodeId: 'lab-test',
            state: 'answered',
            runtimes: [expect.objectContaining({ runtimeId: labRuntimeId, scopeRef: SCOPE })],
          }),
          expect.objectContaining({ nodeId: 'max3-test', state: 'unreachable', runtimes: [] }),
        ])

        await labServer.stop()
        labServer = undefined
        const downStartedAt = performance.now()
        const downResponse = await svc.fetchSocket('/v1/federation/runtimes')
        expect(performance.now() - downStartedAt).toBeLessThan(2_500)
        const downProjection = (await downResponse.json()) as FederationRuntimeProjectionReport
        expect(downProjection.nodes).toEqual([
          expect.objectContaining({ nodeId: 'svc-test', state: 'answered' }),
          expect.objectContaining({
            nodeId: 'lab-test',
            state: 'unreachable',
            answeredAt: expect.any(String),
            runtimes: [expect.objectContaining({ runtimeId: labRuntimeId })],
          }),
          expect.objectContaining({ nodeId: 'max3-test', state: 'unreachable', runtimes: [] }),
        ])
      } finally {
        await labServer?.stop()
        await svcServer.stop()
      }
    },
    10_000
  )
})
