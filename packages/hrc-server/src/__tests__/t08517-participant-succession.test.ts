import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { registerDirectParticipant } from '../participant-host-registration.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'

const SCOPE = 'agent:arris:project:hrc-runtime:task:T-08517'
const CLASS_ID = 't08517-class'
const PARTICIPANT_KEY = 'participant-a'

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('T-08517 host participant succession', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08517-succession-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function start(): Promise<void> {
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    // The predecessor's broker endpoint is gone, so HRC's own transport probe
    // is what proves the exact prior writer dead.
    ;(server as unknown as HrcServerInstanceForHandlers).brokerUnixClientFactory = async () => {
      const causeError = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
      throw Object.assign(new Error('Failed to connect to broker unix socket'), { causeError })
    }
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
            SET state = 'ACTIVE', broker_identity_json = ?, attach_socket_path = ?,
                initial_activation_confirmed_at = ?, establishment_work_state = 'completed'
          WHERE attempt_id = ?`
      )
      .run(
        JSON.stringify({ brokerInstanceId: 'broker-a' }),
        `${fixture.tmpDir}/${hostIncarnationId}.sock`,
        '2026-09-16T04:01:00.000Z',
        attemptId
      )
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

  function successorDescriptor(
    result: Record<string, unknown>,
    continuation?: Record<string, unknown>
  ) {
    const identity = result['identity'] as Record<string, unknown>
    const descriptor = makeParticipantBrokerDescriptor({
      requestId: identity['requestId'] as string,
      operationId: identity['operationId'] as string,
      hostSessionId: result['hostSessionId'] as string,
      generation: result['generation'] as number,
      runtimeId: identity['runtimeId'] as string,
      invocationId: identity['invocationId'] as string,
      cwd: fixture.tmpDir,
    })
    if (continuation === undefined) return descriptor

    const carried = structuredClone(descriptor)
    carried.harnessInvocation.startRequest.spec.continuation = continuation as never
    carried.harnessInvocation.specHash = neutralSpecHash(
      carried.harnessInvocation.startRequest.spec
    )
    carried.harnessInvocation.startRequestHash = neutralStartRequestHash(
      carried.harnessInvocation.startRequest
    )
    carried.descriptorHash = neutralParticipantBrokerDescriptorHash(carried)
    carried.harnessInvocation.startRequest.spec.correlation = {
      ...carried.harnessInvocation.startRequest.spec.correlation,
      startRequestHash: carried.harnessInvocation.startRequestHash,
      selectedProfileHash: carried.descriptorHash,
    }
    return carried
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
      recoveryDisposition: 'abandoned',
      dispositionReason: expect.stringContaining('transport_dead'),
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
      dispositionReason: 'transport_dead',
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
      dispositionReason: expect.stringContaining('pre_attach_superseded'),
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
        descriptor: successorDescriptor(successor),
      })
    )
    expect(mismatch).toMatchObject({
      status: 'rejected',
      reason: 'participant_continuation_mismatch',
    })
    expect(
      server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)
        ?.preparedDescriptorJson
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
        descriptor: successorDescriptor(successor, continuation),
      })
    )
    expect(attached).toMatchObject({ status: 'attached', prepared: true })
    expect(
      server!.db.participantRegistrations.getAttempt(identity['attemptId'] as string)
    ).toMatchObject({ resumeState: 'requested', preparedDescriptorJson: expect.any(String) })
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
    // owner/key pair. With no attached endpoint its HRC transport probe is
    // indeterminate, so the existing inert hold remains unchanged.
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
      detail: expect.stringContaining('transport_indeterminate'),
    })
    const heldAttempt = server!.db.participantRegistrations.getAttempt(attempt.attemptId)!
    expect(heldAttempt).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
    })
    expect(heldAttempt.replacementIntentJson).toBeUndefined()
    expect(
      await json(
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
    ).toMatchObject({
      status: 'pending',
      reason: 'host_retirement_unproven',
      detail: 'transport_indeterminate: predecessor has no durable attach socket path',
    })
    const repeatedAttempt = server!.db.participantRegistrations.getAttempt(attempt.attemptId)!
    expect(repeatedAttempt).toMatchObject({
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
    })
    expect(repeatedAttempt.replacementIntentJson).toBeUndefined()

    const mintedScope = `${SCOPE}-classless-minted`
    const minted = await json(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: mintedScope,
        hostIncarnationId: 'arris-minted-a',
      })
    )
    const mintedIdentity = minted['identity'] as Record<string, unknown>
    const mintedSuccessor = await json(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: mintedScope,
        hostIncarnationId: 'arris-minted-b',
        expectedPredecessor: {
          hostIncarnationId: 'arris-minted-a',
          runtimeId: mintedIdentity['runtimeId'],
          generation: 1,
        },
      })
    )
    expect(mintedSuccessor).toMatchObject({
      status: 'registered',
      created: true,
      generation: 2,
    })
    const mintedAttempt = server!.db.participantRegistrations.getAttempt(
      mintedIdentity['attemptId'] as string
    )!
    expect(mintedAttempt).toMatchObject({
      state: 'ABANDONED',
      dispositionReason: expect.stringContaining('pre_attach_superseded'),
      recoveryDisposition: 'abandoned',
      recoveryReason: 'pre_attach_superseded',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
    })
    expect(
      server!.db.participantHostBindings.getBindingById(mintedAttempt.hostBindingId!)
    ).toMatchObject({
      state: 'RETIRED',
      dispositionReason: 'pre_attach_superseded',
    })

    await server!.stop()
    server = undefined
    await start()
    expect(server!.db.participantRegistrations.getAttempt(attempt.attemptId)).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
    })
    expect(server!.db.participantRegistrations.getAttempt(mintedAttempt.attemptId)).toMatchObject({
      state: 'ABANDONED',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
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
})
