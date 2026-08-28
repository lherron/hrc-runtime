import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from 'hrc-store-sqlite'
import type { BindingRegistry } from 'hrc-store-sqlite'

import type { PeerEntry } from '../federation/federation-config.js'
import { PeerToken } from '../federation/peer-token.js'
import { HttpBindingRegistryClient } from '../federation/registry-client.js'
import type { RegistryClientFetch } from '../federation/registry-client.js'
import { createBindingRegistryRequestHandler } from '../federation/registry-endpoint.js'
import type { RegistryAuthPeer } from '../federation/registry-endpoint.js'

/**
 * T-07661 — the unborn-designation read across the HTTP boundary.
 *
 * The registry has ONE host, so every node but that one asks this over the
 * wire. Two properties are the whole reason the route exists in this shape:
 *
 *  - A NODE ASKS ONLY ABOUT ITSELF. The answer is scoped to the authenticated
 *    caller, so it can never become a second, weaker way to hand a birth to a
 *    node the collective did not designate. That is the T-07650 invariant this
 *    change is required to leave intact.
 *  - A HOST THAT PREDATES IT SERVES NOTHING, and nothing is exactly what "no
 *    virgin births owed" means. A 404 read as unreachable would put a WARN on
 *    every sweep of every upgraded node for the length of a rollout window —
 *    the failure mode T-07655's own 404 fallback was written for, one route
 *    later.
 */

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-07661-wire'
const TOKEN = 'unborn-designation-secret'
const PEER: RegistryAuthPeer = {
  nodeId: 'max3',
  token: { matches: (candidate: string) => candidate === TOKEN },
}

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function registry(): Promise<BindingRegistry> {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-t07661-wire-'))
  const store = openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
  store.recordDesignation({
    scopeRef: SCOPE,
    homeNodeId: 'max3',
    provenance: 'default_home_node(sender)',
    birthEnvelopeId: 'EN-00745',
    senderScopeRef: 'agent:mable:project:wrkq:task:primary',
    now: '2026-08-28T07:00:00.000Z',
  })
  return store
}

function get(homeNodeId: string, token = TOKEN): Request {
  const url = new URL('http://registry.invalid/v1/federation/registry/unborn-designations')
  url.searchParams.set('homeNodeId', homeNodeId)
  return new Request(url.toString(), { headers: { authorization: `Bearer ${token}` } })
}

function peer(): PeerEntry {
  return {
    nodeId: 'svc' as PeerEntry['nodeId'],
    endpoint: 'http://svc.example.ts.net:18491',
    token: new PeerToken(TOKEN),
  }
}

function client(fetchImpl: RegistryClientFetch): HttpBindingRegistryClient {
  return new HttpBindingRegistryClient(peer(), { fetch: fetchImpl })
}

describe('T-07661 — the unborn-designation route', () => {
  test('answers the authenticated node with the births it owes', async () => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const response = await handler(get('max3'))
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        designations: { scopeRef: string; homeNodeId: string }[]
      }
      expect(body.designations.map((row) => row.scopeRef)).toEqual([SCOPE])
      expect(body.designations[0]?.homeNodeId).toBe('max3')
    } finally {
      store.close()
    }
  })

  test('refuses a node asking about somebody else', async () => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      // lab's virgin births are lab's to take. Answering max3 here would make
      // this route a way to learn of — and act on — a birth designated
      // elsewhere, which is the multi-node race T-07655 removed.
      const response = await handler(get('lab'))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'authenticated_node_mismatch' })
    } finally {
      store.close()
    }
  })

  test('an unauthenticated caller learns nothing', async () => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      expect((await handler(get('max3', 'wrong'))).status).toBe(401)
    } finally {
      store.close()
    }
  })

  test('a host that predates the route owes this node nothing', async () => {
    const registryClient = client(async () => new Response('not found', { status: 404 }))
    expect(await registryClient.listUnbornDesignations('max3')).toEqual([])
  })

  test('a malformed answer is unreachable, never an empty list', async () => {
    // Silently reading garbage as "no births owed" would turn a broken host
    // into a permanent, invisible delivery gap — which is the class of bug
    // this whole task closes.
    const registryClient = client(async () => Response.json({ ok: true, designations: 'nope' }))
    await expect(registryClient.listUnbornDesignations('max3')).rejects.toThrow(
      /invalid unborn-designation list/
    )
  })
})
