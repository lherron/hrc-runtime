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
        defaultHomeNode?: string
        pins?: Record<string, string>
        taskDefaults?: Record<string, string>
      }
    | undefined
): PlacementPolicyResolution {
  return {
    outcome: 'resolved',
    profilePath: PROFILE,
    policy: {
      claimsTask: false,
      ...(placement === undefined
        ? {}
        : {
            placement: {
              ...(placement.defaultHomeNode === undefined
                ? {}
                : { defaultHomeNode: placement.defaultHomeNode }),
              pins: placement.pins ?? {},
              taskDefaults: placement.taskDefaults ?? {},
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
    policyFor: async () => policy({ defaultHomeNode: 'max3' }),
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
        policyFor: async () => policy({ defaultHomeNode: 'max3' }),
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
        policyFor: async () =>
          policy({ taskDefaults: { 'T-06613': 'lab' }, defaultHomeNode: 'svc' }),
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
            taskDefaults: { 'T-06613': 'lab' },
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

describe('skew — a PIN disagreeing with an established binding, and nothing else', () => {
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
        policyFor: async () => policy({ taskDefaults: { 'T-06613': 'lab' } }),
      }),
    })

    expect(location.skew).toMatchObject({
      kind: 'task-default-vs-binding',
      taskKey: 'T-06613',
      taskDefaultNodeId: 'lab',
      boundNodeId: 'max3',
    })
    expect(location.skew?.detail).toContain('[placement.task-defaults] "T-06613" = "lab"')
  })

  test('a task-default agreeing with the binding is not skew', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'lab' })),
        policyFor: async () => policy({ taskDefaults: { 'T-06613': 'lab' } }),
      }),
    })

    expect(location.skew).toBeUndefined()
    expect(location.notes.map((note) => note.code)).toContain('task-default-honored')
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
          policyFor: async () => policy({ defaultHomeNode: 'max3' }),
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

  test('default_home_node = "local" resolves to this node and is reported as such', async () => {
    const location = await locateScope({
      scopeRef: SCOPE,
      deps: deps({
        localNodeId: 'max3',
        ledger: ledgerStub(ledgerRow({ homeNodeId: 'max3' })),
        policyFor: async () => policy({ defaultHomeNode: 'local' }),
      }),
    })

    expect(location.declared).toMatchObject({
      source: 'default_home_node(local)',
      nodeId: 'max3',
    })
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
        scopeRef === SCOPE
          ? policy({ pins: { [PIN_KEY]: 'mini' } })
          : policy({ defaultHomeNode: 'mini' }),
    })

    expect(scan.scanned).toBe(2)
    expect(scan.skewed).toHaveLength(1)
    expect(scan.skewed[0]?.scopeRef).toBe(SCOPE)
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
