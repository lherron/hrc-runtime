import { describe, expect, test } from 'bun:test'

import type { BirthDesignationRecord, BirthDesignationResult } from 'hrc-store-sqlite'

import { RegistryUnreachableError } from '../federation/registry-client.js'
import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import { type SummonGateDeps, evaluateSummonGate } from '../federation/summon-gate.js'

/**
 * T-07655 — the gate's tier-5 birth designation.
 *
 * The branch under test is the T-07398 v3 "omission means local" line, which is
 * the ONLY one a designation may touch: every declared tier answers above it,
 * and an operator's explicit start answers before that. The tests therefore all
 * use a profile with a `[placement]` stanza that speaks for nothing and no
 * `provisioning.node` — clod's real shape, and the shape three task scopes were
 * born on three different nodes under on 2026-08-28.
 */

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-07655'
const LOCAL_NODE = 'svc'

const DESIGNATION: BirthDesignationRecord = {
  scopeRef: SCOPE,
  homeNodeId: 'max3',
  provenance: 'default_home_node(sender)',
  birthEnvelopeId: 'EN-00722',
  senderScopeRef: 'agent:mable:project:wrkq:task:primary',
  designationEpoch: 1,
  designatedAt: '2026-08-28T05:00:00.000Z',
  state: 'live',
}

function registryStub(
  designateBirth?: (scopeRef: string) => Promise<BirthDesignationResult>
): BindingRegistryClient {
  return {
    async consult(): Promise<RegistryConsultResult> {
      return { outcome: 'unbound' }
    },
    async establish() {
      throw new Error('establish must not be called from the gate evaluation path')
    },
    ...(designateBirth === undefined ? {} : { designateBirth }),
  }
}

function deps(overrides: Partial<SummonGateDeps> = {}): SummonGateDeps {
  return {
    mode: 'enforce',
    federationConfigured: true,
    localNodeId: LOCAL_NODE,
    ledger: { activeAuthority: () => undefined },
    registry: registryStub(),
    knownNodeIds: [LOCAL_NODE, 'max3', 'lab'],
    policyFor: async () => ({ placement: { pins: {}, homes: {} }, claimsTask: false }),
    ...overrides,
  } as unknown as SummonGateDeps
}

describe('T-07655 tier-5 birth designation in the summon gate', () => {
  test('a designation naming another node refuses this node without claiming anything', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        registry: registryStub(async () => ({ kind: 'designated', designation: DESIGNATION })),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    // NOT `routed-elsewhere`: that reason invites a remote-establish
    // disposition, and a designated birth is never delegated — the designated
    // node's own kicker births it from the same ledger insert.
    expect(result.evaluation.reason).toBe('birth-designated-elsewhere')
    expect(result.evaluation.homeNodeId).toBe('max3')
    expect(result.evaluation.birthDesignation).toEqual(DESIGNATION)
    expect(result.placement?.outcome).toBe('refuse')
    // The diagnostic must name the sender and the way out, so an operator does
    // not have to reconstruct either from the ledger by hand.
    expect(result.evaluation.diagnostic).toContain('agent:mable:project:wrkq:task:primary')
    expect(result.evaluation.diagnostic).toContain('EN-00722')
  })

  test('the designated node establishes under the birth-designation fence', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'max3',
        registry: registryStub(async () => ({ kind: 'designated', designation: DESIGNATION })),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.reason).toBe('virgin-establishment')
    expect(result.evaluation.birthDesignation).toEqual({ action: 'enforce-designated-home' })
    expect(result.evaluation.homeNodeId).toBe('max3')
  })

  // Out of scope by ruling: a sender with no scope, no binding, or no birth
  // envelope keeps today's CAS-arbitrated local tier 5, with `+node=` to steer.
  test('a `none` answer falls through to the pre-existing local tier 5', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({ registry: registryStub(async () => ({ kind: 'none' })) }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.birthDesignation).toBeUndefined()
    expect(result.evaluation.homeNodeId).toBe(LOCAL_NODE)
  })

  // Acceptance 1(g) at the gate. There is no local fallback for a scoped
  // sender: falling back would fire on every node at once, and a birth cannot
  // be taken back.
  test('an unreachable registry refuses retryably instead of birthing locally', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        registry: registryStub(async () => {
          throw new RegistryUnreachableError('registry host is down')
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.reason).toBe('registry-unreachable')
    expect(result.evaluation.retryable).toBe(true)
  })

  // A designation nobody can act on must be VISIBLE rather than silently
  // deferred forever on every node.
  test('a designated home that is not a known peer is refused as unreachable', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        knownNodeIds: [LOCAL_NODE, 'lab'],
        registry: registryStub(async () => ({ kind: 'designated', designation: DESIGNATION })),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.reason).toBe('designated-home-unreachable')
    expect(result.evaluation.retryable).toBe(true)
    expect(result.evaluation.birthDesignation).toEqual(DESIGNATION)
  })

  // The precedence rule, proved from the gate's side: a designation is reached
  // only where tiers 1-4 are silent, so it can never be asked about a declared
  // scope and can never contradict one.
  test.each([
    ['an exact pin', { pins: { 'hrc-runtime:T-07655': LOCAL_NODE }, homes: {} }, 'pin'],
    ['a placement home', { pins: {}, homes: { 'T-07655': LOCAL_NODE } }, 'task_default'],
  ])(
    '%s answers without consulting the designation at all',
    async (_label, placement, supersededBy) => {
      let consulted = 0
      const result = await evaluateSummonGate({
        scopeRef: SCOPE,
        path: 'ensure-target',
        intent: 'implicit',
        deps: deps({
          policyFor: async () => ({ placement, claimsTask: false }),
          registry: registryStub(async () => {
            consulted += 1
            return { kind: 'designated', designation: DESIGNATION }
          }),
        }),
      })

      expect(consulted).toBe(0)
      expect(result.evaluation.decision).toBe('allow')
      if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
      expect(result.evaluation.birthDesignation).toEqual({ action: 'supersede', supersededBy })
    }
  )

  test.each([
    ['an operator start here', 'explicit_local' as const],
    ['a node= directive', 'default_home_node' as const],
  ])('%s answers without consulting the designation at all', async (_label, supersededBy) => {
    let consulted = 0
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: supersededBy === 'explicit_local' ? 'explicit_local' : 'implicit',
      ...(supersededBy === 'default_home_node' ? { provision: { node: LOCAL_NODE } } : {}),
      deps: deps({
        registry: registryStub(async () => {
          consulted += 1
          return { kind: 'designated', designation: DESIGNATION }
        }),
      }),
    })

    expect(consulted).toBe(0)
    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') throw new Error('unreachable')
    expect(result.evaluation.birthDesignation).toEqual({ action: 'supersede', supersededBy })
  })
})
