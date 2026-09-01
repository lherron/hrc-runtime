import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import type { FederationConfig } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import {
  type SummonGateServerContext,
  captureLivePlacementRepairCandidates,
  repairLiveUnboundPlacements,
} from '../federation/summon-gate-server.js'
import type { SummonGatePolicy } from '../federation/summon-gate.js'

const NOW = '2026-07-20T18:30:00.000Z'
const INTENT: HrcRuntimeIntent = {
  harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
}

describe('T-06697 federation v1.3 startup placement repair', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function harness(
    policyFor: (scopeRef: string) => Promise<SummonGatePolicy | undefined>,
    capabilityFor: SummonGateServerContext['capabilityFor'] = async () => ({
      outcome: 'capable' as const,
    })
  ) {
    const tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06697-startup-repair-'))
    tempDirs.push(tempDir)
    const db = openHrcDatabase(join(tempDir, 'state.sqlite'))
    const registry = openBindingRegistry(join(tempDir, 'registry.sqlite'))
    const registryClient: BindingRegistryClient = {
      async consult(scopeRef) {
        const binding = registry.get(scopeRef)
        return binding === undefined
          ? { outcome: 'unbound' as const }
          : { outcome: 'bound' as const, binding }
      },
      async establish(request) {
        return registry.establish(request)
      },
      async deleteBinding(request) {
        return registry.deleteBinding(request)
      },
    }
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
      registryClient,
      policyFor,
      capabilityFor,
    } satisfies SummonGateServerContext
    return { db, registry, server }
  }

  function insertLiveRuntime(
    h: Awaited<ReturnType<typeof harness>>,
    input: { scopeRef: string; suffix: string; intent?: HrcRuntimeIntent | undefined }
  ): void {
    const hostSessionId = `hsid-t06697-${input.suffix}`
    h.db.sessions.insert({
      hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
      ...(input.intent === undefined ? {} : { lastAppliedIntentJson: input.intent }),
    })
    h.db.runtimes.insert({
      runtimeId: `rt-t06697-${input.suffix}`,
      runtimeKind: 'harness',
      hostSessionId,
      scopeRef: input.scopeRef,
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
  }

  test('repairs a live unbound task-default scope despite warmup stale classification', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-06697-repair'
    const h = await harness(async () => ({
      placement: { pins: {}, homes: { 'T-06697-repair': 'svc' } },
      claimsTask: false,
    }))
    try {
      insertLiveRuntime(h, { scopeRef, suffix: 'repair', intent: INTENT })

      expect(h.registry.get(scopeRef)).toBeUndefined()
      const candidates = captureLivePlacementRepairCandidates(h.db)
      expect(candidates).toHaveLength(1)

      // Startup reconciliation can mark the row stale after the live snapshot;
      // the captured candidate still owns eligibility for repair.
      h.db.runtimes.updateStatus('rt-t06697-repair', 'stale', NOW)
      const summary = await repairLiveUnboundPlacements(h.server, candidates)

      expect(summary).toEqual({ scanned: 1, repaired: 1, alreadyBound: 0, unresolved: 0 })
      const binding = h.registry.get(scopeRef)
      expect(binding).toMatchObject({ scopeRef, homeNodeId: 'svc' })
      expect(binding).not.toHaveProperty('placementEpoch')
      expect(binding).not.toHaveProperty('birthClass')
      expect(binding).not.toHaveProperty('authorityProvenance')
      expect(createPlacementLedgerRepository(h.db.sqlite).activeAuthority(scopeRef)).toEqual({
        ...binding,
        state: 'active',
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('installs an exact local registry row before launch capability checks', async () => {
    const scopeRef = 'agent:soakprobe:project:hrc-runtime:task:soak-neg'
    let capabilityChecks = 0
    const h = await harness(
      async () => {
        throw new Error('registry recovery must not consult placement policy')
      },
      async () => {
        capabilityChecks += 1
        return {
          outcome: 'incapable' as const,
          capability: 'agent-home-skills' as const,
          source: 'presence-heuristic' as const,
          diagnostic: 'fixture agent home missing',
        }
      }
    )
    try {
      const established = h.registry.establish({
        scopeRef,
        homeNodeId: 'svc',
        now: NOW,
      })
      if (!('binding' in established)) throw new Error('expected fixture binding')
      insertLiveRuntime(h, { scopeRef, suffix: 'registry-repair' })

      const summary = await repairLiveUnboundPlacements(h.server)

      expect(summary).toEqual({ scanned: 1, repaired: 1, alreadyBound: 0, unresolved: 0 })
      expect(capabilityChecks).toBe(0)
      expect(createPlacementLedgerRepository(h.db.sqlite).activeAuthority(scopeRef)).toEqual({
        ...established.binding,
        state: 'active',
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('fences a live wrong-node scope without wedging startup', async () => {
    const scopeRef = 'agent:mable:project:hrc-runtime:task:primary'
    const h = await harness(async () => ({
      placement: { pins: { 'hrc-runtime:primary': 'lab' }, homes: {} },
      claimsTask: false,
    }))
    try {
      insertLiveRuntime(h, { scopeRef, suffix: 'wrong-node' })

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
