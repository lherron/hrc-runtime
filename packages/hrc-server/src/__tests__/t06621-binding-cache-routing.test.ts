import { describe, expect, test } from 'bun:test'

import {
  InMemoryBindingHintCache,
  createStalePlacementRedirectHandler,
} from '../federation/binding-cache.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06621'

describe('v1.3 home-only binding hint cache', () => {
  test('stores only a non-authoritative home hint', () => {
    const cache = new InMemoryBindingHintCache()
    const result = cache.learn({ scopeRef: SCOPE, homeNodeId: 'svc' })
    expect(result.outcome).toBe('stored')
    expect(cache.get(SCOPE)).toEqual({
      purpose: 'routing-hint',
      scopeRef: SCOPE,
      homeNodeId: 'svc',
    })
    expect(JSON.stringify(cache.get(SCOPE))).not.toContain('placementEpoch')
  })

  test('fresh redirect discovery replaces a stale hint without granting authority', () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn({ scopeRef: SCOPE, homeNodeId: 'svc' })
    const redirected = createStalePlacementRedirectHandler(cache)(SCOPE, 'lab')
    expect(redirected.outcome).toBe('replaced')
    expect(redirected.current).toEqual({
      purpose: 'routing-hint',
      scopeRef: SCOPE,
      homeNodeId: 'lab',
    })
  })

  test('forget supports explicit cache refresh after retirement', () => {
    const cache = new InMemoryBindingHintCache()
    cache.learn({ scopeRef: SCOPE, homeNodeId: 'svc' })
    expect(cache.forget(SCOPE)).toBe(true)
    expect(cache.get(SCOPE)).toBeUndefined()
  })
})
