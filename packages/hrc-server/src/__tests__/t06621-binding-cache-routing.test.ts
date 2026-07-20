import { describe, expect, test } from 'bun:test'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'
import type { PlacementBinding } from 'hrc-store-sqlite'

import {
  BindingCacheConflictError,
  InMemoryBindingHintCache,
  createStalePlacementRedirectHandler,
} from '../federation/binding-cache.js'
import type { BindingHintCache } from '../federation/binding-cache.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { RegistryUnreachableError } from '../federation/registry-client.js'
import {
  FederationRoutingResolutionError,
  resolveFederationRoutingBinding,
} from '../federation/routing-resolution.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06621'

function binding(
  patch: Partial<Pick<PlacementBinding, 'homeNodeId' | 'placementEpoch'>> = {}
): PlacementBinding {
  return {
    scopeRef: SCOPE,
    homeNodeId: patch.homeNodeId ?? 'lab',
    placementEpoch: patch.placementEpoch ?? 4,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'pin' },
    establishmentProvenance: 'pin',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  }
}

function registry(result: PlacementBinding): BindingRegistryClient {
  return {
    async consult() {
      return { outcome: 'bound', binding: result }
    },
    async establish() {
      throw new Error('not used by routing resolution')
    },
  }
}

describe('T-06621 epoch-fenced binding hint cache', () => {
  test('a stale-placement redirect advances the cache and older redirects cannot regress it', () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn(binding())
    const onStaleRedirect = createStalePlacementRedirectHandler(cache)

    expect(onStaleRedirect(SCOPE, 'lab-next', 5)).toMatchObject({ outcome: 'advanced' })
    expect(onStaleRedirect(SCOPE, 'lab', 4)).toMatchObject({ outcome: 'ignored_stale' })
    expect(cache.get(SCOPE)).toEqual({
      purpose: 'routing-hint',
      scopeRef: SCOPE,
      homeNodeId: 'lab-next',
      placementEpoch: 5,
    })
  })

  test('same-epoch conflicting homes fail rather than silently changing the fence', () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn(binding())
    const onStaleRedirect = createStalePlacementRedirectHandler(cache)

    expect(() => onStaleRedirect(SCOPE, 'svc', 4)).toThrow(BindingCacheConflictError)
    expect(cache.get(SCOPE)?.homeNodeId).toBe('lab')
  })

  test('a cache hit below the requested epoch fence is bypassed for a registry consult', async () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn(binding({ placementEpoch: 4 }))

    const resolved = await resolveFederationRoutingBinding({
      scopeRef: SCOPE,
      minimumPlacementEpoch: 5,
      ledger: { get: () => undefined },
      cache,
      registry: registry(binding({ homeNodeId: 'lab-next', placementEpoch: 5 })),
    })

    expect(resolved).toMatchObject({
      source: 'registry',
      homeNodeId: 'lab-next',
      placementEpoch: 5,
    })
    expect(cache.get(SCOPE)?.placementEpoch).toBe(5)
  })

  test('learning a routing hint never creates local summon authority', () => {
    const db = openHrcDatabase(':memory:')
    const ledger = createPlacementLedgerRepository(db.sqlite)
    try {
      const cache = new InMemoryBindingHintCache()
      cache.learn(binding())

      expect(cache.get(SCOPE)).toMatchObject({ purpose: 'routing-hint', homeNodeId: 'lab' })
      expect(ledger.activeAuthority(SCOPE)).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('T-06621 routing resolution order', () => {
  test('uses local ledger, then cache, then registry — and caches registry bindings learned', async () => {
    const trace: string[] = []
    const learned: string[] = []
    const cache: BindingHintCache = {
      get() {
        trace.push('cache')
        return undefined
      },
      learn(value) {
        learned.push(`${value.homeNodeId}@${value.placementEpoch}`)
        return { outcome: 'stored', current: { purpose: 'routing-hint', ...value } }
      },
    }

    const resolved = await resolveFederationRoutingBinding({
      scopeRef: SCOPE,
      ledger: {
        get() {
          trace.push('ledger')
          return undefined
        },
      },
      cache,
      registry: {
        async consult() {
          trace.push('registry')
          return { outcome: 'bound', binding: binding() }
        },
        async establish() {
          throw new Error('not used')
        },
      },
    })

    expect(trace).toEqual(['ledger', 'cache', 'registry'])
    expect(learned).toEqual(['lab@4'])
    expect(resolved).toMatchObject({ source: 'registry', purpose: 'routing-hint' })
  })

  test('local ledger and cache hits each short-circuit every lower-priority source', async () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn(binding())
    let consulted = 0
    const registryClient: BindingRegistryClient = {
      async consult() {
        consulted += 1
        return { outcome: 'bound', binding: binding() }
      },
      async establish() {
        throw new Error('not used')
      },
    }

    const ledgerResolved = await resolveFederationRoutingBinding({
      scopeRef: SCOPE,
      ledger: { get: () => ({ ...binding({ homeNodeId: 'svc' }), state: 'active' as const }) },
      cache,
      registry: registryClient,
    })
    expect(ledgerResolved).toMatchObject({ source: 'local-ledger', homeNodeId: 'svc' })

    const cacheResolved = await resolveFederationRoutingBinding({
      scopeRef: SCOPE,
      ledger: { get: () => undefined },
      cache,
      registry: registryClient,
    })
    expect(cacheResolved).toMatchObject({ source: 'cache', homeNodeId: 'lab' })
    expect(consulted).toBe(0)
  })

  test('registry outage fails only uncached routing, visibly and retryably', async () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn(binding())
    const down: BindingRegistryClient = {
      async consult() {
        throw new RegistryUnreachableError('svc registry stopped')
      },
      async establish() {
        throw new Error('not used')
      },
    }

    await expect(
      resolveFederationRoutingBinding({
        scopeRef: SCOPE,
        ledger: { get: () => undefined },
        cache,
        registry: down,
      })
    ).resolves.toMatchObject({ source: 'cache', homeNodeId: 'lab' })

    const error = await resolveFederationRoutingBinding({
      scopeRef: `${SCOPE}-uncached`,
      ledger: { get: () => undefined },
      cache,
      registry: down,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FederationRoutingResolutionError)
    expect(error).toMatchObject({
      code: 'registry_unreachable',
      retryable: true,
      visible: true,
    })
  })
})
