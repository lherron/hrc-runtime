/**
 * T-06613 — `hrc target locate` core + skew surfacing (federation spec §5, §10).
 *
 * The contract under test, in the AC's own words:
 *
 *   - locate reports declared policy vs ledger home vs observed runtime node,
 *     plus birth class and establishment provenance.
 *   - SKEW IS EXACTLY a PIN disagreeing with an established binding. The
 *     established home keeps summon authority; the pin value is not acted on;
 *     nothing reconciles automatically.
 *   - An UNPINNED scope established away from default_home_node is EXPECTED
 *     state, NOT skew. locate must not flag it; provenance keeps it explainable.
 *
 * The third bullet is the one worth a test per provenance class, because the
 * cheap implementation of skew ("declared home != bound home") passes every
 * pin test and gets that bullet exactly backwards.
 */

import { describe, expect, test } from 'bun:test'

import type { PlacementLedgerRecord } from 'hrc-store-sqlite'

import {
  type LocateDeps,
  type LocateObservedRuntime,
  locateScope,
  scanLedgerForSkew,
} from '../federation/locate.js'
import type { PlacementPolicyResolution } from '../federation/placement-policy.js'
import {
  type BindingRegistryClient,
  type RegistryConsultResult,
  RegistryRefusedError,
  RegistryUnreachableError,
} from '../federation/registry-client.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'
const PIN_KEY = 'hrc-runtime:T-06613'
const PROFILE = '/agents/mable/agent-profile.toml'

function ledgerRow(overrides: Partial<PlacementLedgerRecord> = {}): PlacementLedgerRecord {
  return {
    scopeRef: SCOPE,
    homeNodeId: 'max3',
    placementEpoch: 1,
    state: 'active',
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'default_home_node' },
    establishmentProvenance: 'default_home_node',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  } as PlacementLedgerRecord
}

function ledgerStub(row: PlacementLedgerRecord | undefined) {
  return {
    get: () => row,
    activeAuthority: () => (row?.state === 'active' ? row : undefined),
  }
}

function registryStub(behavior: RegistryConsultResult | Error): BindingRegistryClient {
  return {
    async consult(): Promise<RegistryConsultResult> {
      if (behavior instanceof Error) throw behavior
      return behavior
    },
    async establish() {
      throw new Error('locate must never establish a binding')
    },
  }
}

function policy(
  placement:
    | {
        node?: string
        pins?: Record<string, string>
        homes?: Record<string, string>
      }
    | undefined
): PlacementPolicyResolution {
  return {
    outcome: 'resolved',
    profilePath: PROFILE,
    policy: {
      claimsTask: false,
      ...(placement?.node === undefined ? {} : { provisioning: { node: placement.node } }),
      ...(placement === undefined
        ? {}
        : {
            placement: {
              pins: placement.pins ?? {},
              homes: placement.homes ?? {},
            },
          }),
    },
  }
}

function deps(overrides: Partial<LocateDeps> = {}): LocateDeps {
  return {
    localNodeId: 'max3',
    federationConfigured: true,
    gateMode: 'advisory',
    ledger: ledgerStub(undefined),
    registry: registryStub({ outcome: 'unbound' }),
    policyFor: async () => policy({ node: 'max3' }),
    observedFor: (): readonly LocateObservedRuntime[] => [],
    ...overrides,
  } as LocateDeps
}

describe('locate degrades visibly, never falsely', () => {
  test('a registry tombstone is reported as retired authority, never unbound', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub({
          outcome: 'retired',
          retirement: {
            state: 'retired',
            scopeRef: SCOPE,
            placementEpoch: 3,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:03:00.000Z',
            retiredHomeNodeId: 'max3',
            retiredAt: '2026-07-20T00:03:00.000Z',
            reason: 'namespace_reconciliation',
            successorNodeId: 'mini',
          },
        }),
      }),
    })

    expect(location.registry).toMatchObject({
      outcome: 'retired',
      record: { placementEpoch: 3, successorNodeId: 'mini' },
    })
    expect(location.authority).toMatchObject({
      state: 'retired',
      placementEpoch: 3,
      retiredHomeNodeId: 'max3',
      successorNodeId: 'mini',
    })
  })

  test('an unreachable registry is UNKNOWN authority, never "unbound"', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub(new RegistryUnreachableError('connect ECONNREFUSED')),
      }),
    })

    expect(location.registry).toMatchObject({ outcome: 'unknown', retryable: true })
    expect(location.authority).toMatchObject({ state: 'unknown', retryable: true })
  })

  test('a refused registry is UNKNOWN and not retryable', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub(new RegistryRefusedError('unauthorized', 401, 'unauthorized')),
      }),
    })

    expect(location.registry).toMatchObject({ outcome: 'unknown', retryable: false })
    expect(location.authority).toMatchObject({ state: 'unknown', retryable: false })
  })

  test('unknown authority yields no skew verdict — skew needs an ESTABLISHED binding', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub(new RegistryUnreachableError('down')),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
      }),
    })

    expect(location.skew).toBeUndefined()
  })

  test('an unreadable profile is reported as unavailable, not as "declares nothing"', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        policyFor: async () => ({
          outcome: 'unreadable',
          detail: 'Could not parse agent-profile.toml: unexpected token',
          profilePath: PROFILE,
        }),
      }),
    })

    expect(location.declared).toMatchObject({ source: 'unavailable' })
    expect(location.declared).toHaveProperty('detail')
  })

  test('federation unconfigured: no registry consult is attempted at all', async () => {
    let consulted = false
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        federationConfigured: false,
        gateMode: 'off',
        ledger: ledgerStub(undefined),
        registry: {
          async consult(): Promise<RegistryConsultResult> {
            consulted = true
            return { outcome: 'unbound' }
          },
          async establish() {
            throw new Error('unreachable')
          },
        },
      }),
    })

    expect(consulted).toBe(false)
    expect(location.registry.outcome).toBe('not-consulted')
    expect(location.federationConfigured).toBe(false)
  })

  test('a retirement mark is surfaced as a note', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        retirementFor: () => ({
          retiredNodeId: 'max3',
          successorNodeId: 'mini',
          retiredPlacementEpoch: 2,
          reason: 'namespace reconciliation',
        }),
      }),
    })

    expect(location.retirement).toMatchObject({ successorNodeId: 'mini' })
    expect(location.notes.map((n) => n.code)).toContain('scope-retired')
  })

  test('a local retirement mark suppresses stale-ledger skew in locate', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        localNodeId: 'max3',
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
        retirementFor: () => ({
          retiredNodeId: 'max3',
          successorNodeId: 'mini',
          retiredPlacementEpoch: 1,
          reason: 'namespace reconciliation',
        }),
      }),
    })

    expect(location.skew).toBeUndefined()
    expect(location.notes.map((n) => n.code)).toContain('scope-retired')
  })
})

describe('birth chain (T-06610 seam)', () => {
  test('policy-born scopes report the chain as not-applicable', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({ ledger: ledgerStub(ledgerRow({ birthClass: 'policy-born' })) }),
    })

    expect(location.birthChain.state).toBe('not-applicable')
  })

  test('mechanism-born with no resolver wired reports unresolved, not empty', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({ ledger: ledgerStub(ledgerRow({ birthClass: 'mechanism-born' })) }),
    })

    expect(location.birthChain).toMatchObject({ state: 'unresolved' })
    expect(location.notes.map((n) => n.code)).toContain('birth-chain-unresolved')
  })

  test('mechanism-born resolves through the injected chain resolver', async () => {
    const ancestor = {
      scopeRef: 'agent:mable:project:hrc-runtime:task:parent',
      birthClass: 'policy-born' as const,
      homeNodeId: 'max3',
      authorityProvenance: { kind: 'policy' },
    }
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ birthClass: 'mechanism-born' })),
        resolveBirthChain: () => ({
          chain: [
            {
              scopeRef: SCOPE,
              birthClass: 'mechanism-born' as const,
              homeNodeId: 'max3',
              authorityProvenance: { kind: 'child-birth', parentScopeRef: ancestor.scopeRef },
            },
            ancestor,
          ],
          ancestor,
        }),
      }),
    })

    expect(location.birthChain).toMatchObject({ state: 'resolved' })
    expect(location.birthChain).toMatchObject({ ancestor: { birthClass: 'policy-born' } })
  })

  test('a chain that cannot be walked is reported, not thrown', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ birthClass: 'mechanism-born' })),
        resolveBirthChain: () => {
          throw new Error('birth chain cycle detected')
        },
      }),
    })

    expect(location.birthChain).toMatchObject({ state: 'unresolved' })
    expect((location.birthChain as { detail: string }).detail).toContain('cycle')
  })
})

describe('scanLedgerForSkew — the doctor surface', () => {
  test('finds pin-vs-binding skew across the ledger', async () => {
    const scan = await scanLedgerForSkew({
      localNodeId: 'max3',
      bindings: [
        ledgerRow({ scopeRef: SCOPE, homeNodeId: 'max3' }),
        ledgerRow({
          scopeRef: 'agent:mable:project:hrc-runtime:task:T-00001',
          homeNodeId: 'max3',
        }),
      ],
      policyFor: async (scopeRef) =>
        scopeRef === SCOPE ? policy({ pins: { [PIN_KEY]: 'mini' } }) : policy({ node: 'mini' }),
    })

    expect(scan.scanned).toBe(2)
    expect(scan.skewed).toHaveLength(1)
    expect(scan.skewed[0]?.scopeRef).toBe(SCOPE)
  })

  test('finds external-registration default_home_node skew across the ledger', async () => {
    const report = await scanLedgerForSkew({
      bindings: [
        ledgerRow({
          homeNodeId: 'max3',
          birthClass: 'mechanism-born',
          authorityProvenance: {
            kind: 'external-registration',
            registrationId: 'registration-t07150',
            classId: 'arris-svc-agent',
          },
          establishmentProvenance: 'explicit_local',
        }),
      ],
      localNodeId: 'max3',
      policyFor: async () => policy({ node: 'svc' }),
    })

    expect(report.skewed).toHaveLength(1)
    expect(report.skewed[0]?.skew).toMatchObject({
      kind: 'default-home-vs-binding',
      defaultHomeNodeId: 'svc',
      boundNodeId: 'max3',
    })
  })

  test('revoked rows are not scanned', async () => {
    const scan = await scanLedgerForSkew({
      localNodeId: 'max3',
      bindings: [ledgerRow({ state: 'revoked', homeNodeId: 'max3' })],
      policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
    })

    expect(scan.skewed).toHaveLength(0)
  })

  test('retired local rows are not reported as skew', async () => {
    const scan = await scanLedgerForSkew({
      localNodeId: 'max3',
      bindings: [ledgerRow({ homeNodeId: 'max3' })],
      policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
      retirementFor: () => ({
        retiredNodeId: 'max3',
        successorNodeId: 'mini',
        retiredPlacementEpoch: 1,
        reason: 'namespace reconciliation',
      }),
    })

    expect(scan.skewed).toHaveLength(0)
  })

  test('unreadable policy is reported separately from "no skew"', async () => {
    const scan = await scanLedgerForSkew({
      localNodeId: 'max3',
      bindings: [ledgerRow()],
      policyFor: async () => ({
        outcome: 'unreadable',
        detail: 'boom',
        profilePath: PROFILE,
      }),
    })

    expect(scan.skewed).toHaveLength(0)
    expect(scan.unreadable).toHaveLength(1)
  })
})
