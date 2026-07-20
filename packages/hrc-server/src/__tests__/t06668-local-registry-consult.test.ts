/**
 * T-06668 — a registry-hosting node consults its own authority locally.
 *
 * Self-peers remain invalid. The local registry is not a peer and therefore
 * reaches the gate through the endpoint-owned in-process client instead. A
 * zero-peer listener rejects every network request while retaining that local
 * authority path.
 */

import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import { afterEach, describe, expect, test } from 'bun:test'

import type { FederationConfig, PeerEntry } from '../federation/federation-config.js'
import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import {
  type BindingRegistryClient,
  HttpBindingRegistryClient,
  type RegistryConsultResult,
} from '../federation/registry-client.js'
import { resolveFederationRegistryClient } from '../federation/registry-resolution.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:localgate:project:hrc-runtime:task:T-06668'
const SESSION = `${SCOPE}/lane:main`

function peer(nodeId: string): PeerEntry {
  return {
    nodeId: nodeId as PeerEntry['nodeId'],
    endpoint: `http://${nodeId}.example.ts.net:18490`,
    token: new PeerToken(`${nodeId}-token`),
  }
}

function federationConfig(input: {
  nodeId: string
  registry?: boolean | undefined
  registryHost?: string | undefined
  peers?: readonly PeerEntry[] | undefined
}): FederationConfig {
  return {
    nodeId: input.nodeId as FederationConfig['nodeId'],
    nodeIdProvenance: 'declared',
    sourcePath: '/state/federation.json',
    sourceExists: true,
    peers: new Map((input.peers ?? []).map((entry) => [entry.nodeId, entry])),
    ...(input.registry ? { registry: { bind: 'http://100.64.0.1:18490' } } : {}),
    gate: {
      mode: 'advisory',
      ...(input.registryHost === undefined
        ? {}
        : { registryHost: input.registryHost as FederationConfig['nodeId'] }),
    },
    warnings: [],
  }
}

function registryStub(): BindingRegistryClient {
  return {
    async consult(): Promise<RegistryConsultResult> {
      return { outcome: 'unbound' }
    },
    async establish() {
      throw new Error('not used')
    },
  }
}

function localTailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function captureServerLog(): { lines: string[]; restore(): void } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  return {
    lines,
    restore() {
      process.stderr.write = original
    },
  }
}

describe('registry selection', () => {
  test('registry host selects its endpoint-owned local client without a self-peer', () => {
    const local = registryStub()
    const config = federationConfig({
      nodeId: 'svc',
      registry: true,
      registryHost: 'svc',
      peers: [peer('lab')],
    })

    expect(resolveFederationRegistryClient(config, local)).toBe(local)
    expect(config.peers.has(config.nodeId)).toBe(false)
  })

  test('non-registry node still selects the declared remote peer client', () => {
    const config = federationConfig({
      nodeId: 'lab',
      registryHost: 'svc',
      peers: [peer('svc')],
    })

    expect(resolveFederationRegistryClient(config)).toBeInstanceOf(HttpBindingRegistryClient)
  })

  test('local-host diagnostic names the reachable configuration, not a self-peer', async () => {
    const client = resolveFederationRegistryClient(
      federationConfig({ nodeId: 'svc', registry: true, peers: [peer('lab')] })
    )

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(String(error)).toContain('set "gate": {"registryHost": "svc"}')
    expect(String(error)).not.toContain('add the registry host to "peers"')
  })
})

describe('registry-host gate on a live isolated daemon', () => {
  let fixture: HrcServerTestFixture | undefined

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  const tailnetIpv4 = localTailnetIpv4()
  const liveTailnetTest = tailnetIpv4 === undefined ? test.skip : test
  liveTailnetTest('boots zero-peer advisory with local-only authority', async () => {
    if (tailnetIpv4 === undefined) throw new Error('tailnet IPv4 unavailable')
    fixture = await createHrcTestFixture('hrc-t06668-local-registry-')

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
        peers: {},
        registry: { bind },
        gate: { mode: 'advisory', registryHost: 'svc-test' },
      }),
      { mode: 0o600 }
    )

    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      expect(server.federationRegistryEndpoint).toBe(bind)
      const remote = await fetch(
        `${bind}/v1/federation/registry/consult?scopeRef=${encodeURIComponent(SCOPE)}`,
        { headers: { authorization: 'Bearer no-configured-peer-can-match' } }
      )
      expect(remote.status).toBe(401)
      expect(await remote.json()).toEqual({ ok: false, error: 'unauthorized' })

      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION,
        create: true,
      })
      expect(response.status).toBe(200)

      const logs = captured.lines.join('')
      expect(logs).toContain('federation.registry.consult.unbound')
      expect(logs).toContain('"transport":"local"')
      expect(logs).toContain(SUMMON_GATE_REFUSAL_EVENT)
      expect(logs).not.toContain('add the registry host to')

      const locate = await fixture.fetchSocket(
        `/v1/federation/locate?scopeRef=${encodeURIComponent(SCOPE)}`
      )
      expect(locate.status).toBe(200)
      expect(await locate.json()).toMatchObject({
        localNodeId: 'svc-test',
        gateMode: 'advisory',
        registry: { outcome: 'unbound' },
      })
    } finally {
      await server.stop()
      captured.restore()
    }
  })
})
