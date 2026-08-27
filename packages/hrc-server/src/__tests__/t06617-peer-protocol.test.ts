/**
 * T-06617 — narrow peer protocol listener, unit bar (federation spec §2/§6).
 *
 * The dedicated TCP listener is deliberately tested without HrcServer's Unix
 * socket router. Accidentally forwarding the main router here would expose the
 * full HRC API over TCP, which §2 explicitly forbids.
 */

import { describe, expect, test } from 'bun:test'

import { parseFederationConfigDocument } from '../federation/federation-config.js'
import {
  PEER_PROTOCOL_VERSION,
  PEER_PROTOCOL_VERSION_HEADER,
  createPeerProtocolRequestHandler,
  parsePeerProtocolBind,
} from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'

const CURRENT_TOKEN = 'svc-lab-current-token'
const NEXT_TOKEN = 'svc-lab-next-token'

function handler() {
  return createPeerProtocolRequestHandler({
    localNodeId: 'lab',
    peers: new Map([
      [
        'svc',
        {
          nodeId: 'svc',
          endpoint: 'http://svc.example.ts.net:18490',
          token: new PeerToken(CURRENT_TOKEN),
          acceptedTokens: [new PeerToken(CURRENT_TOKEN), new PeerToken(NEXT_TOKEN)],
        },
      ],
    ]),
    locate: async (scopeRef) => ({
      scopeRef,
      localNodeId: 'lab',
      authority: {
        state: 'bound',
        record: { homeNodeId: 'lab', placementEpoch: 7 },
      },
      observed: { nodeId: 'lab', runtimeCount: 1 },
      birthChain: { state: 'not-applicable' },
    }),
    health: () => ({
      startedAt: '2026-07-20T00:00:00.000Z',
      capabilities: { locate: true, health: true },
    }),
  })
}

function request(
  path: string,
  options: {
    token?: string | undefined
    version?: string | undefined
    method?: string | undefined
    body?: unknown
  } = {}
): Request {
  const headers = new Headers()
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`)
  if (options.version !== undefined) {
    headers.set(PEER_PROTOCOL_VERSION_HEADER, options.version)
  }
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return new Request(`http://lab.example.ts.net:18490${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

describe('T-06617 peer protocol authentication and versioning', () => {
  test('missing and wrong bearer tokens are generic 401s with no token reflection', async () => {
    const serve = handler()
    for (const token of [undefined, 'wrong-secret']) {
      const response = await serve(
        request('/v1/federation/health', { token, version: PEER_PROTOCOL_VERSION })
      )
      expect(response.status).toBe(401)
      const text = await response.text()
      expect(text).toContain('unauthorized')
      expect(text).not.toContain(CURRENT_TOKEN)
      expect(text).not.toContain(NEXT_TOKEN)
      expect(text).not.toContain('wrong-secret')
    }
  })

  test('rotation overlap accepts both configured inbound tokens', async () => {
    const serve = handler()
    for (const token of [CURRENT_TOKEN, NEXT_TOKEN]) {
      const response = await serve(
        request('/v1/federation/health', { token, version: PEER_PROTOCOL_VERSION })
      )
      expect(response.status).toBe(200)
    }
  })

  test('config keeps outbound and inbound-overlap tokens opaque and distinct', () => {
    const config = parseFederationConfigDocument(
      {
        nodeId: 'lab',
        peers: {
          svc: {
            endpoint: 'http://svc.example.ts.net:18490',
            token: CURRENT_TOKEN,
            acceptedTokens: [CURRENT_TOKEN, NEXT_TOKEN],
          },
        },
      },
      '/isolated/federation.json'
    )
    const peer = config.peers.get('svc' as never)
    expect(peer?.token.matches(CURRENT_TOKEN)).toBe(true)
    expect(peer?.acceptedTokens?.map((token) => token.matches(NEXT_TOKEN))).toEqual([false, true])
    expect(JSON.stringify(config)).not.toContain(CURRENT_TOKEN)
    expect(JSON.stringify(config)).not.toContain(NEXT_TOKEN)
  })

  test('missing, malformed, and incompatible-major versions are visible typed refusals', async () => {
    const serve = handler()
    const missing = await serve(request('/v1/federation/health', { token: CURRENT_TOKEN }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({
      ok: false,
      error: { code: 'protocol_version_required' },
    })

    const malformed = await serve(
      request('/v1/federation/health', { token: CURRENT_TOKEN, version: 'banana' })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_protocol_version' },
    })

    const incompatible = await serve(
      request('/v1/federation/health', { token: CURRENT_TOKEN, version: '2.4' })
    )
    expect(incompatible.status).toBe(426)
    expect(await incompatible.json()).toMatchObject({
      ok: false,
      protocolVersion: PEER_PROTOCOL_VERSION,
      error: { code: 'incompatible_protocol_major', supportedMajor: 1, receivedMajor: 2 },
    })
  })
})

describe('T-06617 narrow peer routes', () => {
  test('health reports node liveness/capabilities on demand', async () => {
    const response = await handler()(
      request('/v1/federation/health', {
        token: CURRENT_TOKEN,
        version: PEER_PROTOCOL_VERSION,
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      protocolVersion: PEER_PROTOCOL_VERSION,
      nodeId: 'lab',
      startedAt: '2026-07-20T00:00:00.000Z',
      capabilities: { locate: true, health: true },
    })
  })

  test('locate is a tolerant reader and returns binding, observation, and provenance', async () => {
    const response = await handler()(
      request('/v1/federation/locate', {
        method: 'POST',
        token: CURRENT_TOKEN,
        version: '1.99',
        body: { scopeRef: 'agent:cody:project:hrc-runtime:task:T-06617', futureField: true },
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      protocolVersion: PEER_PROTOCOL_VERSION,
      location: {
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-06617',
        authority: { record: { homeNodeId: 'lab', placementEpoch: 7 } },
        observed: { nodeId: 'lab', runtimeCount: 1 },
        birthChain: { state: 'not-applicable' },
      },
    })
  })

  test('the federation MESSAGE route is gone, not merely disabled (T-07616)', async () => {
    // Flag day: agent talk is the shared wrkq ledger, so the peer protocol has
    // no accept verb at all. A peer still on the old build sees the
    // unmatched-path 404, which its outbox treats as terminal rather than
    // retrying a route that will never come back.
    const response = await handler()(
      request('/v1/federation/accept', {
        method: 'POST',
        token: CURRENT_TOKEN,
        version: PEER_PROTOCOL_VERSION,
        body: { envelope: { messageId: 'msg-any' } },
      })
    )
    expect(response.status).toBe(404)
  })

  test('establish has a schema-exact authority-only request and exact binding response', async () => {
    const established: unknown[] = []
    const serve = createPeerProtocolRequestHandler({
      localNodeId: 'lab',
      peers: new Map([
        [
          'svc',
          {
            nodeId: 'svc',
            endpoint: 'http://svc.example.ts.net:18490',
            token: new PeerToken(CURRENT_TOKEN),
          },
        ],
      ]),
      locate: async () => ({}),
      health: () => ({
        startedAt: '2026-07-20T00:00:00.000Z',
        capabilities: { establish: true, locate: true, health: true },
      }),
      establish: async (input) => {
        established.push(input)
        return {
          outcome: 'established',
          correlationId: input.correlationId,
          binding: {
            scopeRef: input.scopeRef,
            homeNodeId: 'lab',
            placementEpoch: 1,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'pin',
            createdAt: '2026-07-22T20:00:00.000Z',
            updatedAt: '2026-07-22T20:00:00.000Z',
          },
        }
      },
    })
    const body = {
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-06805',
      intent: 'implicit',
      correlationId: 'establish-msg-1',
    }
    const response = await serve(
      request('/v1/federation/establish', {
        token: CURRENT_TOKEN,
        version: '1.7',
        body,
      })
    )
    expect(response.status).toBe(200)
    expect(established).toEqual([{ authenticatedNodeId: 'svc', protocolVersion: '1.7', ...body }])
    expect(await response.json()).toEqual({
      ok: true,
      protocolVersion: PEER_PROTOCOL_VERSION,
      correlationId: 'establish-msg-1',
      outcome: 'established',
      binding: {
        scopeRef: body.scopeRef,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        createdAt: '2026-07-22T20:00:00.000Z',
        updatedAt: '2026-07-22T20:00:00.000Z',
      },
    })

    const oversized = await serve(
      request('/v1/federation/establish', {
        token: CURRENT_TOKEN,
        version: PEER_PROTOCOL_VERSION,
        body: { ...body, homeNodeId: 'lab' },
      })
    )
    expect(oversized.status).toBe(400)
    expect(established).toHaveLength(1)
  })

  test('roster-start is authenticated, schema-exact, and returns the home-local claim', async () => {
    const received: unknown[] = []
    const serve = createPeerProtocolRequestHandler({
      localNodeId: 'lab',
      peers: new Map([
        [
          'svc',
          {
            nodeId: 'svc',
            endpoint: 'http://svc.example.ts.net:18490',
            token: new PeerToken(CURRENT_TOKEN),
          },
        ],
      ]),
      locate: async () => ({}),
      health: () => ({
        startedAt: '2026-07-20T00:00:00.000Z',
        capabilities: { rosterStart: true, locate: true, health: true },
      }),
      rosterStart: async (input) => {
        received.push(input)
        return {
          runtimeId: 'rt-roster',
          hostSessionId: 'hsid-roster',
          transport: 'headless',
          status: 'ready',
          supportsInFlightInput: true,
          claim: {
            slot: 'minilab-nova',
            scopeRef: 'agent:mable:project:hrc-runtime:task:minilab-nova',
            sessionRef: 'agent:mable:project:hrc-runtime:task:minilab-nova/lane:main',
            hostSessionId: 'hsid-roster',
            idempotencyKey: 'mobile-1',
            replayed: false,
          },
        }
      },
    })
    const body = {
      baseSessionRef: 'agent:mable:project:hrc-runtime:task:minilab/lane:main',
      runtimeIntent: { placement: 'workspace' },
      conflictPolicy: 'suffix',
      idempotencyKey: 'mobile-1',
      summonIntent: 'implicit',
    }
    const response = await serve(
      request('/v1/federation/roster-start', {
        token: CURRENT_TOKEN,
        version: '1.9',
        body,
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      runtimeId: 'rt-roster',
      claim: { slot: 'minilab-nova', idempotencyKey: 'mobile-1' },
    })
    expect(received).toEqual([{ authenticatedNodeId: 'svc', protocolVersion: '1.9', body }])

    const oversized = await serve(
      request('/v1/federation/roster-start', {
        token: CURRENT_TOKEN,
        version: PEER_PROTOCOL_VERSION,
        body: { ...body, homeNodeId: 'lab' },
      })
    )
    expect(oversized.status).toBe(400)
    expect(received).toHaveLength(1)
  })

  test('the TCP handler exposes only the narrow federation verbs', async () => {
    const serve = handler()
    for (const path of ['/v1/status', '/v1/events', '/v1/federation/bindings', '/']) {
      const response = await serve(
        request(path, { token: CURRENT_TOKEN, version: PEER_PROTOCOL_VERSION })
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    }
    const history = await serve(
      request('/v1/federation/history/query', {
        token: CURRENT_TOKEN,
        version: PEER_PROTOCOL_VERSION,
        body: { filter: {} },
      })
    )
    expect(history.status).toBe(404)
    expect(await history.json()).toMatchObject({
      ok: false,
      error: { code: 'collective_history_not_authoritative', retryable: true },
    })
    const checkpoint = await serve(
      request('/v1/federation/history/checkpoint', {
        token: CURRENT_TOKEN,
        version: PEER_PROTOCOL_VERSION,
        body: { checkpoint: { maxMessageSeq: 0, pendingReplicationCount: 0 } },
      })
    )
    expect(checkpoint.status).toBe(404)
    expect(await checkpoint.json()).toMatchObject({
      ok: false,
      error: { code: 'collective_history_not_authoritative', retryable: true },
    })
  })

  test('wildcard, loopback, and non-tailnet binds are rejected before startup', () => {
    for (const bind of [
      'http://0.0.0.0:18490',
      'http://[::]:18490',
      'http://127.0.0.1:18490',
      'http://192.168.1.5:18490',
    ]) {
      expect(() => parsePeerProtocolBind(bind, 'federation.json peerListener')).toThrow(
        /specific tailnet host/
      )
    }
    expect(
      parsePeerProtocolBind('http://100.73.60.81:18490', 'federation.json peerListener')
    ).toEqual({ bind: 'http://100.73.60.81:18490/' })
  })
})
