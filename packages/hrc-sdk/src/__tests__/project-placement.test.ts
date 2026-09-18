/**
 * T-08597 — daemon-backed placement wrapper mapping tests (no socket).
 *
 * Policy outcomes are pinned hermetically in hrc-core placement-policy.test.ts.
 * These pin the wrapper's pure mapping: request building, response mapping,
 * and the agent-miss shape. Socket round trips are proved by the route parity
 * table, not here.
 */
import { describe, expect, it } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import {
  buildPlacementRequest,
  isAgentNotFoundError,
  toMissedPaths,
  toResolvedPaths,
} from '../project-placement.js'

const canned = {
  agentId: 'cody',
  projectId: 'agent-spaces',
  taskId: 'discord',
  agentRoot: '/Users/lherron/praesidium/var/agents/cody',
  projectRoot: '/Users/lherron/praesidium/agent-spaces',
  cwd: '/Users/lherron/praesidium/agent-spaces',
  bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: '/x' },
  bundleIdentity: 'abc',
  harness: { provider: 'openai', frontend: 'codex-cli', effectiveHarness: 'codex' },
  provision: { scalars: { model: 'm' } },
  policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
  identity: { operator: false },
  agentSources: { provenance: 'daemon-default' },
  searchedAgentRoots: ['/agents/cody'],
  source: {
    agentProfile: 'valid',
    projectTargets: 'valid',
    selectedTarget: 'absent',
    priming: 'valid',
  },
  resolution: {
    source: 'wrkq-registry',
    projectId: 'agent-spaces',
    canonicalRoot: '/Users/lherron/praesidium/agent-spaces',
    cwd: '/Users/lherron/praesidium/agent-spaces',
    reason: 'cwd from wrkq registry root /Users/lherron/praesidium/agent-spaces',
  },
  warnings: [],
  release: { releaseId: 'r', sourceCommit: 'c' },
} as const

describe('buildPlacementRequest', () => {
  it('forwards placement inputs, origin, and seams to the route', () => {
    expect(
      buildPlacementRequest({
        agentId: 'cody',
        projectId: 'agent-spaces',
        projectOrigin: 'explicit',
        cwd: '/Users/lherron/praesidium/agent-control-plane',
        taskId: 'discord',
        registryProjects: [],
      })
    ).toMatchObject({
      agentId: 'cody',
      projectId: 'agent-spaces',
      projectOrigin: 'explicit',
      cwd: '/Users/lherron/praesidium/agent-control-plane',
      taskId: 'discord',
      registryProjects: [],
    })
  })

  it('omits absent optionals so the daemon applies its own policy', () => {
    expect(buildPlacementRequest({ agentId: 'cody', projectOrigin: 'inferred' })).toEqual({
      agentId: 'cody',
      projectOrigin: 'inferred',
    })
  })
})

describe('toResolvedPaths', () => {
  it('maps the full daemon response to the wrapper shape', () => {
    const resolved = toResolvedPaths({ ...canned })
    expect(resolved.agentRoot).toBe('/Users/lherron/praesidium/var/agents/cody')
    expect(resolved.projectRoot).toBe('/Users/lherron/praesidium/agent-spaces')
    expect(resolved.cwd).toBe('/Users/lherron/praesidium/agent-spaces')
    expect(resolved.searchedAgentRoots).toEqual(['/agents/cody'])
    expect(resolved.resolution.source).toBe('wrkq-registry')
    expect(resolved.resolution.reason).toContain('wrkq registry root')
    expect(resolved.warnings).toBeUndefined()
  })
})

describe('isAgentNotFoundError', () => {
  it('matches declaration_invalid + producerCode agent_not_found and nothing else', () => {
    const miss = new HrcDomainError(
      HrcErrorCode.DECLARATION_INVALID,
      'agent "nope" was not found',
      {
        producerCode: 'agent_not_found',
        searchedAgentRoots: ['/agents/nope'],
      }
    )
    expect(isAgentNotFoundError(miss)).toBe(true)
    expect(
      isAgentNotFoundError(
        new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, 'other', { producerCode: 'x' })
      )
    ).toBe(false)
    expect(
      isAgentNotFoundError(new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'down', {}))
    ).toBe(false)
    expect(isAgentNotFoundError(new Error('boom'))).toBe(false)
  })
})

describe('toMissedPaths', () => {
  it('returns a placement without agentRoot (no throw) for an unknown agent', () => {
    const resolved = toMissedPaths(
      { projectId: 'agent-spaces' },
      {
        searchedAgentRoots: ['/agents/nope'],
        cwd: '/tmp',
      }
    )
    expect(resolved.agentRoot).toBeUndefined()
    expect(resolved.searchedAgentRoots).toEqual(['/agents/nope'])
    expect(resolved.cwd).toBe('/tmp')
    expect(resolved.resolution.source).toBe('inferred')
  })
})
