import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { formatAddress, resolveCallerAddress, resolveTargetToSessionRef } from '../normalize.js'

describe('hrcchat normalize helpers', () => {
  const savedAspProject = process.env['ASP_PROJECT']
  const savedSessionRef = process.env['HRC_SESSION_REF']

  // Strip ambient envs at suite start so that test-runner inheritance from
  // the parent shell does not leak into resolveTargetToSessionRef.
  beforeEach(() => {
    Reflect.deleteProperty(process.env, 'ASP_PROJECT')
    Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
  })

  afterEach(() => {
    if (savedAspProject !== undefined) {
      process.env['ASP_PROJECT'] = savedAspProject
    } else {
      Reflect.deleteProperty(process.env, 'ASP_PROJECT')
    }
    if (savedSessionRef !== undefined) {
      process.env['HRC_SESSION_REF'] = savedSessionRef
    } else {
      Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
    }
  })

  it('resolves main-lane handles to canonical session refs', () => {
    expect(resolveTargetToSessionRef('clod@agent-spaces:T-01128')).toBe(
      'agent:clod:project:agent-spaces:task:T-01128/lane:main'
    )
  })

  it('resolves explicit lanes without duplicating the lane prefix', () => {
    expect(resolveTargetToSessionRef('clod@agent-spaces:T-01128~repair')).toBe(
      'agent:clod:project:agent-spaces:task:T-01128/lane:repair'
    )
  })

  it('formats non-main session addresses with lane suffixes', () => {
    expect(
      formatAddress({
        kind: 'session',
        sessionRef: 'agent:clod:project:agent-spaces:task:T-01128/lane:repair',
      })
    ).toBe('clod@agent-spaces:T-01128~repair')
  })

  it('fills missing task with primary when only project is provided', () => {
    expect(resolveTargetToSessionRef('clod@agent-spaces')).toBe(
      'agent:clod:project:agent-spaces:task:primary/lane:main'
    )
  })

  it('fills both project (from ASP_PROJECT) and task (primary) for bare agent handles', () => {
    process.env['ASP_PROJECT'] = 'agent-spaces'
    Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
    expect(resolveTargetToSessionRef('clod')).toBe(
      'agent:clod:project:agent-spaces:task:primary/lane:main'
    )
  })

  it('inherits caller taskId from HRC_SESSION_REF when input lacks one', () => {
    process.env['ASP_PROJECT'] = 'agent-spaces'
    process.env['HRC_SESSION_REF'] = 'agent:rex:project:agent-spaces:task:T-09999/lane:main'
    expect(resolveTargetToSessionRef('clod')).toBe(
      'agent:clod:project:agent-spaces:task:T-09999/lane:main'
    )
  })

  it('preserves session-handle lane while filling missing task', () => {
    expect(resolveTargetToSessionRef('clod@agent-spaces~repair')).toBe(
      'agent:clod:project:agent-spaces:task:primary/lane:repair'
    )
  })
})

/**
 * Regression tests for resolveCallerAddress (T-01212)
 *
 * Verifies that hrcchat correctly reads HRC_SESSION_REF set by
 * buildCorrelationEnvVars in placement-based headless runs,
 * resolving the caller as the agent session instead of entity:human.
 */
describe('resolveCallerAddress', () => {
  const savedRef = process.env['HRC_SESSION_REF']

  afterEach(() => {
    if (savedRef !== undefined) {
      process.env['HRC_SESSION_REF'] = savedRef
    } else {
      Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
    }
  })

  it('returns session address when HRC_SESSION_REF is set with lane: prefix', () => {
    process.env['HRC_SESSION_REF'] = 'agent:smokey:project:media-ingest/lane:main'

    const addr = resolveCallerAddress()

    expect(addr).toEqual({
      kind: 'session',
      sessionRef: 'agent:smokey:project:media-ingest/lane:main',
    })
  })

  it('normalizes legacy format without lane: prefix', () => {
    process.env['HRC_SESSION_REF'] = 'agent:smokey:project:media-ingest/main'

    const addr = resolveCallerAddress()

    expect(addr).toEqual({
      kind: 'session',
      sessionRef: 'agent:smokey:project:media-ingest/lane:main',
    })
  })

  it('falls back to entity:human when HRC_SESSION_REF is absent', () => {
    Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')

    const addr = resolveCallerAddress()

    expect(addr).toEqual({ kind: 'entity', entity: 'human' })
  })

  it('handles task-scoped session refs from placement correlation', () => {
    process.env['HRC_SESSION_REF'] = 'agent:rex:project:agent-spaces:task:T-01104/lane:repair'

    const addr = resolveCallerAddress()

    expect(addr).toEqual({
      kind: 'session',
      sessionRef: 'agent:rex:project:agent-spaces:task:T-01104/lane:repair',
    })
  })
})
