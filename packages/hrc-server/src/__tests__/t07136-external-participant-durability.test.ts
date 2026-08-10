import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RUNTIME_STATUS_LEVEL_BY_STATUS } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { ExternalRegistrationGrant, HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller.js'
import {
  EPR_REPLAY_UNAVAILABLE_CODE,
  hashRegistrationCredential,
  markExternalParticipantDetached,
  performExternalParticipantAttach,
  performExternalRegistrationHello,
  runExternalRegistrationRendezvous,
} from '../index.js'
import type {
  EprEstablishedDelivery,
  ExternalParticipantRpcClient,
  HrcServerOptions,
} from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'

const REGISTRATION_ID = 'registration-t07136'
const CREDENTIAL = 'credential-t07136'
const SCOPE = 'agent:arris:project:arris:task:reg-t07136'

function event(
  invocationId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: new Date(1_786_306_000_000 + seq).toISOString(),
    type,
    payload,
  } as InvocationEventEnvelope
}

function snapshot(invocationId: string, currentSeq: number) {
  return {
    invocationId,
    state: 'ready',
    capabilities: {},
    pendingInputIds: [],
    inputDispositions: {},
    pendingPermissionRequests: [],
    currentSeq,
    retentionFloorSeq: 0,
  }
}

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
    if (method === 'epr.established') {
      if (Number(params['ackedThroughSeq']) < 0) {
        throw Object.assign(new Error('ackedThroughSeq must be nonnegative'), { code: -32602 })
      }
      return { ready: true, currentSeq: 0 }
    }
    throw new Error(`unexpected ${method}`)
  }

  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

class AttachClient implements ExternalParticipantRpcClient {
  readonly calls: string[] = []

  constructor(
    readonly invocationId: string,
    readonly events: InvocationEventEnvelope[],
    readonly options: {
      reattach?: boolean | undefined
      reattachErrorCode?: number | undefined
      snapshotErrorCode?: number | undefined
      eventsSinceErrorCode?: number | undefined
      retentionFloorSeq?: number | undefined
    } = {}
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push(method)
    if (method === 'epr.reattach') {
      if (this.options.reattachErrorCode !== undefined) {
        throw Object.assign(new Error('replay unavailable'), {
          code: this.options.reattachErrorCode,
        })
      }
      return {
        attached: true,
        participantInstanceId: 'participant-t07136',
        currentSeq: this.events.at(-1)?.seq ?? 0,
        retentionFloorSeq: this.options.retentionFloorSeq ?? 0,
        snapshot: snapshot(this.invocationId, this.events.at(-1)?.seq ?? 0),
      }
    }
    if (method === 'invocation.snapshot') {
      if (this.options.snapshotErrorCode !== undefined) {
        throw Object.assign(new Error('replay unavailable'), {
          code: this.options.snapshotErrorCode,
        })
      }
      return snapshot(this.invocationId, this.events.at(-1)?.seq ?? 0)
    }
    if (method === 'invocation.eventsSince') {
      if (this.options.eventsSinceErrorCode !== undefined) {
        throw Object.assign(new Error('replay unavailable'), {
          code: this.options.eventsSinceErrorCode,
        })
      }
      const afterSeq = Number(params['afterSeq'])
      const replay = this.events.filter((item) => item.seq > afterSeq)
      return {
        events: replay,
        currentSeq: this.events.at(-1)?.seq ?? afterSeq,
        retentionFloorSeq: this.options.retentionFloorSeq ?? 0,
      }
    }
    if (method === 'invocation.ackEvents') {
      return { ackedThroughSeq: params['throughSeq'] }
    }
    if (method === 'broker.health') return { status: 'ok', activeInvocations: 1 }
    if (method === 'invocation.status') {
      return { invocationId: this.invocationId, state: 'ready' }
    }
    throw new Error(`unexpected ${method}`)
  }

  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

class FailingProbeClient extends AttachClient {
  private closeResolve!: () => void
  private readonly closePromise = new Promise<void>((resolve) => {
    this.closeResolve = resolve
  })
  private statusCalls = 0

  override async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'invocation.status') {
      this.calls.push(method)
      this.statusCalls += 1
      if (this.statusCalls > 1) throw new Error('wedged control plane')
      return { invocationId: this.invocationId, state: 'ready' }
    }
    return super.request(method, params)
  }

  streamNotifications(): AsyncIterable<never> {
    const closed = this.closePromise
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await closed
          return { done: true, value: undefined }
        },
      }),
    }
  }

  waitForClose(): Promise<void> {
    return this.closePromise
  }

  override async close(): Promise<void> {
    this.closeResolve()
  }
}

describe('T-07136 EPR durable event, reattach, and detached semantics', () => {
  let root: string
  let db: HrcDatabase
  let server: HrcServerInstanceForHandlers
  let delivery: EprEstablishedDelivery

  beforeEach(async () => {
    root = join(tmpdir(), `hrc-epr-t07136-${crypto.randomUUID()}`)
    await mkdir(root, { recursive: true })
    db = openHrcDatabase(join(root, 'state.sqlite'))
    const controller = new HarnessBrokerController({ db })
    server = {
      db,
      options: { runtimeRoot: join(root, 'run') } as HrcServerOptions,
      harnessBrokerController: controller,
      generateBrokerAttachToken: () => 'attach-token-t07136',
      externalParticipantClients: new Map(),
      externalRegistrationOperations: new Map(),
      stopping: false,
      ctx: { notifyEvent: () => undefined },
    } as unknown as HrcServerInstanceForHandlers
    const grant: ExternalRegistrationGrant = {
      registrationId: REGISTRATION_ID,
      classId: 'arris-agent',
      derivedScope: SCOPE,
      socketPath: join(root, 'participant.sock'),
      credentialHash: hashRegistrationCredential(CREDENTIAL),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumed: false,
      turnsAllowed: false,
      provisioner: {},
      createdAt: new Date().toISOString(),
    }
    expect(
      db.externalRegistrationGrants.issueWithinCapacity(grant, 1, grant.createdAt).outcome
    ).toBe('issued')
    delivery = (await performExternalRegistrationHello(server, REGISTRATION_ID, new HelloClient()))
      .delivery
  })

  afterEach(async () => {
    server.harnessBrokerController?.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  test('keeps detached unavailable for selection but outside runtime-dead monitor truth', () => {
    expect(isRuntimeUnavailableStatus('detached')).toBe(true)
    expect(RUNTIME_STATUS_LEVEL_BY_STATUS.detached).toBeNull()
  })

  test('maps the closed 0.2 registry and ACKs through currentSeq before health publishes active', async () => {
    const client = new AttachClient(delivery.invocationId, [
      event(delivery.invocationId, 1, 'invocation.started', {
        command: 'arris',
        args: ['agent'],
        cwd: root,
      }),
      event(delivery.invocationId, 2, 'driver.notice', {
        message: 'scene indexed',
        code: 'epr.activity',
        data: { nodeCount: 4 },
      }),
    ])

    const attached = await performExternalParticipantAttach(
      server,
      REGISTRATION_ID,
      client,
      'established'
    )

    expect(attached.terminal).toBe(false)
    expect(client.calls).toEqual([
      'invocation.snapshot',
      'invocation.eventsSince',
      'invocation.ackEvents',
      'broker.health',
      'invocation.status',
    ])
    expect(
      db.brokerInvocationEvents.listByInvocationId(delivery.invocationId).map((row) => row.type)
    ).toEqual(['invocation.started', 'driver.notice'])
    expect(db.runtimes.getByRuntimeId(delivery.runtimeId)?.runtimeStateJson).toMatchObject({
      status: 'ready',
      control: { mode: 'epr', brokerAttached: true },
      externalRegistration: { ackedThroughSeq: 2 },
    })
  })

  test('rejects an envelope outside the 0.2 closed registry before ACK', async () => {
    const client = new AttachClient(delivery.invocationId, [
      event(delivery.invocationId, 1, 'epr.custom', { value: 1 }),
    ])
    await expect(
      performExternalParticipantAttach(server, REGISTRATION_ID, client, 'established')
    ).rejects.toThrow('Invalid invocation event envelope')
    expect(client.calls).not.toContain('invocation.ackEvents')
  })

  test('reattaches with a fresh controller fence and replays from the durable ACK high-water', async () => {
    await performExternalParticipantAttach(
      server,
      REGISTRATION_ID,
      new AttachClient(delivery.invocationId, []),
      'established'
    )
    const before = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)!
    markExternalParticipantDetached(server, before, 60_000, { reason: 'socket_closed' })
    const reattach = new AttachClient(delivery.invocationId, [
      event(delivery.invocationId, 1, 'invocation.started', {
        command: 'arris',
        args: ['agent'],
        cwd: root,
      }),
    ])

    await performExternalParticipantAttach(server, REGISTRATION_ID, reattach, 'reattach')

    const after = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)!
    expect(after.controllerInstanceId).not.toBe(before.controllerInstanceId)
    expect(reattach.calls.slice(0, 3)).toEqual([
      'epr.reattach',
      'invocation.eventsSince',
      'invocation.ackEvents',
    ])
    expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({ status: 'ready' })
  })

  test('fails closed on EventReplayUnavailable with explicit replay_gap terminal fact', async () => {
    const grant = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)!
    markExternalParticipantDetached(server, grant, 60_000)
    const client = new AttachClient(delivery.invocationId, [], {
      reattach: true,
      reattachErrorCode: EPR_REPLAY_UNAVAILABLE_CODE,
    })

    await expect(
      performExternalParticipantAttach(server, REGISTRATION_ID, client, 'reattach')
    ).rejects.toThrow('replay')

    expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'replay_gap',
    })
    expect(
      db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: delivery.runtimeId })
        .some((item) => item.payload?.['reason'] === 'replay_gap')
    ).toBe(true)
  })

  test.each(['invocation.snapshot', 'invocation.eventsSince'] as const)(
    'fails closed when %s refuses the establishment replay plane',
    async (method) => {
      const client = new AttachClient(delivery.invocationId, [], {
        ...(method === 'invocation.snapshot'
          ? { snapshotErrorCode: EPR_REPLAY_UNAVAILABLE_CODE }
          : { eventsSinceErrorCode: EPR_REPLAY_UNAVAILABLE_CODE }),
      })

      await expect(
        performExternalParticipantAttach(server, REGISTRATION_ID, client, 'established')
      ).rejects.toThrow('replay')

      expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({
        status: 'terminated',
        lifecycleTerminalReason: 'replay_gap',
      })
    }
  )

  test('classifies clean invocation.exited as external_participant_exit, never crashed', async () => {
    const client = new AttachClient(delivery.invocationId, [
      event(delivery.invocationId, 1, 'invocation.started', {
        command: 'arris',
        args: ['agent'],
        cwd: root,
      }),
      event(delivery.invocationId, 2, 'invocation.exited', {
        exitCode: 0,
        signal: null,
        reason: 'complete',
      }),
    ])
    const attached = await performExternalParticipantAttach(
      server,
      REGISTRATION_ID,
      client,
      'established'
    )
    expect(attached.terminal).toBe(true)
    expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'external_participant_exit',
    })
  })

  test('never infers a broker crash from an external invocation.failed event', async () => {
    const client = new AttachClient(delivery.invocationId, [
      event(delivery.invocationId, 1, 'invocation.started', {
        command: 'arris',
        args: ['agent'],
        cwd: root,
      }),
      event(delivery.invocationId, 2, 'invocation.failed', {
        code: 'participant_error',
        message: 'agent loop failed',
      }),
    ])

    await performExternalParticipantAttach(server, REGISTRATION_ID, client, 'established')

    expect(db.runtimes.getByRuntimeId(delivery.runtimeId)?.status).not.toBe('crashed')
    expect(
      db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: delivery.runtimeId })
        .some((item) => item.kind === 'runtime.crashed')
    ).toBe(false)
  })

  test('closes after three probe misses, stays detached during linger, then expires explicitly', async () => {
    await performExternalParticipantAttach(
      server,
      REGISTRATION_ID,
      new AttachClient(delivery.invocationId, []),
      'established'
    )
    const grant = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)!
    markExternalParticipantDetached(server, grant, 25, { reason: 'socket_closed' })
    server.options.externalParticipantProbeIntervalMs = 1
    server.options.externalParticipantProbeDeadlineMs = 10
    server.options.externalParticipantProbeFailureThreshold = 3
    server.options.externalParticipantLingerMs = 25
    server.options.externalParticipantRendezvousRetryMs = 1
    const client = new FailingProbeClient(delivery.invocationId, [])
    let dials = 0
    server.options.externalParticipantClientFactory = async () => {
      dials += 1
      if (dials === 1) return client
      throw new Error('participant remains offline')
    }

    await runExternalRegistrationRendezvous.call(server, REGISTRATION_ID)

    expect(client.calls.filter((method) => method === 'invocation.status')).toHaveLength(4)
    expect(dials).toBeGreaterThan(1)
    expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'detached_expired',
    })
  })
})
