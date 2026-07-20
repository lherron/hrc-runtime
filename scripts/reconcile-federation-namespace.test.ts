import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
  readScopeRetirement,
} from '../packages/hrc-store-sqlite/src/index.ts'
import {
  applyNamespaceRetirements,
  inventoryFederationNamespace,
  reconcileFederationNamespace,
} from './reconcile-federation-namespace.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function seedNode(input: {
  root: string
  nodeId: string
  scopeRef: string
  hostSessionId: string
  updatedAt: string
  continuationKey?: string
}): string {
  const path = join(input.root, `${input.nodeId}.sqlite`)
  const db = openHrcDatabase(path)
  try {
    db.sqlite
      .query(
        `INSERT INTO sessions (
          host_session_id, scope_ref, lane_ref, generation, status,
          prior_host_session_id, created_at, updated_at, parsed_scope_json,
          ancestor_scope_refs_json, last_applied_intent_json, continuation_json
        ) VALUES (?, ?, 'main', 1, 'archived', NULL, ?, ?, NULL, '[]', NULL, ?)`
      )
      .run(
        input.hostSessionId,
        input.scopeRef,
        input.updatedAt,
        input.updatedAt,
        input.continuationKey === undefined
          ? null
          : JSON.stringify({ provider: 'anthropic', key: input.continuationKey })
      )
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef: input.scopeRef,
      homeNodeId: input.nodeId,
      placementEpoch: 1,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'legacy_seed', hostSessionId: input.hostSessionId },
      establishmentProvenance: 'explicit_local',
      updatedAt: input.updatedAt,
    })
  } finally {
    db.close()
  }
  return path
}

function seedSyntheticSession(path: string, scopeRef: string, hostSessionId: string): void {
  const db = openHrcDatabase(path)
  try {
    db.sqlite
      .query(
        `INSERT INTO sessions (
          host_session_id, scope_ref, lane_ref, generation, status,
          prior_host_session_id, created_at, updated_at, parsed_scope_json,
          ancestor_scope_refs_json, last_applied_intent_json, continuation_json
        ) VALUES (?, ?, 'main', 1, 'archived', NULL, ?, ?, NULL, '[]', NULL, NULL)`
      )
      .run(hostSessionId, scopeRef, '2026-07-20T02:30:00.000Z', '2026-07-20T02:30:00.000Z')
  } finally {
    db.close()
  }
}

describe('pre-federation namespace reconciliation', () => {
  it('reports the documented sweep bookkeeping ref without reconciling it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-system-ref-'))
    roots.push(root)
    const scopeRef = 'agent:clod:project:hrc-runtime:task:T-06614'
    const svcPath = seedNode({
      root,
      nodeId: 'svc',
      scopeRef,
      hostSessionId: 'hsid-svc',
      updatedAt: '2026-07-20T02:00:00.000Z',
    })
    seedSyntheticSession(svcPath, 'system:hrc/sweep', 'hrc-sweep-summary')

    const report = inventoryFederationNamespace({
      nodeStores: [{ nodeId: 'svc', path: svcPath }],
      registryPath: join(root, 'registry.sqlite'),
    })

    expect(report.scopes.map((scope) => scope.scopeRef)).toEqual([scopeRef])
    expect(report.excludedSystemRefs).toEqual([
      { scopeRef: 'system:hrc/sweep', nodeId: 'svc', sessionCount: 1 },
    ])
  })

  it('still rejects every unrecognized non-agent session ref', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-unknown-ref-'))
    roots.push(root)
    const svcPath = seedNode({
      root,
      nodeId: 'svc',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-06614',
      hostSessionId: 'hsid-svc',
      updatedAt: '2026-07-20T02:00:00.000Z',
    })
    seedSyntheticSession(svcPath, 'system:hrc/unknown', 'unknown-system-row')

    expect(() =>
      inventoryFederationNamespace({
        nodeStores: [{ nodeId: 'svc', path: svcPath }],
        registryPath: join(root, 'registry.sqlite'),
      })
    ).toThrow('ScopeRef must start with "agent:<agentId>"')
  })

  it('never allows a non-agent ref in the binding registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-registry-system-ref-'))
    roots.push(root)
    const registryPath = join(root, 'registry.sqlite')
    const registry = openBindingRegistry(registryPath)
    try {
      registry.sqlite
        .query(
          `INSERT INTO binding_registry (
            scope_ref, home_node_id, placement_epoch, birth_class,
            authority_provenance_json, establishment_provenance,
            prior_home_node_id, created_at, updated_at
          ) VALUES (?, 'svc', 1, 'policy-born', '{}', 'explicit_local', NULL, ?, ?)`
        )
        .run('system:hrc/sweep', '2026-07-20T02:00:00.000Z', '2026-07-20T02:00:00.000Z')
    } finally {
      registry.close()
    }

    expect(() =>
      inventoryFederationNamespace({
        nodeStores: [
          {
            nodeId: 'svc',
            path: seedNode({
              root,
              nodeId: 'svc',
              scopeRef: 'agent:clod:project:hrc-runtime:task:T-06614',
              hostSessionId: 'hsid-svc',
              updatedAt: '2026-07-20T02:00:00.000Z',
            }),
          },
        ],
        registryPath,
      })
    ).toThrow('ScopeRef must start with "agent:<agentId>"')
  })

  it('exposes inventory and reconcile as reviewable JSON commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-command-'))
    roots.push(root)
    const scopeRef = 'agent:clod:project:hrc-runtime:task:T-06614'
    const max3Path = seedNode({
      root,
      nodeId: 'max3',
      scopeRef,
      hostSessionId: 'hsid-max3',
      updatedAt: '2026-07-20T01:00:00.000Z',
    })
    const svcPath = seedNode({
      root,
      nodeId: 'svc',
      scopeRef,
      hostSessionId: 'hsid-svc',
      updatedAt: '2026-07-20T02:00:00.000Z',
    })
    const registryPath = join(root, 'registry.sqlite')
    const scriptPath = join(import.meta.dir, 'reconcile-federation-namespace.ts')

    const inventory = Bun.spawnSync(
      [
        'bun',
        scriptPath,
        'inventory',
        '--registry',
        registryPath,
        '--node',
        `max3=${max3Path}`,
        '--node',
        `svc=${svcPath}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    expect(inventory.exitCode).toBe(0)
    expect(JSON.parse(inventory.stdout.toString())).toMatchObject({
      f1EnablementBlocked: true,
      remainingUnreconciled: [{ scopeRef }],
    })

    const reconcile = Bun.spawnSync(
      [
        'bun',
        scriptPath,
        'reconcile',
        '--registry',
        registryPath,
        '--node',
        `max3=${max3Path}`,
        '--node',
        `svc=${svcPath}`,
        '--select',
        `${scopeRef}=max3`,
        '--yes',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    expect(reconcile.exitCode).toBe(0)
    const reconcileOutput = JSON.parse(reconcile.stdout.toString())
    expect(reconcileOutput).toMatchObject({
      dryRun: false,
      changed: 1,
      f1EnablementBlocked: true,
      artifact: { retirementSteps: [{ retiredNodeId: 'svc' }] },
    })
    const artifactPath = join(root, 'reconciliation.json')
    writeFileSync(artifactPath, JSON.stringify(reconcileOutput))
    const apply = Bun.spawnSync(
      [
        'bun',
        scriptPath,
        'apply',
        '--node-id',
        'svc',
        '--state',
        svcPath,
        '--artifact',
        artifactPath,
        '--yes',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    expect(apply.exitCode).toBe(0)
    expect(JSON.parse(apply.stdout.toString())).toMatchObject({ changed: 1, nodeId: 'svc' })

    const finalInventory = inventoryFederationNamespace({
      nodeStores: [
        { nodeId: 'max3', path: max3Path },
        { nodeId: 'svc', path: svcPath },
      ],
      registryPath,
    })
    expect(finalInventory.f1EnablementBlocked).toBe(false)
  })

  it('inventories duplicate continuities and advisory off-home creation as F1 blockers', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-inventory-'))
    roots.push(root)
    const scopeRef = 'agent:clod:project:hrc-runtime:task:T-06614'
    const max3Path = seedNode({
      root,
      nodeId: 'max3',
      scopeRef,
      hostSessionId: 'hsid-max3',
      updatedAt: '2026-07-20T01:00:00.000Z',
      continuationKey: 'max3-continuation',
    })
    const svcPath = seedNode({
      root,
      nodeId: 'svc',
      scopeRef,
      hostSessionId: 'hsid-svc',
      updatedAt: '2026-07-20T02:00:00.000Z',
    })

    const report = inventoryFederationNamespace({
      nodeStores: [
        { nodeId: 'max3', path: max3Path },
        { nodeId: 'svc', path: svcPath },
      ],
      registryPath: join(root, 'registry.sqlite'),
      advisoryCreations: [
        {
          scopeRef,
          nodeId: 'svc',
          occurredAt: '2026-07-20T02:00:00.000Z',
          decision: 'would_refuse_off_home',
        },
      ],
    })

    expect(report.scopes).toHaveLength(1)
    expect(report.scopes[0]).toMatchObject({
      scopeRef,
      nodes: [
        {
          nodeId: 'max3',
          lastActivityAt: '2026-07-20T01:00:00.000Z',
          continuationPresent: true,
          retired: false,
        },
        {
          nodeId: 'svc',
          lastActivityAt: '2026-07-20T02:00:00.000Z',
          continuationPresent: false,
          retired: false,
        },
      ],
      advisoryCreations: [{ nodeId: 'svc', decision: 'would_refuse_off_home' }],
    })
    expect(report.remainingUnreconciled).toEqual([
      expect.objectContaining({
        scopeRef,
        reasons: ['binding_missing', 'multiple_unretired_nodes'],
      }),
    ])
    expect(report.f1EnablementBlocked).toBe(true)
  })

  it('dry-runs without mutation, imports the selected canonical binding, retires the loser, and converges', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-reconcile-'))
    roots.push(root)
    const scopeRef = 'agent:clod:project:hrc-runtime:task:T-06614'
    const max3Path = seedNode({
      root,
      nodeId: 'max3',
      scopeRef,
      hostSessionId: 'hsid-max3',
      updatedAt: '2026-07-20T01:00:00.000Z',
      continuationKey: 'max3-continuation',
    })
    const svcPath = seedNode({
      root,
      nodeId: 'svc',
      scopeRef,
      hostSessionId: 'hsid-svc',
      updatedAt: '2026-07-20T02:00:00.000Z',
      continuationKey: 'svc-continuation',
    })
    const registryPath = join(root, 'registry.sqlite')
    const input = {
      nodeStores: [
        { nodeId: 'max3', path: max3Path },
        { nodeId: 'svc', path: svcPath },
      ],
      registryPath,
      selections: [{ scopeRef, canonicalNodeId: 'max3' }],
      now: '2026-07-20T03:00:00.000Z',
    }

    const dryRun = reconcileFederationNamespace({ ...input, dryRun: true })
    expect(dryRun).toMatchObject({
      changed: 0,
      wouldChange: 1,
      projectedRemainingUnreconciledAfterApply: [],
      f1EnablementBlocked: true,
      artifact: { dryRun: true, retirementSteps: [{ retiredNodeId: 'svc' }] },
    })
    const registryAfterDryRun = openBindingRegistry(registryPath)
    try {
      expect(registryAfterDryRun.get(scopeRef)).toBeUndefined()
    } finally {
      registryAfterDryRun.close()
    }
    const svcAfterDryRun = new Database(svcPath, { readonly: true })
    try {
      expect(readScopeRetirement(svcAfterDryRun, scopeRef)).toBeUndefined()
    } finally {
      svcAfterDryRun.close()
    }

    const applied = reconcileFederationNamespace({ ...input, dryRun: false })
    expect(applied).toMatchObject({
      changed: 1,
      wouldChange: 0,
      projectedRemainingUnreconciledAfterApply: [],
      f1EnablementBlocked: true,
    })
    const registry = openBindingRegistry(registryPath)
    try {
      expect(registry.get(scopeRef)).toMatchObject({
        scopeRef,
        homeNodeId: 'max3',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'legacy_seed', hostSessionId: 'hsid-max3' },
      })
    } finally {
      registry.close()
    }
    const applyDryRun = applyNamespaceRetirements({
      nodeId: 'svc',
      statePath: svcPath,
      artifact: applied.artifact,
      dryRun: true,
    })
    expect(applyDryRun).toMatchObject({ changed: 0, wouldChange: 1 })
    const appliedOnSvc = applyNamespaceRetirements({
      nodeId: 'svc',
      statePath: svcPath,
      artifact: applied.artifact,
      dryRun: false,
    })
    expect(appliedOnSvc).toMatchObject({ changed: 1, wouldChange: 0 })

    const svc = new Database(svcPath, { readonly: true })
    try {
      expect(readScopeRetirement(svc, scopeRef)).toMatchObject({
        scopeRef,
        retiredNodeId: 'svc',
        canonicalHomeNodeId: 'max3',
        canonicalPlacementEpoch: 1,
        reason: 'namespace_reconciliation',
      })
    } finally {
      svc.close()
    }

    const finalInventory = inventoryFederationNamespace({
      nodeStores: input.nodeStores,
      registryPath,
    })
    expect(finalInventory).toMatchObject({ f1EnablementBlocked: false, remainingUnreconciled: [] })

    const rerun = reconcileFederationNamespace({ ...input, dryRun: false })
    expect(rerun).toMatchObject({ changed: 0, wouldChange: 0, remainingUnreconciled: [] })
    expect(
      applyNamespaceRetirements({
        nodeId: 'svc',
        statePath: svcPath,
        artifact: rerun.artifact,
        dryRun: false,
      })
    ).toMatchObject({ changed: 0, wouldChange: 0 })
  })

  it('uses registry CAS when the operator selects a different canonical node', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-f0-reconcile-cas-'))
    roots.push(root)
    const scopeRef = 'agent:clod:project:hrc-runtime:task:T-06614'
    const max3Path = seedNode({
      root,
      nodeId: 'max3',
      scopeRef,
      hostSessionId: 'hsid-max3',
      updatedAt: '2026-07-20T01:00:00.000Z',
    })
    const svcPath = seedNode({
      root,
      nodeId: 'svc',
      scopeRef,
      hostSessionId: 'hsid-svc',
      updatedAt: '2026-07-20T02:00:00.000Z',
    })
    const registryPath = join(root, 'registry.sqlite')
    const registry = openBindingRegistry(registryPath)
    try {
      registry.establish({
        scopeRef,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'legacy_seed', hostSessionId: 'hsid-svc' },
        establishmentProvenance: 'explicit_local',
        now: '2026-07-20T02:00:00.000Z',
      })
    } finally {
      registry.close()
    }

    const result = reconcileFederationNamespace({
      nodeStores: [
        { nodeId: 'max3', path: max3Path },
        { nodeId: 'svc', path: svcPath },
      ],
      registryPath,
      selections: [{ scopeRef, canonicalNodeId: 'max3' }],
      dryRun: false,
      now: '2026-07-20T03:00:00.000Z',
    })

    expect(result.changed).toBe(1)
    const after = openBindingRegistry(registryPath)
    try {
      expect(after.get(scopeRef)).toMatchObject({
        homeNodeId: 'max3',
        placementEpoch: 2,
        priorHomeNodeId: 'svc',
        establishmentProvenance: 'rebind',
      })
    } finally {
      after.close()
    }
  })
})
