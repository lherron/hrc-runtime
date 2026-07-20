import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BindingEstablishResult, PlacementBinding } from 'hrc-store-sqlite'

import { establishLocalPlacement } from '../federation/establishment.js'
import type { PeerEntry } from '../federation/federation-config.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import {
  HttpBindingRegistryClient,
  type RegistryClientFetch,
  RegistryRefusedError,
  RegistryUnreachableError,
} from '../federation/registry-client.js'
import {
  type BindingRegistryEndpointControl,
  startBindingRegistryEndpoint,
} from '../federation/registry-endpoint.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06663'
const LOCAL_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06668'
const TOKEN = 'registry-client-secret'
const BINDING: PlacementBinding = {
  scopeRef: SCOPE,
  homeNodeId: 'lab',
  placementEpoch: 1,
  birthClass: 'policy-born',
  authorityProvenance: { kind: 'policy', source: 'pin' },
  establishmentProvenance: 'pin',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
}

function peer(endpoint = 'http://svc.example.ts.net:18491'): PeerEntry {
  return { nodeId: 'svc' as PeerEntry['nodeId'], endpoint, token: new PeerToken(TOKEN) }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function localTailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function clientWith(
  fetch: RegistryClientFetch,
  options: Partial<ConstructorParameters<typeof HttpBindingRegistryClient>[1]> = {}
): HttpBindingRegistryClient {
  return new HttpBindingRegistryClient(peer(), {
    fetch,
    perAttemptTimeoutMs: 50,
    totalTimeoutMs: 500,
    random: () => 0,
    sleep: async () => {},
    log: () => {},
    ...options,
  })
}

describe('T-06663 registry consult result contract', () => {
  test('maps a valid 200 binding and exact unbound 404 into results', async () => {
    let calls = 0
    const client = clientWith((_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      return Promise.resolve(
        calls++ === 0
          ? json({ ok: true, authenticatedNodeId: 'lab', binding: BINDING })
          : json({ ok: false, error: 'unbound', authenticatedNodeId: 'lab' }, 404)
      )
    })

    expect(await client.consult(SCOPE)).toEqual({ outcome: 'bound', binding: BINDING })
    expect(await client.consult(SCOPE)).toEqual({ outcome: 'unbound' })
  })

  test('a non-unbound 404 never becomes virgin authority', async () => {
    let attempts = 0
    const client = clientWith(() => {
      attempts += 1
      return Promise.resolve(json({ ok: false, error: 'not_found' }, 404))
    })

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect((error as RegistryUnreachableError).retryable).toBe(true)
    expect(attempts).toBe(3)
  })

  test('an exotic malformed 200 body fails closed instead of reading as unbound', async () => {
    const client = clientWith(() => Promise.resolve(json({ ok: true, binding: new Map() })))

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect((error as RegistryUnreachableError).retryable).toBe(true)
  })

  test('an unclassified thrown value is normalized to the fail-closed error type', async () => {
    const client = clientWith(() => Promise.reject(Symbol('exotic transport failure')))

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect((error as RegistryUnreachableError).retryable).toBe(true)
  })
})

describe('T-06663 registry error taxonomy and retry posture', () => {
  test.each([
    [401, 'unauthorized'],
    [400, 'invalid_request'],
  ] as const)('status %i is refused, non-retryable, and attempted once', async (status, code) => {
    let attempts = 0
    const client = clientWith(() => {
      attempts += 1
      return Promise.resolve(json({ ok: false, error: code }, status))
    })

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryRefusedError)
    expect(error).toMatchObject({ retryable: false, status, code })
    expect(attempts).toBe(1)
    expect(String(error)).not.toContain(TOKEN)
  })

  test('unreachable and 5xx failures retry at most twice, then surface retryable', async () => {
    for (const fetch of [
      () => Promise.reject(new TypeError('connection refused')),
      () => Promise.resolve(json({ ok: false }, 503)),
    ]) {
      let attempts = 0
      const client = clientWith((url, init) => {
        attempts += 1
        return fetch(url, init)
      })
      const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RegistryUnreachableError)
      expect((error as RegistryUnreachableError).retryable).toBe(true)
      expect(attempts).toBe(3)
    }
  })

  test('per-attempt timeout is bounded and retryable', async () => {
    let attempts = 0
    const client = clientWith(
      (_url, init) => {
        attempts += 1
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      },
      { perAttemptTimeoutMs: 5, totalTimeoutMs: 100, sleep: async () => {} }
    )

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect((error as RegistryUnreachableError).retryable).toBe(true)
    expect(attempts).toBe(3)
  })

  test('the total budget hard-caps attempts plus backoff', async () => {
    let now = 0
    let attempts = 0
    const client = clientWith(
      () => {
        attempts += 1
        now += 4
        return Promise.resolve(json({ ok: false }, 503))
      },
      {
        totalTimeoutMs: 10,
        now: () => now,
        random: () => 1,
        sleep: async (ms) => {
          now += ms
        },
      }
    )

    const error = await client.consult(SCOPE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect(attempts).toBe(1)
    expect(now).toBe(10)
  })

  test('caller abort is honored, retryable to the gate, and never retried internally', async () => {
    const controller = new AbortController()
    controller.abort('operator cancelled')
    let attempts = 0
    const client = clientWith(() => {
      attempts += 1
      return Promise.resolve(json({ ok: true, binding: BINDING }))
    })

    const error = await client
      .consult(SCOPE, { signal: controller.signal })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect((error as RegistryUnreachableError).retryable).toBe(true)
    expect(attempts).toBe(0)
  })
})

describe('T-06663 establishment compatibility', () => {
  const request = {
    scopeRef: SCOPE,
    homeNodeId: 'lab',
    placementEpoch: 1,
    birthClass: 'policy-born' as const,
    authorityProvenance: { kind: 'policy', source: 'pin' },
    establishmentProvenance: 'pin' as const,
    now: '2026-07-20T00:00:00.000Z',
  }

  test('is a structural superset of establishLocalPlacement registry without changing it', async () => {
    const response: BindingEstablishResult = { outcome: 'created', binding: BINDING }
    const client = clientWith((_url, init) => {
      expect(init.method).toBe('POST')
      return Promise.resolve(json({ ok: true, authenticatedNodeId: 'lab', ...response }))
    })
    let installed: PlacementBinding | undefined

    const result = await establishLocalPlacement({
      registry: client,
      ledger: {
        activeAuthority: () => undefined,
        installActive: (binding) => {
          installed = binding as PlacementBinding
          return { ...binding, state: 'active' }
        },
      },
      request,
    })

    expect(result).toEqual({ outcome: 'established', binding: BINDING })
    expect(installed).toEqual(BINDING)
  })

  test('establish retries only a provably pre-send connect failure', async () => {
    let attempts = 0
    const client = clientWith(() => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        )
      }
      return Promise.resolve(
        json({ ok: true, outcome: 'created', authenticatedNodeId: 'lab', binding: BINDING })
      )
    })

    expect(await client.establish(request)).toEqual({ outcome: 'created', binding: BINDING })
    expect(attempts).toBe(2)
  })

  test.each(['timeout', '5xx'] as const)(
    'establish never retries an ambiguous %s',
    async (kind) => {
      let attempts = 0
      const client = clientWith(
        (_url, init) => {
          attempts += 1
          if (kind === '5xx') return Promise.resolve(json({ ok: false }, 503))
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          })
        },
        { perAttemptTimeoutMs: 5 }
      )

      const error = await client.establish(request).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RegistryUnreachableError)
      expect(attempts).toBe(1)
    }
  )
})

describe('T-06663 construction and secret egress', () => {
  test('refuses a non-tailnet registry endpoint before making a request', () => {
    expect(
      () =>
        new HttpBindingRegistryClient(peer('https://registry.example.com:18491'), {
          fetch: () => Promise.reject(new Error('must not run')),
        })
    ).toThrow(RegistryRefusedError)
  })

  test('has only the two audited PeerToken reveal sites at outbound Authorization headers', () => {
    const scan = Bun.spawnSync({
      cmd: ['rg', '-n', String.raw`\.reveal\(\)`, 'packages'],
      cwd: `${import.meta.dir}/../../../..`,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(scan.exitCode).toBe(0)
    const matches = scan.stdout.toString().trim().split('\n')
    expect(matches).toHaveLength(2)
    expect(matches).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^packages\/hrc-server\/src\/federation\/accept-client\.ts:\d+:.*token\.reveal\(\)/
        ),
        expect.stringMatching(
          /^packages\/hrc-server\/src\/federation\/registry-client\.ts:\d+:.*token\.reveal\(\)/
        ),
      ])
    )
  })
})

describe('T-06663 real registry endpoint integration', () => {
  let endpoint: BindingRegistryEndpointControl | undefined
  let tempDir: string | undefined

  afterEach(async () => {
    endpoint?.stop()
    endpoint = undefined
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  const tailnetIpv4 = localTailnetIpv4()
  const liveTailnetTest = tailnetIpv4 === undefined ? test.skip : test
  liveTailnetTest(
    'consults and establishes through the authenticated Tailnet listener',
    async () => {
      if (tailnetIpv4 === undefined) throw new Error('tailnet IPv4 unavailable')
      tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06663-client-'))
      const probe = Bun.serve({
        hostname: tailnetIpv4,
        port: 0,
        fetch: () => new Response('probe'),
      })
      const port = probe.port
      probe.stop(true)
      endpoint = startBindingRegistryEndpoint({
        listener: { bind: `http://${tailnetIpv4}:${port}` },
        peers: new Map([['lab', { nodeId: 'lab', token: new PeerToken(TOKEN) }]]),
        registryPath: join(tempDir, 'binding-registry.sqlite'),
        localNodeId: 'svc',
      })
      const client = new HttpBindingRegistryClient(
        {
          nodeId: 'svc' as PeerEntry['nodeId'],
          endpoint: endpoint.url,
          token: new PeerToken(TOKEN),
        },
        { log: () => {} }
      )

      expect(await client.consult(SCOPE)).toEqual({ outcome: 'unbound' })
      const established = await client.establish({ ...BINDING, now: BINDING.updatedAt })
      expect(established).toMatchObject({
        outcome: 'created',
        binding: {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          placementEpoch: 1,
          birthClass: 'policy-born',
        },
      })
      expect(await client.consult(SCOPE)).toEqual({
        outcome: 'bound',
        binding: established.binding,
      })

      // The registry host shares this same authority handle without pretending
      // to be a peer. A local establishment is immediately visible remotely.
      expect(await endpoint.registryClient.consult(LOCAL_SCOPE)).toEqual({ outcome: 'unbound' })
      const localEstablished = await endpoint.registryClient.establish({
        ...BINDING,
        scopeRef: LOCAL_SCOPE,
        homeNodeId: 'svc',
        now: BINDING.updatedAt,
      })
      expect(localEstablished).toMatchObject({
        outcome: 'created',
        binding: { scopeRef: LOCAL_SCOPE, homeNodeId: 'svc' },
      })
      expect(await client.consult(LOCAL_SCOPE)).toEqual({
        outcome: 'bound',
        binding: localEstablished.binding,
      })
    }
  )
})
