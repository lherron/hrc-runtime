import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { DurableBrokerClientLike } from '../broker/controller.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  type DirectJoinRequest,
  registerDirectParticipant,
} from '../participant-host-registration.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

type ProbeMode = 'dead' | 'live' | 'indeterminate'

describe('T-08526 evidence-less participant transport succession', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let probeMode: ProbeMode
  let probeCalls: string[]
  let closedClients: number

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08526-transport-succession-')
    probeMode = 'dead'
    probeCalls = []
    closedClients = 0
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    installProbeFactory()
  })

  function installProbeFactory(): void {
    ;(server as unknown as HrcServerInstanceForHandlers).brokerUnixClientFactory = async (
      options
    ) => {
      probeCalls.push(options.socketPath)
      if (probeMode === 'dead') {
        const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
        throw Object.assign(new Error('Failed to connect to broker unix socket'), { cause })
      }
      return {
        hello: async () => {
          if (probeMode === 'indeterminate') return new Promise<never>(() => undefined)
          return {} as never
        },
        close: async () => {
          closedClients += 1
        },
      } as unknown as DurableBrokerClientLike
    }
  }

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  function request(
    scope: string,
    hostIncarnationId: string,
    socketPath: string,
    expectedPredecessor?: { hostIncarnationId: string; runtimeId: string; generation: number }
  ): DirectJoinRequest {
    return {
      requestedSessionRef: scope,
      laneRef: 'main',
      hostIncarnationId,
      socketPath,
      ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
    }
  }

  async function activePredecessor(scope: string, hostIncarnationId = 'host-a') {
    const endpoint = `${fixture.tmpDir}/${scope.slice(-8)}-${hostIncarnationId}.sock`
    const first = await registerDirectParticipant(
      server as unknown as HrcServerInstanceForHandlers,
      request(scope, hostIncarnationId, endpoint)
    )
    if (first.outcome !== 'registered') throw new Error('predecessor registration refused')
    const attempt = server!.db.participantRegistrations.getAttempt(first.identity.attemptId)!
    server!.db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', broker_identity_json = ?, attach_socket_path = ?,
                initial_activation_confirmed_at = ?, establishment_work_state = 'completed'
          WHERE attempt_id = ?`
      )
      .run(
        JSON.stringify({ brokerInstanceId: `${hostIncarnationId}-broker` }),
        endpoint,
        '2026-09-16T06:00:00.000Z',
        attempt.attemptId
      )
    expect(
      server!.db.participantHostBindings.transitionBinding({
        bindingId: attempt.hostBindingId!,
        from: ['BINDING'],
        to: 'BOUND',
        now: '2026-09-16T06:00:00.000Z',
      })
    ).toBe(true)
    return {
      endpoint,
      first,
      attemptId: attempt.attemptId,
      bindingId: attempt.hostBindingId!,
      expected: {
        hostIncarnationId,
        runtimeId: first.identity.runtimeId,
        generation: first.identity.generation,
      },
    }
  }

  function storeReplacementIntent(
    prior: Awaited<ReturnType<typeof activePredecessor>>,
    candidateHostIncarnationId = 'host-b'
  ): string {
    const attempt = server!.db.participantRegistrations.getAttempt(prior.attemptId)!
    const binding = server!.db.participantHostBindings.getBindingById(prior.bindingId)!
    const intent = JSON.stringify({
      schemaVersion: 'participant-replacement-intent/v1',
      kind: 'host',
      operationId: 'participant-replacement-transport-crash-boundary',
      predecessor: {
        bindingId: binding.bindingId,
        hostIncarnationId: binding.hostIncarnationId,
        hostSessionId: binding.hostSessionId,
        generation: binding.generation,
        runtimeId: binding.runtimeId,
        attemptId: attempt.attemptId,
        attachEpoch: attempt.attachEpoch,
        invocationId: attempt.invocationId,
      },
      predecessorWork: {
        state: attempt.establishmentWorkState,
        attemptCount: attempt.establishmentAttemptCount,
      },
      candidate: {
        hostIncarnationId: candidateHostIncarnationId,
        socketPath: `${fixture.tmpDir}/${candidateHostIncarnationId}.sock`,
      },
      createdAt: '2026-09-16T06:01:00.000Z',
    })
    expect(
      server!.db.participantRegistrations.storeReplacementIntent({
        attemptId: attempt.attemptId,
        attachEpoch: attempt.attachEpoch,
        replacementIntentJson: intent,
        updatedAt: '2026-09-16T06:01:00.000Z',
      })
    ).toBe('stored')
    return intent
  }

  async function restartAndWaitForSuccessor(registrationId: string): Promise<void> {
    await server!.stop()
    server = undefined
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    installProbeFactory()
    const deadline = Date.now() + 2_000
    while (
      server.db.participantRegistrations.listAttemptsByRegistrationId(registrationId).length < 2 &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20)
    }
  }

  test('dead transport authorizes H2 with persisted transport_dead evidence', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-08526-h2'
    const prior = await activePredecessor(scope)
    const successor = await registerDirectParticipant(
      server as unknown as HrcServerInstanceForHandlers,
      request(scope, 'host-b', `${fixture.tmpDir}/host-b.sock`, prior.expected)
    )

    expect(successor).toMatchObject({
      outcome: 'registered',
      created: true,
      identity: { generation: 2 },
    })
    expect(probeCalls).toEqual([prior.endpoint])
    const retiredAttempt = server!.db.participantRegistrations.getAttempt(prior.attemptId)!
    const evidence = JSON.parse(retiredAttempt.writerEvidenceJson!) as WriterEvidence
    expect(retiredAttempt).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'abandoned',
      recoveryReason: 'transport_dead',
      dispositionReason: expect.stringContaining('transport_dead'),
      writerEvidenceJson: expect.stringContaining('transport_dead'),
    })
    expect(evidence.liveness).toMatchObject({
      state: 'dead',
      reason: 'transport_dead',
      detail: { basis: 'transport', probedEndpoint: prior.endpoint },
    })
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)).toMatchObject({
      state: 'RETIRED',
      dispositionReason: 'host_replaced',
    })
    expect(
      server!.db.participantHostBindings.getBindingByHostIncarnationId('host-b')
    ).toMatchObject({ state: 'BINDING', generation: 2 })
  })

  test('dead transport authorizes H1 without changing session runtime or generation', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-08526-h1'
    const prior = await activePredecessor(scope)
    const successor = await registerDirectParticipant(
      server as unknown as HrcServerInstanceForHandlers,
      request(scope, 'host-a', `${fixture.tmpDir}/host-a-restarted.sock`, prior.expected)
    )

    expect(successor).toMatchObject({
      outcome: 'registered',
      created: true,
      identity: {
        hostSessionId:
          prior.first.outcome === 'registered' ? prior.first.identity.hostSessionId : '',
        runtimeId: prior.expected.runtimeId,
        generation: 1,
        attachEpoch: 2,
      },
    })
    expect(probeCalls).toEqual([prior.endpoint])
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)).toMatchObject({
      state: 'BOUND',
      generation: 1,
      runtimeId: prior.expected.runtimeId,
    })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      state: 'ABANDONED',
      dispositionReason: expect.stringContaining('transport_dead'),
    })
  })

  test('completed hello is a live conflict and a bare claim never probes', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-08526-live'
    const prior = await activePredecessor(scope)
    probeMode = 'live'
    const live = await registerDirectParticipant(
      server as unknown as HrcServerInstanceForHandlers,
      request(scope, 'host-b', `${fixture.tmpDir}/host-b.sock`, prior.expected)
    )
    expect(live).toMatchObject({
      outcome: 'refused',
      status: 'rejected',
      reason: 'host_binding_conflict',
    })
    expect(probeCalls).toEqual([prior.endpoint])
    expect(closedClients).toBe(1)
    const liveAttempt = server!.db.participantRegistrations.getAttempt(prior.attemptId)!
    expect(liveAttempt).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
      writerEvidenceJson: expect.stringContaining('transport_live'),
    })
    expect(liveAttempt.replacementIntentJson).toBeUndefined()

    probeCalls = []
    const bare = await registerDirectParticipant(
      server as unknown as HrcServerInstanceForHandlers,
      request(scope, 'host-c', `${fixture.tmpDir}/host-c.sock`)
    )
    expect(bare).toMatchObject({
      outcome: 'refused',
      status: 'rejected',
      reason: 'host_binding_conflict',
    })
    expect(probeCalls).toEqual([])
  })

  test('hello timeout is an inert transport_indeterminate hold', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-08526-timeout'
    const prior = await activePredecessor(scope)
    probeMode = 'indeterminate'
    const held = await registerDirectParticipant(
      server as unknown as HrcServerInstanceForHandlers,
      request(scope, 'host-b', `${fixture.tmpDir}/host-b.sock`, prior.expected)
    )
    expect(held).toMatchObject({
      outcome: 'refused',
      status: 'pending',
      reason: 'host_retirement_unproven',
      detail: expect.stringContaining('transport_indeterminate'),
    })
    expect(probeCalls).toEqual([prior.endpoint])
    expect(closedClients).toBe(1)
    const heldAttempt = server!.db.participantRegistrations.getAttempt(prior.attemptId)!
    expect(heldAttempt).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
      writerEvidenceJson: expect.stringContaining('transport_indeterminate'),
    })
    expect(heldAttempt.replacementIntentJson).toBeUndefined()
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)?.state).toBe('BOUND')
  }, 10_000)

  test('restart after probe intent persistence redrives through transport-dead TX-D and TX6', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-08526-crash-a0'
    const prior = await activePredecessor(scope)
    storeReplacementIntent(prior)
    const registrationId =
      prior.first.outcome === 'registered' ? prior.first.identity.registrationId : ''

    await restartAndWaitForSuccessor(registrationId)

    const attempts =
      server!.db.participantRegistrations.listAttemptsByRegistrationId(registrationId)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'abandoned',
      dispositionReason: expect.stringContaining('transport_dead'),
    })
    expect(server!.db.participantRegistrations.getRegistrationById(registrationId)).toMatchObject({
      hostIncarnationId: 'host-b',
      generation: 2,
    })
  })

  test('restart after transport-dead TX-D commits resumes at successor allocation', async () => {
    const scope = 'agent:arris:project:hrc-runtime:task:T-08526-crash-txd'
    const prior = await activePredecessor(scope)
    storeReplacementIntent(prior)
    const attempt = server!.db.participantRegistrations.getAttempt(prior.attemptId)!
    const evidence: WriterEvidence = {
      schemaVersion: 'writer-evidence/v1',
      writerRef: {
        subject: 'host',
        classId: 'hrc-direct-registration',
        participantKey: attempt.registrationId,
        attemptId: attempt.attemptId,
        invocationId: attempt.invocationId as WriterEvidence['writerRef']['invocationId'],
        attachEpoch: attempt.attachEpoch,
        hostIncarnationId: 'host-a',
      },
      observedAt: '2026-09-16T06:02:00.000Z',
      writePath: { state: 'unknown', reason: 'transport_dead' },
      liveness: {
        state: 'dead',
        reason: 'transport_dead',
        detail: { basis: 'transport', probedEndpoint: prior.endpoint },
      },
      priorRecovery: { state: 'unknown', reason: 'transport probe does not observe recovery' },
    }
    server!.db.sqlite.transaction(() => {
      expect(
        server!.db.participantRegistrations.transitionAttempt(
          attempt.attemptId,
          ['ACTIVE'],
          'ABANDONED',
          '2026-09-16T06:02:00.000Z',
          'transport_dead:2026-09-16T06:02:00.000Z'
        )
      ).toBe(true)
      expect(
        server!.db.participantRegistrations.recordRecoveryDisposition(
          attempt.attemptId,
          'abandoned',
          'transport_dead',
          '2026-09-16T06:02:00.000Z'
        )
      ).toBe(true)
      expect(
        server!.db.participantHostBindings.transitionBinding({
          bindingId: prior.bindingId,
          from: ['BOUND'],
          to: 'RETIRING',
          now: '2026-09-16T06:02:00.000Z',
          retirementReceiptJson: JSON.stringify(evidence),
        })
      ).toBe(true)
    })()
    const registrationId =
      prior.first.outcome === 'registered' ? prior.first.identity.registrationId : ''

    await restartAndWaitForSuccessor(registrationId)

    const attempts =
      server!.db.participantRegistrations.listAttemptsByRegistrationId(registrationId)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'abandoned',
      dispositionReason: expect.stringContaining('transport_dead'),
    })
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)?.state).toBe(
      'RETIRED'
    )
  })
})
