import { describe, expect, test } from 'bun:test'

import type { PlacementBinding } from 'hrc-store-sqlite'

import {
  parseOptionalBirthCredential,
  parseOptionalChildDispatchIntent,
} from '../federation/birth-credential.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { type SummonGateDeps, evaluateSummonGate } from '../federation/summon-gate.js'

const PARENT_SCOPE = 'agent:room-coordinator:project:wrkq:task:T-06674'
const TARGET_SCOPE = 'agent:clod:project:hrc-runtime:task:T-06674'
const CREDENTIAL = 'rt-live-parent'

const provenance = {
  kind: 'child-birth' as const,
  parentScopeRef: PARENT_SCOPE,
  parentRuntimeId: CREDENTIAL,
  parentRunId: 'run-live-parent',
}

function registry(
  result: { outcome: 'unbound' } | { outcome: 'bound'; binding: PlacementBinding }
): BindingRegistryClient {
  return {
    async consult() {
      return result
    },
    async establish() {
      throw new Error('pure gate tests do not commit establishment')
    },
  }
}

function deps(overrides: Partial<SummonGateDeps> = {}): SummonGateDeps {
  return {
    mode: 'enforce',
    federationConfigured: true,
    localNodeId: 'svc',
    ledger: { activeAuthority: () => undefined },
    registry: registry({ outcome: 'unbound' }),
    policyFor: async () => ({
      placement: {
        pins: { 'hrc-runtime:T-06674': 'lab' },
        defaultHomeNode: 'svc',
      },
      claimsTask: false,
    }),
    capabilityFor: async () => ({ outcome: 'capable' }),
    validateBirthCredential: () => ({ valid: true, provenance }),
    ...overrides,
  }
}

describe('T-06674 live-parent origin and target-bound child intent', () => {
  test.each(['resolve-session', 'ensure-target'] as const)(
    'valid ambient credential on %s follows ordinary placement',
    async (path) => {
      const result = await evaluateSummonGate({
        scopeRef: TARGET_SCOPE,
        path,
        intent: 'implicit',
        birthCredential: CREDENTIAL,
        deps: deps(),
      })

      expect(result.evaluation).toMatchObject({
        decision: 'refuse',
        reason: 'pin-mismatch',
        homeNodeId: 'lab',
      })
    }
  )

  test.each([
    ['malformed or unknown', 'invalid-birth-credential' as const],
    ['dead parent', 'zombie-runtime' as const],
  ])('%s credential refuses before authority classification', async (_label, reason) => {
    const result = await evaluateSummonGate({
      scopeRef: TARGET_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      birthCredential: 'bad-parent',
      childDispatchIntent: { targetScopeRef: TARGET_SCOPE },
      deps: deps({
        validateBirthCredential: () => ({ valid: false, reason, diagnostic: reason }),
      }),
    })

    expect(result.evaluation).toMatchObject({ decision: 'refuse', reason })
    expect(result.enforced).toBe(true)
  })

  test('child intent without a credential refuses', async () => {
    const result = await evaluateSummonGate({
      scopeRef: TARGET_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      childDispatchIntent: { targetScopeRef: TARGET_SCOPE },
      deps: deps(),
    })

    expect(result.evaluation).toMatchObject({
      decision: 'refuse',
      reason: 'invalid-child-dispatch-intent',
    })
  })

  test('valid cross-agent child intent on a globally unbound pinned target is local mechanism birth', async () => {
    const result = await evaluateSummonGate({
      scopeRef: TARGET_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      birthCredential: CREDENTIAL,
      childDispatchIntent: { targetScopeRef: TARGET_SCOPE },
      deps: deps(),
    })

    expect(result.evaluation).toEqual({
      decision: 'allow',
      reason: 'child-birth',
      homeNodeId: 'svc',
      birthClass: 'mechanism-born',
      authorityProvenance: provenance,
    })
  })

  test('existing collective binding wins over valid child authority', async () => {
    const binding: PlacementBinding = {
      scopeRef: TARGET_SCOPE,
      homeNodeId: 'lab',
      placementEpoch: 4,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
      state: 'active',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }
    const result = await evaluateSummonGate({
      scopeRef: TARGET_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      birthCredential: CREDENTIAL,
      childDispatchIntent: { targetScopeRef: TARGET_SCOPE },
      deps: deps({ registry: registry({ outcome: 'bound', binding }) }),
    })

    expect(result.evaluation).toMatchObject({
      decision: 'refuse',
      reason: 'bound-elsewhere',
      homeNodeId: 'lab',
    })
  })

  test('ambient credential cannot reclassify a claims_task policy summon', async () => {
    const result = await evaluateSummonGate({
      scopeRef: TARGET_SCOPE,
      path: 'command-run',
      intent: 'implicit',
      birthCredential: CREDENTIAL,
      deps: deps({
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'svc' },
          claimsTask: true,
        }),
      }),
    })

    expect(result.evaluation).toMatchObject({
      decision: 'allow',
      reason: 'virgin-establishment',
    })
    expect('birthClass' in result.evaluation).toBe(false)
  })

  test('child intent is exact-target bound', async () => {
    const result = await evaluateSummonGate({
      scopeRef: TARGET_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      birthCredential: CREDENTIAL,
      childDispatchIntent: {
        targetScopeRef: 'agent:clod:project:hrc-runtime:task:T-OTHER',
      },
      deps: deps(),
    })

    expect(result.evaluation).toMatchObject({
      decision: 'refuse',
      reason: 'invalid-child-dispatch-intent',
    })
  })

  test('wire parsers reject malformed origin and child-intent shapes', () => {
    expect(() => parseOptionalBirthCredential({})).toThrow('birthCredential')
    expect(() => parseOptionalChildDispatchIntent('child')).toThrow('childDispatchIntent')
    expect(() => parseOptionalChildDispatchIntent({ targetScopeRef: ' ' })).toThrow(
      'childDispatchIntent.targetScopeRef'
    )
  })
})
