import { afterEach, describe, expect, it } from 'bun:test'

import { formatAddress, resolveCallerAddress, resolveTargetToSessionRef } from '../normalize.js'

describe('hrcchat normalize helpers', () => {
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
