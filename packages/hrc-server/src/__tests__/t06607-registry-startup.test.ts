import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import { openBindingRegistry } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { resolveBindingRegistryPath } from '../federation/registry-endpoint.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06607'
const TOKEN = 'isolated-registry-token'

function localTailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

describe('T-06607 isolated daemon registry lifecycle', () => {
  let fixture: HrcServerTestFixture | undefined

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  test('absent registry config leaves the listener and registry database dark', async () => {
    fixture = await createHrcTestFixture('hrc-t06607-dark-')
    const registryPath = resolveBindingRegistryPath(fixture.stateRoot)
    const server = await createHrcServer(fixture.serverOpts())
    try {
      expect(server.federationRegistryEndpoint).toBeUndefined()
      expect(existsSync(registryPath)).toBe(false)
    } finally {
      await server.stop()
    }
  })

  const tailnetIpv4 = localTailnetIpv4()
  const liveTailnetTest = selectLiveTailnetTest(import.meta.path, tailnetIpv4)
  liveTailnetTest(
    'serves authenticated registry writes on the configured tailnet bind',
    async () => {
      if (tailnetIpv4 === undefined) throw new Error('tailnet IPv4 unavailable')
      fixture = await createHrcTestFixture('hrc-t06607-live-')

      // Reserve a currently-free tailnet port, then hand it immediately to the
      // isolated daemon. This never touches the shared launchd service.
      const probe = Bun.serve({
        hostname: tailnetIpv4,
        port: 0,
        fetch: () => new Response('probe'),
      })
      const port = probe.port
      probe.stop(true)
      const bind = `http://${tailnetIpv4}:${port}`
      await writeFile(
        `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
        JSON.stringify({
          nodeId: 'svc-test',
          peers: {
            lab: { endpoint: 'http://lab.example.ts.net:18490', token: TOKEN },
          },
          registry: { bind },
        }),
        { mode: 0o600 }
      )

      const server = await createHrcServer(fixture.serverOpts())
      try {
        expect(server.federationRegistryEndpoint).toBe(bind)
        const missing = await fetch(`${bind}/v1/federation/registry/consult?scopeRef=${SCOPE}`)
        expect(missing.status).toBe(401)

        const established = await fetch(`${bind}/v1/federation/registry/establish`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            scopeRef: SCOPE,
            homeNodeId: 'lab',
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'pin',
          }),
        })
        expect(established.status).toBe(200)
      } finally {
        await server.stop()
      }

      const registry = openBindingRegistry(resolveBindingRegistryPath(fixture.stateRoot))
      try {
        expect(registry.get(SCOPE)).toMatchObject({
          homeNodeId: 'lab',
          placementEpoch: 1,
          birthClass: 'policy-born',
        })
      } finally {
        registry.close()
      }
    }
  )
})
