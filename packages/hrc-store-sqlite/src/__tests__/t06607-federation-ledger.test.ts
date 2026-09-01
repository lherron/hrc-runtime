import { describe, expect, test } from 'bun:test'

import { createPlacementLedgerRepository, openBindingRegistry, openHrcDatabase } from '../index.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-07032'

describe('federation v1.3 home-only placement storage', () => {
  test('persists one home without epochs, birth classes, or provenance', () => {
    const db = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      const binding = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        now: '2026-09-01T07:00:00.000Z',
      }).binding
      expect(binding).toEqual({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        createdAt: '2026-09-01T07:00:00.000Z',
        updatedAt: '2026-09-01T07:00:00.000Z',
      })
      const ledger = createPlacementLedgerRepository(db.sqlite)
      expect(ledger.installActive(binding)).toMatchObject({ state: 'active', homeNodeId: 'svc' })
      expect(Object.keys(binding).sort()).toEqual([
        'createdAt',
        'homeNodeId',
        'scopeRef',
        'updatedAt',
      ])
    } finally {
      registry.close()
      db.close()
    }
  })

  test('a local retirement fence is permanent and registry deletion is conditional', () => {
    const db = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      const binding = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        now: '2026-09-01T07:00:00.000Z',
      }).binding
      const ledger = createPlacementLedgerRepository(db.sqlite)
      ledger.installActive(binding)
      expect(
        ledger.retire({
          scopeRef: SCOPE,
          expectedHomeNodeId: 'svc',
          reason: 'operator',
          retiredAt: '2026-09-01T07:01:00.000Z',
        })
      ).toMatchObject({ outcome: 'retired', record: { state: 'retired' } })
      expect(
        registry.deleteBinding({
          scopeRef: SCOPE,
          expectedHomeNodeId: 'lab',
          retiredAt: '2026-09-01T07:01:00.000Z',
        })
      ).toMatchObject({ outcome: 'conflict', binding: { homeNodeId: 'svc' } })
      expect(
        registry.deleteBinding({
          scopeRef: SCOPE,
          expectedHomeNodeId: 'svc',
          retiredAt: '2026-09-01T07:01:00.000Z',
        })
      ).toEqual({ outcome: 'deleted' })
      expect(() => ledger.installActive(binding)).toThrow('permanently retired')
    } finally {
      registry.close()
      db.close()
    }
  })
})
