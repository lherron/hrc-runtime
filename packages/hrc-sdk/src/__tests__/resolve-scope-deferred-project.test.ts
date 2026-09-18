/**
 * Regression: scope assembly must apply the caller's projectId fallback
 * BEFORE enforcing scope legality, so the project-deferred shorthand
 * (`<agent>:<task>`) resolves when a project is supplied out-of-band.
 *
 * T-08597: placement + default role arrive as a daemon observation; these pin
 * the pure assembly (no socket). Socket round trips are proved by the route
 * parity table.
 */
import { describe, expect, it } from 'bun:test'

import { applyScopeObservation } from '../resolve-scope.js'

const observation = {
  agentId: 'mable',
  projectId: 'agent-loop',
  agentRoot: '/agents/mable',
  projectRoot: '/src/agent-loop',
  cwd: '/src/agent-loop',
  harness: { provider: 'anthropic', frontend: 'claude-code', effectiveHarness: 'claude' },
  provision: { scalars: {} },
  policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
  identity: { operator: false },
  agentSources: { provenance: 'daemon-default' },
  searchedAgentRoots: [],
  source: {
    agentProfile: 'valid',
    projectTargets: 'valid',
    selectedTarget: 'absent',
    priming: 'valid',
  },
  resolution: { source: 'inferred', reason: 'cwd from inferred project agent-loop' },
  warnings: [],
  release: { releaseId: 'r', sourceCommit: 'c' },
} as const

describe('applyScopeObservation — project-deferred shorthand', () => {
  it('resolves <agent>:<task> when projectId is supplied as a scope fallback', () => {
    const resolved = applyScopeObservation('mable:BLAH', { projectId: 'agent-loop' }, 'inferred', {
      ...observation,
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH')
    expect(resolved.parsed.projectId).toBe('agent-loop')
    expect(resolved.parsed.taskId).toBe('BLAH')
    expect(resolved.projectOrigin).toBe('inferred')
  })

  it('still throws the actionable error when no project is resolvable anywhere', () => {
    expect(() => applyScopeObservation('mable:BLAH', {}, 'inferred', { ...observation })).toThrow(
      /task "BLAH" requires a project/
    )
  })

  it('leaves an explicit <agent>@<project>:<task> handle unchanged', () => {
    const resolved = applyScopeObservation('mable@agent-loop:BLAH', {}, 'explicit', {
      ...observation,
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH')
    expect(resolved.projectOrigin).toBe('explicit')
  })

  it('qualifies a bare agent to primary task using the project fallback', () => {
    const resolved = applyScopeObservation(
      'mable',
      { projectId: 'agent-loop', defaultTaskId: 'primary' },
      'inferred',
      { ...observation }
    )
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:primary')
    expect(resolved.projectOrigin).toBe('inferred')
  })

  it('allows an explicit project option to preserve its origin through shorthand parsing', () => {
    const resolved = applyScopeObservation('mable:BLAH', { projectId: 'agent-loop' }, 'explicit', {
      ...observation,
    })
    expect(resolved.projectOrigin).toBe('explicit')
  })

  it('applies the observed default role to an explicit task', () => {
    const resolved = applyScopeObservation('mable@agent-loop:BLAH', {}, 'explicit', {
      ...observation,
      identity: { role: 'coordinator', operator: false },
    })
    expect(resolved.defaultRoleName).toBe('coordinator')
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH:role:coordinator')
  })

  it('attaches the mapped placement', () => {
    const resolved = applyScopeObservation('mable@agent-loop:BLAH', {}, 'explicit', {
      ...observation,
    })
    expect(resolved.placement.agentRoot).toBe('/agents/mable')
    expect(resolved.placement.projectRoot).toBe('/src/agent-loop')
  })
})
