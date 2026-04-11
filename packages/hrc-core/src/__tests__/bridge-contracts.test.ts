import { describe, expect, test } from 'bun:test'

import type { HrcBridgeTargetRequest, HrcBridgeTargetSelector } from '../index.js'

describe('canonical bridge contracts', () => {
  test('exports sessionRef and hostSessionId bridge selector variants', () => {
    const bySessionRef: HrcBridgeTargetSelector = {
      sessionRef: 'agent:larry:project:agent-spaces:task:T-01082/lane:main',
    }
    const byHostSessionId: HrcBridgeTargetSelector = {
      hostSessionId: 'hsid-bridge-001',
    }

    expect('sessionRef' in bySessionRef).toBe(true)
    expect('hostSessionId' in byHostSessionId).toBe(true)
  })

  test('accepts canonical bridge target requests keyed by sessionRef', () => {
    const request: HrcBridgeTargetRequest = {
      selector: {
        sessionRef: 'agent:larry:project:agent-spaces:task:T-01082/lane:main',
      },
      transport: 'tmux',
      target: '%42',
    }

    expect('sessionRef' in request.selector).toBe(true)
    expect(request.transport).toBe('tmux')
    expect(request.target).toBe('%42')
  })
})
