import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  type ParticipantAttempt,
  type ParticipantRegistration,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { HrcServerInstance, createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  PARTICIPANT_BROKER_GONE_REASON,
  settleParticipantBrokerLoss,
} from '../participant-broker-gone.js'
import { scheduleParticipantEstablishment } from '../participant-establishment.js'
import {
  type DirectJoinRequest,
  type DirectJoinResult,
  registerDirectParticipant,
} from '../participant-host-registration.js'
import { createParticipantHostingIntent } from '../participant-hosting-intent.js'
import { externalRegistrationServerDouble } from './external-registration-server.fixture.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'

/**
 * T-10741: a participant-served seat respawned in place (same host incarnation)
 * after HRC already settled its broker loss (T-10333) was allocated a bridge
 * successor that reused the terminated runtime row. Establishment then refused
 * that row as a bookkeeping conflict five times and exhausted, leaving the
 * scope with no runtime. A terminated runtime is never a successor candidate.
 */
describe('T-10741 participant respawn after a settled broker loss', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10741-respawn-')
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

  const scope = 'agent:foundry:project:hrc-runtime:task:T-10741-respawn'
  const endpoint = () => `${fixture.tmpDir}/primary.brk.sock`
  function handlers(): HrcServerInstance {
    if (!(server instanceof HrcServerInstance)) throw new Error('expected a real HRC server')
    return server
  }

  function register(
    expectedPredecessor?: DirectJoinRequest['expectedPredecessor']
  ): Promise<DirectJoinResult> {
    return registerDirectParticipant(handlers(), {
      requestedSessionRef: scope,
      laneRef: 'main',
      hostIncarnationId: 'host-a',
      socketPath: endpoint(),
      ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
    })
  }

  function identityOf(result: DirectJoinResult) {
    if (result.outcome !== 'registered') throw new Error(`refused: ${JSON.stringify(result)}`)
    return result.identity
  }

  /** What establishment leaves behind: ACTIVE attempt, BOUND binding, ready runtime row. */
  function establish(identity: ReturnType<typeof identityOf>): void {
    const db = server!.db
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
        '2026-10-12T08:00:00.000Z',
        identity.attemptId
      )
    const attempt = db.participantRegistrations.getAttempt(identity.attemptId)!
    db.participantHostBindings.transitionBinding({
      bindingId: attempt.hostBindingId!,
      from: ['BINDING', 'DETACHED'],
      to: 'BOUND',
      now: '2026-10-12T08:00:00.000Z',
    })
    const existing = db.runtimes.getByRuntimeId(identity.runtimeId)
    if (existing === null) {
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
        status: 'ready',
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
        createdAt: '2026-10-12T08:00:00.000Z',
        updatedAt: '2026-10-12T08:00:00.000Z',
      } as never)
    } else {
      db.runtimes.update(identity.runtimeId, {
        status: 'ready',
        activeOperationId: attempt.operationId,
        activeInvocationId: attempt.invocationId,
        updatedAt: '2026-10-12T08:00:00.000Z',
      })
    }
  }

  test('a same-incarnation respawn after a settled broker loss gets a fresh runtime', async () => {
    const first = identityOf(await register())
    establish(first)

    // The old child's broker closes; HRC proves the socket dead and terminates.
    expect(
      await settleParticipantBrokerLoss(handlers(), {
        runtimeId: first.runtimeId,
        invocationId: first.invocationId,
        code: 'broker_process_closed',
      })
    ).toBe('terminated')

    // seat.respawn: same host incarnation, names its predecessor exactly.
    const respawn = identityOf(
      await register({
        hostIncarnationId: 'host-a',
        runtimeId: first.runtimeId,
        generation: first.generation,
      })
    )
    expect(respawn.attachEpoch).toBe(2)
    expect(respawn.runtimeId).not.toBe(first.runtimeId)
    expect(respawn.generation).toBe(first.generation + 1)
    expect(respawn.hostSessionId).not.toBe(first.hostSessionId)

    // The terminated row keeps the reason HRC actually recorded.
    expect(server!.db.runtimes.getByRuntimeId(first.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: PARTICIPANT_BROKER_GONE_REASON,
    })

    // And a second respawn after that one is lost succeeds the same way.
    establish(respawn)
    expect(
      await settleParticipantBrokerLoss(handlers(), {
        runtimeId: respawn.runtimeId,
        invocationId: respawn.invocationId,
        code: 'broker_process_closed',
      })
    ).toBe('terminated')
    const again = identityOf(
      await register({
        hostIncarnationId: 'host-a',
        runtimeId: respawn.runtimeId,
        generation: respawn.generation,
      })
    )
    expect(again.runtimeId).not.toBe(respawn.runtimeId)
    expect(again.generation).toBe(respawn.generation + 1)
  })

  test('control: a same-incarnation reattach onto a live runtime still bridges it', async () => {
    const first = identityOf(await register())
    establish(first)
    const bridged = identityOf(
      await register({
        hostIncarnationId: 'host-a',
        runtimeId: first.runtimeId,
        generation: first.generation,
      })
    )
    expect(bridged).toMatchObject({
      attachEpoch: 2,
      runtimeId: first.runtimeId,
      generation: first.generation,
      hostSessionId: first.hostSessionId,
    })
  })
})

describe('T-10741 deterministic bookkeeping conflicts fail fast', () => {
  const NOW = '2026-10-12T08:00:00.000Z'

  function registration(): ParticipantRegistration {
    return {
      registrationId: 'registration-t10741',
      join: 'participant-served',
      scopeRef: 'agent:foundry:project:hrc-runtime:task:T-10741-fast',
      laneRef: 'main',
      hostSessionId: 'hsid-t10741',
      generation: 1,
      workspaceCwd: '/tmp/t10741-workspace',
      socketPath: '/tmp/t10741.sock',
      policy: {
        addressPolicy: 'selected-scope',
        continuityPolicy: 'host-incarnation',
        lifecycleOwner: 'externally-owned',
        replaySemantics: 'full-source-replay',
      },
      hostIncarnationId: 'host-incarnation:t10741',
      createdAt: NOW,
      updatedAt: NOW,
    }
  }

  function brokerFactory() {
    return async () =>
      ({
        installIdentity: async (identity: {
          runtimeId: string
          hostSessionId: string
          generation: number
          attachEpoch: number
          invocationId: string
        }) => ({
          installed: true as const,
          brokerInstanceId: 'broker-t10741',
          ...identity,
          installedAt: NOW,
        }),
        hello: async () => ({
          protocolVersion: 'harness-broker/0.2' as const,
          capabilities: {},
          drivers: [],
        }),
        ensureInvocation: async (request: {
          startAttemptId: string
          invocationId: string
          attachEpoch: number
        }) => ({
          receipt: {
            startAttemptId: request.startAttemptId,
            invocationId: request.invocationId,
            attachEpoch: request.attachEpoch,
            state: 'started' as const,
            requestDigest: 'ensure-t10741',
            brokerInstanceId: 'broker-t10741',
            updatedAt: NOW,
          },
        }),
        close: async () => undefined,
      }) as never
  }

  async function runAgainstExistingRuntime(runtimePatch: Record<string, unknown>) {
    const db = openHrcDatabase(':memory:')
    const factory = brokerFactory()
    const server = externalRegistrationServerDouble({
      options: { runtimeRoot: '/tmp/t10741-runtime-root' },
      db,
      generateBrokerAttachToken: () => 't10741-token',
      brokerUnixClientFactory: factory,
      harnessBrokerController: { activeClientInvocationId: () => undefined },
      participantEstablishmentOperations: new Map<string, Promise<void>>(),
      stopping: false,
    })
    const reg = registration()
    const attempt: ParticipantAttempt = {
      attemptId: 'attempt-t10741',
      registrationId: reg.registrationId,
      attachEpoch: 2,
      requestId: 'req-t10741',
      operationId: 'op-t10741-2',
      invocationId: 'inv-t10741-2',
      runtimeId: 'rt-t10741',
      state: 'HOSTING_INTENT_PERSISTED',
      recoveryDisposition: 'unresolved',
      establishmentWorkState: 'pending',
      establishmentAttemptCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const descriptor = makeParticipantBrokerDescriptor({
      requestId: attempt.requestId,
      operationId: attempt.operationId,
      hostSessionId: reg.hostSessionId,
      generation: reg.generation,
      runtimeId: attempt.runtimeId,
      invocationId: attempt.invocationId,
      cwd: '/tmp/t10741-workspace',
    })
    const intent = await createParticipantHostingIntent(server, reg, attempt, descriptor)
    db.sessions.insert({
      hostSessionId: reg.hostSessionId,
      scopeRef: reg.scopeRef,
      laneRef: reg.laneRef,
      generation: reg.generation,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.participantRegistrations.insertRegistration(reg)
    db.participantRegistrations.insertAttempt({
      ...attempt,
      preparedDescriptorJson: JSON.stringify(descriptor),
      adapterDispatchEnvJson: 'null',
      hostingIntentJson: JSON.stringify(intent),
    })
    db.runtimes.insert({
      runtimeId: attempt.runtimeId,
      hostSessionId: reg.hostSessionId,
      scopeRef: reg.scopeRef,
      laneRef: reg.laneRef,
      generation: reg.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      controllerKind: 'harness-broker',
      status: 'ready',
      activeOperationId: 'op-t10741-1',
      activeInvocationId: 'inv-t10741-1',
      runtimeStateJson: { lifecycleOwner: 'external' },
      createdAt: NOW,
      updatedAt: NOW,
      ...runtimePatch,
    } as never)
    scheduleParticipantEstablishment(server, reg, attempt)
    await server.participantEstablishmentOperations.get(attempt.attemptId)
    // Observe exactly one establishment pass; no re-armed retry outlives the db.
    ;(server as { stopping: boolean }).stopping = true
    const after = db.participantRegistrations.getAttempt(attempt.attemptId)!
    db.close()
    return after
  }

  test('a terminated runtime is refused once, by name, and exhausts immediately', async () => {
    const after = await runAgainstExistingRuntime({
      status: 'terminated',
      lifecycleTerminalReason: 'participant_broker_gone',
      activeInvocationId: undefined,
    })
    expect(after.establishmentWorkState).toBe('exhausted')
    expect(after.establishmentAttemptCount).toBe(1)
    expect(after.establishmentLastError).toContain('terminated')
    expect(after.establishmentLastError).toContain('participant_broker_gone')
  })

  test('control: a runtime owned by a different scope is still refused, naming the field', async () => {
    const after = await runAgainstExistingRuntime({
      scopeRef: 'agent:someone-else:project:hrc-runtime:task:other',
    })
    expect(after.establishmentWorkState).toBe('exhausted')
    expect(after.establishmentAttemptCount).toBe(1)
    expect(after.establishmentLastError).toContain('scopeRef')
  })
})
