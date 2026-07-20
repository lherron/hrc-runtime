import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ScopeRetirementConflictError,
  applyT06681F0RetirementMigration,
  createPlacementLedgerRepository,
  createScopeRetirementRepository,
  openBindingRegistry,
  openHrcDatabase,
  rebuildBindingRegistryFromLedgers,
} from '../index.js'
import type { PlacementLedgerRecord, ScopeRetirementRecord } from '../index.js'

const POLICY_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06681-policy'
const MECHANISM_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06681-mechanism'

describe('T-06681 durable registry retirement', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function registry() {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06681-registry-'))
    return openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
  }

  test('retirement is an atomic authoritative state that preserves epoch and birth identity', async () => {
    const store = await registry()
    try {
      const active = store.establish({
        scopeRef: POLICY_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      }).binding

      const retired = store.retire({
        scopeRef: POLICY_SCOPE,
        expectedHomeNodeId: 'svc',
        expectedPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })

      expect(retired.outcome).toBe('retired')
      expect(store.get(POLICY_SCOPE)).toBeUndefined()
      expect(store.getRecord(POLICY_SCOPE)).toMatchObject({
        state: 'retired',
        scopeRef: POLICY_SCOPE,
        retiredHomeNodeId: 'svc',
        placementEpoch: 1,
        successorNodeId: 'lab',
        birthClass: active.birthClass,
        authorityProvenance: active.authorityProvenance,
        createdAt: active.createdAt,
      })
      expect(
        store.establish({
          scopeRef: POLICY_SCOPE,
          homeNodeId: 'max3',
          placementEpoch: 1,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'default_home_node' },
          establishmentProvenance: 'default_home_node',
          now: '2026-07-20T00:02:00.000Z',
        }).outcome
      ).toBe('retired')
    } finally {
      store.close()
    }
  })

  test('policy succession consumes the exact tombstone at epoch plus one', async () => {
    const store = await registry()
    try {
      const active = store.establish({
        scopeRef: POLICY_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      }).binding
      store.retire({
        scopeRef: POLICY_SCOPE,
        expectedHomeNodeId: 'svc',
        expectedPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })

      const activated = store.activateRetired({
        scopeRef: POLICY_SCOPE,
        successorNodeId: 'lab',
        expectedPlacementEpoch: 1,
        now: '2026-07-20T00:02:00.000Z',
      })
      expect(activated).toMatchObject({
        outcome: 'activated',
        binding: {
          homeNodeId: 'lab',
          priorHomeNodeId: 'svc',
          placementEpoch: 2,
          birthClass: active.birthClass,
          authorityProvenance: active.authorityProvenance,
          createdAt: active.createdAt,
        },
      })
      expect(
        store.activateRetired({
          scopeRef: POLICY_SCOPE,
          successorNodeId: 'lab',
          expectedPlacementEpoch: 1,
          now: '2026-07-20T00:03:00.000Z',
        }).outcome
      ).toBe('idempotent')
    } finally {
      store.close()
    }
  })

  test('terminal and mechanism-born tombstones cannot be generically activated', async () => {
    const store = await registry()
    try {
      store.establish({
        scopeRef: MECHANISM_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'mechanism-born',
        authorityProvenance: { kind: 'child-birth', parentScopeRef: POLICY_SCOPE },
        establishmentProvenance: 'explicit_local',
        now: '2026-07-20T00:00:00.000Z',
      })
      store.retire({
        scopeRef: MECHANISM_SCOPE,
        expectedHomeNodeId: 'svc',
        expectedPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })
      expect(
        store.activateRetired({
          scopeRef: MECHANISM_SCOPE,
          successorNodeId: 'lab',
          expectedPlacementEpoch: 1,
          now: '2026-07-20T00:02:00.000Z',
        }).outcome
      ).toBe('mechanism_refused')

      store.establish({
        scopeRef: POLICY_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      })
      store.retire({
        scopeRef: POLICY_SCOPE,
        expectedHomeNodeId: 'svc',
        expectedPlacementEpoch: 1,
        successorNodeId: null,
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })
      expect(
        store.activateRetired({
          scopeRef: POLICY_SCOPE,
          successorNodeId: 'lab',
          expectedPlacementEpoch: 1,
          now: '2026-07-20T00:02:00.000Z',
        }).outcome
      ).toBe('conflict')
    } finally {
      store.close()
    }
  })

  test('retargeting a disclosed successor burns an epoch', async () => {
    const store = await registry()
    try {
      store.establish({
        scopeRef: POLICY_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: '2026-07-20T00:00:00.000Z',
      })
      store.retire({
        scopeRef: POLICY_SCOPE,
        expectedHomeNodeId: 'svc',
        expectedPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })

      expect(
        store.retargetRetired({
          scopeRef: POLICY_SCOPE,
          expectedSuccessorNodeId: 'lab',
          expectedPlacementEpoch: 1,
          newSuccessorNodeId: 'max3',
          now: '2026-07-20T00:02:00.000Z',
        })
      ).toMatchObject({
        outcome: 'updated',
        retirement: { placementEpoch: 2, successorNodeId: 'max3' },
      })
      expect(
        store.retargetRetired({
          scopeRef: POLICY_SCOPE,
          expectedSuccessorNodeId: 'other-stale-successor',
          expectedPlacementEpoch: 1,
          newSuccessorNodeId: 'max3',
          now: '2026-07-20T00:03:00.000Z',
        }).outcome
      ).toBe('conflict')
    } finally {
      store.close()
    }
  })
})

describe('T-06681 node-local epoch fences and registry rebuild', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  test('one monotonic fence per scope rejects lower and conflicting same-epoch dispositions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06681-fence-'))
    const db = openHrcDatabase(join(tempDir, 'state.sqlite'))
    try {
      const fences = createScopeRetirementRepository(db.sqlite)
      const first = fences.retire({
        scopeRef: POLICY_SCOPE,
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })
      expect(first.outcome).toBe('created')
      expect(fences.retire(first.record).outcome).toBe('existing')
      expect(() => fences.retire({ ...first.record, successorNodeId: 'max3' })).toThrow(
        ScopeRetirementConflictError
      )

      const raised = fences.retire({
        ...first.record,
        retiredPlacementEpoch: 2,
        successorNodeId: 'max3',
        retiredAt: '2026-07-20T00:02:00.000Z',
      })
      expect(raised).toMatchObject({
        outcome: 'updated',
        record: { retiredPlacementEpoch: 2, successorNodeId: 'max3' },
      })
      expect(() => fences.retire(first.record)).toThrow(ScopeRetirementConflictError)
    } finally {
      db.close()
    }
  })

  test('opening HRC state migrates legacy canonical marks into successor epoch fences', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06681-legacy-fence-'))
    const statePath = join(tempDir, 'state.sqlite')
    const legacy = new Database(statePath)
    legacy.exec(`
      CREATE TABLE federation_scope_retirements (
        scope_ref TEXT PRIMARY KEY,
        retired_node_id TEXT NOT NULL,
        canonical_home_node_id TEXT NOT NULL,
        canonical_placement_epoch INTEGER NOT NULL,
        canonical_host_session_id TEXT,
        reason TEXT NOT NULL,
        retired_at TEXT NOT NULL
      );
      INSERT INTO federation_scope_retirements VALUES (
        'agent:cody:project:hrc-runtime:task:pin-probe',
        'svc', 'svc', 1, NULL, 'namespace_reconciliation', '2026-07-20T00:01:00.000Z'
      );
    `)
    legacy.close()

    const db = openHrcDatabase(statePath)
    try {
      expect(
        db.scopeRetirements.get('agent:cody:project:hrc-runtime:task:pin-probe')
      ).toMatchObject({
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId: null,
      })
      const schema = db.sqlite
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'federation_scope_retirements'"
        )
        .get()?.sql
      expect(schema).toContain('retired_placement_epoch')
      expect(schema).not.toContain('canonical_home_node_id')
    } finally {
      db.close()
    }
  })

  test('rebuild combines ledgers and fences without collapsing retirement to virgin', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06681-rebuild-'))
    const db = openHrcDatabase(join(tempDir, 'state.sqlite'))
    const rebuilt = openBindingRegistry(join(tempDir, 'rebuilt.sqlite'))
    try {
      const ledger = createPlacementLedgerRepository(db.sqlite)
      const active = ledger.installActive({
        scopeRef: POLICY_SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: '2026-07-20T00:00:00.000Z',
      })
      const fence = createScopeRetirementRepository(db.sqlite).retire({
        scopeRef: POLICY_SCOPE,
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      }).record

      expect(rebuildBindingRegistryFromLedgers(rebuilt, [active], [fence])).toEqual({
        inserted: 1,
        duplicates: 0,
      })
      expect(rebuilt.getRecord(POLICY_SCOPE)).toMatchObject({
        state: 'retired',
        placementEpoch: 1,
        retiredHomeNodeId: 'svc',
        successorNodeId: 'lab',
        birthClass: 'policy-born',
      })
    } finally {
      db.close()
      rebuilt.close()
    }
  })

  test('the one-time F0 migration corrects only the two ruled identities and preserves pin-probe', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06681-f0-'))
    const target = openBindingRegistry(join(tempDir, 'registry.sqlite'))
    const scopes = [
      {
        scopeRef: 'agent:cody:project:agent-control-plane:task:wrkq-refactor',
        successorNodeId: 'lab',
      },
      {
        scopeRef: 'agent:cody:project:hrc-runtime:task:pin-probe',
        successorNodeId: null,
      },
      {
        scopeRef: 'agent:mable:project:hrc-runtime:task:max3',
        successorNodeId: 'max3',
      },
    ] as const
    const ledgerRows: PlacementLedgerRecord[] = scopes.map(({ scopeRef }) => ({
      scopeRef,
      homeNodeId: 'svc',
      placementEpoch: 1,
      state: 'active',
      birthClass: 'mechanism-born',
      authorityProvenance: { kind: 'child-birth', source: 'F0' },
      establishmentProvenance: 'explicit_local',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }))
    const retirementFences: ScopeRetirementRecord[] = scopes.map(
      ({ scopeRef, successorNodeId }) => ({
        scopeRef,
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId,
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })
    )
    try {
      expect(
        applyT06681F0RetirementMigration({
          target,
          ledgerRows,
          retirementFences,
          dryRun: true,
        }).rows.map((row) => row.action)
      ).toEqual(['would_insert', 'would_insert', 'would_insert'])
      expect(target.listRecords()).toEqual([])

      const applied = applyT06681F0RetirementMigration({
        target,
        ledgerRows,
        retirementFences,
        dryRun: false,
      })
      expect(applied.rows.map((row) => row.action)).toEqual(['inserted', 'inserted', 'inserted'])
      expect(target.getRecord(scopes[0].scopeRef)).toMatchObject({
        state: 'retired',
        birthClass: 'policy-born',
        successorNodeId: 'lab',
        authorityProvenance: { kind: 'policy', source: 'pin', designatedNodeId: 'lab' },
      })
      expect(target.getRecord(scopes[1].scopeRef)).toMatchObject({
        state: 'retired',
        birthClass: 'mechanism-born',
        successorNodeId: null,
        authorityProvenance: { kind: 'child-birth', source: 'F0' },
      })
      expect(target.getRecord(scopes[2].scopeRef)).toMatchObject({
        state: 'retired',
        birthClass: 'policy-born',
        successorNodeId: 'max3',
        authorityProvenance: {
          kind: 'policy',
          source: 'reconciliation-ruling',
          designatedNodeId: 'max3',
        },
      })
      expect(
        applyT06681F0RetirementMigration({
          target,
          ledgerRows,
          retirementFences,
          dryRun: false,
        }).rows.map((row) => row.action)
      ).toEqual(['existing', 'existing', 'existing'])
      expect(
        target.activateRetired({
          scopeRef: scopes[0].scopeRef,
          successorNodeId: 'lab',
          expectedPlacementEpoch: 1,
          now: '2026-07-20T00:02:00.000Z',
        })
      ).toMatchObject({ outcome: 'activated', binding: { placementEpoch: 2, homeNodeId: 'lab' } })
      expect(
        target.activateRetired({
          scopeRef: scopes[1].scopeRef,
          successorNodeId: 'svc',
          expectedPlacementEpoch: 1,
          now: '2026-07-20T00:02:00.000Z',
        }).outcome
      ).toBe('mechanism_refused')
      expect(
        target.activateRetired({
          scopeRef: scopes[2].scopeRef,
          successorNodeId: 'max3',
          expectedPlacementEpoch: 1,
          now: '2026-07-20T00:02:00.000Z',
        })
      ).toMatchObject({ outcome: 'activated', binding: { placementEpoch: 2, homeNodeId: 'max3' } })
    } finally {
      target.close()
    }
  })
})
