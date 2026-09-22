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
 * POST /v1/participants/register => plain-text 404, while the legacy EPR route
 * retains its own distinct request and error shape.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { ParticipantAdapter, WriterEvidence } from 'spaces-runtime-contracts'

import { createHrcServer } from '../index.js'
import type { HrcServer, HrcServerOptions, RegistrationClassConfig } from '../index.js'
import { ParticipantAdapterRegistry } from '../participant-adapter-registry.js'
import { isClaimScopeFree } from '../scope-claim-core.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'

type GenericParticipantClass = {
  classId: string
  adapterId: string
  join: 'participant-served'
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

const participantServedClass: GenericParticipantClass = {
  classId: 't08349-participant-served',
  adapterId: 'controlled-participant',
  join: 'participant-served',
  address: 'permanent-keyed',
  continuity: 'key-scoped',
  replaySemantics: 'full-source-replay',
  scopeTemplate: { agent: 'smokey', project: 'hrc-runtime' },
  maxInstances: 2,
  defaultTtl: 60,
}

const eprClass: RegistrationClassConfig = {
  classId: 't08349-epr',
  scopeTemplate: { agent: 'smokey', project: 'hrc-runtime' },
  maxInstances: 2,
  defaultTtl: 60,
  turnsAllowed: false,
}

function controlledParticipantAdapter(
  workspaceCwd: string,
  writerEvidence?: Omit<WriterEvidence, 'schemaVersion' | 'writerRef'>
): ParticipantAdapter {
  const writer = (request: { writerRef: WriterEvidence['writerRef'] }): WriterEvidence => ({
    schemaVersion: 'writer-evidence/v1',
    writerRef: request.writerRef,
    ...(writerEvidence ?? {
      observedAt: '2026-09-15T15:00:00.000Z',
      writePath: { state: 'unknown', reason: 'not configured' },
      liveness: { state: 'unknown', reason: 'not configured' },
      priorRecovery: { state: 'unknown', reason: 'not configured' },
    }),
  })
  return {
    adapterId: participantServedClass.adapterId,
    admit: () => ({ status: 'pending', reason: 'not used by direct registration' }),
    prepare: (request) => ({
      status: 'prepared',
      descriptor: makeParticipantBrokerDescriptor({
        requestId: request.identity.requestId,
        operationId: request.identity.operationId,
        hostSessionId: request.identity.hostSessionId,
        generation: request.identity.generation,
        runtimeId: request.identity.runtimeId,
        invocationId: request.identity.invocationId,
        cwd: workspaceCwd,
      }),
    }),
    retireWriter: writer,
    inspectWriter: writer,
  }
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
        workspaceCwd: fixture.tmpDir,
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
        workspaceCwd: fixture.tmpDir,
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
          participantServedClass,
        ] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          controlledParticipantAdapter(fixture.tmpDir),
        ]),
      })
    ).then(
      (value) => ({ server: value, error: undefined }),
      (error: unknown) => ({ server: undefined, error })
    )

    expect(started.error).toBeUndefined()
    if (started.server === undefined) return
    server = started.server

    const servedWithoutSocket = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'opaque-served-token',
        workspaceCwd: fixture.tmpDir,
        participantKey: 'served-permanent-key',
      })
    )
    expect(servedWithoutSocket).toMatchObject({
      status: 400,
      body: { error: { code: 'malformed_request', detail: { field: 'socketPath' } } },
    })

    // Use the canonical source-graph adapter, not a local duplicate, for the
    // participant-served join shape. This reaches the first durable boundary only.
    const admittedServed = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'opaque-served-token',
        workspaceCwd: fixture.tmpDir,
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

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      expect(
        db.participantRegistrations.getRegistrationByClassAndKey(
          participantServedClass.classId,
          'served-permanent-key'
        )
      ).toMatchObject({ socketPath: `${fixture.tmpDir}/participant-served.sock` })
      const servedRegistration = db.participantRegistrations.getRegistrationByClassAndKey(
        participantServedClass.classId,
        'served-permanent-key'
      )
      const servedAttempt = db.participantRegistrations.getAttemptByRegistrationId(
        servedRegistration?.registrationId ?? ''
      )
      expect(['HOSTING_INTENT_PERSISTED', 'REALIZED', 'DISPATCH_FROZEN']).toContain(
        servedAttempt?.state
      )
      const servedIntent = JSON.parse(servedAttempt?.hostingIntentJson ?? '{}')
      expect(servedIntent).toMatchObject({
        join: 'participant-served',
        presentation: { kind: 'none' },
        endpoint: { socketPath: `${fixture.tmpDir}/participant-served.sock` },
        lifecyclePolicy: expect.objectContaining({ policyId: expect.any(String) }),
      })
      expect(servedIntent.hrcHosted).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('joins without an adapter present, and never takes down EPR', async () => {
    await start({
      registrationClasses: [
        participantServedClass,
        eprClass,
      ] as unknown as readonly RegistrationClassConfig[],
    })

    const unavailable = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'opaque-served-token',
        workspaceCwd: fixture.tmpDir,
        participantKey: 'unavailable-adapter-key',
        socketPath: `${fixture.tmpDir}/unavailable-adapter.sock`,
      })
    )
    // R6.1 inverts this case. HRC "does not ... load an adapter to approve
    // identity, or require adapter availability before joining", so an absent
    // adapter no longer refuses the address -- it only means no post-join
    // preparation helper exists and the participant must attach for itself.
    expect(unavailable).toMatchObject({
      status: 200,
      body: { status: 'registered', observation: { state: 'attachment_pending' } },
    })

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        participantServedClass.classId,
        'unavailable-adapter-key'
      )
      expect(registration).not.toBeNull()
      // Registered, attachment pending: identity is durable and no profile was
      // fabricated to stand in for the adapter that was not there.
      const attempt = db.participantRegistrations.getAttemptByRegistrationId(
        registration?.registrationId ?? ''
      )
      expect(attempt).toMatchObject({
        state: 'IDENTITY_MINTED',
        establishmentWorkState: 'pending',
      })
      expect(attempt?.preparedDescriptorJson).toBeUndefined()
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

  test('ingests exact writer evidence and allocates one changed-known same-session successor', async () => {
    await start({
      registrationClasses: [
        participantServedClass,
      ] as unknown as readonly RegistrationClassConfig[],
      participantAdapterRegistry: new ParticipantAdapterRegistry([
        controlledParticipantAdapter(fixture.tmpDir, {
          observedAt: '2026-09-15T15:00:00.000Z',
          writePath: { state: 'retired', reason: 'controlled bridge writer retired' },
          liveness: { state: 'dead', reason: 'controlled bridge process exited' },
          priorRecovery: { state: 'recovered', reason: 'controlled replay drained' },
        }),
      ]),
    })

    const first = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'first-process',
        workspaceCwd: fixture.tmpDir,
        participantKey: 'successor-key',
        socketPath: `${fixture.tmpDir}/first.sock`,
        evidence: { kind: 'controlled-continuity/v1', token: 'first' },
      })
    )
    expect(first.body).toMatchObject({ status: 'registered', created: true, resumed: false })

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    let priorAttemptId = ''
    let priorRuntimeId = ''
    let priorInvocationId = ''
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        participantServedClass.classId,
        'successor-key'
      )
      const prior = db.participantRegistrations.getAttemptByRegistrationId(
        registration?.registrationId ?? ''
      )
      const reservedSession = db.sessions.getByHostSessionId(registration?.hostSessionId ?? '')
      expect(reservedSession).not.toBeNull()
      expect(
        isClaimScopeFree(server as unknown as HrcServerInstanceForHandlers, reservedSession!)
      ).toBe(false)
      await expect(
        server!.startRuntimeForSession(reservedSession!, {} as never, 'fresh_pty')
      ).rejects.toThrow('participant scope cannot be cold-born')
      expect(prior).not.toBeNull()
      priorAttemptId = prior?.attemptId ?? ''
      priorRuntimeId = prior?.runtimeId ?? ''
      priorInvocationId = prior?.invocationId ?? ''
      expect(
        db.participantRegistrations.setSnapshotIfAbsent(
          priorAttemptId,
          'brokerIdentityJson',
          JSON.stringify({ brokerInstanceId: 'controlled-prior-broker' }),
          '2026-09-15T15:00:00.000Z'
        )
      ).toBe(true)
      // Only an activation accepts known evidence. Without this commit the
      // prior attempt holds an unaccepted candidate, and a changed successor
      // correctly attaches instead of resuming; the resume below is asserted
      // against a baseline that was genuinely activated.
      // R6.2 makes `evidence` ignored for continuation, so the successor is now
      // requested by the prior attempt reaching an absorbing disposition. The
      // writer-retirement and recovery gate it must pass is unchanged.
      expect(
        db.participantRegistrations.transitionAttempt(
          priorAttemptId,
          [prior?.state ?? 'REGISTERED'],
          'ABANDONED',
          '2026-09-15T15:00:00.000Z',
          'prior participant attempt abandoned by the fixture'
        )
      ).toBe(true)
    } finally {
      db.close()
    }

    const successor = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: participantServedClass.classId,
        processToken: 'successor-process',
        workspaceCwd: fixture.tmpDir,
        participantKey: 'successor-key',
        socketPath: `${fixture.tmpDir}/successor.sock`,
        evidence: { kind: 'controlled-continuity/v1', token: 'changed' },
      })
    )
    expect(successor.body).toMatchObject({
      status: 'registered',
      created: false,
      resumed: false,
      scopeRef: (first.body as { scopeRef: string }).scopeRef,
      hostSessionId: (first.body as { hostSessionId: string }).hostSessionId,
      generation: 1,
    })

    const readback = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const registration = readback.participantRegistrations.getRegistrationByClassAndKey(
        participantServedClass.classId,
        'successor-key'
      )
      const attempts = readback.participantRegistrations.listAttemptsByRegistrationId(
        registration?.registrationId ?? ''
      )
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toMatchObject({
        attemptId: priorAttemptId,
        runtimeId: priorRuntimeId,
        invocationId: priorInvocationId,
        state: 'ABANDONED',
        recoveryDisposition: 'reconciled',
        writerEvidenceJson: expect.stringContaining('controlled-prior-broker'),
      })
      expect(attempts[1]).toMatchObject({
        attachEpoch: 2,
        // With the adapter's continuity candidate withdrawn (R6.6) there is no
        // known baseline to compare against, so a successor is classified as
        // what it honestly is rather than as a resume nobody proved.
        activationClassification: 'attached_unknown',
        recoveryDisposition: 'unresolved',
        establishmentWorkState: expect.stringMatching(/pending|retry_wait/),
      })
      expect(attempts[1]?.attemptId).not.toBe(priorAttemptId)
      expect(attempts[1]?.runtimeId).not.toBe(priorRuntimeId)
      expect(attempts[1]?.invocationId).not.toBe(priorInvocationId)
    } finally {
      readback.close()
    }
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
        workspaceCwd: fixture.tmpDir,
        participantKey: 'must-not-be-reinterpreted',
      })
    )
    expect(genericBodyOnEpr).toMatchObject({
      status: 400,
      body: { error: { code: 'malformed' } },
    })
  })
})
