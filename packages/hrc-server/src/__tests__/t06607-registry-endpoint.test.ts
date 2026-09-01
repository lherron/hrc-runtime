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

describe('T-06607 authenticated home-only registry endpoint', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function harness() {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06607-endpoint-'))
    const registry = openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
    const handler = createBindingRegistryRequestHandler({
      registry,
      peers: new Map([
        ['lab', { nodeId: 'lab', token: new PeerToken(TOKEN) }],
        ['max3', { nodeId: 'max3', token: new PeerToken('max3-token') }],
      ]),
      now: () => '2026-07-20T00:00:00.000Z',
    })
    return { registry, handler }
  }

  function post(path: string, token: string, body: object): Request {
    return new Request(`http://registry${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('establishes and consults a home-only binding', async () => {
    const h = await harness()
    try {
      const established = await h.handler(
        post('/v1/federation/registry/establish', TOKEN, {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
        })
      )
      expect(established.status).toBe(200)
      const body = await established.json()
      expect(body).toMatchObject({
        ok: true,
        outcome: 'created',
        authenticatedNodeId: 'lab',
        binding: { scopeRef: SCOPE, homeNodeId: 'lab' },
      })
      expect(JSON.stringify(body)).not.toContain('placementEpoch')
      expect(JSON.stringify(body)).not.toContain('birthClass')
      expect(JSON.stringify(body)).not.toContain('authorityProvenance')
      expect(JSON.stringify(body)).not.toContain('placementSource')
      expect(JSON.stringify(body)).not.toContain('establishmentProvenance')

      const consulted = await h.handler(
        new Request(
          `http://registry/v1/federation/registry/consult?scopeRef=${encodeURIComponent(SCOPE)}`,
          { headers: { authorization: `Bearer ${TOKEN}` } }
        )
      )
      expect(consulted.status).toBe(200)
      expect(await consulted.json()).toMatchObject({
        outcome: 'bound',
        binding: { scopeRef: SCOPE, homeNodeId: 'lab' },
      })
    } finally {
      h.registry.close()
    }
  })

  test('authenticated node cannot establish or delete another home', async () => {
    const h = await harness()
    try {
      const wrongEstablish = await h.handler(
        post('/v1/federation/registry/establish', TOKEN, {
          scopeRef: SCOPE,
          homeNodeId: 'max3',
        })
      )
      expect(wrongEstablish.status).toBe(403)

      await h.handler(
        post('/v1/federation/registry/establish', TOKEN, {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
        })
      )
      const wrongDelete = await h.handler(
        post('/v1/federation/registry/delete', 'max3-token', {
          scopeRef: SCOPE,
          expectedHomeNodeId: 'lab',
          retiredAt: '2026-07-20T00:01:00.000Z',
        })
      )
      expect(wrongDelete.status).toBe(403)
      expect(h.registry.get(SCOPE)?.homeNodeId).toBe('lab')
    } finally {
      h.registry.close()
    }
  })

  test('conditionally deletes only the authenticated old-home binding', async () => {
    const h = await harness()
    try {
      await h.handler(
        post('/v1/federation/registry/establish', TOKEN, {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
        })
      )
      const deleted = await h.handler(
        post('/v1/federation/registry/delete', TOKEN, {
          scopeRef: SCOPE,
          expectedHomeNodeId: 'lab',
          retiredAt: '2026-07-20T00:01:00.000Z',
        })
      )
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toMatchObject({ outcome: 'deleted' })
      expect(h.registry.get(SCOPE)).toBeUndefined()

      const repeated = await h.handler(
        post('/v1/federation/registry/delete', TOKEN, {
          scopeRef: SCOPE,
          expectedHomeNodeId: 'lab',
          retiredAt: '2026-07-20T00:01:00.000Z',
        })
      )
      expect(await repeated.json()).toMatchObject({ outcome: 'idempotent' })
    } finally {
      h.registry.close()
    }
  })

  test('missing tokens and removed movement routes refuse without leaking secrets', async () => {
    const h = await harness()
    try {
      const unauthorized = await h.handler(
        new Request('http://registry/v1/federation/registry/consult')
      )
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.text()).not.toContain(TOKEN)

      for (const route of ['cas', 'retire', 'activate-retired']) {
        const response = await h.handler(post(`/v1/federation/registry/${route}`, TOKEN, {}))
        expect(response.status).toBe(404)
      }
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
