import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  createScopeRetirementRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import type { FederationConfig } from '../federation/federation-config.js'
import {
  assertSummonAuthority,
  captureLivePlacementRepairCandidates,
  repairLiveUnboundPlacements,
} from '../federation/summon-gate-server.js'
import type { SummonGatePolicy } from '../federation/summon-gate.js'

const NOW = '2026-07-20T18:30:00.000Z'
const INTENT: HrcRuntimeIntent = {
  harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
}

describe('T-06697 policy-born registry establishment', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function harness(policyFor: (scopeRef: string) => Promise<SummonGatePolicy>) {
    const tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06697-establish-'))
    tempDirs.push(tempDir)
    const db = openHrcDatabase(join(tempDir, 'state.sqlite'))
    const registry = openBindingRegistry(join(tempDir, 'registry.sqlite'))
    const server = {
      db,
      federationConfig: {
        nodeId: 'svc',
        nodeIdProvenance: 'declared',
        sourcePath: join(tempDir, 'federation.json'),
        sourceExists: true,
        peers: new Map(),
        gate: { mode: 'enforce' },
        warnings: [],
      } as FederationConfig,
      registryClient: {
        async consult(scopeRef: string) {
          const record = registry.getRecord(scopeRef)
          if (record === undefined) return { outcome: 'unbound' } as const
          return record.state === 'retired'
            ? ({ outcome: 'retired', retirement: record } as const)
            : ({ outcome: 'bound', binding: registry.get(scopeRef)! } as const)
        },
        async establish(request: Parameters<typeof registry.establish>[0]) {
          return registry.establish(request)
        },
        async activateRetired(request: Parameters<typeof registry.activateRetired>[0]) {
          return registry.activateRetired(request)
        },
      },
      policyFor,
      capabilityFor: async () => ({ outcome: 'capable' as const }),
    }
    return { db, registry, server }
  }

  test('an eligible same-node policy successor atomically activates at E+1 and installs its ledger', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-06697-retired-successor'
    const h = await harness(async () => ({
      placement: { pins: { 'hrc-runtime:T-06697-retired-successor': 'svc' } },
      claimsTask: false,
    }))
    try {
      h.registry.establish({
        scopeRef,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: NOW,
      })
      h.registry.retire({
        scopeRef,
        expectedHomeNodeId: 'svc',
        expectedPlacementEpoch: 1,
        successorNodeId: 'svc',
        reason: 'namespace_reconciliation',
        retiredAt: NOW,
      })
      createPlacementLedgerRepository(h.db.sqlite).installActive({
        scopeRef,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: NOW,
      })
      createScopeRetirementRepository(h.db.sqlite).retire({
        scopeRef,
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId: 'svc',
        reason: 'namespace_reconciliation',
        retiredAt: NOW,
      })

      const result = await assertSummonAuthority(h.server, {
        scopeRef,
        path: 'ensure-target',
        intent: 'implicit',
        capabilityHint: { harness: INTENT.harness },
      })

      expect(result?.evaluation.reason).toBe('retired-policy-succession')
      expect(h.registry.get(scopeRef)).toMatchObject({
        homeNodeId: 'svc',
        priorHomeNodeId: 'svc',
        placementEpoch: 2,
        birthClass: 'policy-born',
      })
      expect(createPlacementLedgerRepository(h.db.sqlite).activeAuthority(scopeRef)).toMatchObject({
        homeNodeId: 'svc',
        placementEpoch: 2,
        state: 'active',
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  const cases = [
    {
      name: 'pin',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-06697-pin',
      provenance: 'pin' as const,
      policy: {
        placement: { pins: { 'hrc-runtime:T-06697-pin': 'svc' } },
        claimsTask: false,
      },
    },
    {
      name: 'default_home_node',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-06697-default',
      provenance: 'default_home_node' as const,
      policy: {
        placement: { pins: {}, defaultHomeNode: 'svc' },
        claimsTask: false,
      },
    },
    {
      name: 'task-default',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-06697-task-default',
      provenance: 'task_default' as const,
      policy: {
        placement: { pins: {}, taskDefaults: { 'T-06697-task-default': 'svc' } },
        claimsTask: false,
      },
    },
  ] satisfies ReadonlyArray<{
    name: string
    scopeRef: string
    provenance: 'pin' | 'default_home_node' | 'task_default'
    policy: SummonGatePolicy
  }>

  for (const placementCase of cases) {
    test(`${placementCase.name} commits registry and ledger before returning`, async () => {
      const h = await harness(async () => placementCase.policy)
      try {
        const result = await assertSummonAuthority(h.server, {
          scopeRef: placementCase.scopeRef,
          path: 'ensure-target',
          intent: 'implicit',
          capabilityHint: { harness: INTENT.harness },
        })

        expect(result?.evaluation.reason).toBe('virgin-establishment')
        const expected = {
          scopeRef: placementCase.scopeRef,
          homeNodeId: 'svc',
          placementEpoch: 1,
          birthClass: 'policy-born',
          establishmentProvenance: placementCase.provenance,
          authorityProvenance: { kind: 'policy', source: placementCase.provenance },
        }
        expect(h.registry.get(placementCase.scopeRef)).toMatchObject(expected)
        expect(
          createPlacementLedgerRepository(h.db.sqlite).activeAuthority(placementCase.scopeRef)
        ).toMatchObject({ ...expected, state: 'active' })
      } finally {
        h.registry.close()
        h.db.close()
      }
    })
  }

  test('startup repair binds a pre-reconcile live task-default scope even when warmup marks it stale', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-06697-repair'
    const h = await harness(async () => ({
      placement: { pins: {}, taskDefaults: { 'T-06697-repair': 'svc' } },
      claimsTask: false,
    }))
    try {
      h.db.sessions.insert({
        hostSessionId: 'hsid-t06697-repair',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        ancestorScopeRefs: [],
        lastAppliedIntentJson: INTENT,
      })
      h.db.runtimes.insert({
        runtimeId: 'rt-t06697-repair',
        runtimeKind: 'harness',
        hostSessionId: 'hsid-t06697-repair',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })

      expect(h.registry.get(scopeRef)).toBeUndefined()
      const candidates = captureLivePlacementRepairCandidates(h.db)
      expect(candidates).toHaveLength(1)

      // Models startup reconciliation running before the server/endpoints are
      // constructed. The pre-start snapshot, not the new stale status, defines
      // rollout eligibility.
      h.db.runtimes.updateStatus('rt-t06697-repair', 'stale', NOW)
      const summary = await repairLiveUnboundPlacements(h.server, candidates)

      expect(summary).toEqual({ scanned: 1, repaired: 1, alreadyBound: 0, unresolved: 0 })
      expect(h.registry.get(scopeRef)).toMatchObject({
        homeNodeId: 'svc',
        birthClass: 'policy-born',
        establishmentProvenance: 'task_default',
      })
      expect(createPlacementLedgerRepository(h.db.sqlite).activeAuthority(scopeRef)).toMatchObject({
        homeNodeId: 'svc',
        state: 'active',
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('startup repair installs an exact local registry row before launch capability checks', async () => {
    const scopeRef = 'agent:soakprobe:project:hrc-runtime:task:soak-neg'
    let capabilityChecks = 0
    const h = await harness(async () => {
      throw new Error('registry recovery must not consult placement policy')
    })
    try {
      const binding = h.registry.establish({
        scopeRef,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'default_home_node' },
        establishmentProvenance: 'default_home_node',
        now: NOW,
      })
      if (binding.outcome !== 'created') throw new Error('expected new fixture binding')
      Object.assign(h.server, {
        capabilityFor: async () => {
          capabilityChecks += 1
          return {
            outcome: 'incapable' as const,
            capability: 'agent-home-skills' as const,
            source: 'presence-heuristic' as const,
            diagnostic: 'fixture agent home missing',
          }
        },
      })
      h.db.sessions.insert({
        hostSessionId: 'hsid-t06697-registry-repair',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        ancestorScopeRefs: [],
      })
      h.db.runtimes.insert({
        runtimeId: 'rt-t06697-registry-repair',
        runtimeKind: 'harness',
        hostSessionId: 'hsid-t06697-registry-repair',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })

      const summary = await repairLiveUnboundPlacements(h.server)

      expect(summary).toEqual({ scanned: 1, repaired: 1, alreadyBound: 0, unresolved: 0 })
      expect(capabilityChecks).toBe(0)
      expect(createPlacementLedgerRepository(h.db.sqlite).activeAuthority(scopeRef)).toEqual({
        ...binding.binding,
        state: 'active',
        createdAt: binding.binding.updatedAt,
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('startup repair fences a live wrong-node scope without wedging daemon startup', async () => {
    const scopeRef = 'agent:mable:project:hrc-runtime:task:primary'
    const h = await harness(async () => ({
      placement: { pins: { 'hrc-runtime:primary': 'lab' } },
      claimsTask: false,
    }))
    try {
      h.db.sessions.insert({
        hostSessionId: 'hsid-t06697-wrong-node',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        ancestorScopeRefs: [],
      })
      h.db.runtimes.insert({
        runtimeId: 'rt-t06697-wrong-node',
        runtimeKind: 'harness',
        hostSessionId: 'hsid-t06697-wrong-node',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })

      const summary = await repairLiveUnboundPlacements(h.server)

      expect(summary).toEqual({ scanned: 1, repaired: 0, alreadyBound: 0, unresolved: 1 })
      expect(h.db.runtimes.getByRuntimeId('rt-t06697-wrong-node')?.status).toBe('stale')
      expect(h.registry.get(scopeRef)).toBeUndefined()
      expect(createPlacementLedgerRepository(h.db.sqlite).get(scopeRef)).toBeUndefined()
    } finally {
      h.registry.close()
      h.db.close()
    }
  })
})
