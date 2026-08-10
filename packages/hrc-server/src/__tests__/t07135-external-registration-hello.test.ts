import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { ExternalRegistrationGrant, HrcDatabase } from 'hrc-store-sqlite'

import { projectBrokerHostingState } from '../broker/runtime-hosting.js'
import { externalRegistrationRetryDelayMs } from '../external-registration-rendezvous.js'
import {
  EPR_HELLO_ERROR_CODE,
  EprHelloError,
  hashRegistrationCredential,
  performExternalRegistrationHello,
  runExternalRegistrationRendezvous,
} from '../index.js'
import type {
  EprEstablishedDelivery,
  ExternalParticipantRpcClient,
  HrcServerOptions,
} from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { reconcileDurableBrokerStartup, warmDurableBrokerBindings } from '../startup-reconcile.js'

const CREDENTIAL = 'epr_test_credential'
const REGISTRATION_ID = 'registration-t07135'
const DERIVED_SCOPE = 'agent:arris:project:arris:task:reg-t07135'

type ScriptedClientOptions = {
  registrationId?: string | undefined
  credential?: string | undefined
  protocolVersion?: string | undefined
  capabilities?: Record<string, unknown> | undefined
  participantInfo?: Record<string, unknown> | undefined
  established?: ((delivery: EprEstablishedDelivery) => unknown | Promise<unknown>) | undefined
}

class ScriptedClient implements ExternalParticipantRpcClient {
  readonly deliveries: EprEstablishedDelivery[] = []
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  closed = false

  constructor(private readonly options: ScriptedClientOptions = {}) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'epr.hello') {
      const registrationId = this.options.registrationId ?? String(params['registrationId'])
      return {
        protocolVersion: this.options.protocolVersion ?? 'epr/1',
        registrationId,
        credential: this.options.credential ?? CREDENTIAL,
        capabilities: this.options.capabilities ?? {
          events: true,
          turns: false,
          continuations: false,
        },
        participantInfo: this.options.participantInfo ?? { name: 'arris', version: '1.0.0' },
      }
    }
    if (method === 'epr.established') {
      const delivery = params as unknown as EprEstablishedDelivery
      this.deliveries.push(delivery)
      return (await this.options.established?.(delivery)) ?? { ready: true, currentSeq: 0 }
    }
    throw new Error(`unexpected RPC ${method}`)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, params })
  }
}

function futureIso(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString()
}

function makeGrant(patch: Partial<ExternalRegistrationGrant> = {}): ExternalRegistrationGrant {
  return {
    registrationId: REGISTRATION_ID,
    classId: 'arris-agent',
    derivedScope: DERIVED_SCOPE,
    socketPath: '/tmp/arris-t07135.sock',
    credentialHash: hashRegistrationCredential(CREDENTIAL),
    expiresAt: futureIso(),
    consumed: false,
    turnsAllowed: false,
    provisioner: { name: 'test' },
    createdAt: new Date().toISOString(),
    ...patch,
  }
}

describe('T-07135 EPR hello mint and establishment ACK', () => {
  let root: string
  let db: HrcDatabase
  let server: HrcServerInstanceForHandlers

  beforeEach(async () => {
    root = join(tmpdir(), `hrc-epr-t07135-${crypto.randomUUID()}`)
    await mkdir(root, { recursive: true })
    db = openHrcDatabase(join(root, 'state.sqlite'))
    server = {
      db,
      options: { runtimeRoot: join(root, 'run') } as HrcServerOptions,
      generateBrokerAttachToken: () => 'attach-token-t07135',
      externalParticipantClients: new Map(),
      externalRegistrationOperations: new Map(),
      stopping: false,
    } as unknown as HrcServerInstanceForHandlers
  })

  afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  function issue(grant = makeGrant()): void {
    expect(
      db.externalRegistrationGrants.issueWithinCapacity(grant, 4, grant.createdAt).outcome
    ).toBe('issued')
  }

  test('atomically mints the full ready graph, durable token reference, and ACK marker', async () => {
    issue()
    let deliveryPendingObserved = false
    const client = new ScriptedClient({
      established: async (delivery) => {
        const duringDelivery = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
        deliveryPendingObserved = duringDelivery?.establishmentState === 'DELIVERY_PENDING'
        expect(duringDelivery?.controllerInstanceId).toBe(delivery.controllerInstanceId)
        expect(duringDelivery?.runtimeId).toBe(delivery.runtimeId)
        expect(duringDelivery?.invocationId).toBe(delivery.invocationId)
        return { ready: true, currentSeq: 0 }
      },
    })

    const result = await performExternalRegistrationHello(server, REGISTRATION_ID, client)
    expect(result.branch).toBe('minted')
    expect(deliveryPendingObserved).toBe(true)
    expect(client.deliveries).toHaveLength(1)
    expect(result.delivery).toMatchObject({
      derivedScope: DERIVED_SCOPE,
      attachToken: 'attach-token-t07135',
      ackedThroughSeq: 0,
      probe: { intervalMs: 30_000, deadlineMs: 2_000, failureThreshold: 3 },
    })

    const grant = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
    expect(grant).toMatchObject({
      consumed: true,
      establishmentState: 'ESTABLISHED',
      runtimeId: result.delivery.runtimeId,
      invocationId: result.delivery.invocationId,
      capabilities: { events: true, turns: false, continuations: false },
      participantInfo: { name: 'arris', version: '1.0.0' },
    })
    expect(grant?.establishedAt).toBeString()
    expect(db.sessions.getByHostSessionId(grant!.hostSessionId!)).toMatchObject({
      scopeRef: DERIVED_SCOPE,
      laneRef: 'main',
      generation: 1,
      status: 'active',
    })
    expect(db.continuities.getByKey(DERIVED_SCOPE, 'main')?.activeHostSessionId).toBe(
      grant?.hostSessionId
    )
    expect(db.runtimeOperations.getByOperationId(grant!.operationId!)).toMatchObject({
      runtimeId: result.delivery.runtimeId,
      startupMethod: 'epr.hello',
      status: 'completed',
    })
    expect(db.brokerInvocations.getByInvocationId(result.delivery.invocationId)).toMatchObject({
      runtimeId: result.delivery.runtimeId,
      brokerProtocol: 'epr/1',
      brokerDriver: 'external-participant',
      invocationState: 'ready',
    })

    const runtime = db.runtimes.getByRuntimeId(result.delivery.runtimeId)!
    expect(runtime).toMatchObject({
      status: 'ready',
      transport: 'headless',
      harness: 'epr-external',
      provider: 'epr-external',
    })
    expect(runtime.runtimeStateJson).toMatchObject({
      origin: 'external-registration',
      lifecycleOwner: 'external',
      externalRegistration: {
        registrationId: REGISTRATION_ID,
        establishmentState: 'ESTABLISHED',
        capabilities: { events: true, turns: false, continuations: false },
      },
      broker: {
        endpoint: { kind: 'unix-jsonrpc-ndjson', socketPath: '/tmp/arris-t07135.sock' },
        substrate: { kind: 'external' },
        presentation: { kind: 'none' },
      },
    })
    expect(projectBrokerHostingState(runtime)).toMatchObject({
      broker: { protocolVersion: 'epr/1', endpoint: { kind: 'unix-jsonrpc-ndjson' } },
      substrate: { kind: 'external' },
      presentation: { kind: 'none' },
    })
    expect((await readFile(grant!.attachTokenRef!, 'utf8')).trim()).toBe('attach-token-t07135')

    const raw = new Database(join(root, 'state.sqlite'), { readonly: true })
    try {
      const serialized = JSON.stringify(
        raw.query('SELECT * FROM external_registration_grants').all()
      )
      expect(serialized).not.toContain('attach-token-t07135')
    } finally {
      raw.close()
    }
  })

  test('re-delivers identical minted authority after a lost established response', async () => {
    issue()
    const lost = new ScriptedClient({
      established: () => {
        throw new Error('response lost')
      },
    })
    await expect(performExternalRegistrationHello(server, REGISTRATION_ID, lost)).rejects.toThrow(
      'response lost'
    )
    const pending = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
    expect(pending?.establishmentState).toBe('DELIVERY_PENDING')

    const retry = new ScriptedClient()
    const result = await performExternalRegistrationHello(server, REGISTRATION_ID, retry)
    expect(result.branch).toBe('redelivered')
    expect(retry.deliveries[0]).toEqual(lost.deliveries[0])
    expect(db.sessions.count()).toBe(1)
    expect(db.runtimes.listAll()).toHaveLength(1)
    expect(
      db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)?.establishmentState
    ).toBe('ESTABLISHED')
  })

  test('retries a malformed established ACK without misclassifying it as a hello refusal', async () => {
    issue()
    const malformedAck = new ScriptedClient({ established: () => ({ ready: false }) })
    const accepted = new ScriptedClient()
    let attempts = 0
    server.options.externalParticipantRendezvousRetryMs = 1
    server.options.externalParticipantClientFactory = async () => {
      attempts += 1
      return attempts === 1 ? malformedAck : accepted
    }

    await runExternalRegistrationRendezvous.call(server, REGISTRATION_ID)

    expect(attempts).toBe(2)
    expect(malformedAck.notifications).toEqual([])
    expect(malformedAck.closed).toBe(true)
    expect(accepted.deliveries[0]).toEqual(malformedAck.deliveries[0])
    expect(
      db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)?.establishmentState
    ).toBe('ESTABLISHED')
  })

  test('uses deterministic exponential rendezvous backoff with a hard delay cap', () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((failures) => externalRegistrationRetryDelayMs(failures, 100, 1_000))
    ).toEqual([100, 200, 400, 800, 1_000, 1_000])
    expect(externalRegistrationRetryDelayMs(1, 100, 50)).toBe(50)
  })

  test('detaches DELIVERY_PENDING after its retry budget, redelivers during linger, then expires', async () => {
    issue()
    let attempts = 0
    let observedDeliveryTimeout = false
    server.options.externalParticipantRendezvousRetryMs = 1
    server.options.externalParticipantRendezvousRetryMaxMs = 50
    server.options.externalParticipantRendezvousRetryBudget = 2
    server.options.externalParticipantLingerMs = 500
    server.options.externalParticipantClientFactory = async () => {
      attempts += 1
      const current = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
      const runtime =
        current?.runtimeId === undefined ? null : db.runtimes.getByRuntimeId(current.runtimeId)
      observedDeliveryTimeout ||=
        runtime?.status === 'detached' &&
        runtime.runtimeStateJson?.['control']?.['reason'] === 'delivery_timeout'
      return new ScriptedClient({ established: () => ({ ready: false }) })
    }

    await runExternalRegistrationRendezvous.call(server, REGISTRATION_ID)

    const grant = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)!
    expect(observedDeliveryTimeout).toBe(true)
    expect(attempts).toBeGreaterThan(2)
    expect(grant.establishmentState).toBe('DELIVERY_PENDING')
    expect(db.runtimes.getByRuntimeId(grant.runtimeId!)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'detached_expired',
    })
  })

  test('rolls grant consumption and every start row back when mint persistence fails', async () => {
    issue()
    db.externalRegistrationGrants.recordMint = () => {
      throw new Error('injected mint failure')
    }
    await expect(
      performExternalRegistrationHello(server, REGISTRATION_ID, new ScriptedClient())
    ).rejects.toThrow('injected mint failure')
    const rolledBack = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
    expect(rolledBack?.consumed).toBe(false)
    expect(rolledBack?.establishmentState).toBeUndefined()
    expect(db.sessions.count()).toBe(0)
    expect(db.runtimes.count()).toBe(0)
    expect(db.runtimeOperations.listByRuntimeId('missing')).toEqual([])
  })

  test('classifies established and finalized consumed registrations with exact integer codes', async () => {
    issue()
    const established = await performExternalRegistrationHello(
      server,
      REGISTRATION_ID,
      new ScriptedClient()
    )
    await expect(
      performExternalRegistrationHello(server, REGISTRATION_ID, new ScriptedClient())
    ).rejects.toMatchObject({
      eprError: 'registration_established',
      code: EPR_HELLO_ERROR_CODE.registration_established,
    })

    db.runtimes.updateStatus(established.delivery.runtimeId, 'terminated', new Date().toISOString())
    await expect(
      performExternalRegistrationHello(server, REGISTRATION_ID, new ScriptedClient())
    ).rejects.toMatchObject({
      eprError: 'registration_completed',
      code: EPR_HELLO_ERROR_CODE.registration_completed,
    })
  })

  test('sends epr.rejected then closes on a validation refusal', async () => {
    issue()
    const client = new ScriptedClient({ credential: 'wrong' })
    server.options.externalParticipantClientFactory = async () => client

    await runExternalRegistrationRendezvous.call(server, REGISTRATION_ID)

    expect(client.notifications).toEqual([
      {
        method: 'epr.rejected',
        params: {
          registrationId: REGISTRATION_ID,
          code: EPR_HELLO_ERROR_CODE.credential_mismatch,
          eprError: 'credential_mismatch',
        },
      },
    ])
    expect(client.closed).toBe(true)
    expect(db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)?.consumed).toBe(false)
  })

  test('never opens hello for an established registration', async () => {
    issue()
    await performExternalRegistrationHello(server, REGISTRATION_ID, new ScriptedClient())
    let dials = 0
    server.options.externalParticipantClientFactory = async () => {
      dials += 1
      return new ScriptedClient()
    }

    await runExternalRegistrationRendezvous.call(server, REGISTRATION_ID)
    expect(dials).toBe(0)
  })

  test('rejects an established race with the reattach hint before closing', async () => {
    issue()
    const client = new ScriptedClient()
    server.options.externalParticipantClientFactory = async () => {
      db.sqlite
        .query(
          `UPDATE external_registration_grants
           SET consumed = 1, establishment_state = 'ESTABLISHED'
           WHERE registration_id = ?`
        )
        .run(REGISTRATION_ID)
      return client
    }

    await runExternalRegistrationRendezvous.call(server, REGISTRATION_ID)

    expect(client.notifications).toEqual([
      {
        method: 'epr.rejected',
        params: {
          registrationId: REGISTRATION_ID,
          code: EPR_HELLO_ERROR_CODE.registration_established,
          eprError: 'registration_established',
          data: { reattach: true },
        },
      },
    ])
    expect(client.closed).toBe(true)
    expect(db.sessions.count()).toBe(0)
    expect(db.runtimes.count()).toBe(0)
  })

  test('keeps epr-external legacy labels out of driver/provider behavior branches', async () => {
    const sourceRoot = join(import.meta.dir, '..')
    const references: string[] = []
    for await (const relative of new Bun.Glob('**/*.ts').scan({ cwd: sourceRoot })) {
      if (relative.startsWith('__tests__/')) continue
      const source = await readFile(join(sourceRoot, relative), 'utf8')
      if (source.includes("'epr-external'")) references.push(relative)
    }
    expect(references.sort()).toEqual(['external-registration-rendezvous.ts'])
  })

  test('keeps external substrates out of harness-broker restart attach and stale paths', async () => {
    issue()
    const established = await performExternalRegistrationHello(
      server,
      REGISTRATION_ID,
      new ScriptedClient()
    )
    let attachCalls = 0
    const controller = {
      attachAndReplay: async () => {
        attachCalls += 1
        throw new Error('harness-broker attach must not receive EPR rows')
      },
    }
    const neverClient = async () => {
      throw new Error('harness-broker Unix client must not dial EPR rows')
    }
    const outcomes = await reconcileDurableBrokerStartup(db, {
      controller,
      brokerUnixClientFactory: neverClient,
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('harness-broker lease probe must not inspect external substrates')
      },
      attach: false,
      sweepOrphans: async () => undefined,
    })
    const warmup = await warmDurableBrokerBindings(db, {
      controller,
      brokerUnixClientFactory: neverClient,
    })
    expect(outcomes).toEqual([])
    expect(warmup.total).toBe(0)
    expect(attachCalls).toBe(0)
    expect(db.runtimes.getByRuntimeId(established.delivery.runtimeId)?.status).toBe('ready')
  })

  test('uses the §9.8 errors for every validation refusal without consuming or minting', async () => {
    const cases: Array<{
      name: string
      grant?: ExternalRegistrationGrant | undefined
      client: ScriptedClient
      expected: keyof typeof EPR_HELLO_ERROR_CODE
    }> = [
      {
        name: 'unknown',
        client: new ScriptedClient({ registrationId: 'missing' }),
        expected: 'unknown_registration',
      },
      {
        name: 'credential',
        grant: makeGrant(),
        client: new ScriptedClient({ credential: 'wrong' }),
        expected: 'credential_mismatch',
      },
      {
        name: 'expired',
        grant: makeGrant({ expiresAt: '2000-01-01T00:00:00.000Z' }),
        client: new ScriptedClient(),
        expected: 'grant_expired',
      },
      {
        name: 'protocol',
        grant: makeGrant(),
        client: new ScriptedClient({ protocolVersion: 'epr/2' }),
        expected: 'protocol_unsupported',
      },
      {
        name: 'malformed',
        grant: makeGrant(),
        client: new ScriptedClient({ capabilities: { events: true } }),
        expected: 'malformed_hello',
      },
    ]

    for (const entry of cases) {
      if (entry.grant !== undefined) issue(entry.grant)
      try {
        await performExternalRegistrationHello(
          server,
          entry.name === 'unknown' ? 'missing' : REGISTRATION_ID,
          entry.client
        )
        throw new Error(`expected ${entry.expected}`)
      } catch (error) {
        expect(error).toBeInstanceOf(EprHelloError)
        expect(error).toMatchObject({
          eprError: entry.expected,
          code: EPR_HELLO_ERROR_CODE[entry.expected],
        })
      }
      expect(db.sessions.count()).toBe(0)
      expect(db.runtimes.count()).toBe(0)
      if (entry.grant !== undefined) {
        expect(db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)?.consumed).toBe(
          false
        )
        db.sqlite.query('DELETE FROM external_registration_grants').run()
      }
    }
  })
})
