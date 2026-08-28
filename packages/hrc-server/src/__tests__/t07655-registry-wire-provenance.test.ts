import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from 'hrc-store-sqlite'
import type { BindingRegistry, EstablishmentProvenance } from 'hrc-store-sqlite'

import { createBindingRegistryRequestHandler } from '../federation/registry-endpoint.js'
import type { RegistryAuthPeer } from '../federation/registry-endpoint.js'

/**
 * T-07655 — the establishment vocabulary at the HTTP boundary.
 *
 * The registry has ONE host, so every other node establishes over the wire.
 * That makes `parseEstablishmentProvenance` a validator only remote nodes
 * cross — and every in-process test goes around it, which is exactly how two
 * new provenances shipped with the type, the SQL CHECK and the client set all
 * updated while the wire whitelist still rejected them.
 *
 * Live consequence on 2026-08-28T06:16:04Z: max3 resolved its own designated
 * birth, POSTed `default_home_node(sender)` to svc, and got a 400 back. The
 * daemon reported it as `registry-refused` with "Check this node's peer entry
 * and bearer token" — a credentials diagnostic for a vocabulary mismatch.
 *
 * The test drives the REAL handler with a REAL Request, so it fails if any
 * accepted provenance stops being spellable on the wire.
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

function establishRequest(provenance: string, scopeRef: string): Request {
  return new Request('http://registry.invalid/v1/federation/registry/establish', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      scopeRef,
      homeNodeId: 'max3',
      placementEpoch: 1,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: provenance },
      establishmentProvenance: provenance,
    }),
  })
}

describe('T-07655 establishment provenance crosses the wire', () => {
  test.each([
    ['pin'],
    ['task_default'],
    ['default_home_node'],
    ['default_home_node(local)'],
    ['default_home_node(sender)'],
    ['default_home_node(sender-retired)'],
    ['explicit_local'],
  ])('%s is accepted by the HTTP establish route', async (provenance) => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const scopeRef = `${SCOPE}-${provenance.replace(/[^a-z]/g, '')}`
      const response = await handler(establishRequest(provenance, scopeRef))

      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body['outcome']).toBe('created')
      expect(store.get(scopeRef)?.establishmentProvenance).toBe(
        provenance as EstablishmentProvenance
      )
    } finally {
      store.close()
    }
  })

  test('an unknown provenance is still refused', async () => {
    const store = await registry()
    try {
      const handler = createBindingRegistryRequestHandler({
        registry: store,
        peers: new Map([['max3', PEER]]),
      })
      const response = await handler(establishRequest('default_home_node(invented)', SCOPE))
      expect(response.status).toBe(400)
      expect(store.get(SCOPE)).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
