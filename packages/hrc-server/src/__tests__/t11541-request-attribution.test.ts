/**
 * T-11541 — the request-metric record's caller and listener. The scratch-daemon
 * E2E (hrc-cli t11541-request-attribution-e2e) proves the whole path; these pin
 * the guards it cannot reach: hostile labels, federation peer attribution (its
 * listener only binds a tailnet host), and route sets frozen by the parity
 * inventory. Failure modes: var/wrkq-artifacts/T-11541/failure-modes.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMeteredPeerProtocolRequestHandler } from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'
import {
  ServerRequestMetricSampler,
  flushServerMetrics,
  normalizeRoute,
  peerClientLabel,
  requestClientLabel,
} from '../request-metrics.js'
import { listRequestRouteInventory } from '../request-route-inventory.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function readRecords(stateRoot: string): Promise<Record<string, unknown>[]> {
  await flushServerMetrics(stateRoot)
  const dir = join(stateRoot, 'metrics')
  const records: Record<string, unknown>[] = []
  for (const name of await readdir(dir)) {
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (line) records.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return records
}

describe('caller label', () => {
  test('keeps a declared label, bounded and line-safe', () => {
    const hostile = new Request('http://hrc/v1/health', {
      headers: { 'x-hrc-client': `acp"\t{evil} ${'x'.repeat(500)}` },
    })
    const label = requestClientLabel(hostile)
    expect(label.length).toBeLessThanOrEqual(64)
    expect(label).toMatch(/^[A-Za-z0-9._:/@+-]+$/)
    expect(label.startsWith('acp_')).toBe(true)
    expect(
      requestClientLabel(new Request('http://hrc/', { headers: { 'x-hrc-client': '@scope/pkg' } }))
    ).toBe('@scope/pkg')
  })

  test('falls back to the User-Agent product token only, then to unknown', () => {
    const ua = (value: string) =>
      requestClientLabel(new Request('http://hrc/', { headers: { 'user-agent': value } }))
    expect(ua('HRCMac/1 CFNetwork/3826.500.62 Darwin/25.6.0')).toBe('ua:HRCMac')
    expect(ua('curl/8.7.1')).toBe('ua:curl')
    expect(ua('Bun/1.3.14')).toBe('ua:Bun')
    // A header-less request: Bun's Request adds no UA of its own.
    expect(requestClientLabel(new Request('http://hrc/'))).toBe('unknown')
  })

  test('a federation caller is its authenticated peer or nobody', () => {
    expect(peerClientLabel('svc')).toBe('peer:svc')
    expect(peerClientLabel(undefined)).toBe('unauthenticated')
  })
})

describe('sampling strata', () => {
  test('a rare caller of a hot route keeps its own unsampled head', () => {
    const sampler = new ServerRequestMetricSampler()
    const base = { method: 'GET', route: '/v1/events', ms: 0.1, status: 200 }
    for (let index = 0; index < 1_000; index += 1) {
      sampler.weight({ ...base, client: 'acp-cli' }, 0)
    }
    expect(sampler.weight({ ...base, client: 'hrc-cli' }, 0)).toBe(1)
    // Same path, other listener: its own stratum too.
    expect(sampler.weight({ ...base, client: 'acp-cli', listener: 'peer' }, 0)).toBe(1)
  })
})

describe('route normalization', () => {
  test('pattern routes dispatched by the main socket are no longer unmatched', () => {
    const none = new Set<string>()
    expect(normalizeRoute('GET', '/v1/inputs/in-1', none)).toBe('/v1/inputs/:inputId')
    expect(normalizeRoute('GET', '/v1/inputs/in-1/watch', none)).toBe('/v1/inputs/:inputId/watch')
    expect(normalizeRoute('GET', '/v1/runtimes/rt-1/seat', none)).toBe(
      '/v1/runtimes/:runtimeId/seat'
    )
    // Malformed escapes are the handler's 400, never a metrics exception.
    expect(normalizeRoute('GET', '/v1/runtimes/%E0%A4%A/seat', none)).toBe(
      '/v1/runtimes/:runtimeId/seat'
    )
    expect(normalizeRoute('GET', '/v1/inputs/a/b/c', none)).toBe('unmatched')
  })

  test('the inventory equals the frozen parity inventory for every listener', () => {
    const frozen = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', '..', '..', '..', 'contract', 'hrc-parity', 'inventory.json'),
        'utf8'
      )
    ) as {
      items: { kind: string; transport?: string; method?: string; path?: string }[]
    }
    const listenerOf: Record<string, string> = {
      'public-unix': 'main',
      ingest: 'ingest',
      peer: 'peer',
      registry: 'registry',
    }
    const expected = frozen.items
      .filter((item) =>
        ['public-exact', 'public-computed', 'public-pattern', 'auxiliary-route'].includes(item.kind)
      )
      .map((item) => `${listenerOf[item.transport ?? '']} ${item.method} ${item.path}`)
      .sort()
    const actual = listRequestRouteInventory()
      .map((entry) => `${entry.listener} ${entry.method} ${entry.route}`)
      .sort()
    expect(actual).toEqual(expected)
  })
})

describe('federation peer listener', () => {
  test('records each request under the peer its token authenticates, in its own listener', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'hrc-t11541-peer-'))
    roots.push(stateRoot)
    const handler = createMeteredPeerProtocolRequestHandler(
      {
        localNodeId: 'lab',
        peers: new Map([
          [
            'svc',
            {
              nodeId: 'svc',
              endpoint: 'http://svc.example.ts.net:18490',
              token: new PeerToken('svc-token'),
            },
          ],
        ]),
        locate: async (scopeRef) => ({ scopeRef, localNodeId: 'lab' }),
        health: () => ({ startedAt: '2026-10-23T00:00:00.000Z', capabilities: { locate: true } }),
      },
      { stateRoot, sampler: new ServerRequestMetricSampler() }
    )
    const at = (path: string, token?: string) =>
      new Request(`http://lab.example.ts.net:18490${path}`, {
        headers: token
          ? { authorization: `Bearer ${token}`, 'x-hrc-client': 'forged' }
          : { 'x-hrc-client': 'forged' },
      })

    const ok = await handler(at('/v1/federation/health', 'svc-token'))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true })
    expect((await handler(at('/v1/federation/health'))).status).toBe(401)
    expect((await handler(at('/v1/nonesuch/abc', 'svc-token'))).status).toBe(404)

    const records = (await readRecords(stateRoot)).filter((record) => record['kind'] === 'server')
    expect(
      records.map((record) => [record['listener'], record['route'], record['client']])
    ).toEqual([
      ['peer', '/v1/federation/health', 'peer:svc'],
      ['peer', '/v1/federation/health', 'unauthenticated'],
      ['peer', 'unmatched', 'peer:svc'],
    ])
  })
})
