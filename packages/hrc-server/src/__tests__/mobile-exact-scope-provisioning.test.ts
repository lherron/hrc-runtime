/**
 * T-07302 — the federated half of exact-scope provisioning.
 *
 * Three seams, each of which has to hold on its own:
 *
 *  - ORIGIN resolution: HRC decides where an exact scope lives from policy and
 *    registry state, from a request that asserts no node.
 *  - RECEIVER authority: the home re-derives everything for itself and refuses
 *    a wrong-home or undeclared scope before any mutation — and, unlike the
 *    suffix family, does NOT demand a pre-declared eleven-member task-default
 *    block just to honour an arbitrary custom name.
 *  - WIRE: `exactStart` is its own capability behind its own route, so a peer
 *    that predates it fails closed instead of having `rosterStart` reused with
 *    different occupancy semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ExactStartRuntimeRequest } from 'hrc-core'

import { sendRemoteExactStart } from '../federation/exact-start-client.js'
import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import {
  PEER_PROTOCOL_VERSION,
  PEER_PROTOCOL_VERSION_HEADER,
  createPeerProtocolRequestHandler,
} from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { preflightExactScope, resolveImplicitScopeHome } from '../federation/summon-gate-server.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const EXACT_SCOPE = 'agent:cody:project:hrc-runtime:task:hrcdev'
const CUSTOM_SCOPE = 'agent:cody:project:hrc-runtime:task:my-own-name'
const CAPABILITY_HINT = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task' as const,
    bundle: { kind: 'compose' as const, compose: [] },
    dryRun: false,
  },
  harness: { provider: 'anthropic' as const, id: 'claude-code' as const, interactive: true },
}

function registryUnbound(): BindingRegistryClient {
  return {
    async consult() {
      return { outcome: 'unbound' }
    },
    async establish(request) {
      return {
        outcome: 'created',
        binding: { ...request, placementEpoch: 1, updatedAt: request.now },
      }
    },
  }
}

describe('T-07302 exact-scope placement preflight', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-mobile-exact-')
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function serverWithPlacement(placement: {
    node?: string
    pins?: Record<string, string>
    homes?: Record<string, string>
  }) {
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'hrcdev', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    const server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      registryClient: registryUnbound(),
      policyFor: async () => ({
        provisioning: { node: placement.node ?? 'max3' },
        placement: {
          pins: placement.pins ?? {},
          homes: placement.homes ?? {},
        },
        claimsTask: false,
      }),
      capabilityFor: async () => ({ outcome: 'capable' as const }),
    })
    return server
  }

  test('a pinned exact scope preflights on its home without minting anything', async () => {
    const server = await serverWithPlacement({ pins: { 'hrc-runtime:hrcdev': 'hrcdev' } })
    try {
      await preflightExactScope(server, {
        scopeRef: EXACT_SCOPE,
        capabilityHint: CAPABILITY_HINT,
        origin: 'federated-ingress',
      })
      expect(server.db.sessions.count()).toBe(0)
      expect(server.db.rosterClaims.listByBaseScope(EXACT_SCOPE)).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test('an arbitrary custom name needs no task-default family, only a declared default', async () => {
    const server = await serverWithPlacement({ node: 'hrcdev' })
    try {
      await preflightExactScope(server, {
        scopeRef: CUSTOM_SCOPE,
        capabilityHint: CAPABILITY_HINT,
        origin: 'local',
      })
      expect(server.db.sessions.count()).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('the receiver refuses a scope that names another home, before mutation', async () => {
    const server = await serverWithPlacement({ pins: { 'hrc-runtime:hrcdev': 'lab' } })
    try {
      await expect(
        preflightExactScope(server, {
          scopeRef: EXACT_SCOPE,
          capabilityHint: CAPABILITY_HINT,
          origin: 'federated-ingress',
        })
      ).rejects.toMatchObject({ code: 'stale_context' })
      expect(server.db.sessions.count()).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('the receiver refuses an undeclared implicit scope rather than falling back', async () => {
    const server = await serverWithPlacement({ node: 'max3' })
    try {
      await expect(
        preflightExactScope(server, {
          scopeRef: CUSTOM_SCOPE,
          capabilityHint: CAPABILITY_HINT,
          origin: 'federated-ingress',
        })
      ).rejects.toMatchObject({ code: 'stale_context' })
      expect(server.db.sessions.count()).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('the origin resolves a remote exact pin without asserting a destination', async () => {
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'max3', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    const server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      registryClient: registryUnbound(),
      policyFor: async () => ({
        provisioning: { node: 'max3' },
        placement: {
          pins: { 'hrc-runtime:hrcdev': 'hrcdev' },
          homes: {},
        },
        claimsTask: false,
      }),
      capabilityFor: async () => ({ outcome: 'capable' as const }),
    })
    try {
      expect(
        await resolveImplicitScopeHome(server, {
          scopeRef: EXACT_SCOPE,
          capabilityHint: CAPABILITY_HINT,
        })
      ).toBe('hrcdev')
      // A custom name with no pin rides the declared default — which is this node.
      expect(
        await resolveImplicitScopeHome(server, {
          scopeRef: CUSTOM_SCOPE,
          capabilityHint: CAPABILITY_HINT,
        })
      ).toBe('max3')
      expect(server.db.sessions.count()).toBe(0)
    } finally {
      await server.stop()
    }
  })
})

describe('T-07302 exact-scope peer client', () => {
  const peer = {
    nodeId: 'hrcdev' as never,
    endpoint: 'http://hrcdev.example.ts.net:18490',
    token: new PeerToken('outbound-token'),
  }
  const request: ExactStartRuntimeRequest = {
    sessionRef: `${EXACT_SCOPE}/lane:main`,
    runtimeIntent: {
      placement: CAPABILITY_HINT.placement,
      harness: CAPABILITY_HINT.harness,
      execution: { preferredMode: 'headless' },
      presentation: {},
    } as ExactStartRuntimeRequest['runtimeIntent'],
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: 'mobile-exact-1',
  }

  test('capability-gates the authenticated verb and preserves the claim response', async () => {
    const calls: string[] = []
    const result = await sendRemoteExactStart({
      peer,
      request,
      fetch: async (input, init) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/v1/federation/health')) {
          return Response.json({ capabilities: { rosterStart: true, exactStart: true } })
        }
        expect(JSON.parse(String(init?.body))).toMatchObject({
          sessionRef: `${EXACT_SCOPE}/lane:main`,
          conflictPolicy: 'reject',
          summonIntent: 'implicit',
          idempotencyKey: 'mobile-exact-1',
        })
        return Response.json({
          runtimeId: 'rt-1',
          hostSessionId: 'hsid-1',
          transport: 'headless',
          status: 'ready',
          supportsInFlightInput: true,
          claim: {
            slot: 'hrcdev',
            scopeRef: EXACT_SCOPE,
            sessionRef: `${EXACT_SCOPE}/lane:main`,
            hostSessionId: 'hsid-1',
            idempotencyKey: 'mobile-exact-1',
            replayed: false,
            conflictPolicy: 'reject',
          },
        })
      },
    })
    expect(calls).toEqual([
      'http://hrcdev.example.ts.net:18490/v1/federation/health',
      'http://hrcdev.example.ts.net:18490/v1/federation/exact-start',
    ])
    expect(result.claim).toMatchObject({
      slot: 'hrcdev',
      scopeRef: EXACT_SCOPE,
      conflictPolicy: 'reject',
      replayed: false,
    })
  })

  test('a peer advertising only rosterStart fails closed as stale_context', async () => {
    await expect(
      sendRemoteExactStart({
        peer,
        request,
        fetch: async () => Response.json({ capabilities: { rosterStart: true } }),
      })
    ).rejects.toMatchObject({
      code: 'stale_context',
      detail: { reason: 'peer_upgrade_required', retryable: false },
    })
  })

  test('a typed home refusal is relayed verbatim, not softened into unavailable', async () => {
    await expect(
      sendRemoteExactStart({
        peer,
        request,
        fetch: async (input) => {
          if (String(input).endsWith('/v1/federation/health')) {
            return Response.json({ capabilities: { exactStart: true } })
          }
          return Response.json(
            {
              ok: false,
              error: {
                code: 'session_scope_occupied',
                message: 'the exact scope is occupied by a live session',
                detail: { scopeRef: EXACT_SCOPE, retryable: false },
              },
            },
            { status: 409 }
          )
        },
      })
    ).rejects.toMatchObject({
      code: 'session_scope_occupied',
      detail: { scopeRef: EXACT_SCOPE, retryable: false },
    })
  })

  test('peer unreachability is a typed retryable runtime_unavailable, never an outbox', async () => {
    await expect(
      sendRemoteExactStart({
        peer,
        request,
        fetch: async () => {
          throw new Error('peer asleep')
        },
      })
    ).rejects.toMatchObject({
      code: 'runtime_unavailable',
      detail: { homeNodeId: 'hrcdev', retryable: true },
    })
  })
})

describe('T-07302 exact-start peer route', () => {
  const TOKEN = 'svc-hrcdev-token'

  function serve(options: { exactStart?: boolean } = {}) {
    return createPeerProtocolRequestHandler({
      localNodeId: 'hrcdev',
      peers: new Map([
        [
          'svc',
          {
            nodeId: 'svc',
            endpoint: 'http://svc.example.ts.net:18490',
            token: new PeerToken(TOKEN),
            acceptedTokens: [new PeerToken(TOKEN)],
          },
        ],
      ]),
      locate: async () => ({}),
      health: () => ({
        startedAt: '2026-08-18T00:00:00.000Z',
        capabilities: { accept: false, locate: true, health: true },
      }),
      ...(options.exactStart === false
        ? {}
        : {
            exactStart: async ({ body, authenticatedNodeId }) => ({
              runtimeId: 'rt-1',
              hostSessionId: 'hsid-1',
              transport: 'headless' as const,
              status: `ready:${authenticatedNodeId}`,
              supportsInFlightInput: true,
              claim: {
                slot: 'hrcdev',
                scopeRef: EXACT_SCOPE,
                sessionRef: String(body['sessionRef']),
                hostSessionId: 'hsid-1',
                idempotencyKey: String(body['idempotencyKey']),
                replayed: false,
                conflictPolicy: 'reject' as const,
              },
            }),
          }),
    })
  }

  function request(body: unknown): Request {
    const headers = new Headers({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      [PEER_PROTOCOL_VERSION_HEADER]: PEER_PROTOCOL_VERSION,
    })
    return new Request('http://hrcdev.example.ts.net:18490/v1/federation/exact-start', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  }

  const exactBody = {
    sessionRef: `${EXACT_SCOPE}/lane:main`,
    runtimeIntent: { placement: 'workspace' },
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: 'wire-1',
  }

  test('passes the authenticated peer and canonical body to the home handler', async () => {
    const response = await serve()(request(exactBody))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ready:svc',
      claim: { scopeRef: EXACT_SCOPE, idempotencyKey: 'wire-1', conflictPolicy: 'reject' },
    })
  })

  test('a base-shaped field on the exact route is a refusal, never a coercion', async () => {
    const response = await serve()(
      request({ ...exactBody, baseSessionRef: `${EXACT_SCOPE}/lane:main` })
    )
    expect(response.status).toBe(400)
  })

  test('a peer without the exactStart handler 404s as peer_upgrade_required', async () => {
    const response = await serve({ exactStart: false })(request(exactBody))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'peer_upgrade_required', retryable: false },
    })
  })
})
