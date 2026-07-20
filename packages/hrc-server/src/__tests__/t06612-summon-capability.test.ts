/**
 * T-06612 — materialization capability composes into the §5 summon gate.
 *
 * Authority is decided first. Only the home node asks whether it can actually
 * materialize the scope, and capability can never grant or move authority.
 */

import { describe, expect, test } from 'bun:test'

import type { PlacementBinding } from 'hrc-store-sqlite'

import type { BindingRegistryClient } from '../federation/registry-client.js'
import {
  type SummonCapabilityName,
  type SummonGateDeps,
  evaluateSummonGate,
} from '../federation/summon-gate.js'

const SCOPE = 'agent:larry:project:missing-project:task:T-06612'

function localBinding(homeNodeId = 'max3'): PlacementBinding {
  return {
    scopeRef: SCOPE,
    homeNodeId,
    placementEpoch: 1,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'default_home_node' },
    establishmentProvenance: 'default_home_node',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  } as PlacementBinding
}

function deps(overrides: Partial<SummonGateDeps> = {}): SummonGateDeps {
  const registry: BindingRegistryClient = {
    async consult() {
      return { outcome: 'unbound' }
    },
    async establish() {
      throw new Error('not used')
    },
  }

  return {
    mode: 'advisory',
    federationConfigured: true,
    localNodeId: 'max3',
    ledger: { activeAuthority: () => ({ ...localBinding(), state: 'active' }) },
    registry,
    policyFor: async () => ({
      placement: { pins: {}, defaultHomeNode: 'max3' },
      claimsTask: false,
    }),
    capabilityFor: async () => ({ outcome: 'capable' }),
    ...overrides,
  } as SummonGateDeps
}

describe('home-node materialization capability', () => {
  test('all capabilities present preserves the authority allow', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps(),
    })

    expect(result.evaluation).toMatchObject({ decision: 'allow', reason: 'local-authority' })
    expect(result.enforced).toBe(false)
  })

  for (const capability of [
    'project-checkout',
    'agent-home-skills',
    'credentials',
    'harness',
  ] as const satisfies readonly SummonCapabilityName[]) {
    test(`missing ${capability} is a visible, item-specific refusal`, async () => {
      const diagnostic = `${capability} absent at /node/${capability}`
      const result = await evaluateSummonGate({
        scopeRef: SCOPE,
        path: 'ensure-target',
        intent: 'implicit',
        deps: deps({
          capabilityFor: async () => ({
            outcome: 'incapable',
            capability,
            diagnostic,
          }),
        }),
      })

      expect(result.evaluation.decision).toBe('refuse')
      expect(result.evaluation.reason).toBe(`capability-${capability}-missing`)
      if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
      expect(result.evaluation.diagnostic).toBe(diagnostic)
      expect(result.evaluation.diagnostic).toContain(capability)
      // F0 is advisory: the exact refusal is evaluated, but does not bite.
      expect(result.enforced).toBe(false)
    })
  }

  test('advisory capability refusal uses the gate event with its distinct reason code', async () => {
    const entries: Array<{ event: string; details: Record<string, unknown> }> = []
    await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'archived-successor',
      intent: 'implicit',
      deps: deps({
        capabilityFor: async () => ({
          outcome: 'incapable',
          capability: 'project-checkout',
          diagnostic: 'project checkout absent at /missing-project',
        }),
        log: (_level, event, details) => entries.push({ event, details: details ?? {} }),
      }),
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('federation.summon_gate.refusal')
    expect(entries[0]?.details).toMatchObject({
      reason: 'capability-project-checkout-missing',
      capability: 'project-checkout',
      capability_source: 'presence-heuristic',
      enforced: false,
      mode: 'advisory',
    })
  })

  test('enforce mode makes the same capability refusal bite', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        mode: 'enforce',
        capabilityFor: async () => ({
          outcome: 'incapable',
          capability: 'harness',
          diagnostic: 'harness codex is unavailable',
        }),
      }),
    })

    expect(result.evaluation.reason).toBe('capability-harness-missing')
    expect(result.enforced).toBe(true)
  })
})

describe('capability is observed state, never authority', () => {
  test('a capable non-home node still refuses and never probes local capability', async () => {
    let capabilityCalls = 0
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        ledger: {
          activeAuthority: () => ({ ...localBinding('lab'), state: 'active' }),
        },
        capabilityFor: async () => {
          capabilityCalls += 1
          return { outcome: 'capable' }
        },
      }),
    })

    expect(result.evaluation).toMatchObject({
      decision: 'refuse',
      reason: 'bound-elsewhere',
      homeNodeId: 'lab',
    })
    expect(capabilityCalls).toBe(0)
  })

  test('non-agent scope abstains without probing capability', async () => {
    let capabilityCalls = 0
    const result = await evaluateSummonGate({
      scopeRef: 'app:discord',
      path: 'app-session',
      intent: 'implicit',
      deps: deps({
        capabilityFor: async () => {
          capabilityCalls += 1
          return { outcome: 'capable' }
        },
      }),
    })

    expect(result.evaluation).toEqual({ decision: 'allow', reason: 'non-agent-scope' })
    expect(capabilityCalls).toBe(0)
  })

  test('dark stays first: zero authority or capability work and zero events', async () => {
    let capabilityCalls = 0
    const events: string[] = []
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        federationConfigured: false,
        capabilityFor: async () => {
          capabilityCalls += 1
          return {
            outcome: 'incapable',
            capability: 'project-checkout',
            diagnostic: 'must never be observed',
          }
        },
        log: (_level, event) => events.push(event),
      }),
    })

    expect(result.evaluation).toEqual({ decision: 'allow', reason: 'gate-dark' })
    expect(capabilityCalls).toBe(0)
    expect(events).toEqual([])
  })
})
