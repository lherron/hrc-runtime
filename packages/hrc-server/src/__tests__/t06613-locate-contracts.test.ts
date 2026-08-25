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

import { type LocateDeps, type LocateObservedRuntime, locateScope } from '../federation/locate.js'
import type { PlacementPolicyResolution } from '../federation/placement-policy.js'
import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'

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

describe('locate — the three truths are reported separately', () => {
  test('declared policy, ledger home, and observed node each appear on their own', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'mini' })),
        policyFor: async () => policy({ node: 'max3' }),
        observedFor: () => [
          {
            runtimeId: 'rt-1',
            laneRef: 'main',
            status: 'idle',
            updatedAt: '2026-07-20T01:00:00.000Z',
          },
        ],
      }),
    })

    expect(location.declared).toMatchObject({ source: 'default_home_node', nodeId: 'max3' })
    expect(location.ledger).toMatchObject({ state: 'active' })
    expect(location.authority).toMatchObject({ state: 'bound', source: 'ledger', isLocal: false })
    expect(location.observed.nodeId).toBe('max3')
    expect(location.observed.scope).toBe('local-node-only')
    expect(location.observed.runtimeCount).toBe(1)
  })

  test('birth class and establishment provenance are surfaced from the binding', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(
          ledgerRow({ birthClass: 'policy-born', establishmentProvenance: 'explicit_local' })
        ),
      }),
    })

    expect(location.authority).toMatchObject({
      state: 'bound',
      record: { birthClass: 'policy-born', establishmentProvenance: 'explicit_local' },
    })
  })

  test('task-default is declared across projects, but an exact pin still overrides it', async () => {
    const taskDefaultLocation = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        policyFor: async () => policy({ homes: { 'T-06613': 'lab' }, node: 'svc' }),
      }),
    })
    expect(taskDefaultLocation.declared).toMatchObject({
      source: 'task-default',
      taskKey: 'T-06613',
      nodeId: 'lab',
    })

    const exactLocation = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        policyFor: async () =>
          policy({
            pins: { 'hrc-runtime:T-06613': 'max3' },
            homes: { 'T-06613': 'lab' },
          }),
      }),
    })
    expect(exactLocation.declared).toMatchObject({
      source: 'pin',
      pinKey: 'hrc-runtime:T-06613',
      nodeId: 'max3',
    })
  })

  test('ledger-first: an active local binding short-circuits the registry consult', async () => {
    let consulted = false
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow()),
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
    expect(location.authority).toMatchObject({ source: 'ledger' })
  })

  test('a revoked ledger row is not authority — the registry is still consulted', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ state: 'revoked' })),
        registry: registryStub({ outcome: 'bound', binding: ledgerRow({ homeNodeId: 'mini' }) }),
      }),
    })

    expect(location.ledger).toMatchObject({ state: 'revoked' })
    expect(location.authority).toMatchObject({ state: 'bound', source: 'registry' })
    expect(location.authority).toMatchObject({ record: { homeNodeId: 'mini' } })
  })

  test('a revoked local epoch is visibly nowhere while the registry still names it', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ state: 'revoked', placementEpoch: 3 })),
        registry: registryStub({
          outcome: 'bound',
          binding: ledgerRow({ homeNodeId: 'max3', placementEpoch: 3 }),
        }),
      }),
    })

    expect(location.ledger).toMatchObject({ state: 'revoked' })
    expect(location.registry).toMatchObject({
      outcome: 'bound',
      record: { homeNodeId: 'max3', placementEpoch: 3 },
    })
    expect(location.authority).toEqual({ state: 'unbound' })
    expect(location.notes).toContainEqual(expect.objectContaining({ code: 'rebind-revoked' }))
  })

  test('a rebound local epoch is visibly nowhere until its ledger activation lands', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        localNodeId: 'lab',
        ledger: ledgerStub(undefined),
        registry: registryStub({
          outcome: 'bound',
          binding: ledgerRow({
            homeNodeId: 'lab',
            placementEpoch: 4,
            establishmentProvenance: 'rebind',
            priorHomeNodeId: 'max3',
          }),
        }),
      }),
    })

    expect(location.registry).toMatchObject({
      outcome: 'bound',
      record: { homeNodeId: 'lab', placementEpoch: 4 },
    })
    expect(location.authority).toEqual({ state: 'unbound' })
    expect(location.notes).toContainEqual(
      expect.objectContaining({ code: 'rebind-activation-pending' })
    )
  })
})

describe('skew — governing placement constraints disagreeing with a binding', () => {
  test('pin pointing away from the established binding is SKEW', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3', placementEpoch: 3 })),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
      }),
    })

    expect(location.skew).toBeDefined()
    expect(location.skew).toMatchObject({
      kind: 'pin-vs-binding',
      pinKey: PIN_KEY,
      pinnedNodeId: 'mini',
      boundNodeId: 'max3',
      placementEpoch: 3,
    })
  })

  test('skew does not move authority: the established home still holds it', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
      }),
    })

    expect(location.authority).toMatchObject({ state: 'bound', record: { homeNodeId: 'max3' } })
    expect(location.skew?.detail).toContain('keeps summon authority')
    expect(location.skew?.detail).toContain('NOT acted on')
  })

  test('the diagnostic names manual rebuild, not an automatic fix', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
      }),
    })

    expect(location.skew?.detail).toContain('rebuild')
    expect(location.skew?.detail).toContain('nothing reconciles automatically')
  })

  test('a pin AGREEING with the binding is not skew', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'max3' } }),
      }),
    })

    expect(location.skew).toBeUndefined()
    expect(location.notes.map((note) => note.code)).toContain('pin-honored')
  })

  test('a task-default has the same skew semantics and names its matched line', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3', placementEpoch: 3 })),
        policyFor: async () => policy({ homes: { 'T-06613': 'lab' } }),
      }),
    })

    expect(location.skew).toMatchObject({
      kind: 'task-default-vs-binding',
      taskKey: 'T-06613',
      taskDefaultNodeId: 'lab',
      boundNodeId: 'max3',
    })
    expect(location.skew?.detail).toContain('[placement.homes] "T-06613" = "lab"')
  })

  test('a task-default agreeing with the binding is not skew', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'lab' })),
        policyFor: async () => policy({ homes: { 'T-06613': 'lab' } }),
      }),
    })

    expect(location.skew).toBeUndefined()
    expect(location.notes.map((note) => note.code)).toContain('task-default-honored')
  })

  test('an external-registration binding away from default_home_node is skew', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(
          ledgerRow({
            homeNodeId: 'max3',
            birthClass: 'mechanism-born',
            authorityProvenance: {
              kind: 'external-registration',
              registrationId: 'registration-t07150',
              classId: 'arris-svc-agent',
            },
            establishmentProvenance: 'explicit_local',
          })
        ),
        policyFor: async () => policy({ node: 'svc' }),
      }),
    })

    expect(location.skew).toMatchObject({
      kind: 'default-home-vs-binding',
      defaultHomeNodeId: 'svc',
      boundNodeId: 'max3',
      placementEpoch: 1,
    })
  })

  test('a pin on an UNBOUND scope is not skew — there is nothing to disagree with', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub({ outcome: 'unbound' }),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'mini' } }),
      }),
    })

    expect(location.authority).toMatchObject({ state: 'unbound' })
    expect(location.skew).toBeUndefined()
  })

  test("a pin for a SIBLING task does not read as this scope's pin", async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ pins: { 'hrc-runtime:T-99999': 'mini' } }),
      }),
    })

    expect(location.skew).toBeUndefined()
    expect(location.declared.source).toBe('none')
  })
})

describe('NOT skew — expected divergence per provenance class', () => {
  const cases = [
    { provenance: 'explicit_local' as const, boundTo: 'mini' },
    { provenance: 'default_home_node' as const, boundTo: 'mini' },
    { provenance: 'default_home_node(local)' as const, boundTo: 'mini' },
    { provenance: 'rebind' as const, boundTo: 'mini' },
  ]

  for (const { provenance, boundTo } of cases) {
    test(`unpinned scope established on "${boundTo}" by ${provenance} is expected, not skew`, async () => {
      const location = await locateScope({
        scopeRef: SCOPE,
        deps: deps({
          ledger: ledgerStub(
            ledgerRow({ homeNodeId: boundTo, establishmentProvenance: provenance })
          ),
          // default_home_node says max3; the scope lives on mini. Expected.
          policyFor: async () => policy({ node: 'max3' }),
        }),
      })

      expect(location.skew).toBeUndefined()
      const note = location.notes.find((n) => n.code === 'unpinned-established-elsewhere')
      expect(note).toBeDefined()
      expect(note?.detail).toContain('Not skew')
      expect(note?.detail).toContain('does not constrain')
      // Provenance is what makes it explainable — it must be reachable.
      expect(location.authority).toMatchObject({
        record: { establishmentProvenance: provenance },
      })
    })
  }

  test('a profile with NO placement stanza never produces skew', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'mini' })),
        policyFor: async () => policy(undefined),
      }),
    })

    expect(location.skew).toBeUndefined()
    expect(location.declared.source).toBe('none')
  })

  test('provisioning.node = "local" is reported unavailable as a deleted sentinel', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        localNodeId: 'max3',
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ node: 'local' }),
      }),
    })

    expect(location.declared).toMatchObject({ source: 'unavailable' })
    expect(location.skew).toBeUndefined()
  })

  test('a pin of "local" is reported invalid rather than silently treated as a pin', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'mini' })),
        policyFor: async () => policy({ pins: { [PIN_KEY]: 'local' } }),
      }),
    })

    expect(location.declared.source).toBe('pin-invalid')
    // An invalid pin is not a pin, so it cannot be half of a skew pair.
    expect(location.skew).toBeUndefined()
  })
})
