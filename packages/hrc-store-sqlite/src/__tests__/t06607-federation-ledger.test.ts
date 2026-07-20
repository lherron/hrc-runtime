import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PlacementEpochRegressionError,
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
  rebuildBindingRegistryFromLedgers,
} from '../index.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06607'
const OTHER_SCOPE = 'agent:clod:project:hrc-runtime:task:T-06608'

describe('T-06607 federation placement persistence', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function paths(): Promise<{ local: string; registry: string }> {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06607-store-'))
    return {
      local: join(tempDir, 'state.sqlite'),
      registry: join(tempDir, 'federation', 'binding-registry.sqlite'),
    }
  }

  test('local ledger is opt-in and an ACTIVE row is durable summon authority', async () => {
    const { local } = await paths()
    const db = openHrcDatabase(local)
    try {
      expect(
        db.sqlite
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
          )
          .get('placement_ledger')
      ).toBeNull()

      const ledger = createPlacementLedgerRepository(db.sqlite)
      const inserted = ledger.installActive({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: '2026-07-20T00:00:00.000Z',
      })

      expect(inserted.state).toBe('active')
      expect(ledger.activeAuthority(SCOPE)).toEqual(inserted)
      expect(ledger.installActive(inserted)).toEqual(inserted)
    } finally {
      db.close()
    }
  })

  test('local ledger rejects placement epoch regression', async () => {
    const { local } = await paths()
    const db = openHrcDatabase(local)
    try {
      const ledger = createPlacementLedgerRepository(db.sqlite)
      ledger.installActive({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        placementEpoch: 2,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'rebind' },
        establishmentProvenance: 'rebind',
        priorHomeNodeId: 'lab',
        updatedAt: '2026-07-20T00:00:02.000Z',
      })

      expect(() =>
        ledger.installActive({
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          placementEpoch: 1,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'pin' },
          establishmentProvenance: 'pin',
          updatedAt: '2026-07-20T00:00:03.000Z',
        })
      ).toThrow(PlacementEpochRegressionError)
      expect(ledger.get(SCOPE)?.placementEpoch).toBe(2)
    } finally {
      db.close()
    }
  })

  test('registry first birth is globally unique and the existing class always wins', async () => {
    const { registry: registryPath } = await paths()
    const registry = openBindingRegistry(registryPath)
    try {
      const policyBirth = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'default_home_node' },
        establishmentProvenance: 'default_home_node',
        now: '2026-07-20T00:00:00.000Z',
      })
      const conflictingMechanismBirth = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        placementEpoch: 1,
        birthClass: 'mechanism-born',
        authorityProvenance: { kind: 'child', parentScopeRef: OTHER_SCOPE },
        establishmentProvenance: 'explicit_local',
        now: '2026-07-20T00:00:01.000Z',
      })

      expect(policyBirth.outcome).toBe('created')
      expect(conflictingMechanismBirth.outcome).toBe('existing')
      expect(conflictingMechanismBirth.binding).toEqual(policyBirth.binding)
      expect(registry.list()).toHaveLength(1)
    } finally {
      registry.close()
    }
  })

  test('registry CAS is idempotent on retry and epochs only advance by one', async () => {
    const { registry: registryPath } = await paths()
    const registry = openBindingRegistry(registryPath)
    try {
      registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'lab',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      })

      const moved = registry.compareAndSwap({
        scopeRef: SCOPE,
        expectedHomeNodeId: 'lab',
        expectedPlacementEpoch: 1,
        newHomeNodeId: 'max3',
        now: '2026-07-20T00:00:01.000Z',
      })
      const retry = registry.compareAndSwap({
        scopeRef: SCOPE,
        expectedHomeNodeId: 'lab',
        expectedPlacementEpoch: 1,
        newHomeNodeId: 'max3',
        now: '2026-07-20T00:00:02.000Z',
      })
      const stale = registry.compareAndSwap({
        scopeRef: SCOPE,
        expectedHomeNodeId: 'lab',
        expectedPlacementEpoch: 1,
        newHomeNodeId: 'svc',
        now: '2026-07-20T00:00:03.000Z',
      })

      expect(moved.outcome).toBe('updated')
      expect(moved.binding?.placementEpoch).toBe(2)
      expect(retry.outcome).toBe('idempotent')
      expect(retry.binding).toEqual(moved.binding)
      expect(stale.outcome).toBe('conflict')
      expect(stale.binding?.placementEpoch).toBe(2)
    } finally {
      registry.close()
    }
  })

  test('registry rebuild from the union of ledgers exactly reproduces bindings', async () => {
    const { local, registry: sourcePath } = await paths()
    const secondLocal = join(tempDir!, 'second.sqlite')
    const rebuiltPath = join(tempDir!, 'rebuilt', 'binding-registry.sqlite')
    const firstDb = openHrcDatabase(local)
    const secondDb = openHrcDatabase(secondLocal)
    const source = openBindingRegistry(sourcePath)
    const rebuilt = openBindingRegistry(rebuiltPath)
    try {
      const firstLedger = createPlacementLedgerRepository(firstDb.sqlite)
      const secondLedger = createPlacementLedgerRepository(secondDb.sqlite)
      const bindings = [
        source.establish({
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          placementEpoch: 1,
          birthClass: 'policy-born' as const,
          authorityProvenance: { kind: 'policy', source: 'pin' },
          establishmentProvenance: 'pin' as const,
          now: '2026-07-20T00:00:00.000Z',
        }).binding,
        source.establish({
          scopeRef: OTHER_SCOPE,
          homeNodeId: 'max3',
          placementEpoch: 1,
          birthClass: 'mechanism-born' as const,
          authorityProvenance: { kind: 'child', parentScopeRef: SCOPE },
          establishmentProvenance: 'explicit_local' as const,
          now: '2026-07-20T00:00:01.000Z',
        }).binding,
      ]
      firstLedger.installActive(bindings[0]!)
      secondLedger.installActive(bindings[1]!)

      const result = rebuildBindingRegistryFromLedgers(rebuilt, [
        ...firstLedger.list(),
        ...secondLedger.list(),
      ])

      expect(result).toEqual({ inserted: 2, duplicates: 0 })
      expect(rebuilt.list()).toEqual(source.list())
    } finally {
      firstDb.close()
      secondDb.close()
      source.close()
      rebuilt.close()
    }
  })

  test('task_default provenance widens existing ledger and registry CHECK schemas without data loss', async () => {
    const { local, registry: registryPath } = await paths()
    const db = openHrcDatabase(local)
    db.sqlite.exec(`
      CREATE TABLE placement_ledger (
        scope_ref TEXT PRIMARY KEY,
        home_node_id TEXT NOT NULL,
        placement_epoch INTEGER NOT NULL CHECK (placement_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        birth_class TEXT NOT NULL CHECK (birth_class IN ('policy-born', 'mechanism-born')),
        authority_provenance_json TEXT NOT NULL,
        establishment_provenance TEXT NOT NULL CHECK (
          establishment_provenance IN (
            'pin', 'default_home_node', 'default_home_node(local)', 'explicit_local', 'rebind'
          )
        ),
        prior_home_node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO placement_ledger VALUES (
        '${SCOPE}', 'svc', 1, 'active', 'policy-born', '{"kind":"policy","source":"pin"}',
        'pin', NULL, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
    `)

    await mkdir(join(tempDir!, 'federation'), { recursive: true })
    const rawRegistry = new Database(registryPath, { create: true })
    rawRegistry.exec(`
      CREATE TABLE binding_registry (
        scope_ref TEXT PRIMARY KEY,
        home_node_id TEXT NOT NULL,
        placement_epoch INTEGER NOT NULL CHECK (placement_epoch >= 1),
        birth_class TEXT NOT NULL CHECK (birth_class IN ('policy-born', 'mechanism-born')),
        authority_provenance_json TEXT NOT NULL,
        establishment_provenance TEXT NOT NULL CHECK (
          establishment_provenance IN (
            'pin', 'default_home_node', 'default_home_node(local)', 'explicit_local', 'rebind'
          )
        ),
        prior_home_node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO binding_registry VALUES (
        '${SCOPE}', 'svc', 1, 'policy-born', '{"kind":"policy","source":"pin"}',
        'pin', NULL, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
    `)
    rawRegistry.close()

    const ledger = createPlacementLedgerRepository(db.sqlite)
    const registry = openBindingRegistry(registryPath)
    try {
      expect(ledger.get(SCOPE)?.establishmentProvenance).toBe('pin')
      expect(registry.get(SCOPE)?.establishmentProvenance).toBe('pin')

      ledger.installActive({
        scopeRef: OTHER_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'task_default' },
        establishmentProvenance: 'task_default',
        updatedAt: '2026-07-20T00:00:01.000Z',
      })
      registry.establish({
        scopeRef: OTHER_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'task_default' },
        establishmentProvenance: 'task_default',
        now: '2026-07-20T00:00:01.000Z',
      })

      expect(ledger.get(OTHER_SCOPE)?.establishmentProvenance).toBe('task_default')
      expect(registry.get(OTHER_SCOPE)?.establishmentProvenance).toBe('task_default')
    } finally {
      registry.close()
      db.close()
    }
  })
})
