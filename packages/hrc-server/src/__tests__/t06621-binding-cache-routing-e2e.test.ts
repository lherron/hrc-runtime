import { afterEach, describe, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FederationMessageEnvelope } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { createFederationAcceptHandler } from '../federation/accept.js'
import { InMemoryBindingHintCache } from '../federation/binding-cache.js'
import type { PeerEntry } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import {
  PEER_PROTOCOL_VERSION_HEADER,
  startPeerProtocolEndpoint,
} from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { HttpBindingRegistryClient } from '../federation/registry-client.js'
import { startBindingRegistryEndpoint } from '../federation/registry-endpoint.js'
import {
  FederationRoutingResolutionError,
  resolveFederationRoutingBinding,
} from '../federation/routing-resolution.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const TOKEN = 't06621-origin-token'
const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06621-e2e'
const SESSION = `${SCOPE}/lane:default`
const MESSAGE_ID = 'msg-66666666-6666-4666-8666-666666666666'

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePort(host: string): number {
  const probe = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  return port
}

function envelope(homeNodeId: string, placementEpoch: number): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId: MESSAGE_ID,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime:task:minisvc' },
    to: { kind: 'session', sessionRef: SESSION },
    body: 'cached route survives registry outage',
    rootMessageId: MESSAGE_ID,
    expected: { homeNodeId, placementEpoch },
  }
}

describe('T-06621 isolated registry-outage delivery', () => {
  const cleanup: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  const host = tailnetIpv4()
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  liveTest(
    'stopping svc registry preserves cached delivery while uncached routing fails visibly/retryably',
    async () => {
      if (host === undefined) throw new Error('tailnet IPv4 unavailable')
      const tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06621-'))
      cleanup.push(() => rm(tempDir, { recursive: true, force: true }))

      const registryPath = join(tempDir, 'binding-registry.sqlite')
      const seededRegistry = openBindingRegistry(registryPath)
      seededRegistry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      })
      seededRegistry.close()

      const registryEndpoint = startBindingRegistryEndpoint({
        listener: { bind: `http://${host}:${reservePort(host)}` },
        peers: new Map([['origin', { nodeId: 'origin', token: new PeerToken(TOKEN) }]]),
        registryPath,
        localNodeId: 'svc',
      })
      let registryRunning = true
      cleanup.push(() => {
        if (registryRunning) registryEndpoint.stop()
      })

      const labDb = openHrcDatabase(':memory:')
      cleanup.push(() => labDb.close())
      createPlacementLedgerRepository(labDb.sqlite).installActive({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: '2026-07-20T00:00:00.000Z',
      })
      const labEndpoint = startPeerProtocolEndpoint({
        listener: { bind: `http://${host}:${reservePort(host)}` },
        options: {
          localNodeId: 'lab',
          peers: new Map([
            [
              'origin',
              {
                nodeId: parseNodeId('origin', 'test origin'),
                endpoint: registryEndpoint.url,
                token: new PeerToken(TOKEN),
              },
            ],
          ]),
          locate: async () => ({}),
          health: () => ({
            startedAt: '2026-07-20T00:00:00.000Z',
            capabilities: { accept: true, locate: true, health: true },
          }),
          accept: createFederationAcceptHandler({ db: labDb, localNodeId: 'lab' }),
        },
      })
      cleanup.push(() => labEndpoint.stop())

      const registryClient = new HttpBindingRegistryClient(
        {
          nodeId: parseNodeId('svc', 'test registry peer'),
          endpoint: registryEndpoint.url,
          token: new PeerToken(TOKEN),
        } satisfies PeerEntry,
        {
          perAttemptTimeoutMs: 50,
          totalTimeoutMs: 100,
          random: () => 0,
          log: () => {},
        }
      )
      const originDb = openHrcDatabase(':memory:')
      cleanup.push(() => originDb.close())
      const cache = new InMemoryBindingHintCache()
      const resolve = (scopeRef: string) =>
        resolveFederationRoutingBinding({
          scopeRef,
          ledger: createPlacementLedgerRepository(originDb.sqlite),
          cache,
          registry: registryClient,
        })

      expect(await resolve(SCOPE)).toMatchObject({
        source: 'registry',
        homeNodeId: 'lab',
        placementEpoch: 1,
      })

      registryEndpoint.stop()
      registryRunning = false

      const cached = await resolve(SCOPE)
      expect(cached).toMatchObject({ source: 'cache', homeNodeId: 'lab', placementEpoch: 1 })
      const delivered = await fetch(new URL('/v1/federation/accept', labEndpoint.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          [PEER_PROTOCOL_VERSION_HEADER]: '1.0',
        },
        body: JSON.stringify({ envelope: envelope(cached.homeNodeId, cached.placementEpoch) }),
      })
      expect(delivered.status).toBe(200)
      expect(await delivered.json()).toMatchObject({
        ack: { outcome: 'accepted', messageId: MESSAGE_ID },
      })
      expect(labDb.messages.getById(MESSAGE_ID)).toMatchObject({
        body: 'cached route survives registry outage',
      })

      const uncachedError = await resolve(`${SCOPE}-uncached`).catch((caught: unknown) => caught)
      expect(uncachedError).toBeInstanceOf(FederationRoutingResolutionError)
      expect(uncachedError).toMatchObject({
        code: 'registry_unreachable',
        visible: true,
        retryable: true,
      })
    }
  )
})
