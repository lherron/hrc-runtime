import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import type {
  BrokerExecutionProfile,
  ParticipantAdapter,
  WriterEvidence,
  WriterInspectionRequest,
  WriterRetirementRequest,
} from 'spaces-runtime-contracts'
import {
  neutralBrokerExecutionProfileHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

import { BrokerEventMapper } from '../broker/event-mapper.js'
import {
  createHrcServer,
  recordParticipantRecoveryDisposition,
  renewParticipantReplacementRecovery,
} from '../index.js'
import type { HrcServer, RegistrationClassConfig } from '../index.js'
import { ParticipantAdapterRegistry } from '../participant-adapter-registry.js'
import { registerDirectParticipant } from '../participant-host-registration.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:arris:project:hrc-runtime:task:T-08517'
const ADAPTER_ID = 't08517-controlled'
const CLASS_ID = 't08517-class'
const PARTICIPANT_KEY = 'participant-a'

const participantClass = {
  classId: CLASS_ID,
  adapterId: ADAPTER_ID,
  join: 'participant-served',
  address: 'permanent-keyed',
  continuity: 'key-scoped',
  replaySemantics: 'full-source-replay',
  scopeTemplate: { agent: 'arris', project: 'hrc-runtime' },
  maxInstances: 4,
  defaultTtl: 60,
}

type EvidenceMode =
  | 'retired-recovered'
  | 'retired-unknown'
  | 'retired-live'
  | 'retired-dead'
  | 'unknown-dead'
  | 'writable-dead'
  | 'writable-unknown'
  | 'unknown-live'
  | 'live'
  | 'wrong-subject'
  | 'unknown'

function evidenceAdapter(
  workspaceCwd: string,
  mode: () => EvidenceMode,
  beforeAnswer: () => void
): ParticipantAdapter {
  const base = createControlledParticipantAdapter({ adapterId: ADAPTER_ID, workspaceCwd })
  const answer = (request: WriterRetirementRequest | WriterInspectionRequest): WriterEvidence => {
    beforeAnswer()
    const current = mode()
    return {
      schemaVersion: 'writer-evidence/v1',
      writerRef:
        current === 'wrong-subject'
          ? {
              ...request.writerRef,
              subject: request.writerRef.subject === 'host' ? 'bridge' : 'host',
            }
          : request.writerRef,
      observedAt: '2026-09-16T04:00:00.000Z',
      writePath: {
        state: current.startsWith('retired-')
          ? 'retired'
          : current === 'live' || current.startsWith('writable-')
            ? 'writable'
            : 'unknown',
        reason: current,
      },
      liveness: {
        state:
          current === 'live' || current.endsWith('-live')
            ? 'live'
            : current.endsWith('-dead')
              ? 'dead'
              : 'unknown',
        reason: current,
      },
      priorRecovery: {
        state: current === 'retired-recovered' ? 'recovered' : 'unknown',
        reason: current,
      },
    }
  }
  return {
    adapterId: base.adapterId,
    admit: (request) => base.admit(request),
    prepare: (request) => base.prepare(request),
    retireWriter: answer,
    inspectWriter: answer,
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('T-08517 host participant succession', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let evidenceMode: EvidenceMode
  let evidenceAnswerHook: (() => void) | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08517-succession-')
    evidenceMode = 'retired-recovered'
    evidenceAnswerHook = undefined
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function start(): Promise<void> {
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        registrationClasses: [participantClass] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          evidenceAdapter(
            fixture.tmpDir,
            () => evidenceMode,
            () => evidenceAnswerHook?.()
          ),
        ]),
      })
    )
  }

  async function register(
    hostIncarnationId: string,
    expectedPredecessor?: { hostIncarnationId: string; runtimeId: string; generation: number },
    scope = SCOPE,
    socketPath = `${fixture.tmpDir}/${hostIncarnationId}.sock`
  ): Promise<Record<string, unknown>> {
    return json(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: scope,
        hostIncarnationId,
        classId: CLASS_ID,
        participantKey: PARTICIPANT_KEY,
        workspaceCwd: fixture.tmpDir,
        socketPath,
        ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
      })
    )
  }

  function replaceWithoutScheduling(
    hostIncarnationId: string,
    expectedPredecessor: { hostIncarnationId: string; runtimeId: string; generation: number }
  ) {
    return registerDirectParticipant(server!, {
      requestedSessionRef: SCOPE,
      hostIncarnationId,
      laneRef: 'main',
      classId: CLASS_ID,
      participantKey: PARTICIPANT_KEY,
      workspaceCwd: fixture.tmpDir,
      socketPath: `${fixture.tmpDir}/${hostIncarnationId}.sock`,
      expectedPredecessor,
    })
  }

  async function waitForAttemptCount(registrationId: string, count: number) {
    const deadline = Date.now() + 2_000
    let attempts = server!.db.participantRegistrations.listAttemptsByRegistrationId(registrationId)
    while (attempts.length < count && Date.now() < deadline) {
      await Bun.sleep(20)
      attempts = server!.db.participantRegistrations.listAttemptsByRegistrationId(registrationId)
    }
    return attempts
  }

  async function activePredecessor(scope = SCOPE): Promise<{
    first: Record<string, unknown>
    expected: { hostIncarnationId: string; runtimeId: string; generation: number }
    attemptId: string
    bindingId: string
  }> {
    const suffix = scope === SCOPE ? '' : scope.slice(-8)
    const hostIncarnationId = `host-a${suffix}`
    const first = await register(hostIncarnationId, undefined, scope)
    const identity = first['identity'] as Record<string, unknown>
    const attemptId = identity['attemptId'] as string
    const attempt = server!.db.participantRegistrations.getAttempt(attemptId)!
    server!.db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', broker_identity_json = ?,
                initial_activation_confirmed_at = ?, establishment_work_state = 'completed'
          WHERE attempt_id = ?`
      )
      .run(JSON.stringify({ brokerInstanceId: 'broker-a' }), '2026-09-16T04:01:00.000Z', attemptId)
    expect(attempt.hostBindingId).toBeString()
    expect(
      server!.db.participantHostBindings.transitionBinding({
        bindingId: attempt.hostBindingId!,
        from: ['BINDING'],
        to: 'BOUND',
        now: '2026-09-16T04:01:00.000Z',
      })
    ).toBe(true)
    return {
      first,
      expected: {
        hostIncarnationId,
        runtimeId: identity['runtimeId'] as string,
        generation: first['generation'] as number,
      },
      attemptId,
      bindingId: attempt.hostBindingId!,
    }
  }

  async function successorProfile(
    result: Record<string, unknown>,
    continuation?: Record<string, unknown>
  ): Promise<BrokerExecutionProfile> {
    const identity = result['identity'] as Record<string, unknown>
    const adapter = createControlledParticipantAdapter({
      adapterId: ADAPTER_ID,
      workspaceCwd: fixture.tmpDir,
      driver: 'noop-driver',
    })
    const prepared = await adapter.prepare({
      classId: CLASS_ID,
      join: 'participant-served',
      participantKey: PARTICIPANT_KEY,
      workspaceCwd: fixture.tmpDir,
      preparation: null,
      identity: {
        requestId: identity['requestId'] as string,
        operationId: identity['operationId'] as string,
        hostSessionId: result['hostSessionId'] as string,
        generation: result['generation'] as number,
        runtimeId: identity['runtimeId'] as string,
        invocationId: identity['invocationId'] as never,
      },
      scopeRef: SCOPE,
      laneRef: identity['laneRef'] as string,
      attachEpoch: identity['attachEpoch'] as number,
    })
    if (prepared.status !== 'prepared') throw new Error('controlled adapter refused profile')
    if (continuation === undefined) return prepared.profile

    const profile = structuredClone(prepared.profile)
    profile.harnessInvocation.startRequest.spec.continuation = continuation as never
    profile.harnessInvocation.specHash = neutralSpecHash(
      profile.harnessInvocation.startRequest.spec
    )
    profile.harnessInvocation.startRequestHash = neutralStartRequestHash(
      profile.harnessInvocation.startRequest
    )
    profile.profileHash = neutralBrokerExecutionProfileHash(profile)
    profile.harnessInvocation.startRequest.spec.correlation = {
      ...profile.harnessInvocation.startRequest.spec.correlation,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      selectedProfileHash: profile.profileHash,
    }
    return profile
  }

  test('H1 advances attempt/epoch/invocation while preserving binding runtime and session', async () => {
    await start()
    const prior = await activePredecessor()

    const replacementSocket = `${fixture.tmpDir}/host-a-replacement.sock`
    const result = await register('host-a', prior.expected, SCOPE, replacementSocket)
    const next = result['identity'] as Record<string, unknown>

    expect(result).toMatchObject({ status: 'registered', generation: 1, resumed: false })
    expect(result['hostSessionId']).toBe(prior.first['hostSessionId'])
    expect(next['runtimeId']).toBe(prior.expected.runtimeId)
    expect(next['attachEpoch']).toBe(2)
    expect(next['attemptId']).not.toBe(prior.attemptId)
    expect(next['invocationId']).not.toBe(
      (prior.first['identity'] as Record<string, unknown>)['invocationId']
    )
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'reconciled',
      dispositionReason: expect.stringContaining('bridge_write_path_retired'),
    })
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)).toMatchObject({
      state: 'BOUND',
      generation: 1,
      runtimeId: prior.expected.runtimeId,
    })
    expect(server!.db.participantRegistrations.getRegistrationByScopeRef(SCOPE)).toMatchObject({
      socketPath: replacementSocket,
    })
  })

  test('H2 atomically retires the old binding and advances session generation and runtime', async () => {
    await start()
    const prior = await activePredecessor()
    server!.db.sessions.updateContinuation(
      prior.first['hostSessionId'] as string,
      { provider: 'openai', key: 'thread-before-succession' },
      '2026-09-16T04:02:00.000Z'
    )

    const result = await register('host-b', prior.expected)
    const next = result['identity'] as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'registered',
      generation: 2,
      resumed: true,
      continuation: {
        carried: true,
        reason: 'carried',
        selected: { provider: 'openai', key: 'thread-before-succession' },
      },
    })
    expect(result['hostSessionId']).not.toBe(prior.first['hostSessionId'])
    expect(next['runtimeId']).not.toBe(prior.expected.runtimeId)
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)).toMatchObject({
      state: 'RETIRED',
      dispositionReason: 'host_replaced',
    })
    expect(
      server!.db.participantHostBindings.getBindingByHostIncarnationId('host-b')
    ).toMatchObject({
      state: 'BINDING',
      generation: 2,
      predecessorBindingId: prior.bindingId,
    })
    expect(server!.db.participantHostBindings.getReservationByAddress(SCOPE, 'main')).toMatchObject(
      { state: 'held' }
    )

    // Lost response retry converges on the allocated successor, not a third generation.
    const duplicate = await register('host-b', prior.expected)
    expect(duplicate['identity']).toEqual(result['identity'])
    expect(server!.db.sessions.listByScopeRef(SCOPE)).toHaveLength(2)

    const stale = await register('host-c', prior.expected)
    expect(stale).toMatchObject({
      status: 'rejected',
      reason: 'host_binding_precondition_failed',
      detail: expect.stringContaining('host-b'),
    })
    expect(server!.db.sessions.listByScopeRef(SCOPE)).toHaveLength(2)
  })

  test('H2 can abandon a never-activated host without inventing a bridge identity', async () => {
    await start()
    const first = await register('host-a')
    const identity = first['identity'] as Record<string, unknown>
    const result = await register('host-b', {
      hostIncarnationId: 'host-a',
      runtimeId: identity['runtimeId'] as string,
      generation: 1,
    })
    expect(result).toMatchObject({ status: 'registered', generation: 2 })
    expect(
      server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)
    ).toMatchObject({
      state: 'ABANDONED',
      dispositionReason: expect.stringContaining('establishment_abandoned_before_activation'),
    })
  })

  test('late H1 predecessor events stay historical and cannot mutate the successor', async () => {
    await start()
    const prior = await activePredecessor()
    const result = await register('host-a', prior.expected)
    const oldIdentity = prior.first['identity'] as Record<string, unknown>
    const nextIdentity = result['identity'] as Record<string, unknown>
    const runtimeId = nextIdentity['runtimeId'] as string
    const hostSessionId = result['hostSessionId'] as string
    const now = '2026-09-16T04:05:00.000Z'

    server!.db.sessions.updateContinuation(
      hostSessionId,
      { provider: 'openai', key: 'successor-continuation' },
      now
    )
    server!.db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'idle',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: nextIdentity['operationId'] as string,
      activeInvocationId: nextIdentity['invocationId'] as string,
      createdAt: now,
      updatedAt: now,
    })
    for (const identity of [oldIdentity, nextIdentity]) {
      server!.db.runtimeOperations.insert({
        operationId: identity['operationId'] as string,
        runtimeId,
        hostSessionId,
        generation: 1,
        operationKind: 'broker_invocation',
        controller: 'harness-broker',
        startupMethod: 'test',
        status: identity === oldIdentity ? 'completed' : 'started',
        routeDecisionJson: '{}',
        createdAt: now,
        updatedAt: now,
      })
      server!.db.brokerInvocations.insert({
        invocationId: identity['invocationId'] as never,
        operationId: identity['operationId'] as string,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        invocationState: 'ready',
        capabilitiesJson: '{}',
        specHash: `sha256:${identity['attemptId']}`,
        startRequestHash: `sha256:${identity['requestId']}`,
        selectedProfileHash: `sha256:${identity['operationId']}`,
        createdAt: now,
        updatedAt: now,
      })
    }

    const mapper = new BrokerEventMapper({ db: server!.db, now: () => now })
    mapper.apply({
      invocationId: oldIdentity['invocationId'] as never,
      seq: 1,
      time: now as never,
      type: 'continuation.updated',
      payload: { provider: 'openai', key: 'late-old-continuation' },
    })
    mapper.apply({
      invocationId: oldIdentity['invocationId'] as never,
      seq: 2,
      time: now as never,
      type: 'invocation.exited',
      payload: { reason: 'old-bridge-exited', exitCode: 0 },
    })

    expect(
      server!.db.brokerInvocationEvents.listByInvocationId(oldIdentity['invocationId'] as string)
    ).toHaveLength(2)
    expect(server!.db.sessions.getByHostSessionId(hostSessionId)?.continuation).toEqual({
      provider: 'openai',
      key: 'successor-continuation',
    })
    expect(server!.db.runtimes.getByRuntimeId(runtimeId)).toMatchObject({
      activeOperationId: nextIdentity['operationId'],
      activeInvocationId: nextIdentity['invocationId'],
      status: 'idle',
    })
    expect(
      server!.db.brokerInvocations.getByInvocationId(oldIdentity['invocationId'] as string)
    ).toMatchObject({ invocationState: 'exited', lifecycleTerminalReason: 'old-bridge-exited' })
    expect(
      server!.db.participantRegistrations.getAttempt(nextIdentity['attemptId'] as string)?.state
    ).toBe('IDENTITY_MINTED')
  })

  test('H2 continuation must match before freeze and unsupported native resume stays pending', async () => {
    await start()
    const prior = await activePredecessor()
    const continuation = { provider: 'openai', key: 'thread-h2' }
    server!.db.sessions.updateContinuation(
      prior.first['hostSessionId'] as string,
      continuation,
      '2026-09-16T04:02:00.000Z'
    )
    const successor = await register('host-b', prior.expected)
    const identity = successor['identity'] as Record<string, unknown>

    const mismatch = await json(
      await fixture.postJson('/v1/participants/attach', {
        registrationId: identity['registrationId'],
        attemptId: identity['attemptId'],
        attachEpoch: identity['attachEpoch'],
        socketPath: `${fixture.tmpDir}/host-b.sock`,
        profile: await successorProfile(successor),
      })
    )
    expect(mismatch).toMatchObject({
      status: 'rejected',
      reason: 'participant_continuation_mismatch',
    })
    expect(
      server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)
        ?.preparedProfileJson
    ).toBeUndefined()

    const unsupported = await json(
      await fixture.postJson('/v1/participants/attach', {
        registrationId: identity['registrationId'],
        attemptId: identity['attemptId'],
        attachEpoch: identity['attachEpoch'],
        resumeUnsupported: true,
        reason: 'Arris has no native cross-incarnation continuation restore',
      })
    )
    expect(unsupported).toMatchObject({
      status: 'pending',
      reason: 'participant_resume_unsupported',
    })
    expect(
      server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)
    ).toMatchObject({
      resumeState: 'unsupported',
      resumeReason: expect.stringContaining('Arris'),
      continuation: {
        carried: true,
        selectedJson: JSON.stringify(continuation),
      },
    })
  })

  test('H2 carried continuation freezes only when the profile expresses the exact selection', async () => {
    await start()
    const prior = await activePredecessor()
    const continuation = { provider: 'openai', key: 'thread-h2-exact' }
    server!.db.sessions.updateContinuation(
      prior.first['hostSessionId'] as string,
      continuation,
      '2026-09-16T04:02:00.000Z'
    )
    const successor = await register('host-b', prior.expected)
    const identity = successor['identity'] as Record<string, unknown>
    const attached = await json(
      await fixture.postJson('/v1/participants/attach', {
        registrationId: identity['registrationId'],
        attemptId: identity['attemptId'],
        attachEpoch: identity['attachEpoch'],
        socketPath: `${fixture.tmpDir}/host-b.sock`,
        profile: await successorProfile(successor, continuation),
      })
    )
    expect(attached).toMatchObject({ status: 'attached', prepared: true })
    expect(
      server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)
    ).toMatchObject({ resumeState: 'requested', preparedProfileJson: expect.any(String) })
  })

  test('live conflict refuses and unknown evidence holds without disposing the predecessor', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'live'
    const live = await register('host-b', prior.expected)
    expect(live).toMatchObject({ status: 'rejected', reason: 'host_binding_conflict' })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)?.state).toBe('ACTIVE')

    evidenceMode = 'unknown'
    const unknown = await register('host-b', prior.expected)
    expect(unknown).toMatchObject({ status: 'pending', reason: 'host_retirement_unproven' })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)?.state).toBe('ACTIVE')
  })

  test('bridge-subject evidence cannot authorize host succession', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'wrong-subject'
    const refused = await register('host-b', prior.expected)
    expect(refused).toMatchObject({
      status: 'rejected',
      reason: 'participant_host_evidence_invalid',
    })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)?.state).toBe('ACTIVE')
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)?.state).toBe('BOUND')
  })

  test('all nine retirement truth-table cells satisfy, hold, or refuse independently', async () => {
    await start()
    const cases: Array<{
      mode: EvidenceMode
      branch: 'satisfied' | 'hold' | 'refuse'
    }> = [
      { mode: 'retired-dead', branch: 'satisfied' },
      { mode: 'retired-live', branch: 'satisfied' },
      { mode: 'retired-unknown', branch: 'satisfied' },
      { mode: 'unknown-dead', branch: 'satisfied' },
      { mode: 'writable-dead', branch: 'satisfied' },
      { mode: 'unknown', branch: 'hold' },
      { mode: 'writable-unknown', branch: 'hold' },
      { mode: 'unknown-live', branch: 'hold' },
      { mode: 'live', branch: 'refuse' },
    ]

    for (const [index, item] of cases.entries()) {
      const scope = `${SCOPE}-truth-${index}`
      const prior = await activePredecessor(scope)
      evidenceMode = item.mode
      const candidate = `host-b-${index}`
      const observed = await register(candidate, prior.expected, scope)
      if (item.branch === 'satisfied') {
        expect(observed).toMatchObject({
          status: 'pending',
          reason: 'participant_prior_recovery_unresolved',
        })
        expect(
          recordParticipantRecoveryDisposition(
            server!,
            prior.attemptId,
            'abandoned',
            `operator:cody truth-table-${index}`
          )
        ).toBe(true)
        expect(await register(candidate, prior.expected, scope)).toMatchObject({
          status: 'registered',
          generation: 2,
        })
      } else if (item.branch === 'hold') {
        expect(observed).toMatchObject({
          status: 'pending',
          reason: 'host_retirement_unproven',
        })
        expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)?.state).toBe(
          'ACTIVE'
        )
        server!.db.participantRegistrations.markEstablishmentCompleted(
          prior.attemptId,
          1,
          '2026-09-16T04:06:00.000Z'
        )
      } else {
        expect(observed).toMatchObject({
          status: 'rejected',
          reason: 'host_binding_conflict',
        })
        expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)?.state).toBe(
          'ACTIVE'
        )
      }
    }
  })

  test('receipt freshness is per-axis and a voided uncommitted succession returns to pending', async () => {
    await start()
    const retainedScope = `${SCOPE}-fresh-retained`
    const retained = await activePredecessor(retainedScope)
    evidenceMode = 'retired-unknown'
    expect(await register('host-b-retained', retained.expected, retainedScope)).toMatchObject({
      reason: 'participant_prior_recovery_unresolved',
    })
    expect(
      recordParticipantRecoveryDisposition(
        server!,
        retained.attemptId,
        'abandoned',
        'operator:cody freshness retained'
      )
    ).toBe(true)
    evidenceMode = 'unknown-live'
    expect(await register('host-b-retained', retained.expected, retainedScope)).toMatchObject({
      status: 'registered',
      generation: 2,
    })

    const voidedScope = `${SCOPE}-fresh-voided`
    const voided = await activePredecessor(voidedScope)
    evidenceMode = 'retired-unknown'
    expect(await register('host-b-voided', voided.expected, voidedScope)).toMatchObject({
      reason: 'participant_prior_recovery_unresolved',
    })
    expect(
      recordParticipantRecoveryDisposition(
        server!,
        voided.attemptId,
        'abandoned',
        'operator:cody freshness voided'
      )
    ).toBe(true)
    evidenceMode = 'live'
    expect(await register('host-b-voided', voided.expected, voidedScope)).toMatchObject({
      status: 'pending',
      reason: 'host_retirement_unproven',
      detail: expect.stringContaining('voided'),
    })
    expect(
      server!.db.participantRegistrations.listAttemptsByRegistrationId(
        (voided.first['identity'] as Record<string, unknown>)['registrationId'] as string
      )
    ).toHaveLength(1)
  })

  test('recovery remains an independent hold until an explicit attributed abandonment', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'retired-unknown'

    const held = await register('host-b', prior.expected)
    expect(held).toMatchObject({
      status: 'pending',
      reason: 'participant_prior_recovery_unresolved',
    })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'unresolved',
    })
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)?.state).toBe(
      'RETIRING'
    )

    expect(
      recordParticipantRecoveryDisposition(
        server!,
        prior.attemptId,
        'abandoned',
        'operator:cody accepted unrecoverable historical tail for T-08517'
      )
    ).toBe(true)
    const admitted = await register('host-b', prior.expected)
    expect(admitted).toMatchObject({ status: 'registered', generation: 2 })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      recoveryDisposition: 'abandoned',
      recoveryReason: expect.stringContaining('operator:cody'),
    })
  })

  test('clear/reuse barrier prevents continuation carry, and classless Arris-shaped succession holds', async () => {
    await start()
    const prior = await activePredecessor()
    server!.db.sessions.updateContinuation(
      prior.first['hostSessionId'] as string,
      { provider: 'openai', key: 'must-not-cross-clear' },
      '2026-09-16T04:02:00.000Z'
    )
    server!.db.sessions.setContinuationReuseDisabled(
      prior.first['hostSessionId'] as string,
      true,
      '2026-09-16T04:03:00.000Z'
    )
    const cleared = await register('host-b', prior.expected)
    expect(cleared).toMatchObject({
      status: 'registered',
      resumed: false,
      continuation: { carried: false, reason: 'reuse_disabled', selected: null },
    })

    // A separate classless address has stable HRC identity but no producer
    // owner/key pair, so transport loss never becomes inferred death.
    const classlessScope = `${SCOPE}-classless`
    const first = await json(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: classlessScope,
        hostIncarnationId: 'arris-real-shape-a',
      })
    )
    const identity = first['identity'] as Record<string, unknown>
    const attempt = server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)!
    server!.db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', broker_identity_json = ?, initial_activation_confirmed_at = ?,
                establishment_work_state = 'completed' WHERE attempt_id = ?`
      )
      .run('{}', '2026-09-16T04:04:00.000Z', attempt.attemptId)
    server!.db.participantHostBindings.transitionBinding({
      bindingId: attempt.hostBindingId!,
      from: ['BINDING'],
      to: 'BOUND',
      now: '2026-09-16T04:04:00.000Z',
    })
    const held = await json(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: classlessScope,
        hostIncarnationId: 'arris-real-shape-b',
        expectedPredecessor: {
          hostIncarnationId: 'arris-real-shape-a',
          runtimeId: identity['runtimeId'],
          generation: 1,
        },
      })
    )
    expect(held).toMatchObject({
      status: 'pending',
      reason: 'host_retirement_unproven',
      detail: expect.stringContaining('producer evidence unavailable'),
    })
    expect(server!.db.participantRegistrations.getAttempt(attempt.attemptId)?.state).toBe('ACTIVE')
  })

  test('only explicit renewed recovery resets an exhausted replacement budget', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'unknown'
    await register('host-b', prior.expected)
    server!.db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET establishment_work_state = 'exhausted', establishment_attempt_count = 5
          WHERE attempt_id = ?`
      )
      .run(prior.attemptId)

    await register('host-b', prior.expected)
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      establishmentWorkState: 'exhausted',
      establishmentAttemptCount: 5,
    })
    expect(
      renewParticipantReplacementRecovery(
        server!,
        prior.attemptId,
        'operator:cody producer evidence source restored'
      )
    ).toBe(true)
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      establishmentWorkState: 'pending',
      establishmentAttemptCount: 0,
      replacementIntentJson: expect.stringContaining('producer evidence source restored'),
    })
  })

  test('restart after intent commit but before A0 redrives without another registration', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'unknown'
    expect(await replaceWithoutScheduling('host-b', prior.expected)).toMatchObject({
      outcome: 'refused',
      reason: 'host_retirement_unproven',
    })
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'pending',
      replacementIntentJson: expect.stringContaining('participant-replacement-intent/v1'),
    })
    await server!.stop()
    server = undefined

    evidenceMode = 'retired-recovered'
    await start()
    const registrationId = (prior.first['identity'] as Record<string, unknown>)[
      'registrationId'
    ] as string
    expect(await waitForAttemptCount(registrationId, 2)).toHaveLength(2)
    expect(
      server!.db.participantHostBindings.getBindingByHostIncarnationId('host-b')
    ).toMatchObject({
      state: 'BINDING',
      generation: 2,
    })
  })

  test('restart after producer retirement but before receipt persistence recovers by inspection', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'unknown'
    evidenceAnswerHook = () => {
      evidenceMode = 'retired-recovered'
      evidenceAnswerHook = undefined
      throw new Error('simulated daemon loss after producer retirement')
    }
    expect(await replaceWithoutScheduling('host-b', prior.expected)).toMatchObject({
      outcome: 'refused',
      reason: 'host_retirement_unproven',
    })
    const effectBoundary = server!.db.participantRegistrations.getAttempt(prior.attemptId)
    expect(effectBoundary).toMatchObject({
      state: 'ACTIVE',
      replacementIntentJson: expect.stringContaining('participant-replacement-intent/v1'),
    })
    expect(effectBoundary?.writerEvidenceJson).toBeUndefined()
    await server!.stop()
    server = undefined

    await start()
    const registrationId = (prior.first['identity'] as Record<string, unknown>)[
      'registrationId'
    ] as string
    expect(await waitForAttemptCount(registrationId, 2)).toHaveLength(2)
    expect(server!.db.participantRegistrations.getAttempt(prior.attemptId)).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'reconciled',
      writerEvidenceJson: expect.stringContaining('retired-recovered'),
    })
  })

  test('restart after successor commit converges a lost response on the same identity', async () => {
    await start()
    const prior = await activePredecessor()
    const committed = await replaceWithoutScheduling('host-b', prior.expected)
    expect(committed.outcome).toBe('registered')
    if (committed.outcome !== 'registered') throw new Error('successor was not committed')
    await server!.stop()
    server = undefined

    await start()
    const duplicate = await replaceWithoutScheduling('host-b', prior.expected)
    expect(duplicate).toMatchObject({ outcome: 'registered', created: false })
    if (duplicate.outcome !== 'registered') throw new Error('duplicate did not converge')
    expect(duplicate.identity).toEqual(committed.identity)
    expect(
      server!.db.participantRegistrations.listAttemptsByRegistrationId(
        committed.identity.registrationId
      )
    ).toHaveLength(2)
  })

  test('daemon restart redrives durable intent and the post-TX-D recovery hold', async () => {
    await start()
    const prior = await activePredecessor()
    evidenceMode = 'retired-unknown'
    const held = await register('host-b', prior.expected)
    expect(held).toMatchObject({ reason: 'participant_prior_recovery_unresolved' })
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)?.state).toBe(
      'RETIRING'
    )
    await server!.stop()
    server = undefined

    evidenceMode = 'retired-recovered'
    await start()
    const deadline = Date.now() + 2_000
    let attempts = server!.db.participantRegistrations.listAttemptsByRegistrationId(
      (prior.first['identity'] as Record<string, unknown>)['registrationId'] as string
    )
    while (attempts.length < 2 && Date.now() < deadline) {
      await Bun.sleep(20)
      attempts = server!.db.participantRegistrations.listAttemptsByRegistrationId(
        (prior.first['identity'] as Record<string, unknown>)['registrationId'] as string
      )
    }
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({
      state: 'ABANDONED',
      recoveryDisposition: 'reconciled',
    })
    expect(server!.db.participantHostBindings.getBindingById(prior.bindingId)?.state).toBe(
      'RETIRED'
    )
    expect(
      server!.db.participantHostBindings.getBindingByHostIncarnationId('host-b')
    ).toMatchObject({ state: 'BINDING', generation: 2 })
  })
})
