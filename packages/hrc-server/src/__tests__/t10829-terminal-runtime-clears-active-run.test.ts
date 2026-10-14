import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { HrcErrorCode } from 'hrc-core'
import type { HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { ExternalRegistrationGrant, HrcDatabase } from 'hrc-store-sqlite'

import { BrokerControllerError } from '../broker/controller/errors.js'
import {
  markExternalParticipantDetached,
  performExternalRegistrationHello,
} from '../external-registration-rendezvous.js'
import type { ExternalParticipantRpcClient } from '../external-registration-rendezvous.js'
import { HrcServerInstance, createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  type DirectJoinRequest,
  type DirectJoinResult,
  registerDirectParticipant,
} from '../participant-host-registration.js'
import { hashRegistrationCredential } from '../registration-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { withServerLog } from './fixtures/server-log.js'

/**
 * T-10829: a runtime that reaches a terminal status owns no run. A terminal row
 * still naming `active_run_id` reads as mid-turn to the session projection
 * (session-recency.ts), so its session was listed in every unscoped
 * `/v1/sessions` read forever: 38 such rows on max3, from broker crashes,
 * operator evictions and host successions, none of which cleared the pointer.
 *
 * Every gate asks the projection the same question: an `updatedSince` past all
 * of the session's activity admits a session only through the running-runtime
 * predicate. Before settlement the session is listed (the control in each
 * test); after it, it is not.
 */

const FUTURE = '2099-01-01T00:00:00.000Z'

async function projectedIds(fixture: HrcServerTestFixture): Promise<string[]> {
  const response = await fixture.fetchSocket(`/v1/sessions?updatedSince=${FUTURE}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as HrcSessionRecord[]).map((row) => row.hostSessionId)
}

function insertOpenRun(
  db: HrcDatabase,
  input: {
    runId: string
    runtimeId: string
    hostSessionId: string
    scopeRef: string
    laneRef?: string
    generation?: number
  }
): void {
  const now = new Date().toISOString()
  db.runs.insert({
    runId: input.runId,
    hostSessionId: input.hostSessionId,
    runtimeId: input.runtimeId,
    scopeRef: input.scopeRef,
    laneRef: input.laneRef ?? 'main',
    generation: input.generation ?? 1,
    transport: 'headless',
    status: 'running',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
  })
  // The ownership guard on `updateRunId` is about who may NAME a run during
  // dispatch; this seeds the state a dispatch already left behind.
  db.sqlite.run('UPDATE runtimes SET active_run_id = ? WHERE runtime_id = ?', [
    input.runId,
    input.runtimeId,
  ])
}

function expectSettled(db: HrcDatabase, runtimeId: string, runId: string, reason: string): void {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)!
  expect(runtime.activeRunId).toBeUndefined()
  const run = db.runs.getByRunId(runId)!
  expect(run.status).toBe('failed')
  expect(run.completedAt).toEqual(expect.any(String))
  expect(run.errorCode).toBe(HrcErrorCode.RUNTIME_UNAVAILABLE)
  expect(run.errorMessage).toContain(reason)
}

describe('T-10829 gate 1: broker crash on a non-participant runtime', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10829-crash-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  test('the crashed runtime fails its run, drops the pointer and leaves the projection', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-10829-crash'
    const hostSessionId = 'hsid-t10829-crash'
    const runtimeId = 'rt-t10829-crash'
    const runId = 'run-t10829-crash'
    const db = (server as HrcServerInstance).db
    fixture.seedSession(hostSessionId, scopeRef)
    const now = fixture.now()
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      controllerKind: 'harness-broker',
      status: 'busy',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    } as never)
    insertOpenRun(db, { runId, runtimeId, hostSessionId, scopeRef, laneRef: 'default' })
    expect(await projectedIds(fixture)).toContain(hostSessionId)
    ;(server as HrcServerInstance)
      .getHarnessBrokerController()
      .markBrokerCrashTerminal(
        runtimeId,
        new BrokerControllerError('broker_process_closed', 'Broker socket closed unexpectedly', {})
      )

    expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('crashed')
    expect(await projectedIds(fixture)).not.toContain(hostSessionId)
    expectSettled(db, runtimeId, runId, 'Broker socket closed unexpectedly')
  })
})

const REGISTRATION_ID = 'registration-t10829'
const CREDENTIAL = 'credential-t10829'
const EPR_SCOPE = 'agent:arris:project:arris:task:reg-t10829'

class HelloClient implements ExternalParticipantRpcClient {
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'epr.hello') {
      return {
        protocolVersion: 'epr/1',
        registrationId: params['registrationId'],
        credential: CREDENTIAL,
        capabilities: { events: true, turns: false, continuations: true },
        participantInfo: { name: 'arris' },
      }
    }
    if (method === 'epr.established') return { ready: true, currentSeq: 0 }
    throw new Error(`unexpected ${method}`)
  }

  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('T-10829 gate 2a: operator evict of an external participant', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10829-evict-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  test('POST /v1/terminate evicts, fails the run, drops the pointer and leaves the projection', async () => {
    const internal = server as unknown as HrcServerInstanceForHandlers
    const db = (server as HrcServerInstance).db
    const now = fixture.now()
    const grant: ExternalRegistrationGrant = {
      registrationId: REGISTRATION_ID,
      classId: 'arris-agent',
      derivedScope: EPR_SCOPE,
      socketPath: join(fixture.tmpDir, 'participant.sock'),
      credentialHash: hashRegistrationCredential(CREDENTIAL),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumed: false,
      turnsAllowed: false,
      provisioner: {},
      createdAt: now,
    }
    expect(db.externalRegistrationGrants.issueWithinCapacity(grant, 1, now).outcome).toBe('issued')
    const delivery = (
      await performExternalRegistrationHello(internal, REGISTRATION_ID, new HelloClient())
    ).delivery
    const linked = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)!
    const runtime = db.runtimes.getByRuntimeId(delivery.runtimeId)!
    const runId = 'run-t10829-evict'
    insertOpenRun(db, {
      runId,
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
    })
    markExternalParticipantDetached(internal, linked, 600_000, { reason: 'socket_closed' })
    // Detached is a linger state: the turn survives it, so does the pointer.
    expect(db.runtimes.getByRuntimeId(runtime.runtimeId)?.activeRunId).toBe(runId)
    expect(await projectedIds(fixture)).toContain(runtime.hostSessionId)

    const response = await fixture.postJson('/v1/terminate', { runtimeId: runtime.runtimeId })
    expect(response.status).toBe(200)

    expect(db.runtimes.getByRuntimeId(runtime.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'operator_evict',
    })
    expect(await projectedIds(fixture)).not.toContain(runtime.hostSessionId)
    expectSettled(db, runtime.runtimeId, runId, 'operator_evict')
  })
})

describe('T-10829 gate 2b: host_replaced succession', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10829-succession-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    // Every broker the probe reaches is already gone.
    handlers().brokerUnixClientFactory = async () => {
      throw Object.assign(new Error('Failed to connect to broker unix socket'), {
        causeError: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
      })
    }
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  const scope = 'agent:foundry:project:hrc-runtime:task:T-10829-succession'
  const endpoint = () => `${fixture.tmpDir}/primary.brk.sock`
  function handlers(): HrcServerInstance {
    if (!(server instanceof HrcServerInstance)) throw new Error('expected a real HRC server')
    return server
  }

  function register(
    hostIncarnationId: string,
    expectedPredecessor?: DirectJoinRequest['expectedPredecessor']
  ): Promise<DirectJoinResult> {
    return registerDirectParticipant(handlers(), {
      requestedSessionRef: scope,
      laneRef: 'main',
      hostIncarnationId,
      socketPath: endpoint(),
      ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
    })
  }

  function identityOf(result: DirectJoinResult) {
    if (result.outcome !== 'registered') throw new Error(`refused: ${JSON.stringify(result)}`)
    return result.identity
  }

  /** What establishment leaves behind: ACTIVE attempt, BOUND binding, busy runtime row. */
  function establish(identity: ReturnType<typeof identityOf>): void {
    const db = handlers().db
    db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', broker_identity_json = ?, attach_socket_path = ?,
                initial_activation_confirmed_at = ?, establishment_work_state = 'completed'
          WHERE attempt_id = ?`
      )
      .run(
        JSON.stringify({ brokerInstanceId: `broker-${identity.attemptId}` }),
        endpoint(),
        '2026-10-13T08:00:00.000Z',
        identity.attemptId
      )
    const attempt = db.participantRegistrations.getAttempt(identity.attemptId)!
    db.participantHostBindings.transitionBinding({
      bindingId: attempt.hostBindingId!,
      from: ['BINDING', 'DETACHED'],
      to: 'BOUND',
      now: '2026-10-13T08:00:00.000Z',
    })
    db.runtimes.insert({
      runtimeId: identity.runtimeId,
      hostSessionId: identity.hostSessionId,
      scopeRef: scope,
      laneRef: 'main',
      generation: identity.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      controllerKind: 'harness-broker',
      status: 'busy',
      activeOperationId: attempt.operationId,
      activeInvocationId: attempt.invocationId,
      runtimeStateJson: {
        lifecycleOwner: 'external',
        participantRegistration: {
          registrationId: attempt.registrationId,
          attemptId: attempt.attemptId,
          attachEpoch: attempt.attachEpoch,
        },
      },
      createdAt: '2026-10-13T08:00:00.000Z',
      updatedAt: '2026-10-13T08:00:00.000Z',
    } as never)
  }

  test('a new host incarnation terminates the predecessor host_replaced and settles its run', async () => {
    const first = identityOf(await register('host-a'))
    establish(first)
    const db = handlers().db
    const runId = 'run-t10829-succession'
    insertOpenRun(db, {
      runId,
      runtimeId: first.runtimeId,
      hostSessionId: first.hostSessionId,
      scopeRef: scope,
      generation: first.generation,
    })
    expect(await projectedIds(fixture)).toContain(first.hostSessionId)

    const successor = identityOf(
      await register('host-b', {
        hostIncarnationId: 'host-a',
        runtimeId: first.runtimeId,
        generation: first.generation,
      })
    )
    expect(successor.runtimeId).not.toBe(first.runtimeId)

    expect(db.runtimes.getByRuntimeId(first.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: 'host_replaced',
    })
    expect(await projectedIds(fixture)).not.toContain(first.hostSessionId)
    expectSettled(db, first.runtimeId, runId, 'host_replaced')
  })
})

describe('T-10829 gate 3: startup reconcile of rows written before the fix', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10829-reconcile-')
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('a daemon start settles a terminated runtime still naming a running run', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-10829-reconcile'
    const hostSessionId = 'hsid-t10829-reconcile'
    const runtimeId = 'rt-t10829-reconcile'
    const runId = 'run-t10829-reconcile'

    // Seed AFTER a first boot so startup reconcile has not seen the row: this
    // server is the control, the state exactly as the pre-fix writers left it.
    const control = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      fixture.seedSession(hostSessionId, scopeRef)
      const db = openHrcDatabase(fixture.dbPath)
      try {
        const now = fixture.now()
        db.runtimes.insert({
          runtimeId,
          hostSessionId,
          scopeRef,
          laneRef: 'default',
          generation: 1,
          transport: 'headless',
          harness: 'codex-cli',
          provider: 'openai',
          controllerKind: 'harness-broker',
          status: 'terminated',
          supportsInflightInput: false,
          adopted: false,
          lifecycleTerminalReason: 'operator_evict',
          createdAt: now,
          updatedAt: now,
        } as never)
        insertOpenRun(db, { runId, runtimeId, hostSessionId, scopeRef, laneRef: 'default' })
      } finally {
        db.close()
      }
      expect(await projectedIds(fixture)).toContain(hostSessionId)
    } finally {
      await control.stop()
    }

    const { value: restarted, log } = await withServerLog(() =>
      createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    )
    const lines = log.events('runtime.terminal_active_run.reconciled')
    try {
      const db = (restarted as HrcServerInstance).db
      expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('terminated')
      expect(await projectedIds(fixture)).not.toContain(hostSessionId)
      expectSettled(db, runtimeId, runId, 'terminated')
      expect(lines).toHaveLength(1)
      const logged = lines[0]!.data
      expect(logged).toMatchObject({
        runtimeId,
        priorStatus: 'terminated',
        activeRunId: runId,
        runStatusBefore: 'running',
        runStatusAfter: 'failed',
      })
    } finally {
      await restarted.stop()
    }
  })
})
