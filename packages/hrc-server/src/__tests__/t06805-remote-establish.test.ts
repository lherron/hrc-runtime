import { afterEach, describe, expect, test } from 'bun:test'

import type { FederationPlacementBinding, SemanticDmRequest } from 'hrc-core'

import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { sendRemoteEstablish } from '../federation/establish-client.js'
import type { FederationConfig } from '../federation/federation-config.js'
import { FederationOriginOutbox } from '../federation/origin-outbox.js'
import { PeerToken } from '../federation/peer-token.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import {
  type SummonGateServerContext,
  establishRemotePolicyAuthority,
} from '../federation/summon-gate-server.js'
import type { SummonGatePolicy } from '../federation/summon-gate.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06805-remote'
const CORRELATION = 'establish-msg-11111111-1111-4111-8111-111111111111'

describe('T-06805 authenticated remote policy establishment', () => {
  const closeables: Array<{ close(): void }> = []

  afterEach(() => {
    for (const closeable of closeables.splice(0)) closeable.close()
  })

  function harness(
    nodeId: string,
    registry: ReturnType<typeof openBindingRegistry>,
    policyFor: (scopeRef: string) => Promise<SummonGatePolicy>
  ): SummonGateServerContext {
    const db = openHrcDatabase(':memory:')
    closeables.push(db)
    const registryClient: BindingRegistryClient = {
      async consult(scopeRef) {
        const record = registry.getRecord(scopeRef)
        if (record === undefined) return { outcome: 'unbound' }
        return record.state === 'retired'
          ? { outcome: 'retired', retirement: record }
          : { outcome: 'bound', binding: record }
      },
      async establish(request) {
        return registry.establish(request)
      },
    }
    return {
      db,
      federationConfig: {
        nodeId,
        nodeIdProvenance: 'declared',
        sourcePath: `/isolated/${nodeId}/federation.json`,
        sourceExists: true,
        peers: new Map(),
        gate: { mode: 'enforce' },
        warnings: [],
      } as FederationConfig,
      registryClient,
      policyFor,
      capabilityFor: async () => ({ outcome: 'capable' }),
    }
  }

  test('receiver performs registry-first policy birth and creates no message or session', async () => {
    const registry = openBindingRegistry(':memory:')
    closeables.push(registry)
    const server = harness('lab', registry, async () => ({
      placement: { pins: { 'hrc-runtime:T-06805-remote': 'lab' } },
      claimsTask: false,
    }))

    const first = await establishRemotePolicyAuthority(server, {
      scopeRef: SCOPE,
      correlationId: CORRELATION,
    })
    expect(first).toMatchObject({
      outcome: 'established',
      correlationId: CORRELATION,
      binding: {
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        establishmentProvenance: 'pin',
      },
    })
    expect(registry.list()).toHaveLength(1)
    expect(createPlacementLedgerRepository(server.db.sqlite).activeAuthority(SCOPE)).toMatchObject({
      homeNodeId: 'lab',
      placementEpoch: 1,
    })
    expect(
      server.db.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM messages').get()
        ?.count
    ).toBe(0)
    expect(
      server.db.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM sessions').get()
        ?.count
    ).toBe(0)

    const retry = await establishRemotePolicyAuthority(server, {
      scopeRef: SCOPE,
      correlationId: `${CORRELATION}-retry`,
    })
    expect(retry).toMatchObject({ outcome: 'existing', binding: first.binding })
    expect(registry.list()).toHaveLength(1)
  })

  test('registry CAS arbitrates competing receiver births and the loser installs no authority', async () => {
    const registry = openBindingRegistry(':memory:')
    closeables.push(registry)
    const lab = harness('lab', registry, async () => ({
      placement: { pins: { 'hrc-runtime:T-06805-remote': 'lab' } },
      claimsTask: false,
    }))
    const max3 = harness('max3', registry, async () => ({
      placement: { pins: { 'hrc-runtime:T-06805-remote': 'max3' } },
      claimsTask: false,
    }))

    const results = await Promise.all([
      establishRemotePolicyAuthority(lab, { scopeRef: SCOPE, correlationId: 'race-lab' }),
      establishRemotePolicyAuthority(max3, { scopeRef: SCOPE, correlationId: 'race-max3' }),
    ])
    expect(results.filter((result) => result.outcome === 'established')).toHaveLength(1)
    expect(results.filter((result) => result.outcome === 'existing')).toHaveLength(1)
    const winner = registry.get(SCOPE)!
    expect(registry.list()).toHaveLength(1)
    expect(
      results.every(
        (result) => result.outcome !== 'refused' && result.binding.homeNodeId === winner.homeNodeId
      )
    ).toBe(true)
    const authorities = [lab, max3].filter(
      (server) =>
        createPlacementLedgerRepository(server.db.sqlite).activeAuthority(SCOPE) !== undefined
    )
    expect(authorities).toHaveLength(1)
    expect(
      createPlacementLedgerRepository(authorities[0]!.db.sqlite).activeAuthority(SCOPE)?.homeNodeId
    ).toBe(winner.homeNodeId)
  })

  test('node-local sentinel and claim birth fail closed without advertising authority', async () => {
    const registry = openBindingRegistry(':memory:')
    closeables.push(registry)
    const localSentinel = harness('lab', registry, async () => ({
      placement: { pins: {}, defaultHomeNode: 'local' },
      claimsTask: false,
    }))
    const localResult = await establishRemotePolicyAuthority(localSentinel, {
      scopeRef: SCOPE,
      correlationId: 'sentinel',
    })
    expect(localResult).toMatchObject({
      outcome: 'refused',
      code: 'stale_context',
      reason: 'routed-elsewhere',
      retryable: false,
    })

    const claim = harness('lab', registry, async () => ({
      placement: { pins: { 'hrc-runtime:T-06805-remote': 'lab' } },
      claimsTask: true,
    }))
    const claimResult = await establishRemotePolicyAuthority(claim, {
      scopeRef: SCOPE,
      correlationId: 'claim',
    })
    expect(claimResult).toMatchObject({
      outcome: 'refused',
      code: 'stale_context',
      reason: 'claim-birth-authority-required',
      retryable: false,
    })
    expect(registry.list()).toEqual([])
  })

  test('origin refuses missing establish capability and route 404 as peer_upgrade_required', async () => {
    const peer = {
      nodeId: 'lab' as never,
      endpoint: 'http://lab.example.ts.net:18490/',
      token: new PeerToken('test-token'),
    }
    const request = { scopeRef: SCOPE, intent: 'implicit' as const, correlationId: CORRELATION }
    let calls = 0
    const omitted = await sendRemoteEstablish({
      peer,
      request,
      fetch: async () => {
        calls += 1
        return Response.json({ capabilities: { accept: true, locate: true, health: true } })
      },
    })
    expect(omitted).toMatchObject({
      outcome: 'refused',
      reason: 'peer_upgrade_required',
      retryable: false,
    })
    expect(calls).toBe(1)

    const notFound = await sendRemoteEstablish({
      peer,
      request,
      fetch: async (input) =>
        new URL(input instanceof Request ? input.url : input.toString()).pathname.endsWith(
          '/health'
        )
          ? Response.json({ capabilities: { establish: true } })
          : Response.json({ error: { code: 'not_found' } }, { status: 404 }),
    })
    expect(notFound).toMatchObject({
      outcome: 'refused',
      reason: 'peer_upgrade_required',
      retryable: false,
    })
  })

  test('origin advances one durable row from establishment to registry-fenced accept', async () => {
    const db = openHrcDatabase(':memory:')
    closeables.push(db)
    let binding: FederationPlacementBinding | undefined
    const wire: Array<{ path: string; body: Record<string, unknown> }> = []
    const peerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        const body =
          request.method === 'POST'
            ? ((await request.json()) as Record<string, unknown>)
            : ({} as Record<string, unknown>)
        wire.push({ path, body })
        if (path.endsWith('/health')) {
          return Response.json({ capabilities: { establish: true } })
        }
        if (path.endsWith('/establish')) {
          binding = {
            scopeRef: SCOPE,
            homeNodeId: 'lab',
            placementEpoch: 1,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'pin',
            createdAt: '2026-07-22T20:00:00.000Z',
            updatedAt: '2026-07-22T20:00:00.000Z',
          }
          return Response.json({
            outcome: 'established',
            correlationId: body['correlationId'],
            binding,
          })
        }
        const envelope = (body['envelope'] as Record<string, unknown>) ?? {}
        return Response.json({
          ack: { outcome: 'accepted', messageId: envelope['messageId'] },
        })
      },
    })
    try {
      const peer = {
        nodeId: 'lab' as never,
        endpoint: peerServer.url.toString(),
        token: new PeerToken('test-token'),
      }
      const registryClient: BindingRegistryClient = {
        async consult() {
          return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
        },
        async establish() {
          throw new Error('origin must not establish receiver authority')
        },
      }
      const outbox = new FederationOriginOutbox({
        db,
        config: {
          nodeId: 'svc',
          nodeIdProvenance: 'declared',
          sourcePath: '/isolated/svc/federation.json',
          sourceExists: true,
          peers: new Map([['lab', peer]]),
          registry: { bind: 'http://svc.example.ts.net:18491/' },
          gate: { mode: 'enforce', registryHost: 'svc' },
          warnings: [],
        } as FederationConfig,
        localRegistryClient: registryClient,
        pollIntervalMs: 10,
      })
      const body: SemanticDmRequest = {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${SCOPE}/lane:main` },
        body: 'ping',
        createIfMissing: true,
      }
      const inserted = db.messages.insert({
        messageId: 'msg-remote-establish-outbox',
        kind: 'dm',
        phase: 'request',
        from: body.from,
        to: body.to,
        body: body.body,
      })
      const routed = await outbox.route(body, inserted, {
        outcome: 'remote-establish',
        scopeRef: SCOPE,
        candidateHomeNodeId: 'lab',
        policyProvenance: 'pin',
      })
      expect(routed.outcome).toBe('queued')
      if (routed.outcome !== 'queued') throw new Error('expected durable remote delivery')

      let delivery = db.federationOutbox.get(routed.delivery.deliveryId)
      for (let attempt = 0; attempt < 100 && delivery?.state !== 'delivered'; attempt += 1) {
        await Bun.sleep(5)
        delivery = db.federationOutbox.get(routed.delivery.deliveryId)
      }
      expect(delivery).toMatchObject({
        deliveryId: routed.delivery.deliveryId,
        messageId: inserted.messageId,
        stage: 'delivering',
        state: 'delivered',
        peerNodeId: 'lab',
        envelope: { expected: { homeNodeId: 'lab', placementEpoch: 1 } },
      })
      expect(db.federationOutbox.list()).toHaveLength(1)
      expect(wire.map((request) => request.path)).toEqual([
        '/v1/federation/health',
        '/v1/federation/establish',
        '/v1/federation/accept',
      ])
      expect(wire[1]?.body).toEqual({
        scopeRef: SCOPE,
        intent: 'implicit',
        correlationId: `establish-${routed.delivery.deliveryId}`,
      })
      expect(wire[2]?.body).toMatchObject({
        envelope: { expected: { homeNodeId: 'lab', placementEpoch: 1 } },
      })
    } finally {
      peerServer.stop(true)
    }
  })
})
