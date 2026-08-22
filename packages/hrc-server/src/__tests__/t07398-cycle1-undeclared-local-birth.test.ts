/**
 * T-07398 DEFECT CYCLE 1, D1 — an undeclared scope with no `provisioning.node`
 * is born HERE, not refused.
 *
 * v3 deleted the `"local"` sentinel and made OMISSION mean it: a profile that
 * declares no `provisioning.node` is saying "born locally", and the amended
 * derivation ends at the platform default rather than at a refusal. The gate
 * still carries the pre-v3 `undeclared-placement` refusal on that branch, so on
 * the installed surface EVERY plain `hrcchat dm <agent>@<proj>:<fresh-task>`
 * dies with "[stale_context] No placement declared ..." (C-15413 D1) — the
 * collective's core dispatch workflow, broken for every future task scope.
 *
 * The `implicit` intent is the whole point: `explicit_local` already falls
 * through to the local node, which is why `hrc start` kept working while the
 * dm/ensure door did not. These cases are all `implicit`.
 */

import { describe, expect, test } from 'bun:test'

import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import { type SummonGateDeps, evaluateSummonGate } from '../federation/summon-gate.js'

const SCOPE = 'agent:clod:project:hrc-runtime:task:t07402smoke5'
const LOCAL_NODE = 'hrcdev'

function registryStub(): BindingRegistryClient {
  return {
    async consult(): Promise<RegistryConsultResult> {
      return { outcome: 'unbound' }
    },
    async establish() {
      throw new Error('establish must not be called from the gate evaluation path')
    },
  }
}

/**
 * clod's real profile shape for this defect: a `[placement]` stanza that speaks
 * for other scopes, and NO `provisioning.node` at all.
 */
function deps(overrides: Partial<SummonGateDeps> = {}): SummonGateDeps {
  return {
    mode: 'enforce',
    federationConfigured: true,
    localNodeId: LOCAL_NODE,
    ledger: { activeAuthority: () => undefined },
    registry: registryStub(),
    knownNodeIds: [LOCAL_NODE, 'max3', 'lab'],
    policyFor: async () => ({
      placement: { pins: {}, homes: {} },
      claimsTask: false,
    }),
    ...overrides,
  } as unknown as SummonGateDeps
}

describe('T-07398 cycle 1 D1 — the dm/ensure door births undeclared scopes locally', () => {
  test('an implicit summon with no provisioning.node lands on this node, with or without a directive', async () => {
    const cases: Array<{ label: string; provision?: Record<string, unknown> }> = [
      // The blocking regression: a plain `hrcchat dm` to a fresh task scope.
      { label: 'no directive' },
      // "Both provisioning doors honor directives": a node= naming this node is
      // an agreeing directive on an undeclared scope, so it births here too.
      { label: 'node= naming this node', provision: { node: LOCAL_NODE } },
      // A non-placement scalar carries no placement opinion at all; it must not
      // turn a birth into a refusal.
      { label: 'model= only', provision: { model: 'sonnet' } },
    ]

    for (const { label, provision } of cases) {
      const result = await evaluateSummonGate({
        scopeRef: SCOPE,
        path: 'ensure-target',
        intent: 'implicit',
        deps: deps(),
        ...(provision === undefined ? {} : { provision }),
      })

      expect({ label, decision: result.evaluation.decision }).toEqual({
        label,
        decision: 'allow',
      })
      expect({ label, homeNodeId: result.evaluation.homeNodeId }).toEqual({
        label,
        homeNodeId: LOCAL_NODE,
      })
    }
  })
})
