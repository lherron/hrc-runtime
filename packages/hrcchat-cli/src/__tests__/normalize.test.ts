import { describe, expect, it } from 'bun:test'

import { formatAddress, resolveTargetToSessionRef } from '../normalize.js'

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
