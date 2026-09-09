/**
 * T-08349 acceptance RED — the HRC-owned edge of generic participant registration.
 *
 * These cases deliberately drive a real HRC server over its Unix callback socket.
 * They do not model activation or hand-write the unpublished T-08346 broker wire
 * contract. Once that producer lands, a second acceptance lane must drive both
 * join directions through real broker.installIdentity / ensureInvocation IPC and
 * assert the attempt, activation, replay, and hosting invariants named in T-08349.
 *
 * Baseline observed against the real installed max3 daemon on 2026-09-09:
 * POST /v1/participants/register => plain-text 404, while the legacy Desktop and
 * EPR routes retain their own distinct request and error shapes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer, HrcServerOptions, RegistrationClassConfig } from '../index.js'
import { ParticipantAdapterRegistry } from '../participant-adapter-registry.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

type GenericParticipantClass = {
  classId: string
  adapterId: string
  join: 'hrc-hosted' | 'participant-served'
  address: 'permanent-keyed'
  continuity: 'key-scoped'
  replaySemantics: 'none' | 'full-source-replay'
  scopeTemplate: { agent: string; project: string }
  maxInstances: number
  defaultTtl: number
}

type ResponseObservation = {
  status: number
  contentType: string
  body: unknown
}

const hostedClass: GenericParticipantClass = {
  classId: 't08349-hosted',
  adapterId: 'controlled-participant',
  join: 'hrc-hosted',
  address: 'permanent-keyed',
  continuity: 'key-scoped',
  replaySemantics: 'none',
  scopeTemplate: { agent: 'smokey', project: 'hrc-runtime' },
  maxInstances: 2,
  defaultTtl: 60,
}

const participantServedClass: GenericParticipantClass = {
  ...hostedClass,
  classId: 't08349-participant-served',
  join: 'participant-served',
  replaySemantics: 'full-source-replay',
}

const eprClass: RegistrationClassConfig = {
  classId: 't08349-epr',
  scopeTemplate: { agent: 'smokey', project: 'hrc-runtime' },
  maxInstances: 2,
  defaultTtl: 60,
  turnsAllowed: false,
}

async function observe(response: Response): Promise<ResponseObservation> {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Preserve the literal response. A missing route is text/plain today, and
    // the assertion should expose that difference instead of failing in JSON.parse.
  }
  return { status: response.status, contentType, body }
}

describe('T-08349 generic participant registration callback surface', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08349-registration-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function start(options: Partial<HrcServerOptions> = {}): Promise<void> {
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, registrationClasses: [], ...options })
    )
  }

  test('exists independently of EPR and returns a typed unknown-class refusal', async () => {
    await start()

    const response = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: 't08349-not-configured',
        processToken: 'opaque-process-token',
        participantKey: 'permanent-key',
      })
    )

    expect(response).toMatchObject({
      status: 404,
      contentType: expect.stringContaining('application/json'),
      body: { error: { code: 'unknown_class' } },
    })
  })

  test('parses the generic body before class lookup and rejects unsupported fields', async () => {
    await start()

    const malformed = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: 't08349-not-configured',
        processToken: 'opaque-process-token',
        participantKey: 'permanent-key',
        provisioner: { name: 'belongs-only-to-epr' },
      })
    )

    expect(malformed).toMatchObject({
      status: 400,
      contentType: expect.stringContaining('application/json'),
      body: { error: { code: 'malformed_request', detail: { field: 'provisioner' } } },
    })
  })

  test('accepts declared generic policies and enforces the one join-specific shape difference', async () => {
    const started = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        // Rev6 C.1 extends the existing validated class declaration. Cast only
        // at this pre-producer red boundary; no local wire or adapter type is invented.
        registrationClasses: [
          hostedClass,
          participantServedClass,
        ] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          createControlledParticipantAdapter({
            adapterId: hostedClass.adapterId,
            workspaceCwd: fixture.tmpDir,
          }),
        ]),
      })
    ).then(
      (value) => ({ server: value, error: undefined }),
      (error: unknown) => ({ server: undefined, error })
    )

    expect(started.error).toBeUndefined()
    if (started.server === undefined) return
    server = started.server

    const hostedWithSocket = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'opaque-hosted-token',
        participantKey: 'hosted-permanent-key',
        socketPath: `${fixture.tmpDir}/must-be-forbidden.sock`,
      })
    )
    expect(hostedWithSocket).toMatchObject({
      status: 400,
      body: { error: { code: 'malformed_request', detail: { field: 'socketPath' } } },
    })

    const servedWithoutSocket = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'opaque-served-token',
        participantKey: 'served-permanent-key',
      })
    )
    expect(servedWithoutSocket).toMatchObject({
      status: 400,
      body: { error: { code: 'malformed_request', detail: { field: 'socketPath' } } },
    })

    // Use the canonical source-graph adapter, not a local duplicate, for both
    // legal join shapes. This reaches the first durable boundary only: profile
    // preparation is frozen before any HRC hosting or broker effect.
    const admittedHosted = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'opaque-hosted-token',
        participantKey: 'hosted-permanent-key',
        evidence: { kind: 'controlled-continuity/v1', token: 'first' },
      })
    )
    expect(admittedHosted).toMatchObject({
      status: 200,
      body: {
        status: 'registered',
        created: true,
        resumed: false,
        scopeRef: expect.stringMatching(/^agent:smokey:project:hrc-runtime:task:participant-/),
        hostSessionId: expect.stringMatching(/^hsid-/),
        generation: 1,
        observation: { state: 'prepared' },
      },
    })

    const admittedServed = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'opaque-served-token',
        participantKey: 'served-permanent-key',
        socketPath: `${fixture.tmpDir}/participant-served.sock`,
        evidence: { kind: 'controlled-continuity/v1', token: 'same' },
      })
    )
    expect(admittedServed).toMatchObject({
      status: 200,
      body: {
        status: 'registered',
        created: true,
        resumed: false,
        observation: { state: 'prepared' },
      },
    })

    const retriedHosted = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'opaque-hosted-token',
        participantKey: 'hosted-permanent-key',
        evidence: { kind: 'controlled-continuity/v1', token: 'first' },
      })
    )
    expect(retriedHosted).toMatchObject({
      status: 200,
      body: {
        status: 'registered',
        created: false,
        resumed: false,
        scopeRef: (admittedHosted.body as { scopeRef: string }).scopeRef,
        hostSessionId: (admittedHosted.body as { hostSessionId: string }).hostSessionId,
        generation: 1,
      },
    })

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        hostedClass.classId,
        'hosted-permanent-key'
      )
      expect(registration).not.toBeNull()
      const attempt = db.participantRegistrations.getAttemptByRegistrationId(
        registration?.registrationId ?? ''
      )
      expect(attempt).toMatchObject({
        state: 'HOSTING_INTENT_PERSISTED',
        requestId: expect.stringMatching(/^req-/),
        operationId: expect.stringMatching(/^op-/),
        invocationId: expect.stringMatching(/^inv-/),
        runtimeId: expect.stringMatching(/^rt-/),
        preparedProfileJson: expect.stringContaining(hostedClass.classId),
      })
      expect(
        db.participantRegistrations.getRegistrationByClassAndKey(
          participantServedClass.classId,
          'served-permanent-key'
        )
      ).toMatchObject({ socketPath: `${fixture.tmpDir}/participant-served.sock` })
      const hostedRegistration = db.participantRegistrations.getRegistrationByClassAndKey(
        hostedClass.classId,
        'hosted-permanent-key'
      )
      const servedRegistration = db.participantRegistrations.getRegistrationByClassAndKey(
        participantServedClass.classId,
        'served-permanent-key'
      )
      const hostedAttempt = db.participantRegistrations.getAttemptByRegistrationId(
        hostedRegistration?.registrationId ?? ''
      )
      const servedAttempt = db.participantRegistrations.getAttemptByRegistrationId(
        servedRegistration?.registrationId ?? ''
      )
      expect(hostedAttempt).toMatchObject({ state: 'HOSTING_INTENT_PERSISTED' })
      expect(servedAttempt).toMatchObject({ state: 'HOSTING_INTENT_PERSISTED' })
      const hostedIntent = JSON.parse(hostedAttempt?.hostingIntentJson ?? '{}')
      const servedIntent = JSON.parse(servedAttempt?.hostingIntentJson ?? '{}')
      expect(hostedIntent).toMatchObject({
        join: 'hrc-hosted',
        hrcHosted: {
          brokerDriver: 'codex-app-server',
          sessionName: expect.stringMatching(/^hrc-codex-app-server-rt-/),
        },
        lifecyclePolicy: expect.objectContaining({ policyId: expect.any(String) }),
      })
      expect(servedIntent).toMatchObject({
        join: 'participant-served',
        endpoint: { socketPath: `${fixture.tmpDir}/participant-served.sock` },
        lifecyclePolicy: expect.objectContaining({ policyId: expect.any(String) }),
      })
      expect(servedIntent.hrcHosted).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('keeps unavailable adapters pending without allocating or taking down EPR', async () => {
    await start({
      registrationClasses: [hostedClass, eprClass] as unknown as readonly RegistrationClassConfig[],
    })

    const unavailable = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'opaque-hosted-token',
        participantKey: 'unavailable-adapter-key',
      })
    )
    expect(unavailable).toMatchObject({
      status: 200,
      body: { status: 'pending', reason: 'participant_adapter_unavailable' },
    })

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      expect(
        db.participantRegistrations.getRegistrationByClassAndKey(
          hostedClass.classId,
          'unavailable-adapter-key'
        )
      ).toBeNull()
    } finally {
      db.close()
    }

    const epr = await observe(
      await fixture.postJson('/v1/registrations', {
        classId: eprClass.classId,
        socketPath: `${fixture.tmpDir}/epr-available.sock`,
        provisioner: { name: 't08349-adapter-pending', version: '1', pid: 83_349 },
      })
    )
    expect(epr).toMatchObject({
      status: 200,
      body: { registrationId: expect.stringMatching(/^registration-/) },
    })
  })

  test('preserves the legacy EPR grant endpoint and does not reinterpret a generic body', async () => {
    await start({ registrationClasses: [eprClass] })

    const issued = await observe(
      await fixture.postJson('/v1/registrations', {
        classId: eprClass.classId,
        socketPath: `${fixture.tmpDir}/epr.sock`,
        provisioner: { name: 't08349-regression', version: '1', pid: 83_349 },
      })
    )
    expect(issued).toMatchObject({
      status: 200,
      body: {
        registrationId: expect.stringMatching(/^registration-/),
        derivedScope: expect.stringMatching(/^agent:smokey:project:hrc-runtime:task:reg-/),
        credential: expect.stringMatching(/^epr_/),
      },
    })

    const genericBodyOnEpr = await observe(
      await fixture.postJson('/v1/registrations', {
        classId: eprClass.classId,
        processToken: 'must-not-be-reinterpreted',
        participantKey: 'must-not-be-reinterpreted',
      })
    )
    expect(genericBodyOnEpr).toMatchObject({
      status: 400,
      body: { error: { code: 'malformed' } },
    })
  })
})
