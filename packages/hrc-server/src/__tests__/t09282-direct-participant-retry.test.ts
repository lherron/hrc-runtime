import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('T-09282 direct participant retry and legacy continuation', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t09282-direct-retry-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  function register(
    hostIncarnationId: string,
    expectedPredecessor:
      | { hostIncarnationId: string; runtimeId: string; generation: number }
      | undefined,
    scope: string
  ): Promise<Record<string, unknown>> {
    return fixture
      .postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: scope,
        hostIncarnationId,
        ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
      })
      .then(json)
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
    if (continuation !== undefined) {
      descriptor.harnessInvocation.startRequest.spec.continuation = continuation as never
    }
    return descriptor
  }

  test('a rejected pre-freeze attach permits an exact same-host retry and a later host supersession', async () => {
    const scope = 'agent:arris:project:arris:task:primary'
    const first = await register('host-a', undefined, scope)
    const firstIdentity = first['identity'] as Record<string, unknown>
    const predecessor = {
      hostIncarnationId: 'host-a',
      runtimeId: firstIdentity['runtimeId'] as string,
      generation: 1,
    }
    const rejected = await json(
      await fixture.postJson('/v1/participants/attach', {
        registrationId: firstIdentity['registrationId'],
        attemptId: firstIdentity['attemptId'],
        attachEpoch: firstIdentity['attachEpoch'],
        descriptor: successorDescriptor(first, { provider: 'arris', key: 'wrong' }),
      })
    )
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'participant_continuation_mismatch',
    })
    expect(await register('host-a', predecessor, scope)).toMatchObject({
      status: 'registered',
      created: false,
      identity: { attemptId: firstIdentity['attemptId'], attachEpoch: 1 },
    })
    expect(
      await register('host-a', { ...predecessor, runtimeId: 'rt-wrong' }, scope)
    ).toMatchObject({ status: 'rejected', reason: 'host_binding_precondition_failed' })

    const second = await register('host-b', predecessor, scope)
    expect(second).toMatchObject({ status: 'registered', generation: 2 })
    const secondIdentity = second['identity'] as Record<string, unknown>
    const secondAttempt = server!.db.participantRegistrations.getAttempt(
      secondIdentity['attemptId'] as string
    )!
    expect(secondAttempt).toMatchObject({ state: 'IDENTITY_MINTED', attachEpoch: 2 })
    expect(
      server!.db.participantRegistrations.getAttempt(firstIdentity['attemptId'] as string)
    ).toMatchObject({
      state: 'ABANDONED',
      dispositionReason: expect.stringContaining('pre_attach_superseded'),
    })
    expect(server!.db.runtimes.getByRuntimeId(firstIdentity['runtimeId'] as string)).toBeNull()
    const attached = await json(
      await fixture.postJson('/v1/participants/attach', {
        registrationId: secondIdentity['registrationId'],
        attemptId: secondIdentity['attemptId'],
        attachEpoch: secondIdentity['attachEpoch'],
        socketPath: `${fixture.tmpDir}/host-b.sock`,
        descriptor: successorDescriptor(second),
      })
    )
    expect(attached).toMatchObject({ status: 'attached', prepared: true })
    expect(server!.db.participantRegistrations.getAttempt(secondAttempt.attemptId)).toMatchObject({
      preparedDescriptorJson: expect.any(String),
      attachSocketPath: `${fixture.tmpDir}/host-b.sock`,
    })
  })

  test('legacy Arris host-incarnation continuation selects fresh on succession', async () => {
    const scope = 'agent:arris:project:arris:task:primary'
    const first = await register('host-a', undefined, scope)
    const identity = first['identity'] as Record<string, unknown>
    server!.db.sessions.updateContinuation(
      first['hostSessionId'] as string,
      { provider: 'arris', kind: 'host-incarnation', key: 'host-incarnation:legacy' },
      '2026-09-26T15:00:00.000Z'
    )
    const successor = await register(
      'host-b',
      {
        hostIncarnationId: 'host-a',
        runtimeId: identity['runtimeId'] as string,
        generation: 1,
      },
      scope
    )
    expect(successor).toMatchObject({
      status: 'registered',
      resumed: false,
      continuation: { carried: false, selected: null },
    })
    expect(
      server!.db.sessions.getByHostSessionId(successor['hostSessionId'] as string)?.continuation
    ).toBeUndefined()
  })
})
