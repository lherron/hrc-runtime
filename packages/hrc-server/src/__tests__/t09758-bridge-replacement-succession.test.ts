import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  type DirectJoinRequest,
  type DirectJoinResult,
  registerDirectParticipant,
} from '../participant-host-registration.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-09758: a bridge successor keeps its predecessor's host binding, so every
 * same-incarnation replacement names the same predecessor triple. Only a retry
 * that arrives before its successor established may replay; after that, the
 * same triple is the next replacement.
 */
describe('T-09758 consecutive same-incarnation bridge replacements', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let probeCalls: string[]

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t09758-bridge-replacement-')
    probeCalls = []
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    // Every broker the probe reaches is already gone.
    ;(server as unknown as HrcServerInstanceForHandlers).brokerUnixClientFactory = async (
      options
    ) => {
      probeCalls.push(options.socketPath)
      throw Object.assign(new Error('Failed to connect to broker unix socket'), {
        causeError: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
      })
    }
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  const scope = 'agent:foundry:project:hrc-runtime:task:T-09758-bridge'
  const endpoint = () => `${fixture.tmpDir}/primary.brk.sock`

  function register(
    expectedPredecessor?: DirectJoinRequest['expectedPredecessor']
  ): Promise<DirectJoinResult> {
    return registerDirectParticipant(server as unknown as HrcServerInstanceForHandlers, {
      requestedSessionRef: scope,
      laneRef: 'main',
      hostIncarnationId: 'host-a',
      // The bridge serves the same endpoint path after every respawn.
      socketPath: endpoint(),
      ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
    })
  }

  /** What establishment leaves behind: identity installed into a broker, ACTIVE. */
  function establish(attemptId: string, brokerInstanceId: string): void {
    server!.db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', broker_identity_json = ?, attach_socket_path = ?,
                initial_activation_confirmed_at = ?, establishment_work_state = 'completed'
          WHERE attempt_id = ?`
      )
      .run(JSON.stringify({ brokerInstanceId }), endpoint(), '2026-09-28T03:00:00.000Z', attemptId)
    const bindingId = server!.db.participantRegistrations.getAttempt(attemptId)!.hostBindingId!
    server!.db.participantHostBindings.transitionBinding({
      bindingId,
      from: ['BINDING', 'DETACHED'],
      to: 'BOUND',
      now: '2026-09-28T03:00:00.000Z',
    })
  }

  function identityOf(result: DirectJoinResult) {
    if (result.outcome !== 'registered') throw new Error(`refused: ${JSON.stringify(result)}`)
    return result.identity
  }

  test('each of two bridge replacements mints and establishes a fresh attempt', async () => {
    const first = identityOf(await register())
    establish(first.attemptId, 'broker-1')
    const triple = {
      hostIncarnationId: 'host-a',
      runtimeId: first.runtimeId,
      generation: first.generation,
    }

    const second = await register(triple)
    expect(second).toMatchObject({ outcome: 'registered', created: true })
    const secondIdentity = identityOf(second)
    expect(secondIdentity.attemptId).not.toBe(first.attemptId)
    expect(secondIdentity).toMatchObject({ attachEpoch: 2, runtimeId: first.runtimeId })
    establish(secondIdentity.attemptId, 'broker-2')

    // Same host incarnation, same binding: the triple is byte-equal to the first.
    const third = await register(triple)
    expect(third).toMatchObject({ outcome: 'registered', created: true })
    const thirdIdentity = identityOf(third)
    expect(thirdIdentity.attemptId).not.toBe(secondIdentity.attemptId)
    expect(thirdIdentity).toMatchObject({
      attachEpoch: 3,
      runtimeId: first.runtimeId,
      generation: first.generation,
    })
    establish(thirdIdentity.attemptId, 'broker-3')

    const attempts = server!.db.participantRegistrations.listAttemptsByRegistrationId(
      thirdIdentity.registrationId
    )
    expect(attempts.map((attempt) => [attempt.attachEpoch, attempt.state])).toEqual([
      [1, 'ABANDONED'],
      [2, 'ABANDONED'],
      [3, 'ACTIVE'],
    ])
    expect(new Set(attempts.map((attempt) => attempt.hostBindingId)).size).toBe(1)
    expect(attempts[1]!.dispositionReason).toContain('transport_dead')
    // Each replacement probed exactly its own predecessor's endpoint once.
    expect(probeCalls).toEqual([endpoint(), endpoint()])
  })

  test('a retry before the successor establishes replays the same successor', async () => {
    const first = identityOf(await register())
    establish(first.attemptId, 'broker-1')
    const triple = {
      hostIncarnationId: 'host-a',
      runtimeId: first.runtimeId,
      generation: first.generation,
    }

    const successor = identityOf(await register(triple))
    const retried = await register(triple)
    expect(retried).toMatchObject({ outcome: 'registered', created: false })
    expect(identityOf(retried)).toEqual(successor)
    // The replay neither probed again nor minted anything.
    expect(probeCalls).toEqual([endpoint()])
    expect(
      server!.db.participantRegistrations.listAttemptsByRegistrationId(successor.registrationId)
    ).toHaveLength(2)

    // Once that successor establishes, the same triple is the next replacement.
    establish(successor.attemptId, 'broker-2')
    const next = await register(triple)
    expect(next).toMatchObject({ outcome: 'registered', created: true })
    expect(identityOf(next).attachEpoch).toBe(3)
  })
})
