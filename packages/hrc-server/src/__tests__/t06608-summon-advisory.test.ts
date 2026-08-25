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

import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import {
  type SummonGateDeps,
  type SummonPath,
  evaluateSummonGate,
} from '../federation/summon-gate.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06608'
const _OTHER_SCOPE = 'agent:mable:project:hrc-runtime:task:lab'

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
    expect(result.placement).toMatchObject({
      outcome: 'refuse',
      reason: 'undeclared-placement',
      retryable: false,
    })
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    // Must name the stanza AND the exact line, never a bare "not configured".
    expect(result.evaluation.diagnostic).toContain('[provisioning]')
    expect(result.evaluation.diagnostic).toContain('node = "max3"')
    expect(result.evaluation.diagnostic).toContain('agent-profile.toml')
  })

  /**
   * REVERSED BY T-07398 v3 (spec addendum, DEFECT CYCLE 1 item 1 / C-15413 D1).
   *
   * This test asserted the pre-v3 law. v3 deleted the
   * `default_home_node = "local"` sentinel and moved its meaning onto the ABSENT
   * key, so a resolved profile that declares no `provisioning.node` now means
   * "born here" rather than "undeclared". Under the old assertion every implicit
   * summon of a fresh task scope — every `hrcchat dm <agent>@<proj>:<new-task>` —
   * died with "No placement declared ...".
   *
   * Kept as a real assertion of the NEW law rather than deleted, and its two
   * siblings in this describe are untouched: `policyFor → undefined` (no policy
   * determinable at all) still refuses, and still names the stanza line.
   */
  test('policy present but no pin and no default_home_node is born HERE (v3)', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({ placement: { pins: {}, homes: {} }, claimsTask: false }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('max3')
    expect(result.evaluation.establishmentProvenance).toBe('default_home_node(local)')
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
          provisioning: { node: 'max3' },
          placement: { pins: {}, homes: {} },
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
          provisioning: { node: 'lab' },
          placement: { pins: {}, homes: {} },
          claimsTask: false,
        }),
      }),
    })
    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('routed-elsewhere')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.homeNodeId).toBe('lab')
  })

  test('provisioning.node = "local" is rejected as a deleted sentinel', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'lab',
        policyFor: async () => ({
          provisioning: { node: 'local' },
          placement: { pins: {}, homes: {} },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('invalid-pin')
  })

  test('"local" is invalid in a pin — a pin meaning "wherever" is not a pin', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        policyFor: async () => ({
          provisioning: { node: 'max3' },
          placement: { pins: { 'hrc-runtime:T-06608': 'local' }, homes: {} },
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
    successorNodeId: 'lab',
    retiredPlacementEpoch: 2,
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
        retirementFor: () => ({ ...retired, retiredNodeId: 'lab', successorNodeId: 'max3' }),
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
