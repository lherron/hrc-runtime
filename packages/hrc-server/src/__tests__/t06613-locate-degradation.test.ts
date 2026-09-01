import { describe, expect, test } from 'bun:test'

import type { PlacementLedgerRecord } from 'hrc-store-sqlite'

import { type LocateDeps, locateScope } from '../federation/locate.js'
import {
  type BindingRegistryClient,
  RegistryUnreachableError,
} from '../federation/registry-client.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'

function registry(consult: BindingRegistryClient['consult']): BindingRegistryClient {
  return {
    consult,
    async establish() {
      throw new Error('not used')
    },
    async deleteBinding() {
      throw new Error('not used')
    },
  }
}

function deps(overrides: Partial<LocateDeps> = {}): LocateDeps {
  return {
    localNodeId: 'max3',
    federationConfigured: true,
    gateMode: 'enforce',
    ledger: { get: () => undefined, activeAuthority: () => undefined },
    registry: registry(async () => ({ outcome: 'unbound' })),
    policyFor: async () => ({ outcome: 'no-profile', detail: 'no profile' }),
    observedFor: () => [],
    ...overrides,
  }
}

describe('locate degrades visibly and preserves permanent local retirement', () => {
  test('registry failure is unknown, never falsely unbound', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        registry: registry(async () => {
          throw new RegistryUnreachableError('registry down')
        }),
      }),
    })
    expect(location.registry).toMatchObject({ outcome: 'unknown', retryable: true })
    expect(location.authority).toMatchObject({ state: 'unknown', retryable: true })
  })

  test('a retired local ledger is authoritative over stale shared discovery', async () => {
    let consulted = false
    const retired: PlacementLedgerRecord = {
      scopeRef: SCOPE,
      homeNodeId: 'max3',
      state: 'retired',
      retiredAt: '2026-07-20T01:00:00.000Z',
      retirementReason: 'operator retirement',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T01:00:00.000Z',
    }
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: { get: () => retired, activeAuthority: () => undefined },
        registry: registry(async () => {
          consulted = true
          return {
            outcome: 'bound',
            binding: {
              scopeRef: SCOPE,
              homeNodeId: 'max3',
              createdAt: retired.createdAt,
              updatedAt: retired.updatedAt,
            },
          }
        }),
      }),
    })
    expect(consulted).toBe(false)
    expect(location.ledger.state).toBe('retired')
    expect(location.authority.state).toBe('unbound')
    expect(location.retirement).toEqual({
      retiredNodeId: 'max3',
      reason: 'operator retirement',
      retiredAt: '2026-07-20T01:00:00.000Z',
    })
    expect(location.notes).toContainEqual(expect.objectContaining({ code: 'scope-retired' }))
  })
})
