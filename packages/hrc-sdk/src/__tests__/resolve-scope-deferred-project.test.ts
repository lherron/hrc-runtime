/**
 * Regression: resolveProfileAwareScopeInput must apply the caller's projectId
 * fallback BEFORE enforcing scope legality, so the project-deferred shorthand
 * (`<agent>:<task>`) resolves when a project is supplied out-of-band (cwd
 * inference / ASP_PROJECT). Previously the wrapper's first step called the
 * strict `resolveScopeInput(input)` with no project hint, which threw
 * "task <t> requires a project" before the fallback was ever applied — breaking
 * `hrc run mable:BLAH` from a project directory.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveProfileAwareScopeInput } from '../index'

// T-07654: explicit-project resolution walks the operator's disk (wrkq registry,
// then a marker scan under $HOME/praesidium) and parses whatever asp-targets.toml
// it finds there. A unit test for scope-string parsing must not depend on the
// developer's sibling checkouts, so the explicit cases run against a throwaway
// HOME with a canonical `agent-loop` checkout and an injected (empty) registry.
const home = mkdtempSync(join(tmpdir(), 'hrc-resolve-scope-'))
mkdirSync(join(home, 'praesidium', 'agent-loop', '.git'), { recursive: true })
mkdirSync(join(home, 'agents', 'mable'), { recursive: true })
afterAll(() => rmSync(home, { recursive: true, force: true }))

const hermeticPlacement = {
  agentRoot: join(home, 'agents', 'mable'),
  registryProjects: [],
  env: { HOME: home, HRC_PROJECT_SEARCH_ROOTS: join(home, 'praesidium') },
} as const

describe('resolveProfileAwareScopeInput — project-deferred shorthand', () => {
  it('resolves <agent>:<task> when projectId is supplied as a scope fallback', () => {
    const resolved = resolveProfileAwareScopeInput('mable:BLAH', {
      scope: { projectId: 'agent-loop' },
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH')
    expect(resolved.parsed.projectId).toBe('agent-loop')
    expect(resolved.parsed.taskId).toBe('BLAH')
    expect(resolved.projectOrigin).toBe('inferred')
  })

  it('still throws the actionable error when no project is resolvable anywhere', () => {
    expect(() => resolveProfileAwareScopeInput('mable:BLAH', { scope: {} })).toThrow(
      /task "BLAH" requires a project/
    )
  })

  it('leaves an explicit <agent>@<project>:<task> handle unchanged', () => {
    const resolved = resolveProfileAwareScopeInput('mable@agent-loop:BLAH', {
      placement: hermeticPlacement,
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH')
    expect(resolved.projectOrigin).toBe('explicit')
    expect(resolved.placement.resolution.source).toBe('marker-scan')
  })

  it('qualifies a bare agent to primary task using the project fallback', () => {
    const resolved = resolveProfileAwareScopeInput('mable', {
      scope: { projectId: 'agent-loop', defaultTaskId: 'primary' },
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:primary')
    expect(resolved.projectOrigin).toBe('inferred')
  })

  it('allows an explicit project option to preserve its origin through shorthand parsing', () => {
    const resolved = resolveProfileAwareScopeInput('mable:BLAH', {
      scope: { projectId: 'agent-loop' },
      projectOrigin: 'explicit',
      placement: hermeticPlacement,
    })
    expect(resolved.projectOrigin).toBe('explicit')
  })
})
