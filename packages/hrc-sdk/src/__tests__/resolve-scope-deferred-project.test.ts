/**
 * Regression: resolveProfileAwareScopeInput must apply the caller's projectId
 * fallback BEFORE enforcing scope legality, so the project-deferred shorthand
 * (`<agent>:<task>`) resolves when a project is supplied out-of-band (cwd
 * inference / ASP_PROJECT). Previously the wrapper's first step called the
 * strict `resolveScopeInput(input)` with no project hint, which threw
 * "task <t> requires a project" before the fallback was ever applied — breaking
 * `hrc run mable:BLAH` from a project directory.
 */
import { describe, expect, it } from 'bun:test'

import { resolveProfileAwareScopeInput } from '../index'

describe('resolveProfileAwareScopeInput — project-deferred shorthand', () => {
  it('resolves <agent>:<task> when projectId is supplied as a scope fallback', () => {
    const resolved = resolveProfileAwareScopeInput('mable:BLAH', {
      scope: { projectId: 'agent-loop' },
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH')
    expect(resolved.parsed.projectId).toBe('agent-loop')
    expect(resolved.parsed.taskId).toBe('BLAH')
  })

  it('still throws the actionable error when no project is resolvable anywhere', () => {
    expect(() => resolveProfileAwareScopeInput('mable:BLAH', { scope: {} })).toThrow(
      /task "BLAH" requires a project/
    )
  })

  it('leaves an explicit <agent>@<project>:<task> handle unchanged', () => {
    const resolved = resolveProfileAwareScopeInput('mable@agent-loop:BLAH', {})
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:BLAH')
  })

  it('qualifies a bare agent to primary task using the project fallback', () => {
    const resolved = resolveProfileAwareScopeInput('mable', {
      scope: { projectId: 'agent-loop' },
    })
    expect(resolved.scopeRef).toBe('agent:mable:project:agent-loop:task:primary')
  })
})
