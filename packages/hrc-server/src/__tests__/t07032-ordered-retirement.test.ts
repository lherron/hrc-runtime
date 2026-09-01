import { describe, expect, test } from 'bun:test'

import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import type { BindingRegistryClient } from '../federation/registry-client.js'
import { RegistryUnreachableError } from '../federation/registry-client.js'
import { retireFederationScope } from '../federation/retirement.js'
import type { FederationRetirementDependencies } from '../federation/retirement.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-07032'
const NOW = '2026-09-01T06:00:00.000Z'

describe('T-07032 federation v1.3 ordered retirement', () => {
  test('non-home refusal and a mid-write failure stay nowhere-or-one and retry safely', async () => {
    const oldDb = openHrcDatabase(':memory:')
    const otherDb = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      const oldLedger = createPlacementLedgerRepository(oldDb.sqlite)
      const otherLedger = createPlacementLedgerRepository(otherDb.sqlite)
      const binding = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        placementSource: 'pin',
        now: NOW,
      }).binding
      oldLedger.installActive(binding)

      const registryClient: BindingRegistryClient = {
        async consult(scopeRef) {
          const current = registry.get(scopeRef)
          return current === undefined
            ? { outcome: 'unbound' }
            : { outcome: 'bound', binding: current }
        },
        async establish(request) {
          return registry.establish(request)
        },
        async deleteBinding(request) {
          return registry.deleteBinding(request)
        },
      }
      const base = {
        owner: {},
        registry: registryClient,
        liveRuntimeIds: () => [],
        log: () => {},
        now: () => NOW,
      }
      const oldHome: FederationRetirementDependencies = {
        ...base,
        localNodeId: 'svc',
        ledger: oldLedger,
      }
      const nonHome: FederationRetirementDependencies = {
        ...base,
        localNodeId: 'lab',
        ledger: otherLedger,
      }

      await expect(
        retireFederationScope(nonHome, { scopeRef: SCOPE, reason: 'operator-rehome' })
      ).resolves.toMatchObject({ ok: false, outcome: 'refused', state: 'unchanged' })
      expect(registry.get(SCOPE)?.homeNodeId).toBe('svc')

      const registryDown: BindingRegistryClient = {
        ...registryClient,
        async deleteBinding() {
          throw new RegistryUnreachableError('fault after local fence')
        },
      }
      await expect(
        retireFederationScope(
          { ...oldHome, registry: registryDown },
          { scopeRef: SCOPE, reason: 'operator-rehome' }
        )
      ).resolves.toMatchObject({
        ok: false,
        outcome: 'registry-unavailable',
        state: 'fenced-registry-pending',
        retryable: true,
      })
      expect(oldLedger.get(SCOPE)).toMatchObject({ state: 'retired', homeNodeId: 'svc' })
      expect(oldLedger.activeAuthority(SCOPE)).toBeUndefined()
      expect(registry.get(SCOPE)?.homeNodeId).toBe('svc')

      await expect(
        retireFederationScope(oldHome, { scopeRef: SCOPE, reason: 'operator-rehome' })
      ).resolves.toMatchObject({ ok: true, outcome: 'retired', state: 'retired' })
      await expect(
        retireFederationScope(oldHome, { scopeRef: SCOPE, reason: 'operator-rehome' })
      ).resolves.toMatchObject({ ok: true, outcome: 'idempotent', state: 'retired' })
      expect(registry.get(SCOPE)).toBeUndefined()

      const fresh = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementSource: 'explicit_local',
        now: '2026-09-01T06:01:00.000Z',
      })
      expect(fresh).toMatchObject({ outcome: 'created', binding: { homeNodeId: 'lab' } })
      expect(() =>
        oldLedger.installActive({
          scopeRef: SCOPE,
          homeNodeId: 'svc',
          createdAt: NOW,
          updatedAt: '2026-09-01T06:02:00.000Z',
        })
      ).toThrow('retired')
      expect(oldLedger.get(SCOPE)).toMatchObject({ state: 'retired', homeNodeId: 'svc' })
    } finally {
      registry.close()
      oldDb.close()
      otherDb.close()
    }
  })
})
