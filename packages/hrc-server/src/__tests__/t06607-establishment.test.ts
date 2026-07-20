import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { establishLocalPlacement } from '../federation/establishment.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06607'

describe('T-06607 registry-first establishment', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function harness() {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06607-establish-'))
    const db = openHrcDatabase(join(tempDir, 'node.sqlite'))
    const registry = openBindingRegistry(join(tempDir, 'federation', 'binding-registry.sqlite'))
    return {
      db,
      ledger: createPlacementLedgerRepository(db.sqlite),
      registry,
      close() {
        db.close()
        registry.close()
      },
    }
  }

  test('virgin establishment registers first and then installs ACTIVE authority', async () => {
    const h = await harness()
    try {
      const result = establishLocalPlacement({
        registry: h.registry,
        ledger: h.ledger,
        request: {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'pin' },
          establishmentProvenance: 'pin',
          now: '2026-07-20T00:00:00.000Z',
        },
      })

      expect(result.outcome).toBe('established')
      expect(result.binding).toEqual(h.registry.get(SCOPE))
      expect(h.ledger.activeAuthority(SCOPE)).toEqual({ ...result.binding, state: 'active' })
    } finally {
      h.close()
    }
  })

  test('double establishment is idempotent', async () => {
    const h = await harness()
    try {
      const request = {
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        birthClass: 'policy-born' as const,
        authorityProvenance: { kind: 'policy', source: 'default_home_node' },
        establishmentProvenance: 'default_home_node' as const,
        now: '2026-07-20T00:00:00.000Z',
      }
      const first = establishLocalPlacement({ registry: h.registry, ledger: h.ledger, request })
      const second = establishLocalPlacement({
        registry: h.registry,
        ledger: h.ledger,
        request: { ...request, now: '2026-07-20T00:00:01.000Z' },
      })

      expect(first.outcome).toBe('established')
      expect(second.outcome).toBe('already-established')
      expect(second.binding).toEqual(first.binding)
      expect(h.registry.list()).toHaveLength(1)
      expect(h.ledger.list()).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  test('crash after registry write converges on retry and preserves the winning birth class', async () => {
    const h = await harness()
    try {
      const registered = h.registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'mechanism-born',
        authorityProvenance: { kind: 'child', parentScopeRef: 'agent:mable' },
        establishmentProvenance: 'explicit_local',
        now: '2026-07-20T00:00:00.000Z',
      }).binding
      expect(h.ledger.get(SCOPE)).toBeUndefined()

      const retry = establishLocalPlacement({
        registry: h.registry,
        ledger: h.ledger,
        request: {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'pin' },
          establishmentProvenance: 'pin',
          now: '2026-07-20T00:00:01.000Z',
        },
      })

      expect(retry.outcome).toBe('established')
      expect(retry.binding).toEqual(registered)
      expect(retry.binding.birthClass).toBe('mechanism-born')
      expect(h.ledger.activeAuthority(SCOPE)?.birthClass).toBe('mechanism-born')
    } finally {
      h.close()
    }
  })

  test('an existing binding on another node wins without writing local authority', async () => {
    const h = await harness()
    try {
      const existing = h.registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      }).binding

      const result = establishLocalPlacement({
        registry: h.registry,
        ledger: h.ledger,
        request: {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'default_home_node' },
          establishmentProvenance: 'default_home_node',
          now: '2026-07-20T00:00:01.000Z',
        },
      })

      expect(result).toEqual({ outcome: 'bound-elsewhere', binding: existing })
      expect(h.ledger.get(SCOPE)).toBeUndefined()
    } finally {
      h.close()
    }
  })
})
