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
    placementEpoch: 1,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'default_home_node' },
    establishmentProvenance: 'default_home_node',
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
      placement: { pins: {}, taskDefaults: {}, defaultHomeNode: 'max3' },
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
      placement: { pins: { 'hrc-runtime:T-06608': 'lab' }, defaultHomeNode: 'max3' },
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
          placement: { pins: { 'hrc-runtime:T-06608': 'max3' }, defaultHomeNode: 'lab' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    expect(result.evaluation.reason).toBe('virgin-establishment')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    // Pin beats default_home_node.
    expect(result.evaluation.establishmentProvenance).toBe('pin')
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
            taskDefaults: { 'T-06608': 'lab' },
            defaultHomeNode: 'max3',
          },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('pin-mismatch')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
    expect(result.evaluation.diagnostic).toContain('[placement.task-defaults]')
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
            taskDefaults: { 'T-06608': 'lab' },
            defaultHomeNode: 'svc',
          },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.establishmentProvenance).toBe('pin')
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
            taskDefaults: { 'T-06608': 'lab' },
            defaultHomeNode: 'svc',
          },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.establishmentProvenance).toBe('task_default')
    expect(result.evaluation.homeNodeId).toBe('lab')
  })
})

describe('undeclared placement — visible refusal naming the stanza line', () => {
  test('agentPolicy omitted entirely (legacy profile) refuses naming the exact line to add', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ policyFor: async () => undefined }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('undeclared-placement')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    // Must name the stanza AND the exact line, never a bare "not configured".
    expect(result.evaluation.diagnostic).toContain('[placement]')
    expect(result.evaluation.diagnostic).toContain('default_home_node = "max3"')
    expect(result.evaluation.diagnostic).toContain('agent-profile.toml')
  })

  test('policy present but no pin and no default_home_node refuses the same way', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ policyFor: async () => ({ placement: { pins: {} }, claimsTask: false }) }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('undeclared-placement')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.diagnostic).toContain('default_home_node = "max3"')
  })

  test('never a silent fallback: undeclared does NOT resolve to the local node', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ policyFor: async () => undefined }),
    })
    expect(result.evaluation.decision).toBe('refuse')
  })
})

describe('default_home_node routing', () => {
  test('default naming this node allows virgin establishment', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'max3' },
          claimsTask: false,
        }),
      }),
    })
    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.establishmentProvenance).toBe('default_home_node')
  })

  test('default naming another node refuses toward home, never spawns', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'lab' },
          claimsTask: false,
        }),
      }),
    })
    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('routed-elsewhere')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
  })

  test('default_home_node = "local" resolves ONCE to this daemon\'s own configured nodeId', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'lab',
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'local' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
    // Provenance records the sentinel, not the resolved value.
    expect(result.evaluation.establishmentProvenance).toBe('default_home_node(local)')
  })

  test('"local" is invalid in a pin — a pin meaning "wherever" is not a pin', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          placement: { pins: { 'hrc-runtime:T-06608': 'local' }, defaultHomeNode: 'max3' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('invalid-pin')
  })
})

describe('advisory mode — evaluates and logs, enforces nothing', () => {
  test('a refusal in advisory mode is never enforced', async () => {
    for (const path of ALL_PATHS) {
      const result = await evaluateSummonGate({
        scopeRef: SCOPE,
        path,
        intent: 'implicit',
        deps: deps({ mode: 'advisory', ledger: ledgerStub(binding({ homeNodeId: 'lab' })) }),
      })
      expect(result.evaluation.decision).toBe('refuse')
      expect(result.enforced).toBe(false)
    }
  })

  test('the same refusal in enforce mode IS enforced (T-06616 flips this, not F0)', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ mode: 'enforce', ledger: ledgerStub(binding({ homeNodeId: 'lab' })) }),
    })
    expect(result.evaluation.decision).toBe('refuse')
    expect(result.enforced).toBe(true)
  })

  test('enforce mode still allows what advisory allows — mode changes behavior only, not decisions', async () => {
    const advisory = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ mode: 'advisory', ledger: ledgerStub(binding({ homeNodeId: 'max3' })) }),
    })
    const enforce = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ mode: 'enforce', ledger: ledgerStub(binding({ homeNodeId: 'max3' })) }),
    })
    expect(advisory.evaluation).toEqual(enforce.evaluation)
    expect(enforce.enforced).toBe(false)
  })
})

describe('advisory log content — the soak data T-06615 collects', () => {
  test('a would-be refusal logs path, scope, reason, and would-be decision', async () => {
    const logged: Array<{ event: string; details: Record<string, unknown> }> = []
    await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'archived-successor',
      intent: 'implicit',
      deps: deps({
        mode: 'advisory',
        ledger: ledgerStub(binding({ homeNodeId: 'lab' })),
        log: (_level, event, details) => logged.push({ event, details: details ?? {} }),
      }),
    })

    expect(logged).toHaveLength(1)
    const entry = logged[0]!
    // One event name across advisory and enforce: a single grep pattern covers
    // the soak and everything after the T-06616 flip.
    expect(entry.event).toBe('federation.summon_gate.refusal')
    expect(entry.details['enforced']).toBe(false)
    expect(entry.details['path']).toBe('archived-successor')
    expect(entry.details['scopeRef']).toBe(SCOPE)
    expect(entry.details['reason']).toBe('bound-elsewhere')
    expect(entry.details['wouldBeDecision']).toBe('refuse')
    expect(entry.details['mode']).toBe('advisory')
    expect(entry.details['homeNodeId']).toBe('lab')
    // T-06609 replaced the provisional derivation with the typed field; soak
    // records now say the intent came from the caller, not from an inference.
    expect(entry.details['intent']).toBe('implicit')
    expect(entry.details['intentSource']).toBe('typed')
  })

  test('allows are not logged as refusals (soak data stays signal, not noise)', async () => {
    const logged: unknown[] = []
    await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        ledger: ledgerStub(binding({ homeNodeId: 'max3' })),
        log: (_l, event) => {
          if (event === 'federation.summon_gate.refusal') logged.push(event)
        },
      }),
    })
    expect(logged).toEqual([])
  })

  test('dark mode logs nothing at all', async () => {
    const logged: unknown[] = []
    await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ federationConfigured: false, log: (_l, event) => logged.push(event) }),
    })
    expect(logged).toEqual([])
  })
})

describe('scope retirement (T-06614 C-11125) — checked before authority logic', () => {
  const retired = {
    retiredNodeId: 'max3',
    canonicalHomeNodeId: 'lab',
    canonicalPlacementEpoch: 2,
    reason: 'namespace_reconciliation',
  }

  test('a retirement OVERRIDES an active local ledger row on the losing node', async () => {
    // The losing node legitimately holds active authority — it established the
    // scope independently pre-federation. If retirement were checked after the
    // ledger, this would allow and reconciliation would never bind.
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'archived-successor',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'max3',
        ledger: ledgerStub(binding({ homeNodeId: 'max3' })),
        retirementFor: () => retired,
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('scope-retired')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
    expect(result.evaluation.diagnostic).toContain('lab')
  })

  test('a retirement for ANOTHER node does not affect this one', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'max3',
        ledger: ledgerStub(binding({ homeNodeId: 'max3' })),
        retirementFor: () => ({ ...retired, retiredNodeId: 'lab', canonicalHomeNodeId: 'max3' }),
      }),
    })
    expect(result.evaluation.decision).toBe('allow')
    expect(result.evaluation.reason).toBe('local-authority')
  })

  test('retirement is not consulted when the gate is dark', async () => {
    let calls = 0
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        federationConfigured: false,
        retirementFor: () => {
          calls += 1
          return retired
        },
      }),
    })
    expect(result.evaluation.reason).toBe('gate-dark')
    expect(calls).toBe(0)
  })

  test('retirement refusal is advisory during the F0 soak, enforced after the flip', async () => {
    const advisory = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'archived-successor',
      intent: 'implicit',
      deps: deps({ localNodeId: 'max3', retirementFor: () => retired }),
    })
    expect(advisory.enforced).toBe(false)

    const enforcing = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'archived-successor',
      intent: 'implicit',
      deps: deps({ mode: 'enforce', localNodeId: 'max3', retirementFor: () => retired }),
    })
    expect(enforcing.enforced).toBe(true)
  })
})

describe('gate never throws on the session-creation path', () => {
  test('a policy resolution failure degrades to a visible refusal, not an exception', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => {
          throw new Error('agent root missing SOUL.md')
        },
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('policy-unavailable')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.retryable).toBe(true)
    expect(result.evaluation.diagnostic).toContain('SOUL.md')
  })

  test('an unclassified registry throw fails CLOSED, never reads as unbound', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ registry: registryStub(new Error('something nobody anticipated')) }),
    })

    // An unclassified failure reading as `unbound` would mint a SECOND authority.
    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('registry-unreachable')
  })
})
