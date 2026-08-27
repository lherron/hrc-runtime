import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type { BindingRegistry, HrcDatabase } from 'hrc-store-sqlite'

import {
  reconcileExternalRegistrationCollectiveEstablishment,
  scheduleExternalRegistrationCollectiveEstablishment,
} from '../external-registration-establishment.js'
import {
  type ExternalParticipantRpcClient,
  performExternalRegistrationHello,
} from '../external-registration-rendezvous.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { hashRegistrationCredential } from '../registration-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import type { HrcServerOptions } from '../server-types.js'

const REGISTRATION_ID = 'registration-t07138'
const CREDENTIAL = 'credential-t07138'
const SCOPE = 'agent:arris:project:arris:task:reg-t07138'

class HelloClient implements ExternalParticipantRpcClient {
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'epr.hello') {
      return {
        protocolVersion: 'epr/1',
        registrationId: params['registrationId'],
        credential: CREDENTIAL,
        capabilities: { events: true, turns: false, continuations: false },
        participantInfo: { name: 'arris' },
      }
    }
    if (method === 'epr.established') return { ready: true, currentSeq: 0 }
    throw new Error(`unexpected method ${method}`)
  }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

function registryClient(
  registry: BindingRegistry,
  fault?: { consult?: () => void; establish?: () => void }
): BindingRegistryClient {
  return {
    async consult(scopeRef) {
      fault?.consult?.()
      const binding = registry.get(scopeRef)
      return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
    },
    async establish(request) {
      fault?.establish?.()
      return registry.establish(request)
    },
  }
}

describe('T-07138 post-mint collective establishment', () => {
  let root: string
  let db: HrcDatabase
  let registry: BindingRegistry
  let mintServer: HrcServerInstanceForHandlers
  let runtimeId: string

  beforeEach(async () => {
    root = join(tmpdir(), `hrc-epr-t07138-${crypto.randomUUID()}`)
    await mkdir(root, { recursive: true })
    db = openHrcDatabase(join(root, 'state.sqlite'))
    registry = openBindingRegistry(join(root, 'registry.sqlite'))
    mintServer = {
      db,
      options: { runtimeRoot: join(root, 'run') } as HrcServerOptions,
      generateBrokerAttachToken: () => 'attach-token-t07138',
      externalParticipantClients: new Map(),
      externalRegistrationOperations: new Map(),
      externalRegistrationEstablishmentOperations: new Map(),
      stopping: false,
      ctx: { notifyEvent: () => undefined },
    } as unknown as HrcServerInstanceForHandlers
    const createdAt = new Date().toISOString()
    expect(
      db.externalRegistrationGrants.issueWithinCapacity(
        {
          registrationId: REGISTRATION_ID,
          classId: 'arris-agent',
          derivedScope: SCOPE,
          socketPath: join(root, 'participant.sock'),
          credentialHash: hashRegistrationCredential(CREDENTIAL),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          consumed: false,
          turnsAllowed: false,
          provisioner: {},
          createdAt,
        },
        1,
        createdAt
      ).outcome
    ).toBe('issued')
    runtimeId = (
      await performExternalRegistrationHello(mintServer, REGISTRATION_ID, new HelloClient())
    ).delivery.runtimeId
  })

  afterEach(async () => {
    db.close()
    registry.close()
    await rm(root, { recursive: true, force: true })
  })

  function reconciliationServer(
    client: BindingRegistryClient,
    policyFor: HrcServerInstanceForHandlers['policyFor'] = async () => ({
      claimsTask: false,
      provisioning: { node: 'svc' },
      placement: { pins: {}, homes: {} },
    })
  ): HrcServerInstanceForHandlers {
    return {
      ...mintServer,
      options: {
        ...mintServer.options,
        federationConfig: {
          sourceExists: true,
          nodeId: 'svc',
          peers: new Map(),
          gate: { mode: 'enforce' },
        },
      },
      registryClient: client,
      policyFor,
    } as unknown as HrcServerInstanceForHandlers
  }

  function projection(): Record<string, unknown> {
    const external = db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson?.[
      'externalRegistration'
    ] as Record<string, unknown>
    return external['collectiveEstablishment'] as Record<string, unknown>
  }

  test('keeps local presence pending, then establishes registry first and projects canonical', async () => {
    expect(db.runtimes.getByRuntimeId(runtimeId)).toMatchObject({
      status: 'ready',
      scopeRef: SCOPE,
    })
    expect(projection()).toMatchObject({ state: 'PENDING', bindingState: 'UNBOUND' })

    const server = reconciliationServer(registryClient(registry))
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('canonical')

    const binding = registry.get(SCOPE)
    expect(binding).toMatchObject({
      scopeRef: SCOPE,
      homeNodeId: 'svc',
      birthClass: 'mechanism-born',
      authorityProvenance: {
        kind: 'external-registration',
        registrationId: REGISTRATION_ID,
        classId: 'arris-agent',
      },
    })
    expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(SCOPE)).toEqual({
      ...binding,
      state: 'active',
    })
    expect(projection()).toMatchObject({
      state: 'CANONICAL',
      bindingState: 'BOUND',
      homeNodeId: 'svc',
      placementEpoch: 1,
    })
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('converges a registry-success/local-ledger crash with the same persisted identity', async () => {
    const registered = registry.establish({
      scopeRef: SCOPE,
      homeNodeId: 'svc',
      placementEpoch: 1,
      birthClass: 'mechanism-born',
      authorityProvenance: {
        kind: 'external-registration',
        registrationId: REGISTRATION_ID,
        classId: 'arris-agent',
      },
      establishmentProvenance: 'explicit_local',
      now: new Date().toISOString(),
    }).binding
    expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(SCOPE)).toBeUndefined()

    const outcome = await reconcileExternalRegistrationCollectiveEstablishment(
      reconciliationServer(registryClient(registry)),
      REGISTRATION_ID
    )
    expect(outcome).toBe('canonical')
    expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(SCOPE)).toEqual({
      ...registered,
      state: 'active',
    })
    expect(db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)).toMatchObject({
      registrationId: REGISTRATION_ID,
      derivedScope: SCOPE,
      runtimeId,
    })
  })

  test('transient registry failure stays pending and retries the same identity to convergence', async () => {
    let fail = true
    const client = registryClient(registry, {
      consult: () => {
        if (fail) throw new Error('registry asleep')
      },
    })
    const server = reconciliationServer(client)
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('pending')
    expect(projection()).toMatchObject({
      state: 'PENDING',
      bindingState: 'UNBOUND',
      retryable: true,
    })
    expect(db.runtimes.getByRuntimeId(runtimeId)).toMatchObject({
      status: 'ready',
      scopeRef: SCOPE,
    })

    fail = false
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('canonical')
    expect(registry.list()).toHaveLength(1)
  })

  test('a repeated pending outcome with an unchanged cause does not rewrite the runtime row', async () => {
    const client = registryClient(registry, {
      consult: () => {
        throw new Error('registry asleep')
      },
    })
    const server = reconciliationServer(client)
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('pending')
    const first = projection()
    expect(first).toMatchObject({ state: 'PENDING' })

    await Bun.sleep(2)
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('pending')
    expect(projection()['updatedAt']).toBe(first['updatedAt'])
  })

  test('abandons establishment when the minted runtime is terminal instead of retrying forever', async () => {
    const now = new Date().toISOString()
    db.runtimes.update(runtimeId, { status: 'terminated', statusChangedAt: now, updatedAt: now })
    const client = registryClient(registry, {})
    const server = reconciliationServer(client)
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('abandoned')
    expect(registry.list()).toHaveLength(0)
  })

  test('scheduled post-mint hook retries in one registration-keyed operation', async () => {
    let consultAttempts = 0
    const client = registryClient(registry, {
      consult: () => {
        consultAttempts += 1
        if (consultAttempts === 1) throw new Error('registry waking')
      },
    })
    const server = reconciliationServer(client)
    server.options.externalParticipantCollectiveEstablishmentRetryMs = 1
    scheduleExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    scheduleExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    const operation = server.externalRegistrationEstablishmentOperations.get(REGISTRATION_ID)
    expect(operation).toBeDefined()
    await operation

    expect(consultAttempts).toBe(2)
    expect(server.externalRegistrationEstablishmentOperations.has(REGISTRATION_ID)).toBe(false)
    expect(projection()).toMatchObject({
      state: 'CANONICAL',
      bindingState: 'BOUND',
      homeNodeId: 'svc',
    })
  })

  test('quarantines a permanently unbound registration at its durable attempt budget', async () => {
    let consultAttempts = 0
    const client = registryClient(registry, {
      consult: () => {
        consultAttempts += 1
        throw new Error(`registry unavailable ${consultAttempts}`)
      },
    })
    const server = reconciliationServer(client)
    server.options.externalParticipantCollectiveEstablishmentRetryMs = 1
    server.options.externalParticipantCollectiveEstablishmentRetryBudget = 3

    scheduleExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    const operation = server.externalRegistrationEstablishmentOperations.get(REGISTRATION_ID)
    expect(operation).toBeDefined()
    await operation

    expect(consultAttempts).toBe(3)
    expect(server.externalRegistrationEstablishmentOperations.has(REGISTRATION_ID)).toBe(false)
    expect(projection()).toMatchObject({
      state: 'QUARANTINED',
      bindingState: 'UNBOUND',
      retryable: false,
      attemptCount: 3,
      attemptBudget: 3,
    })
    expect(typeof projection()['quarantinedAt']).toBe('string')

    scheduleExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    expect(server.externalRegistrationEstablishmentOperations.has(REGISTRATION_ID)).toBe(false)
    await Bun.sleep(5)
    expect(consultAttempts).toBe(3)
  })

  test('resumes the monotonic registration attempt count after controller restart', async () => {
    let consultAttempts = 0
    const client = registryClient(registry, {
      consult: () => {
        consultAttempts += 1
        throw new Error(`alternating failure ${consultAttempts % 2}`)
      },
    })
    const firstServer = reconciliationServer(client)
    firstServer.options.externalParticipantCollectiveEstablishmentRetryMs = 100
    firstServer.options.externalParticipantCollectiveEstablishmentRetryBudget = 3
    scheduleExternalRegistrationCollectiveEstablishment(firstServer, REGISTRATION_ID)
    while (projection()['attemptCount'] !== 1) await Bun.sleep(1)
    firstServer.stopping = true
    await firstServer.externalRegistrationEstablishmentOperations.get(REGISTRATION_ID)

    expect(projection()).toMatchObject({ state: 'PENDING', attemptCount: 1, attemptBudget: 3 })

    const restartedServer = reconciliationServer(client)
    restartedServer.stopping = false
    restartedServer.options.externalParticipantCollectiveEstablishmentRetryMs = 1
    restartedServer.options.externalParticipantCollectiveEstablishmentRetryBudget = 3
    scheduleExternalRegistrationCollectiveEstablishment(restartedServer, REGISTRATION_ID)
    await restartedServer.externalRegistrationEstablishmentOperations.get(REGISTRATION_ID)

    expect(consultAttempts).toBe(3)
    expect(projection()).toMatchObject({
      state: 'QUARANTINED',
      attemptCount: 3,
      attemptBudget: 3,
    })
  })

  test('projects policy refusal and binding conflict as visible noncanonical shadows', async () => {
    const policyServer = reconciliationServer(registryClient(registry), async () => ({
      claimsTask: false,
      placement: { pins: { 'arris:reg-t07138': 'lab' }, homes: {} },
    }))
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(policyServer, REGISTRATION_ID)
    ).toBe('noncanonical')
    expect(projection()).toMatchObject({
      state: 'NONCANONICAL',
      bindingState: 'UNBOUND',
      cause: 'placement_refused',
      homeNodeId: 'lab',
    })
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')

    registry.establish({
      scopeRef: SCOPE,
      homeNodeId: 'lab',
      placementEpoch: 1,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
      now: new Date().toISOString(),
    })
    const conflictServer = reconciliationServer(registryClient(registry))
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(conflictServer, REGISTRATION_ID)
    ).toBe('noncanonical')
    expect(projection()).toMatchObject({
      state: 'NONCANONICAL',
      bindingState: 'BOUND',
      cause: 'binding_conflict',
      homeNodeId: 'lab',
    })
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('projects a remote default_home_node as placement_refused instead of explicit-local canonical', async () => {
    const server = reconciliationServer(registryClient(registry), async () => ({
      claimsTask: false,
      provisioning: { node: 'lab' },
      placement: { pins: {}, homes: {} },
    }))

    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(server, REGISTRATION_ID)
    ).toBe('noncanonical')
    expect(registry.get(SCOPE)).toBeUndefined()
    expect(projection()).toMatchObject({
      state: 'NONCANONICAL',
      bindingState: 'UNBOUND',
      cause: 'placement_refused',
      homeNodeId: 'lab',
    })
    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('ready')
  })

  test('projects noncanonical when a legacy local binding disagrees with default_home_node', async () => {
    const local = reconciliationServer(registryClient(registry))
    expect(await reconcileExternalRegistrationCollectiveEstablishment(local, REGISTRATION_ID)).toBe(
      'canonical'
    )

    const remotePolicy = reconciliationServer(registryClient(registry), async () => ({
      claimsTask: false,
      provisioning: { node: 'lab' },
      placement: { pins: {}, homes: {} },
    }))
    expect(
      await reconcileExternalRegistrationCollectiveEstablishment(remotePolicy, REGISTRATION_ID)
    ).toBe('noncanonical')
    expect(projection()).toMatchObject({
      state: 'NONCANONICAL',
      bindingState: 'BOUND',
      cause: 'placement_refused',
      homeNodeId: 'lab',
      placementEpoch: 1,
    })
    expect(registry.get(SCOPE)?.homeNodeId).toBe('svc')
  })
})
