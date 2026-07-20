/**
 * T-06610 isolated-daemon proof. Uses a real HRC Unix-socket server and its real
 * SQLite tables; only the F0 registry transport is injected so the test remains
 * node-local and deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'

import { type PlacementBinding, createPlacementLedgerRepository } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const PARENT_SCOPE = 'agent:mable:project:hrc-runtime:task:T-06597'
const CHILD_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06610'
const ZOMBIE_CHILD_SCOPE = 'agent:clod:project:hrc-runtime:task:T-06611'
const RUNTIME_ID = 'rt-parent-stable'
const RUN_A = 'run-parent-a'
const RUN_B = 'run-parent-b'

function registryStub(onEstablish?: () => void): BindingRegistryClient {
  const rows = new Map<string, PlacementBinding>()
  return {
    async consult(scopeRef: string): Promise<RegistryConsultResult> {
      const binding = rows.get(scopeRef)
      return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
    },
    async establish(request) {
      onEstablish?.()
      const existing = rows.get(request.scopeRef)
      if (existing !== undefined) return { outcome: 'existing', binding: existing }
      const binding: PlacementBinding = {
        scopeRef: request.scopeRef,
        homeNodeId: request.homeNodeId,
        placementEpoch: request.placementEpoch,
        birthClass: request.birthClass,
        authorityProvenance: request.authorityProvenance,
        establishmentProvenance: request.establishmentProvenance,
        createdAt: request.now,
        updatedAt: request.now,
      }
      rows.set(binding.scopeRef, binding)
      return { outcome: 'created', binding }
    },
  }
}

describe('T-06610 child-birth on a live isolated daemon', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06610-daemon-')
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({ nodeId: 'max3-test', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('run-B child is minted with mechanism provenance; establish-time completion is after birth', async () => {
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const db = server.db
      const now = fixture.now()
      db.sessions.insert({
        hostSessionId: 'hsid-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: RUNTIME_ID,
        runtimeKind: 'harness',
        hostSessionId: 'hsid-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex',
        provider: 'openai',
        status: 'busy',
        supportsInflightInput: true,
        adopted: false,
        activeRunId: RUN_B,
        createdAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: RUN_A,
        hostSessionId: 'hsid-parent',
        runtimeId: RUNTIME_ID,
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: RUN_B,
        hostSessionId: 'hsid-parent',
        runtimeId: RUNTIME_ID,
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        status: 'running',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
      })

      // Force the race edge: validation has already returned the immutable
      // birth permit when registry establishment runs. Completing here must not
      // turn that pre-completion birth into a zombie refusal.
      Object.assign(server, {
        registryClient: registryStub(() => {
          db.runs.markCompleted(RUN_B, {
            status: 'completed',
            completedAt: fixture.now(),
            updatedAt: fixture.now(),
          })
        }),
        policyFor: async () => {
          throw new Error('child-birth must never consult placement')
        },
        capabilityFor: async () => ({ outcome: 'capable' }),
      })

      const born = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${CHILD_SCOPE}/lane:main`,
        create: true,
        birthCredential: RUNTIME_ID,
      })
      expect(born.status).toBe(200)
      const bornBody = (await born.json()) as { created: boolean }
      expect(bornBody.created).toBe(true)

      const ledger = createPlacementLedgerRepository(db.sqlite)
      expect(ledger.activeAuthority(CHILD_SCOPE)).toMatchObject({
        homeNodeId: 'max3-test',
        birthClass: 'mechanism-born',
        authorityProvenance: {
          kind: 'child-birth',
          parentScopeRef: PARENT_SCOPE,
          parentRuntimeId: RUNTIME_ID,
          parentRunId: RUN_B,
        },
      })

      // Completion won before this second request entered the gate. It must
      // refuse visibly and must not install a child authority row.
      const zombie = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${ZOMBIE_CHILD_SCOPE}/lane:main`,
        create: true,
        birthCredential: RUNTIME_ID,
      })
      expect(zombie.status).toBe(409)
      const zombieBody = (await zombie.json()) as { error: { message: string; detail?: unknown } }
      expect(zombieBody.error.message).toContain('no live current run')
      expect(zombieBody.error.message).toContain(RUN_B)
      expect(ledger.get(ZOMBIE_CHILD_SCOPE)).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})
