import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from 'hrc-store-sqlite'
import type { BindingRegistry } from 'hrc-store-sqlite'

import { createBindingRegistryRequestHandler } from '../federation/registry-endpoint.js'
import type { RegistryAuthPeer } from '../federation/registry-endpoint.js'

/**
 * T-07655 — the birth-designation decision at the HTTP boundary.
 *
 * Ordinary establishment has no provenance field. Only the distinct,
 * transient decision needed to arbitrate a live birth designation may cross
 * this boundary, and neither form becomes part of the binding DTO.
 */

const SCOPE = 'agent:sparky:project:hrc-runtime:task:T-07655-wire'
const PEER: RegistryAuthPeer = {
  nodeId: 'max3',
  token: { matches: (candidate: string) => candidate === 'secret' },
}

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function registry(): Promise<BindingRegistry> {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-t07655-wire-'))
  return openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
}

function establishRequest(scopeRef: string, extra: Record<string, unknown> = {}): Request {
  return new Request('http://registry.invalid/v1/federation/registry/establish', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ scopeRef, homeNodeId: 'max3', ...extra }),
  })
}

describe('T-07655 birth-designation decision crosses the wire', () => {
  test('ordinary establishment has no provenance in its request, response, or stored binding', async () => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const response = await handler(establishRequest(SCOPE))

      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body['outcome']).toBe('created')
      expect(store.get(SCOPE)).toEqual({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      })
      for (const value of [body, store.get(SCOPE)]) {
        const encoded = JSON.stringify(value)
        expect(encoded).not.toContain('placementSource')
        expect(encoded).not.toContain('establishmentProvenance')
        expect(encoded).not.toContain('birthDesignation')
      }
    } finally {
      store.close()
    }
  })

  test.each(['placementSource', 'establishmentProvenance'])(
    'refuses the obsolete generic %s field',
    async (field) => {
      const store = await registry()
      try {
        const handler = createBindingRegistryRequestHandler({
          registry: store,
          peers: new Map([['max3', PEER]]),
        })
        const response = await handler(establishRequest(SCOPE, { [field]: 'pin' }))

        expect(response.status).toBe(400)
        expect(store.get(SCOPE)).toBeUndefined()
      } finally {
        store.close()
      }
    }
  )

  test('a designation fence is accepted without entering the binding DTO', async () => {
    const store = await registry()
    try {
      store.recordDesignation({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        provenance: 'default_home_node(sender)',
        birthEnvelopeId: 'EN-00722',
        senderScopeRef: 'agent:mable:project:wrkq:task:primary',
        now: '2026-08-28T05:00:00.000Z',
      })
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const response = await handler(
        establishRequest(SCOPE, {
          birthDesignation: { action: 'enforce-designated-home' },
        })
      )

      expect(response.status).toBe(200)
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        outcome: 'created',
      })
      expect(JSON.stringify(store.get(SCOPE))).not.toContain('birthDesignation')
      expect(store.liveDesignation(SCOPE)?.state).toBe('live')
    } finally {
      store.close()
    }
  })

  test('an explicit supersession decision records only the designation disposition', async () => {
    const store = await registry()
    try {
      store.recordDesignation({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        provenance: 'default_home_node(sender)',
        birthEnvelopeId: 'EN-00722',
        senderScopeRef: 'agent:mable:project:wrkq:task:primary',
        now: '2026-08-28T05:00:00.000Z',
      })
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const response = await handler(
        establishRequest(SCOPE, {
          birthDesignation: { action: 'supersede', supersededBy: 'pin' },
        })
      )

      expect(response.status).toBe(200)
      expect(store.get(SCOPE)?.homeNodeId).toBe('max3')
      expect(store.latestDesignation(SCOPE)).toMatchObject({
        state: 'superseded',
        supersededBy: 'pin',
      })
    } finally {
      store.close()
    }
  })

  test.each([
    { action: 'invented' },
    { action: 'supersede', supersededBy: 'default_home_node(sender)' },
  ])('refuses an invalid designation decision %#', async (birthDesignation) => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const response = await handler(establishRequest(SCOPE, { birthDesignation }))

      expect(response.status).toBe(400)
      expect(store.get(SCOPE)).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
