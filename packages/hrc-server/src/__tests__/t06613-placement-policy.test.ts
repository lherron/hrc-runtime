/**
 * T-06613 — reading the declared `[placement]` stanza from the observed
 * declaration (T-08597: aspd interprets the profile; HRC maps the observed
 * policy).
 *
 * The distinction this suite exists to protect is "declares nothing" vs "could
 * not be read". Collapsing them is the easy bug, and it is the one that makes
 * locate lie: a scope whose profile failed to parse would render as an
 * unconstrained scope, and skew would silently stop being detectable for it.
 */

import { describe, expect, test } from 'bun:test'

import type { ResolvePlacementResponse } from 'hrc-core'

import {
  type PlacementPolicyObservation,
  resolvePlacementPolicy,
} from '../federation/placement-policy.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'

function observation(overrides: Record<string, unknown> = {}): ResolvePlacementResponse {
  return {
    agentId: 'mable',
    projectId: 'hrc-runtime',
    agentRoot: '/agents/mable',
    cwd: '/agents/mable',
    harness: { provider: 'anthropic', frontend: 'claude-code', effectiveHarness: 'claude' },
    provision: { scalars: {} },
    policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
    identity: { operator: false },
    agentSources: { provenance: 'daemon-default' },
    searchedAgentRoots: ['/agents/mable'],
    source: {
      agentProfile: 'valid',
      projectTargets: 'valid',
      selectedTarget: 'absent',
      priming: 'valid',
    },
    resolution: { source: 'inferred', reason: 'test' },
    warnings: [],
    release: { releaseId: 'r', sourceCommit: 'c' },
    ...overrides,
  } as ResolvePlacementResponse
}

function observer(overrides: Record<string, unknown> = {}): PlacementPolicyObservation {
  return async () => observation(overrides)
}

describe('resolvePlacementPolicy', () => {
  test('reads provisioning.node plus placement pins and homes', async () => {
    const resolution = await resolvePlacementPolicy(SCOPE, {
      observe: observer({
        policy: {
          claimsTask: false,
          provisioningNode: 'max3',
          placement: { pins: { 'hrc-runtime:T-06613': 'mini' }, homes: { primary: 'lab' } },
        },
      }),
    })

    expect(resolution.outcome).toBe('resolved')
    if (resolution.outcome !== 'resolved') return
    expect(resolution.policy.provisioning?.node).toBe('max3')
    expect(resolution.policy.placement?.pins['hrc-runtime:T-06613']).toBe('mini')
    expect(resolution.policy.placement?.homes['primary']).toBe('lab')
  })

  test('an observed-but-empty placement resolves with empty pins and homes', async () => {
    const resolution = await resolvePlacementPolicy(SCOPE, { observe: observer() })

    expect(resolution.outcome).toBe('resolved')
    if (resolution.outcome !== 'resolved') return
    expect(resolution.policy.placement).toEqual({ pins: {}, homes: {} })
  })

  test('a missing profile is "no-profile", not an error', async () => {
    const resolution = await resolvePlacementPolicy(SCOPE, {
      observe: observer({
        agentRoot: undefined,
        source: {
          agentProfile: 'absent',
          projectTargets: 'valid',
          selectedTarget: 'absent',
          priming: 'valid',
        },
      }),
    })

    expect(resolution.outcome).toBe('no-profile')
  })

  test('an invalid profile is "unreadable" — never confused with declaring nothing', async () => {
    const resolution = await resolvePlacementPolicy(SCOPE, {
      observe: observer({
        agentRoot: '/agents/mable',
        source: {
          agentProfile: 'invalid',
          projectTargets: 'valid',
          selectedTarget: 'absent',
          priming: 'valid',
        },
        warnings: ['[hrc-core] WARN agent.provisioning.stripped — agent "mable" is being born'],
      }),
    })

    expect(resolution.outcome).toBe('unreadable')
    if (resolution.outcome !== 'unreadable') return
    expect(resolution.detail).toContain('agent-profile.toml')
  })

  test('an observation failure is "unreadable", not "no-profile"', async () => {
    const resolution = await resolvePlacementPolicy(SCOPE, {
      observe: async () => {
        throw new Error('socket gone')
      },
    })

    expect(resolution.outcome).toBe('unreadable')
  })

  test('a scope naming no agent cannot have a profile', async () => {
    const resolution = await resolvePlacementPolicy('app:some-gateway', {
      observe: observer(),
    })

    expect(resolution.outcome).toBe('not-an-agent-scope')
  })

  test('forwards the agentRoot override to the observation', async () => {
    const seen: unknown[] = []
    await resolvePlacementPolicy(SCOPE, {
      agentRoot: '/custom/mable',
      observe: async (input) => {
        seen.push(input)
        return observation({ agentRoot: '/custom/mable' })
      },
    })

    expect(seen[0]).toMatchObject({ agentId: 'mable', agentRoot: '/custom/mable' })
  })
})
