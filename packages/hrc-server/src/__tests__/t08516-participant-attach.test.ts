/**
 * T-08516 (8504A) — attachment: what makes a joined address runnable.
 *
 * Contract revision 7, R6.4, R7.2 and R7.3. The profile every case attaches is
 * composed by the shipped `createControlledParticipantAdapter`, driven with the
 * identities HRC actually returned, rather than hand-written here: a profile
 * this suite wrote itself could agree with a mistake in HRC's own identity
 * binding and prove nothing about it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:arris:project:hrc-runtime:task:T-08516-attach'

type Observed = { status: number; body: Record<string, unknown> }
type Identity = {
  registrationId: string
  laneRef: string
  runtimeId: string
  attemptId: string
  invocationId: string
  attachEpoch: number
}

async function observe(response: Response): Promise<Observed> {
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Preserve the literal payload so a routing regression is visible.
  }
  return { status: response.status, body: body as Record<string, unknown> }
}

describe('T-08516 participant attachment', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08516-attach-')
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, registrationClasses: [] })
    )
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    await fixture.cleanup()
  })

  async function join(hostIncarnationId = 'incarnation-alpha'): Promise<Identity> {
    const registered = await observe(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: SCOPE,
        hostIncarnationId,
      })
    )
    expect(registered.body['status']).toBe('registered')
    return registered.body['identity'] as Identity
  }

  /** A profile the published adapter composed against HRC's own allocation. */
  async function composeProfile(
    identity: Identity,
    hostSessionId = 1
  ): Promise<BrokerExecutionProfile> {
    const adapter = createControlledParticipantAdapter({
      adapterId: 't08516-attach-adapter',
      workspaceCwd: fixture.tmpDir,
      driver: 'noop-driver',
    })
    const registration = readRegistration(identity.registrationId)
    const prepared = await adapter.prepare({
      classId: 't08516-attach-class',
      join: 'participant-served',
      // Structural filler for the published request type; the validator this
      // feeds reads `join` and `identity` only.
      participantKey: 'fixture',
      workspaceCwd: fixture.tmpDir,
      preparation: null,
      identity: {
        requestId: registration.request_id,
        operationId: registration.operation_id,
        hostSessionId: registration.host_session_id,
        generation: hostSessionId,
        runtimeId: identity.runtimeId,
        invocationId: identity.invocationId as never,
      },
      scopeRef: SCOPE,
      laneRef: identity.laneRef,
      attachEpoch: identity.attachEpoch,
    })
    if (prepared.status !== 'prepared') throw new Error('controlled adapter refused to prepare')
    return prepared.profile
  }

  function withStore<T>(read: (db: ReturnType<typeof openHrcDatabase>) => T): T {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      return read(db)
    } finally {
      db.close()
    }
  }

  /** The attempt joined to its registration, as one flat row for assertions. */
  function readRegistration(registrationId: string): Record<string, string> {
    return withStore(
      (db) =>
        db.sqlite
          .query<
            Record<string, string>,
            [string]
          >(`SELECT r.host_session_id, r.generation, a.request_id, a.operation_id
             FROM participant_registrations r
             JOIN participant_registration_attempts a ON a.registration_id = r.registration_id
             WHERE r.registration_id = ?`)
          .get(registrationId) as Record<string, string>
    )
  }

  function readAttempt(attemptId: string): Record<string, unknown> {
    return withStore(
      (db) =>
        db.sqlite
          .query<Record<string, unknown>, [string]>(
            'SELECT * FROM participant_registration_attempts WHERE attempt_id = ?'
          )
          .get(attemptId) as Record<string, unknown>
    )
  }

  function attach(body: Record<string, unknown>): Promise<Response> {
    return fixture.postJson('/v1/participants/attach', body)
  }

  test('a valid attachment freezes the profile and arms the existing work', async () => {
    const identity = await join()
    const profile = await composeProfile(identity)

    const attached = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        socketPath: `${fixture.tmpDir}/broker.sock`,
        profile,
      })
    )

    expect(attached.status).toBe(200)
    expect(attached.body).toMatchObject({ status: 'attached', prepared: true })

    // Stop first: the establishment worker is armed by this very transaction,
    // and reading mid-flight would be asserting against a moving row.
    await server?.stop()
    server = undefined
    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBe(JSON.stringify(profile))
    expect(stored['attach_socket_path']).toBe(`${fixture.tmpDir}/broker.sock`)
    expect(
      withStore((db) =>
        db.participantHostBindings.getBindingById(stored['host_binding_id'] as string)
      )?.state
    ).toBe('BOUND')
  })

  test('an identical retry converges and does not reset a spent retry budget', async () => {
    const identity = await join()
    const profile = await composeProfile(identity)
    const request = {
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      profile,
    }
    await attach(request)

    // Spend the budget the way the worker would, then retry the exact same
    // attachment. R7.2 allows only the FIRST successful preparation to reset
    // it; a retry that re-armed an exhausted attempt would let a participant
    // replay work forever by re-sending bytes HRC already has.
    withStore((db) =>
      db.sqlite
        .query(
          `UPDATE participant_registration_attempts
              SET establishment_work_state = 'exhausted', establishment_attempt_count = 5,
                  establishment_last_error = 'broker unreachable'
            WHERE attempt_id = ?`
        )
        .run(identity.attemptId)
    )

    const retried = await observe(await attach(request))
    expect(retried.status).toBe(200)
    expect(retried.body).toMatchObject({ status: 'attached', prepared: false })

    const stored = readAttempt(identity.attemptId)
    expect(stored['establishment_work_state']).toBe('exhausted')
    expect(stored['establishment_attempt_count']).toBe(5)
    expect(stored['establishment_last_error']).toBe('broker unreachable')
  })

  test('a different profile cannot overwrite a frozen attempt', async () => {
    const identity = await join()
    const profile = await composeProfile(identity)
    await attach({
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      profile,
    })
    const frozen = readAttempt(identity.attemptId)['prepared_profile_json']

    const conflicting = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        profile: { ...profile, brokerOwnership: 'hrc-owned-process' },
      })
    )

    expect(conflicting.status).toBe(409)
    expect(conflicting.body['reason']).toBeOneOf([
      'participant_attach_conflict',
      'participant_profile_invalid',
    ])
    expect(readAttempt(identity.attemptId)['prepared_profile_json']).toBe(frozen as string)
  })

  test('a stale attempt or epoch is refused and changes nothing', async () => {
    const identity = await join()
    const profile = await composeProfile(identity)

    for (const stale of [
      { attemptId: identity.attemptId, attachEpoch: identity.attachEpoch + 1 },
      { attemptId: 'participant-attempt-superseded', attachEpoch: identity.attachEpoch },
    ]) {
      const refused = await observe(
        await attach({ registrationId: identity.registrationId, ...stale, profile })
      )
      expect(refused.status).toBe(409)
      expect(refused.body['reason']).toBe('participant_attach_epoch_stale')
    }

    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBeNull()
    expect(stored['state']).toBe('IDENTITY_MINTED')
  })

  test('an unknown registration is a typed refusal, not a router 404', async () => {
    const refused = await observe(
      await attach({
        registrationId: 'participant-registration-absent',
        attemptId: 'participant-attempt-absent',
        attachEpoch: 1,
        profile: {},
      })
    )
    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_registration_unknown')
  })

  test('refuses a profile that carries a continuation HRC did not select', async () => {
    const identity = await join()
    const profile = (await composeProfile(identity)) as unknown as {
      harnessInvocation: { startRequest: { spec: Record<string, unknown> } }
    }
    // A first join carries nothing forward, so a start request that asks the
    // harness to resume is asking for something HRC never authorized.
    const smuggled = structuredClone(profile)
    smuggled.harnessInvocation.startRequest.spec['continuation'] = {
      continuationId: 'not-selected-by-hrc',
    }

    const refused = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        profile: smuggled as unknown as BrokerExecutionProfile,
      })
    )

    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_continuation_mismatch')
    // The refusal leaves the registration and its selection intact.
    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBeNull()
    expect(stored['continuation_carried']).toBe(0)
    expect(stored['continuation_reason']).toBe('no_continuation')
  })

  test('a profile bound to the wrong identity is refused without freezing', async () => {
    const identity = await join()
    const wrong = await composeProfile({ ...identity, runtimeId: 'rt-not-allocated-by-hrc' })

    const refused = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        profile: wrong,
      })
    )

    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_profile_invalid')
    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBeNull()
    expect(stored['establishment_attempt_count']).toBe(0)
  })

  test('an unsupported native resume is an outcome, not a retraction', async () => {
    const identity = await join()

    const reported = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        resumeUnsupported: true,
        reason: 'the driver has no cross-incarnation thread restoration',
      })
    )

    expect(reported.status).toBe(200)
    expect(reported.body).toMatchObject({
      status: 'pending',
      reason: 'participant_resume_unsupported',
    })
    const stored = readAttempt(identity.attemptId)
    expect(stored['continuation_resume_state']).toBe('unsupported')
    expect(stored['continuation_resume_reason']).toBe(
      'the driver has no cross-incarnation thread restoration'
    )
    // The registration is untouched and its addressed work stays pending.
    expect(stored['state']).toBe('IDENTITY_MINTED')
    expect(stored['establishment_work_state']).toBe('pending')
  })

  test('an unattached participant is not runnable establishment work', async () => {
    const identity = await join()

    // R7.2: it is armed as pending -- it is durable work -- but enumeration
    // must not hand it to the worker, because there is nothing to establish and
    // every hand-off would spend a retry on waiting.
    expect(readAttempt(identity.attemptId)['establishment_work_state']).toBe('pending')
    expect(withStore((db) => db.participantRegistrations.listEstablishmentWork())).toEqual([])

    const profile = await composeProfile(identity)
    await attach({
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      profile,
    })
    await server?.stop()
    server = undefined

    const runnable = withStore((db) => db.participantRegistrations.listEstablishmentWork())
    expect(runnable.map((attempt) => attempt.attemptId)).toContain(identity.attemptId)
  })
})
