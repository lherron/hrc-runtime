import { describe, expect, test } from 'bun:test'

import type { PlacementLedgerRecord } from 'hrc-store-sqlite'

import {
  type LocateDeps,
  type LocateObservedRuntime,
  locateScope,
  scanLedgerForSkew,
} from '../federation/locate.js'
import type { PlacementPolicyResolution } from '../federation/placement-policy.js'
import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'
const PROFILE = '/agents/mable/agent-profile.toml'

function ledgerRow(overrides: Partial<PlacementLedgerRecord> = {}): PlacementLedgerRecord {
  return {
    scopeRef: SCOPE,
    homeNodeId: 'max3',
    state: 'active',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  }
}

function ledgerStub(row: PlacementLedgerRecord | undefined) {
  return {
    get: () => row,
    activeAuthority: () => (row?.state === 'active' ? row : undefined),
  }
}

function registryStub(behavior: RegistryConsultResult): BindingRegistryClient {
  return {
    async consult() {
      return behavior
    },
    async establish() {
      throw new Error('locate must not establish')
    },
    async deleteBinding() {
      throw new Error('locate must not delete')
    },
  }
}

function policy(
  input: {
    node?: string
    pins?: Record<string, string>
    homes?: Record<string, string>
  } = {}
): PlacementPolicyResolution {
  return {
    outcome: 'resolved',
    profilePath: PROFILE,
    policy: {
      claimsTask: false,
      ...(input.node === undefined ? {} : { provisioning: { node: input.node } }),
      placement: { pins: input.pins ?? {}, homes: input.homes ?? {} },
    },
  }
}

function deps(overrides: Partial<LocateDeps> = {}): LocateDeps {
  return {
    localNodeId: 'max3',
    federationConfigured: true,
    gateMode: 'enforce',
    ledger: ledgerStub(undefined),
    registry: registryStub({ outcome: 'unbound' }),
    policyFor: async () => policy({ node: 'max3' }),
    observedFor: (): readonly LocateObservedRuntime[] => [],
    ...overrides,
  }
}

describe('v1.3 locate keeps placement truths separate', () => {
  test('reports declared policy, home-only ledger, and local observations independently', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'lab' })),
        observedFor: () => [{ runtimeId: 'rt-1', laneRef: 'main', status: 'idle' }],
      }),
    })

    expect(location.declared).toMatchObject({ source: 'default_home_node', nodeId: 'max3' })
    expect(location.ledger).toMatchObject({ state: 'active', record: { homeNodeId: 'lab' } })
    expect(location.authority).toMatchObject({ state: 'bound', source: 'ledger', isLocal: true })
    expect(location.observed).toMatchObject({ nodeId: 'max3', runtimeCount: 1 })
    expect(JSON.stringify(location)).not.toContain('placementEpoch')
    expect(JSON.stringify(location)).not.toContain('birthClass')
  })

  test('an active local ledger short-circuits registry consultation', async () => {
    let consulted = false
    const registry = registryStub({ outcome: 'unbound' })
    registry.consult = async () => {
      consulted = true
      return { outcome: 'unbound' }
    }
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({ ledger: ledgerStub(ledgerRow()), registry }),
    })
    expect(consulted).toBe(false)
    expect(location.registry.outcome).toBe('not-consulted')
  })

  test('exact pin and task-default disagreement are skew, without changing authority', async () => {
    for (const declared of [
      policy({ pins: { 'hrc-runtime:T-06613': 'lab' } }),
      policy({ homes: { 'T-06613': 'lab' } }),
    ]) {
      const location = await locateScope({
        scopeRef: SCOPE,
        deps: deps({
          ledger: ledgerStub(ledgerRow()),
          policyFor: async () => declared,
        }),
      })
      expect(location.skew?.boundNodeId).toBe('max3')
      expect(location.authority).toMatchObject({ state: 'bound', record: { homeNodeId: 'max3' } })
    }
  })

  test('default-home divergence remains an expected note, not skew', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({ ledger: ledgerStub(ledgerRow({ homeNodeId: 'lab' })) }),
    })
    expect(location.skew).toBeUndefined()
    expect(location.notes).toContainEqual(
      expect.objectContaining({ code: 'unpinned-established-elsewhere' })
    )
  })

  test('skew scan ignores permanent retired rows', async () => {
    const report = await scanLedgerForSkew({
      bindings: [
        ledgerRow({
          state: 'retired',
          retiredAt: '2026-07-20T01:00:00.000Z',
          retirementReason: 'done',
        }),
      ],
      localNodeId: 'max3',
      policyFor: async () => policy({ pins: { 'hrc-runtime:T-06613': 'lab' } }),
    })
    expect(report).toEqual({ scanned: 0, skewed: [], unreadable: [] })
  })
})
