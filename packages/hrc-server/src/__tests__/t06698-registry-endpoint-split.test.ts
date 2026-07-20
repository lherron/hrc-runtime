/**
 * T-06698 — registry authority remains node-selected while transport origins split.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import {
  FEDERATION_CONFIG_BASENAME,
  type FederationConfig,
  type PeerEntry,
  resolveFederationConfig,
  summarizeFederationConfig,
} from '../federation/federation-config.js'
import { PEER_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION_HEADER } from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { resolveFederationRegistryClient } from '../federation/registry-resolution.js'
import { createHrcServer } from '../index.js'
import { withFederationConfigFile } from './fixtures/federation-config-fixture.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const TOKEN = 'split-listener-token'
const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06698'

function localTailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function peer(input: {
  nodeId: string
  endpoint: string
  registryEndpoint?: string | undefined
}): PeerEntry {
  return {
    nodeId: input.nodeId as PeerEntry['nodeId'],
    endpoint: input.endpoint,
    ...(input.registryEndpoint === undefined ? {} : { registryEndpoint: input.registryEndpoint }),
    token: new PeerToken(`${input.nodeId}-token`),
  }
}

function config(peers: readonly PeerEntry[], registryHost?: string): FederationConfig {
  return {
    nodeId: 'lab' as FederationConfig['nodeId'],
    nodeIdProvenance: 'declared',
    sourcePath: '/state/federation.json',
    sourceExists: true,
    peers: new Map(peers.map((entry) => [entry.nodeId, entry])),
    gate: {
      mode: 'enforce',
      ...(registryHost === undefined
        ? {}
        : { registryHost: registryHost as FederationConfig['nodeId'] }),
    },
    warnings: [],
  }
}

describe('role-specific peer origins', () => {
  test('split config projects both non-secret origins and registry client uses registryEndpoint', async () => {
    await withFederationConfigFile(
      {
        nodeId: 'lab',
        peers: {
          svc: {
            endpoint: 'http://svc.example.ts.net:18493',
            registryEndpoint: 'http://svc.example.ts.net:18491',
            token: TOKEN,
          },
        },
        gate: { mode: 'enforce', registryHost: 'svc' },
      },
      async ({ stateRoot, env }) => {
        const loaded = await resolveFederationConfig({ stateRoot, env })
        const summary = summarizeFederationConfig(loaded)
        expect(summary.peers).toEqual([
          {
            nodeId: 'svc',
            endpoint: 'http://svc.example.ts.net:18493/',
            registryEndpoint: 'http://svc.example.ts.net:18491/',
          },
        ])
        expect(JSON.stringify(summary)).not.toContain(TOKEN)

        const instrumentedPeer = loaded.peers.get('svc' as never)
        expect(instrumentedPeer?.registryEndpoint).toBe('http://svc.example.ts.net:18491/')

        // Exercise the concrete client with a captured fetch to prove URL selection.
        let requested = ''
        const { HttpBindingRegistryClient } = await import('../federation/registry-client.js')
        const captured = new HttpBindingRegistryClient(instrumentedPeer!, {
          fetch: (url) => {
            requested = String(url)
            return Promise.resolve(Response.json({ ok: false, error: 'unbound' }, { status: 404 }))
          },
          log: () => {},
        })
        expect(await captured.consult(SCOPE)).toEqual({ outcome: 'unbound' })
        expect(requested).toStartWith('http://svc.example.ts.net:18491/')
      }
    )
  })

  test('legacy endpoint-only peer remains the registry transport fallback', async () => {
    const selected = peer({ nodeId: 'svc', endpoint: 'http://svc.example.ts.net:18491' })
    let requested = ''
    const { HttpBindingRegistryClient } = await import('../federation/registry-client.js')
    const client = new HttpBindingRegistryClient(selected, {
      fetch: (url) => {
        requested = String(url)
        return Promise.resolve(Response.json({ ok: false, error: 'unbound' }, { status: 404 }))
      },
      log: () => {},
    })
    expect(await client.consult(SCOPE)).toEqual({ outcome: 'unbound' })
    expect(requested).toStartWith('http://svc.example.ts.net:18491/')
  })

  test('registryEndpoint never implies authority when registryHost is absent', async () => {
    const client = resolveFederationRegistryClient(
      config([
        peer({
          nodeId: 'svc',
          endpoint: 'http://svc.example.ts.net:18493',
          registryEndpoint: 'http://svc.example.ts.net:18491',
        }),
        peer({ nodeId: 'max3', endpoint: 'http://max3.example.ts.net:18492' }),
      ])
    )
    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(String(error)).toContain('2 peers but no "gate.registryHost"')
  })

  test.each([
    ['', 'non-empty'],
    ['ftp://svc.example.ts.net:18491', 'http: or https:'],
    ['http://svc.example.ts.net', 'explicit port'],
    ['http://registry.example.com:18491', 'tailnet host'],
    ['http://user:pass@svc.example.ts.net:18491', 'credentials'],
    ['http://svc.example.ts.net:18491/registry', 'origin'],
    ['http://svc.example.ts.net:18491/a/..', 'origin'],
    ['http://svc.example.ts.net:18491?query=1', 'origin'],
    ['http://svc.example.ts.net:18491#fragment', 'origin'],
  ])('startup refuses malformed registryEndpoint %j', async (registryEndpoint, reason) => {
    await withFederationConfigFile(
      {
        nodeId: 'lab',
        peers: {
          svc: {
            endpoint: 'http://svc.example.ts.net:18493',
            registryEndpoint,
            token: TOKEN,
          },
        },
      },
      async ({ stateRoot, env }) => {
        const error = await resolveFederationConfig({ stateRoot, env }).catch(
          (caught: unknown) => caught
        )
        expect(String(error)).toContain('peers.svc.registryEndpoint')
        expect(String(error)).toContain(reason)
      }
    )
  })
})

describe('two-listener route isolation', () => {
  const fixtures: HrcServerTestFixture[] = []

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  })

  const tailnetIp = localTailnetIpv4()
  const liveTailnetTest = selectLiveTailnetTest(import.meta.file, tailnetIp)

  liveTailnetTest('registry and peer protocol use only their declared listener', async () => {
    if (tailnetIp === undefined) throw new Error('tailnet IPv4 unavailable')
    const fixture = await createHrcTestFixture('hrc-t06698-split-listener-')
    fixtures.push(fixture)

    const registryProbe = Bun.serve({ hostname: tailnetIp, port: 0, fetch: () => new Response() })
    const peerProbe = Bun.serve({ hostname: tailnetIp, port: 0, fetch: () => new Response() })
    const registryBind = `http://${tailnetIp}:${registryProbe.port}`
    const peerBind = `http://${tailnetIp}:${peerProbe.port}`
    registryProbe.stop(true)
    peerProbe.stop(true)

    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({
        nodeId: 'svc-test',
        peers: {
          'lab-test': {
            endpoint: peerBind,
            registryEndpoint: registryBind,
            token: TOKEN,
          },
        },
        registry: { bind: registryBind },
        peerListener: { bind: peerBind },
        gate: { mode: 'enforce', registryHost: 'svc-test' },
      }),
      { mode: 0o600 }
    )

    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      [PEER_PROTOCOL_VERSION_HEADER]: PEER_PROTOCOL_VERSION,
    }
    try {
      const statusText = await (await fixture.fetchSocket('/v1/status')).text()
      expect(JSON.parse(statusText).node.peers).toEqual([
        {
          nodeId: 'lab-test',
          endpoint: `${peerBind}/`,
          registryEndpoint: `${registryBind}/`,
        },
      ])
      expect(statusText).not.toContain(TOKEN)

      const consult = await fetch(
        `${registryBind}/v1/federation/registry/consult?scopeRef=${encodeURIComponent(SCOPE)}`,
        { headers }
      )
      expect(consult.status).toBe(404)
      expect(await consult.json()).toMatchObject({ error: 'unbound' })

      const establish = await fetch(`${registryBind}/v1/federation/registry/establish`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scopeRef: SCOPE,
          homeNodeId: 'lab-test',
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'pin' },
          establishmentProvenance: 'pin',
        }),
      })
      expect(establish.status).toBe(200)

      expect((await fetch(`${peerBind}/v1/federation/health`, { headers })).status).toBe(200)
      expect(
        (
          await fetch(`${peerBind}/v1/federation/locate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ scopeRef: SCOPE }),
          })
        ).status
      ).toBe(200)
      expect(
        (
          await fetch(`${peerBind}/v1/federation/accept`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ envelope: {} }),
          })
        ).status
      ).not.toBe(404)

      for (const path of ['/v1/federation/accept', '/v1/federation/locate']) {
        expect((await fetch(`${registryBind}${path}`, { method: 'POST', headers })).status).toBe(
          404
        )
      }
      expect((await fetch(`${registryBind}/v1/federation/health`, { headers })).status).toBe(404)
      for (const path of ['/v1/federation/registry/consult', '/v1/federation/registry/establish']) {
        expect((await fetch(`${peerBind}${path}`, { method: 'POST', headers })).status).toBe(404)
      }
    } finally {
      await server.stop()
    }
  })
})
