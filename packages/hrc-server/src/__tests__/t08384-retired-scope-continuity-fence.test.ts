/**
 * T-08384 — an old home must be unable to reuse an exact continuity after
 * ordered retirement, even if its non-authoritative route hint remains stale.
 *
 * Failure modes, captured before the implementation:
 * 1. A stale route hint alone must not grant the old home authority.
 * 2. A stale exact continuity alone must not be executable on the retired home.
 * 3. Having both stale artifacts must remain equivalent to the continuity-only
 *    failure: no old-home reuse and a fresh, distinct session on the new home.
 * 4. Without retirement, the current home retains ordinary continuity reuse.
 */
import { describe, expect, test } from 'bun:test'

import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import type { FederationConfig } from '../federation/federation-config.js'
import { InMemoryBindingHintCache } from '../federation/binding-cache.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { retireFederationScope } from '../federation/retirement.js'
import type { FederationRetirementDependencies } from '../federation/retirement.js'
import { createHrcServer } from '../index.js'
import { automaticContinuationForSession } from '../session-continuation-reuse.js'
import { findContinuitySession } from '../target-view.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:cody:project:arris:task:T-08319'
const SESSION_REF = `${SCOPE}/lane:default`
const OLD_HOME = 'max3'
const NEW_HOME = 'svc'
const NOW = '2026-09-26T04:00:00.000Z'
const OLD_HOST_SESSION_ID = 'hsid-t08384-retired-max3'
const NEW_HOST_SESSION_ID = 'hsid-t08384-fresh-svc'

function registryClient(registry: ReturnType<typeof openBindingRegistry>): BindingRegistryClient {
  return {
    async consult(scopeRef) {
      const binding = registry.get(scopeRef)
      return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
    },
    async establish(request) {
      return registry.establish(request)
    },
    async deleteBinding(request) {
      return registry.deleteBinding(request)
    },
  }
}

function seedContinuity(
  db: ReturnType<typeof openHrcDatabase>,
  hostSessionId: string,
  home: string
): void {
  db.sessions.insert({
    hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
    continuation: {
      provider: 'codex',
      kind: 'thread',
      key: `thread-t08384-${home}`,
    },
  })
  db.continuities.upsert({
    scopeRef: SCOPE,
    laneRef: 'default',
    activeHostSessionId: hostSessionId,
    updatedAt: NOW,
  })
}

function retirementDependencies(
  oldDb: ReturnType<typeof openHrcDatabase>,
  registry: ReturnType<typeof openBindingRegistry>
): FederationRetirementDependencies {
  return {
    owner: {},
    localNodeId: OLD_HOME,
    ledger: createPlacementLedgerRepository(oldDb.sqlite),
    registry: registryClient(registry),
    liveRuntimeIds: () => [],
    fenceContinuities: (scopeRef) => {
      oldDb.sqlite.transaction(() => {
        const continuities = oldDb.continuities.disassociateScope(scopeRef)
        for (const continuity of continuities) {
          oldDb.sessions.setContinuationReuseDisabled(
            continuity.activeHostSessionId,
            true,
            NOW
          )
        }
      })()
    },
    log: () => {},
    now: () => NOW,
  }
}

describe('T-08384 retired-home continuity fence', () => {
  test.each([
    { label: 'a stale routing hint only', staleHint: true, staleContinuity: false },
    { label: 'a stale continuity only', staleHint: false, staleContinuity: true },
    { label: 'both a stale routing hint and stale continuity', staleHint: true, staleContinuity: true },
  ])('$label cannot make the retired old home executable', async (scenario) => {
    const oldDb = openHrcDatabase(':memory:')
    const newDb = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      const oldLedger = createPlacementLedgerRepository(oldDb.sqlite)
      const oldBinding = registry.establish({ scopeRef: SCOPE, homeNodeId: OLD_HOME, now: NOW }).binding
      oldLedger.installActive(oldBinding)

      const cache = new InMemoryBindingHintCache()
      if (scenario.staleHint) cache.learn({ scopeRef: SCOPE, homeNodeId: OLD_HOME })
      if (scenario.staleContinuity) seedContinuity(oldDb, OLD_HOST_SESSION_ID, OLD_HOME)

      await expect(
        retireFederationScope(retirementDependencies(oldDb, registry), {
          scopeRef: SCOPE,
          reason: 'rehome to the +node=svc delivery home',
        })
      ).resolves.toMatchObject({ ok: true, state: 'retired' })

      // The cache intentionally stays stale: it is a routing hint, never
      // authority. Retirement must instead make its exact old-home target
      // impossible to select for execution.
      expect(cache.get(SCOPE)?.homeNodeId).toBe(scenario.staleHint ? OLD_HOME : undefined)
      expect(findContinuitySession(oldDb, SESSION_REF)).toBeNull()
      expect(oldLedger.get(SCOPE)).toMatchObject({ state: 'retired', homeNodeId: OLD_HOME })

      if (scenario.staleContinuity) {
        const historical = oldDb.sessions.getByHostSessionId(OLD_HOST_SESSION_ID)
        expect(historical?.continuation).toEqual({
          provider: 'codex',
          kind: 'thread',
          key: 'thread-t08384-max3',
        })
        expect(automaticContinuationForSession(oldDb, historical!)).toBeUndefined()
      }

      const newBinding = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: NEW_HOME,
        now: '2026-09-26T04:01:00.000Z',
      }).binding
      const newLedger = createPlacementLedgerRepository(newDb.sqlite)
      newLedger.installActive(newBinding)
      seedContinuity(newDb, NEW_HOST_SESSION_ID, NEW_HOME)

      const established = findContinuitySession(newDb, SESSION_REF)
      expect(established?.hostSessionId).toBe(NEW_HOST_SESSION_ID)
      expect(established?.hostSessionId).not.toBe(OLD_HOST_SESSION_ID)
      expect(newLedger.activeAuthority(SCOPE)?.homeNodeId).toBe(NEW_HOME)
    } finally {
      registry.close()
      oldDb.close()
      newDb.close()
    }
  })

  test('an active home retains legitimate same-home continuity reuse', () => {
    const db = openHrcDatabase(':memory:')
    try {
      seedContinuity(db, OLD_HOST_SESSION_ID, OLD_HOME)
      const selected = findContinuitySession(db, SESSION_REF)
      expect(selected?.hostSessionId).toBe(OLD_HOST_SESSION_ID)
      expect(automaticContinuationForSession(db, selected!)).toEqual({
        provider: 'codex',
        kind: 'thread',
        key: 'thread-t08384-max3',
      })
    } finally {
      db.close()
    }
  })

  test('an unpinned scope can establish ordinary fresh continuity', () => {
    const db = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      expect(registry.get(SCOPE)).toBeUndefined()
      const binding = registry.establish({ scopeRef: SCOPE, homeNodeId: NEW_HOME, now: NOW })
      expect(binding.outcome).toBe('created')
      createPlacementLedgerRepository(db.sqlite).installActive(binding.binding)
      seedContinuity(db, NEW_HOST_SESSION_ID, NEW_HOME)

      expect(findContinuitySession(db, SESSION_REF)?.hostSessionId).toBe(NEW_HOST_SESSION_ID)
      expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(SCOPE)?.homeNodeId).toBe(
        NEW_HOME
      )
    } finally {
      registry.close()
      db.close()
    }
  })

  test('an active binding remains routable to its current home', async () => {
    const db = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      const binding = registry.establish({ scopeRef: SCOPE, homeNodeId: OLD_HOME, now: NOW }).binding
      createPlacementLedgerRepository(db.sqlite).installActive(binding)
      seedContinuity(db, OLD_HOST_SESSION_ID, OLD_HOME)

      await expect(registryClient(registry).consult(SCOPE)).resolves.toEqual({
        outcome: 'bound',
        binding,
      })
      expect(findContinuitySession(db, SESSION_REF)?.hostSessionId).toBe(OLD_HOST_SESSION_ID)
    } finally {
      registry.close()
      db.close()
    }
  })

  test('the real retirement HTTP path leaves a fresh new-home continuity as the sole executable target', async () => {
    const oldFixture = await createHrcTestFixture('hrc-t08384-retire-old-')
    const newFixture = await createHrcTestFixture('hrc-t08384-retire-new-')
    const oldDb = openHrcDatabase(oldFixture.dbPath)
    const newDb = openHrcDatabase(newFixture.dbPath)
    const registry = openBindingRegistry(':memory:')
    let oldServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
    let newServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
    try {
      const oldBinding = registry.establish({ scopeRef: SCOPE, homeNodeId: OLD_HOME, now: NOW }).binding
      createPlacementLedgerRepository(oldDb.sqlite).installActive(oldBinding)
      seedContinuity(oldDb, OLD_HOST_SESSION_ID, OLD_HOME)

      const oldFederationConfig = {
        nodeId: OLD_HOME,
        nodeIdProvenance: 'declared',
        sourcePath: oldFixture.stateRoot,
        sourceExists: true,
        peers: new Map(),
        gate: { mode: 'enforce' },
        warnings: [],
      } as FederationConfig
      oldServer = await createHrcServer(
        oldFixture.serverOpts({ federationConfig: oldFederationConfig })
      )
      Object.assign(oldServer as object, {
        federationRegistryClient: registryClient(registry),
        registryClient: registryClient(registry),
      })

      const retired = await oldFixture.postJson('/v1/federation/retire', {
        scopeRef: SCOPE,
        reason: 'move the next +node=svc delivery to its named home',
      })
      expect(retired.status).toBe(200)
      expect(await retired.json()).toMatchObject({ ok: true, state: 'retired' })
      expect(findContinuitySession(oldDb, SESSION_REF)).toBeNull()
      const historical = oldDb.sessions.getByHostSessionId(OLD_HOST_SESSION_ID)
      expect(historical?.continuation?.key).toBe('thread-t08384-max3')
      expect(automaticContinuationForSession(oldDb, historical!)).toBeUndefined()

      registry.establish({
        scopeRef: SCOPE,
        homeNodeId: NEW_HOME,
        now: '2026-09-26T04:02:00.000Z',
      })
      const newFederationConfig = {
        nodeId: NEW_HOME,
        nodeIdProvenance: 'declared',
        sourcePath: newFixture.stateRoot,
        sourceExists: true,
        peers: new Map(),
        gate: { mode: 'enforce' },
        warnings: [],
      } as FederationConfig
      newServer = await createHrcServer(
        newFixture.serverOpts({ federationConfig: newFederationConfig })
      )
      Object.assign(newServer as object, {
        federationRegistryClient: registryClient(registry),
        registryClient: registryClient(registry),
        capabilityFor: async () => ({ outcome: 'capable' as const }),
      })

      const established = await newFixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
        runtimeIntent: {
          placement: {
            agentRoot: '/tmp/agent',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            dryRun: true,
          },
          harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
          execution: { preferredMode: 'interactive' },
          provision: { node: NEW_HOME },
        },
      })
      expect(established.status).toBe(200)
      const establishedBody = (await established.json()) as { hostSessionId: string; created: boolean }
      expect(establishedBody.created).toBe(true)
      expect(findContinuitySession(newDb, SESSION_REF)?.hostSessionId).toBe(
        establishedBody.hostSessionId
      )
      expect(establishedBody.hostSessionId).not.toBe(OLD_HOST_SESSION_ID)
      expect(createPlacementLedgerRepository(newDb.sqlite).activeAuthority(SCOPE)?.homeNodeId).toBe(
        NEW_HOME
      )
      expect(registry.get(SCOPE)?.homeNodeId).toBe(NEW_HOME)
    } finally {
      await newServer?.stop()
      await oldServer?.stop()
      registry.close()
      oldDb.close()
      newDb.close()
      await oldFixture.cleanup()
      await newFixture.cleanup()
    }
  })
})
