import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from 'hrc-store-sqlite'

import { PeerToken } from '../federation/peer-token.js'
import {
  createBindingRegistryRequestHandler,
  resolveBindingRegistryPath,
} from '../federation/registry-endpoint.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06607'
const TOKEN = 'super-secret-lab-token'

describe('T-06607 authenticated registry endpoint', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function harness() {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06607-endpoint-'))
    const registry = openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
    let clock = 0
    const handler = createBindingRegistryRequestHandler({
      registry,
      peers: new Map([
        ['lab', { nodeId: 'lab', token: new PeerToken(TOKEN) }],
        ['max3', { nodeId: 'max3', token: new PeerToken('max3-token') }],
        ['svc', { nodeId: 'svc', token: new PeerToken('svc-token') }],
      ]),
      now: () => `2026-07-20T00:00:0${clock++}.000Z`,
    })
    return { registry, handler }
  }

  function establishRequest(token: string | null = TOKEN, homeNodeId = 'lab'): Request {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    return new Request('http://registry/v1/federation/registry/establish', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scopeRef: SCOPE,
        homeNodeId,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
      }),
    })
  }

  test('valid token establishes with 200 and consults the binding', async () => {
    const h = await harness()
    try {
      const established = await h.handler(establishRequest())
      expect(established.status).toBe(200)
      expect(await established.json()).toMatchObject({
        ok: true,
        outcome: 'created',
        authenticatedNodeId: 'lab',
        binding: { scopeRef: SCOPE, homeNodeId: 'lab', placementEpoch: 1 },
      })

      const consulted = await h.handler(
        new Request(
          `http://registry/v1/federation/registry/consult?scopeRef=${encodeURIComponent(SCOPE)}`,
          { headers: { authorization: `Bearer ${TOKEN}` } }
        )
      )
      expect(consulted.status).toBe(200)
      expect(await consulted.json()).toMatchObject({
        ok: true,
        authenticatedNodeId: 'lab',
        binding: { scopeRef: SCOPE, homeNodeId: 'lab' },
      })
    } finally {
      h.registry.close()
    }
  })

  test('missing and unknown tokens return 401 without token material', async () => {
    const h = await harness()
    try {
      for (const request of [establishRequest(null), establishRequest('wrong-secret')]) {
        const response = await h.handler(request)
        expect(response.status).toBe(401)
        const body = await response.text()
        expect(body).not.toContain(TOKEN)
        expect(body).not.toContain('wrong-secret')
      }
    } finally {
      h.registry.close()
    }
  })

  test('authenticated node cannot establish or CAS authority for another node', async () => {
    const h = await harness()
    try {
      const wrongEstablish = await h.handler(establishRequest(TOKEN, 'max3'))
      expect(wrongEstablish.status).toBe(403)
      expect(h.registry.get(SCOPE)).toBeUndefined()

      await h.handler(establishRequest())
      const wrongCas = await h.handler(
        new Request('http://registry/v1/federation/registry/cas', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            scopeRef: SCOPE,
            expectedHomeNodeId: 'lab',
            expectedPlacementEpoch: 1,
            newHomeNodeId: 'max3',
          }),
        })
      )
      expect(wrongCas.status).toBe(403)
      expect(h.registry.get(SCOPE)?.placementEpoch).toBe(1)
    } finally {
      h.registry.close()
    }
  })

  test('CAS succeeds for the authenticated new node and stale tuples return 409', async () => {
    const h = await harness()
    try {
      await h.handler(establishRequest())
      const casBody = {
        scopeRef: SCOPE,
        expectedHomeNodeId: 'lab',
        expectedPlacementEpoch: 1,
        newHomeNodeId: 'max3',
      }
      const moved = await h.handler(
        new Request('http://registry/v1/federation/registry/cas', {
          method: 'POST',
          headers: {
            authorization: 'Bearer max3-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(casBody),
        })
      )
      expect(moved.status).toBe(200)
      expect(await moved.json()).toMatchObject({
        ok: true,
        outcome: 'updated',
        binding: { homeNodeId: 'max3', placementEpoch: 2 },
      })

      const stale = await h.handler(
        new Request('http://registry/v1/federation/registry/cas', {
          method: 'POST',
          headers: {
            authorization: 'Bearer svc-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...casBody, newHomeNodeId: 'svc' }),
        })
      )
      expect(stale.status).toBe(409)
      expect((await stale.json()).binding.placementEpoch).toBe(2)
    } finally {
      h.registry.close()
    }
  })

  test('malformed requests and error paths never reflect bearer material', async () => {
    const h = await harness()
    try {
      const response = await h.handler(
        new Request('http://registry/v1/federation/registry/establish', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: `{ "scopeRef": "${TOKEN}", broken`,
        })
      )
      expect(response.status).toBe(400)
      const body = await response.text()
      expect(body).not.toContain(TOKEN)
      expect(JSON.stringify({ peers: h.handler })).not.toContain(TOKEN)
    } finally {
      h.registry.close()
    }
  })

  test('registry database default is the backed-up federation sibling of HRC state', () => {
    expect(resolveBindingRegistryPath('/praesidium/var/state/hrc')).toBe(
      '/praesidium/var/state/federation/binding-registry.sqlite'
    )
  })
})
