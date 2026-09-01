/**
 * T-06608 — summon gate core (federation spec §5, §11 F0).
 *
 * Advisory-only during the F0 soak: the gate EVALUATES on every
 * session-creation path and LOGS what it would refuse, but refuses nothing.
 * The enforce flip is T-06616.
 *
 * The registry consult client is a STUB here, matching the seam contract posted
 * to T-06608 (cody builds the real client). Fail-closed behavior is proven
 * against the stub; the integration proof lands with his client.
 */

import { describe, expect, test } from 'bun:test'

import type { PlacementBinding } from 'hrc-store-sqlite'

import {
  type BindingRegistryClient,
  type RegistryConsultResult,
  RegistryRefusedError,
  RegistryUnreachableError,
} from '../federation/registry-client.js'
import {
  type SummonGateDeps,
  type SummonPath,
  evaluateSummonGate,
  placementPinKey,
} from '../federation/summon-gate.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06608'
const OTHER_SCOPE = 'agent:mable:project:hrc-runtime:task:lab'

function binding(overrides: Partial<PlacementBinding> = {}): PlacementBinding {
  return {
    scopeRef: SCOPE,
    homeNodeId: 'max3',
    placementSource: 'default_home_node',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  } as PlacementBinding
}

/** Registry stub honoring the T-06608 seam contract. */
function registryStub(
  behavior: RegistryConsultResult | Error
): BindingRegistryClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async consult(scopeRef: string): Promise<RegistryConsultResult> {
      calls.push(scopeRef)
      if (behavior instanceof Error) throw behavior
      return behavior
    },
    async establish() {
      throw new Error('establish must not be called from the gate evaluation path')
    },
  }
}

function ledgerStub(row: PlacementBinding | undefined) {
  const calls: string[] = []
  return {
    calls,
    activeAuthority(scopeRef: string) {
      calls.push(scopeRef)
      return row === undefined ? undefined : { ...row, state: 'active' as const }
    },
  }
}

function deps(overrides: Partial<SummonGateDeps> = {}): SummonGateDeps {
  return {
    mode: 'advisory',
    federationConfigured: true,
    localNodeId: 'max3',
    ledger: ledgerStub(undefined),
    registry: registryStub({ outcome: 'unbound' }),
    policyFor: async () => ({
      provisioning: { node: 'max3' },
      placement: { pins: {}, homes: {} },
      claimsTask: false,
    }),
    ...overrides,
  } as SummonGateDeps
}

const ALL_PATHS: SummonPath[] = [
  'ensure-target',
  'archived-successor',
  'resolve-session',
  'command-run',
  'app-session',
]

describe('dark mode — zero behavior change, zero work', () => {
  test('no federation config: allows without touching ledger, registry, or policy', async () => {
    const ledger = ledgerStub(undefined)
    const registry = registryStub({ outcome: 'unbound' })
    let policyCalls = 0

    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        federationConfigured: false,
        ledger,
        registry,
        policyFor: async () => {
          policyCalls += 1
          return undefined
        },
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    expect(result.evaluation.reason).toBe('gate-dark')
    expect(result.enforced).toBe(false)
    // Dark must be genuinely dark: no consult, no ledger read, no policy resolve.
    expect(ledger.calls).toEqual([])
    expect(registry.calls).toEqual([])
    expect(policyCalls).toBe(0)
  })

  test('mode off with federation configured is still fully dark', async () => {
    const registry = registryStub({ outcome: 'unbound' })
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'implicit',
      deps: deps({ mode: 'off', registry }),
    })
    expect(result.evaluation.reason).toBe('gate-dark')
    expect(registry.calls).toEqual([])
  })

  test('dark on every session-creation path', async () => {
    for (const path of ALL_PATHS) {
      const result = await evaluateSummonGate({
        scopeRef: SCOPE,
        path,
        intent: 'implicit',
        deps: deps({ federationConfigured: false }),
      })
      expect(result.evaluation.decision).toBe('allow')
      expect(result.evaluation.reason).toBe('gate-dark')
    }
  })
})

describe('local ledger authority — the hot path, no network', () => {
  test('active local row for this node allows without consulting the registry', async () => {
    const registry = registryStub({ outcome: 'unbound' })
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ ledger: ledgerStub(binding({ homeNodeId: 'max3' })), registry }),
    })

    expect(result.evaluation.decision).toBe('allow')
    expect(result.evaluation.reason).toBe('local-authority')
    expect(result.placement).toMatchObject({
      outcome: 'local-bound',
      source: 'local-ledger',
      binding: { homeNodeId: 'max3' },
    })
    expect(registry.calls).toEqual([])
  })

  test('active local row naming another node refuses with visible skew naming that node', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ ledger: ledgerStub(binding({ homeNodeId: 'lab' })) }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('bound-elsewhere')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
    expect(result.placement).toMatchObject({
      outcome: 'remote-bound',
      binding: { homeNodeId: 'lab' },
    })
    expect(result.evaluation.diagnostic).toContain('lab')
  })
})

describe('registry consult — absence of a local row is not the virgin predicate', () => {
  test('no local row, registry bound elsewhere: refuse naming the bound node', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        registry: registryStub({ outcome: 'bound', binding: binding({ homeNodeId: 'lab' }) }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('bound-elsewhere')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
    // A policy edit alone must never read as authority.
    expect(result.evaluation.diagnostic).toContain('lab')
  })

  test('no local row, registry bound HERE: allow (heal), not virgin', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        registry: registryStub({ outcome: 'bound', binding: binding({ homeNodeId: 'max3' }) }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    expect(result.evaluation.reason).toBe('registry-bound-local')
  })

  test('registry unreachable: fail closed, visible, RETRYABLE', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ registry: registryStub(new RegistryUnreachableError('connect ECONNREFUSED')) }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('registry-unreachable')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.retryable).toBe(true)
    expect(result.evaluation.diagnostic.toLowerCase()).toContain('retry')
  })

  test('registry refused (401/400): fail closed, visible, NOT retryable, names config surface', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        registry: registryStub(new RegistryRefusedError(401, 'unauthorized')),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('registry-refused')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.retryable).toBe(false)
    expect(result.evaluation.diagnostic).toContain('federation.json')
  })
})

describe('placement policy — pins are hard constraints on every path', () => {
  const pinnedElsewhere = deps({
    policyFor: async () => ({
      provisioning: { node: 'max3' },
      placement: { pins: { 'hrc-runtime:T-06608': 'lab' }, homes: {} },
      claimsTask: false,
    }),
  })

  test('pin naming another node refuses on EVERY path, including explicit local start', async () => {
    for (const path of ALL_PATHS) {
      const result = await evaluateSummonGate({
        scopeRef: SCOPE,
        path,
        intent: 'explicit_local',
        deps: pinnedElsewhere,
      })
      expect(result.evaluation.decision).toBe('refuse')
      expect(result.evaluation.reason).toBe('pin-mismatch')
      if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
      expect(result.evaluation.homeNodeId).toBe('lab')
    }
  })

  test('pin naming this node allows virgin establishment with pin provenance', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          provisioning: { node: 'lab' },
          placement: { pins: { 'hrc-runtime:T-06608': 'max3' }, homes: {} },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    expect(result.evaluation.reason).toBe('virgin-establishment')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    // Pin beats default_home_node.
    expect(result.evaluation.placementSource).toBe('pin')
    expect(result.placement).toEqual({
      outcome: 'local-establish',
      kind: 'virgin-policy',
      homeNodeId: 'max3',
      provenance: 'pin',
    })
  })

  test('implicit virgin pin naming a peer resolves remote-establish without acting', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: pinnedElsewhere,
    })

    expect(result.placement).toEqual({
      outcome: 'remote-establish',
      kind: 'virgin-policy',
      candidateHomeNodeId: 'lab',
      reason: 'pin-mismatch',
      policyProvenance: 'pin',
    })
    expect((pinnedElsewhere.ledger as ReturnType<typeof ledgerStub>).calls).toContain(SCOPE)
    expect((pinnedElsewhere.registry as ReturnType<typeof registryStub>).calls).toContain(SCOPE)
  })

  test('pin key is the exact project:task scope key', () => {
    expect(placementPinKey(SCOPE)).toBe('hrc-runtime:T-06608')
    expect(placementPinKey(SCOPE, 'task-default')).toBe('T-06608')
    expect(placementPinKey(OTHER_SCOPE)).toBe('hrc-runtime:lab')
    // Scopes without a task have no pin key — they fall to default_home_node.
    expect(placementPinKey('agent:mable:project:hrc-runtime')).toBeUndefined()
  })
})

describe('placement task defaults — exact pin > task-default > explicit_local > default', () => {
  test('a declared base home applies to an exact reserved-family member', async () => {
    const familyScope = 'agent:mable:project:hrc-runtime:task:primary-nova'
    const result = await evaluateSummonGate({
      scopeRef: familyScope,
      path: 'resolve-session',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          placement: { pins: {}, homes: { primary: 'max3' } },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('max3')
    expect(result.evaluation.placementSource).toBe('task_default')
  })

  test('a reserved-looking task stays independent when its base is undeclared', async () => {
    const independentScope = 'agent:mable:project:hrc-runtime:task:research-nova'
    const result = await evaluateSummonGate({
      scopeRef: independentScope,
      path: 'resolve-session',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          provisioning: { node: 'lab' },
          placement: { pins: {}, homes: { primary: 'max3' } },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
  })

  test('a task-default beats explicit_local and names the matched line in its refusal', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'command-run',
      intent: 'explicit_local',
      deps: deps({
        localNodeId: 'max3',
        policyFor: async () => ({
          placement: {
            pins: {},
            homes: { 'T-06608': 'lab' },
          },
          provisioning: { node: 'max3' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('pin-mismatch')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
    expect(result.evaluation.diagnostic).toContain('[placement.homes]')
    expect(result.evaluation.diagnostic).toContain('"T-06608" = "lab"')
    expect(result.evaluation.diagnostic).not.toContain('is pinned')
  })

  test('an exact pin overrides a task-default for the same scope', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'max3',
        policyFor: async () => ({
          placement: {
            pins: { 'hrc-runtime:T-06608': 'max3' },
            homes: { 'T-06608': 'lab' },
          },
          provisioning: { node: 'svc' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.placementSource).toBe('pin')
    expect(result.evaluation.homeNodeId).toBe('max3')
  })

  test('a matching task-default routes implicit birth ahead of default_home_node', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'lab',
        policyFor: async () => ({
          placement: {
            pins: {},
            homes: { 'T-06608': 'lab' },
          },
          provisioning: { node: 'svc' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.placementSource).toBe('task_default')
    expect(result.evaluation.homeNodeId).toBe('lab')
  })
})
