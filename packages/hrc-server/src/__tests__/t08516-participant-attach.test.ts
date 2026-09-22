/**
 * T-08516 (8504A) — attachment: what makes a joined address runnable.
 *
 * Contract revision 7, R6.4, R7.2 and R7.3. Every case attaches the final
 * published participant descriptor, composed from identities HRC actually
 * returned rather than a database read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import {
  type ParticipantBrokerDescriptor,
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

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
  requestId: string
  operationId: string
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

  /** The host session id HRC returned for the current join. */
  let hostSessionId = ''

  async function join(hostIncarnationId = 'incarnation-alpha'): Promise<Identity> {
    const registered = await observe(
      await fixture.postJson('/v1/participants/register', {
        registrationMode: 'direct',
        requestedSessionRef: SCOPE,
        hostIncarnationId,
      })
    )
    expect(registered.body['status']).toBe('registered')
    hostSessionId = registered.body['hostSessionId'] as string
    const identity = registered.body['identity'] as Identity
    // R6.4's response must carry everything the descriptor is validated against;
    // without these a participant cannot compose a valid attachment at all.
    for (const field of ['requestId', 'operationId'] as const) {
      expect(identity[field]).toBeString()
      expect(identity[field].length).toBeGreaterThan(0)
    }
    return identity
  }

  /** A final participant descriptor composed only from the join response. */
  function composeDescriptor(identity: Identity, generation = 1): ParticipantBrokerDescriptor {
    const descriptor = {
      schemaVersion: 'participant-broker-descriptor/v1',
      descriptorId: `descriptor-${identity.attemptId}`,
      descriptorHash: '',
      compatibilityHash: `compatibility-${identity.attemptId}`,
      interactionMode: 'headless',
      expectedCapabilities: {},
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'noop-driver',
      brokerOwnership: 'participant-owned-process',
      harnessInvocation: {
        startRequest: {
          spec: {
            specVersion: 'harness-broker.invocation/v1',
            invocationId: identity.invocationId,
            labels: { participant: 't08516-attach' },
            harness: { frontend: 'test', provider: 'test', driver: 'noop-driver' },
            process: {
              command: 'noop-driver',
              args: [],
              cwd: fixture.tmpDir,
              lockedEnv: {},
              harnessTransport: { kind: 'pipes' },
            },
            interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
            driver: { kind: 'noop-driver' },
            correlation: {
              runtimeId: identity.runtimeId,
              hostSessionId,
              generation: String(generation),
              invocationId: identity.invocationId,
              startRequestHash: '',
              selectedProfileHash: '',
            },
          },
        },
        specHash: '',
        startRequestHash: '',
      },
      policy: {
        permissionPolicy: { mode: 'deny', audit: true },
        inputPolicy: {
          readyInput: 'start-turn',
          busy: { whenBusy: 'queue', maxDepth: 1 },
          supportedKinds: ['user'],
          attachmentPolicy: { localImages: false, fileRefs: false },
        },
        exposurePolicy: { mode: 'none' },
      },
      observability: {
        correlation: {
          requestId: identity.requestId,
          operationId: identity.operationId,
          hostSessionId,
          generation,
          runtimeId: identity.runtimeId,
          invocationId: identity.invocationId,
        },
      },
    } as unknown as ParticipantBrokerDescriptor
    const startRequest = descriptor.harnessInvocation.startRequest
    descriptor.harnessInvocation.specHash = neutralSpecHash(startRequest.spec)
    descriptor.harnessInvocation.startRequestHash = neutralStartRequestHash(startRequest)
    startRequest.spec.correlation.startRequestHash = descriptor.harnessInvocation.startRequestHash
    descriptor.descriptorHash = neutralParticipantBrokerDescriptorHash(descriptor)
    startRequest.spec.correlation.selectedProfileHash = descriptor.descriptorHash
    return descriptor
  }

  function withStore<T>(read: (db: ReturnType<typeof openHrcDatabase>) => T): T {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      return read(db)
    } finally {
      db.close()
    }
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

  /**
   * A participant-served attachment always carries its broker endpoint, because
   * a real one does: the join in this suite supplies no socketPath, so this is
   * R6.4's "or later through POST /v1/participants/attach" path.
   */
  function attach(body: Record<string, unknown>): Promise<Response> {
    // A resume report is not a descriptor attachment and carries no endpoint; the
    // parser refuses the combination, which is the shape difference itself.
    const endpoint =
      body['resumeUnsupported'] === undefined ? { socketPath: `${fixture.tmpDir}/broker.sock` } : {}
    return fixture.postJson('/v1/participants/attach', { ...endpoint, ...body })
  }

  test('a valid descriptor attachment freezes exact bytes and arms the existing work', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)

    const attached = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        socketPath: `${fixture.tmpDir}/broker.sock`,
        descriptor,
      })
    )

    expect(attached.status).toBe(200)
    expect(attached.body).toMatchObject({ status: 'attached', prepared: true })

    // Stop first: the establishment worker is armed by this very transaction,
    // and reading mid-flight would be asserting against a moving row.
    await server?.stop()
    server = undefined
    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBe(JSON.stringify(descriptor))
    expect(stored['attach_socket_path']).toBe(`${fixture.tmpDir}/broker.sock`)
    expect(
      withStore((db) =>
        db.participantHostBindings.getBindingById(stored['host_binding_id'] as string)
      )?.state
    ).toBe('BOUND')
  })

  test('an identical retry converges and does not reset a spent retry budget', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)
    const request = {
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      descriptor,
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

  test('a different descriptor cannot overwrite a frozen attempt', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)
    await attach({
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      descriptor,
    })
    const frozen = readAttempt(identity.attemptId)['prepared_profile_json']

    const conflicting = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor: { ...descriptor, brokerOwnership: 'hrc-owned-process' },
      })
    )

    expect(conflicting.status).toBe(409)
    expect(conflicting.body['reason']).toBeOneOf([
      'participant_attach_conflict',
      'participant_descriptor_invalid',
    ])
    expect(readAttempt(identity.attemptId)['prepared_profile_json']).toBe(frozen as string)
  })

  test('a stale attempt or epoch is refused and changes nothing', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)

    for (const stale of [
      { attemptId: identity.attemptId, attachEpoch: identity.attachEpoch + 1 },
      { attemptId: 'participant-attempt-superseded', attachEpoch: identity.attachEpoch },
    ]) {
      const refused = await observe(
        await attach({ registrationId: identity.registrationId, ...stale, descriptor })
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
        descriptor: {},
      })
    )
    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_registration_unknown')
  })

  test('refuses a descriptor that carries a continuation HRC did not select', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity) as unknown as {
      harnessInvocation: { startRequest: { spec: Record<string, unknown> } }
    }
    // A first join carries nothing forward, so a start request that asks the
    // harness to resume is asking for something HRC never authorized.
    const smuggled = structuredClone(descriptor)
    smuggled.harnessInvocation.startRequest.spec['continuation'] = {
      continuationId: 'not-selected-by-hrc',
    }

    const refused = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor: smuggled as unknown as ParticipantBrokerDescriptor,
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

  test('a descriptor bound to the wrong identity is refused without freezing', async () => {
    const identity = await join()
    const wrong = composeDescriptor({ ...identity, runtimeId: 'rt-not-allocated-by-hrc' })

    const refused = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor: wrong,
      })
    )

    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_descriptor_invalid')
    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBeNull()
    expect(stored['establishment_attempt_count']).toBe(0)
  })

  test('a retired agent-runtime-profile/v1 object is refused before any attachment effect', async () => {
    const identity = await join()
    const retiredProfile = {
      schemaVersion: 'agent-runtime-profile/v1',
      profileId: 'retired-profile',
      profileHash: 'retired-hash',
    }

    const refused = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor: retiredProfile,
      })
    )

    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_descriptor_invalid')
    const stored = readAttempt(identity.attemptId)
    expect(stored['prepared_profile_json']).toBeNull()
    expect(stored['state']).toBe('IDENTITY_MINTED')
    expect(stored['attach_socket_path']).toBeNull()
  })

  test('a descriptor hash disagreement is refused before persistence', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)

    const refused = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor: { ...descriptor, descriptorHash: 'descriptor-hash-disagreement' },
      })
    )

    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_descriptor_invalid')
    expect(readAttempt(identity.attemptId)['prepared_profile_json']).toBeNull()
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

  test('attachment persists the endpoint and the hosting intent it needs', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)

    // A live Arris attach exhausted its whole retry budget on "participant
    // attempt is missing hosting intent" because attachment armed the work
    // without taking the chain step that work requires. Both halves are
    // asserted here: the endpoint this attachment supplied became the
    // registration's durable serving socket, and the intent exists.
    const attached = await observe(
      await attach({
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor,
      })
    )
    expect(attached.body).toMatchObject({ status: 'attached', prepared: true })

    const stored = readAttempt(identity.attemptId)
    expect(stored['hosting_intent_json']).toBeString()
    expect(
      withStore(
        (db) => db.participantRegistrations.getRegistrationById(identity.registrationId)?.socketPath
      )
    ).toBe(`${fixture.tmpDir}/broker.sock`)
  })

  test('a classless join never fabricates a class into its lifecycle policy', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)
    await attach({
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      descriptor,
    })

    // The route id is interpolated from the class, and a classless direct join
    // has none. A live run froze `policy-route-participant:undefined` into the
    // lifecycle policy id, which is a fabricated identifier travelling into an
    // immutable tuple.
    const intent = JSON.parse(readAttempt(identity.attemptId)['hosting_intent_json'] as string) as {
      lifecyclePolicy: { policyId: string }
    }
    expect(intent.lifecyclePolicy.policyId).not.toContain('undefined')
    expect(intent.lifecyclePolicy.policyId).toContain('participant:direct')
  })

  test('a participant-served attachment without any endpoint is refused', async () => {
    const identity = await join()
    const descriptor = composeDescriptor(identity)

    // Neither the join nor this attachment names an endpoint, and a
    // participant-served registration cannot be hosted without one. It is a
    // typed delivery-configuration refusal, not a crash deeper in the chain.
    const refused = await observe(
      await fixture.postJson('/v1/participants/attach', {
        registrationId: identity.registrationId,
        attemptId: identity.attemptId,
        attachEpoch: identity.attachEpoch,
        descriptor,
      })
    )
    expect(refused.status).toBe(409)
    expect(refused.body['reason']).toBe('participant_serving_endpoint_missing')
    expect(readAttempt(identity.attemptId)['prepared_profile_json']).toBeNull()
  })

  test('an unattached participant is not runnable establishment work', async () => {
    const identity = await join()

    // R7.2: it is armed as pending -- it is durable work -- but enumeration
    // must not hand it to the worker, because there is nothing to establish and
    // every hand-off would spend a retry on waiting.
    expect(readAttempt(identity.attemptId)['establishment_work_state']).toBe('pending')
    expect(withStore((db) => db.participantRegistrations.listEstablishmentWork())).toEqual([])

    const descriptor = composeDescriptor(identity)
    await attach({
      registrationId: identity.registrationId,
      attemptId: identity.attemptId,
      attachEpoch: identity.attachEpoch,
      descriptor,
    })
    await server?.stop()
    server = undefined

    const runnable = withStore((db) => db.participantRegistrations.listEstablishmentWork())
    expect(runnable.map((attempt) => attempt.attemptId)).toContain(identity.attemptId)
  })
})
