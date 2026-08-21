import { afterEach, describe, expect, test } from 'bun:test'

import type { SemanticDmRequest } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  createScopeRetirementRepository,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { createFederationAcceptHandler } from '../federation/accept.js'
import type { FederationConfig } from '../federation/federation-config.js'
import { locateScopeOnServer } from '../federation/locate-server.js'
import { FederationOriginOutbox } from '../federation/origin-outbox.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { FederationRoutingResolutionError } from '../federation/routing-resolution.js'
import { assertScopeNotRetired } from '../federation/summon-gate-server.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06870-rebound'

describe('T-06870 retirement fence epochs', () => {
  const closeables: Array<{ close(): void }> = []
  const outboxes: FederationOriginOutbox[] = []

  afterEach(async () => {
    await Promise.all(outboxes.splice(0).map((outbox) => outbox.stop()))
    for (const closeable of closeables.splice(0)) closeable.close()
  })

  test('origin routing trusts a later active local epoch over an older retirement fence', async () => {
    const db = openHrcDatabase(':memory:')
    closeables.push(db)
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: 'max3',
      placementEpoch: 2,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'explicit_local' },
      establishmentProvenance: 'rebind',
      priorHomeNodeId: 'svc',
      updatedAt: '2026-07-24T00:00:00.000Z',
    })
    createScopeRetirementRepository(db.sqlite).retire({
      scopeRef: SCOPE,
      retiredNodeId: 'max3',
      retiredPlacementEpoch: 1,
      successorNodeId: 'svc',
      reason: 'namespace_reconciliation',
      retiredAt: '2026-07-21T00:00:00.000Z',
    })

    let registryConsults = 0
    const binding = {
      scopeRef: SCOPE,
      homeNodeId: 'max3',
      placementEpoch: 2,
      birthClass: 'policy-born' as const,
      authorityProvenance: { kind: 'policy' as const, source: 'explicit_local' as const },
      establishmentProvenance: 'rebind' as const,
      priorHomeNodeId: 'svc',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    }
    const registry: BindingRegistryClient = {
      async consult() {
        registryConsults += 1
        return { outcome: 'bound', binding }
      },
      async establish() {
        throw new Error('routing an established scope must not establish it again')
      },
    }
    const outbox = new FederationOriginOutbox({
      db,
      config: {
        nodeId: 'max3',
        nodeIdProvenance: 'declared',
        sourcePath: '/isolated/max3/federation.json',
        sourceExists: true,
        peers: new Map(),
        registry: { bind: 'http://max3.example.ts.net:18491/' },
        gate: { mode: 'enforce', registryHost: 'max3' },
        warnings: [],
      } as FederationConfig,
      localRegistryClient: registry,
    })
    outboxes.push(outbox)

    const body: SemanticDmRequest = {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: `${SCOPE}/lane:main` },
      body: 'synthetic rebound-home routing probe',
      createIfMissing: false,
    }

    expect(await outbox.resolveTargetPlacement(body)).toEqual({ outcome: 'local' })
    expect(registryConsults).toBe(0)
  })

  test('an orphan fence remains fail-closed without later active local ledger evidence', async () => {
    const db = openHrcDatabase(':memory:')
    closeables.push(db)
    createScopeRetirementRepository(db.sqlite).retire({
      scopeRef: SCOPE,
      retiredNodeId: 'max3',
      retiredPlacementEpoch: 1,
      successorNodeId: 'svc',
      reason: 'namespace_reconciliation',
      retiredAt: '2026-07-21T00:00:00.000Z',
    })

    let registryConsults = 0
    const registry: BindingRegistryClient = {
      async consult() {
        registryConsults += 1
        return {
          outcome: 'bound',
          binding: {
            scopeRef: SCOPE,
            homeNodeId: 'max3',
            placementEpoch: 2,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'explicit_local' },
            establishmentProvenance: 'rebind',
            priorHomeNodeId: 'svc',
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
          },
        }
      },
      async establish() {
        throw new Error('routing an established scope must not establish it again')
      },
    }
    const outbox = new FederationOriginOutbox({
      db,
      config: {
        nodeId: 'max3',
        nodeIdProvenance: 'declared',
        sourcePath: '/isolated/max3/federation.json',
        sourceExists: true,
        peers: new Map(),
        registry: { bind: 'http://max3.example.ts.net:18491/' },
        gate: { mode: 'enforce', registryHost: 'max3' },
        warnings: [],
      } as FederationConfig,
      localRegistryClient: registry,
    })
    outboxes.push(outbox)

    const error = await outbox
      .resolveTargetPlacement({
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${SCOPE}/lane:main` },
        body: 'synthetic orphan-fence routing probe',
        createIfMissing: false,
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FederationRoutingResolutionError)
    expect(error).toMatchObject({ code: 'binding_retired', retryable: true })
    expect(registryConsults).toBe(1)
  })

  test('accept, existing-target admission, and locate all treat the older fence as inert', async () => {
    const db = openHrcDatabase(':memory:')
    closeables.push(db)
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: 'max3',
      placementEpoch: 2,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'explicit_local' },
      establishmentProvenance: 'rebind',
      priorHomeNodeId: 'svc',
      updatedAt: '2026-07-24T00:00:00.000Z',
    })
    createScopeRetirementRepository(db.sqlite).retire({
      scopeRef: SCOPE,
      retiredNodeId: 'max3',
      retiredPlacementEpoch: 1,
      successorNodeId: 'svc',
      reason: 'namespace_reconciliation',
      retiredAt: '2026-07-21T00:00:00.000Z',
    })

    const registry: BindingRegistryClient = {
      async consult() {
        throw new Error('later active local authority must not consult the registry')
      },
      async establish() {
        throw new Error('later active local authority must not establish again')
      },
    }
    const config = {
      nodeId: 'max3',
      nodeIdProvenance: 'declared',
      sourcePath: '/isolated/max3/federation.json',
      sourceExists: true,
      peers: new Map(),
      registry: { bind: 'http://max3.example.ts.net:18491/' },
      gate: { mode: 'enforce', registryHost: 'max3' },
      warnings: [],
    } as FederationConfig
    const gateServer = {
      db,
      federationConfig: config,
      registryClient: registry,
      policyFor: async () => ({ placement: {}, claimsTask: false }),
    }
    const locateServer = {
      db,
      federationConfig: config,
      registryClient: registry,
      policyFor: async () => ({
        outcome: 'resolved' as const,
        profilePath: '/isolated/max3/agent-profile.toml',
        policy: { placement: { pins: {}, homes: {} }, claimsTask: false },
      }),
      observedFor: () => [],
    }

    expect(
      await assertScopeNotRetired(gateServer, {
        scopeRef: SCOPE,
        path: 'archived-successor',
      })
    ).toBeUndefined()

    const location = await locateScopeOnServer(locateServer, SCOPE)
    expect(location.authority).toMatchObject({
      state: 'bound',
      source: 'ledger',
      record: { homeNodeId: 'max3', placementEpoch: 2 },
    })
    expect(location.notes.map((note) => note.code)).not.toContain('scope-retired')
    expect(location.retirement).toMatchObject({ retiredPlacementEpoch: 1 })

    const accept = createFederationAcceptHandler({ db, localNodeId: 'max3' })
    const accepted = await accept({
      authenticatedNodeId: 'svc',
      protocolVersion: '1.0',
      envelope: {
        protocolVersion: '1.0',
        messageId: 'msg-68706870-6870-4870-8870-687068706870',
        kind: 'dm',
        phase: 'request',
        from: {
          kind: 'session',
          sessionRef: 'agent:mable:project:hrc-runtime:task:primary/lane:main',
        },
        to: { kind: 'session', sessionRef: `${SCOPE}/lane:main` },
        body: 'synthetic later-epoch accept probe',
        rootMessageId: 'msg-68706870-6870-4870-8870-687068706870',
        expected: { homeNodeId: 'max3', placementEpoch: 2 },
      },
    })
    expect(accepted).toMatchObject({
      outcome: 'accepted',
      messageId: 'msg-68706870-6870-4870-8870-687068706870',
    })
  })
})
