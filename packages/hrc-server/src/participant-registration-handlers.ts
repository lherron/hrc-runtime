import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { buildScopeRef, parseScopeRef, validateScopeRef } from 'agent-scope'
import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
  type HrcLifecycleEvent,
} from 'hrc-core'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import {
  type JsonValue,
  type ParticipantAdapter,
  type ParticipantAdapterPreparationRequest,
  type ParticipantBrokerDescriptor,
  type WriterEvidence,
  validateParticipantAdapterPreparation,
} from 'spaces-runtime-contracts'

import { parseParticipantBrokerDescriptor } from './participant-broker-descriptor.js'
import { scheduleParticipantEstablishment } from './participant-establishment.js'
import {
  type DirectJoinRequest,
  registerDirectParticipant,
} from './participant-host-registration.js'
import { createParticipantHostingIntent } from './participant-hosting-intent.js'
import {
  isAbsorbingParticipantAttempt,
  obtainParticipantWriterEvidence,
} from './participant-writer-evidence.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { isParticipantRegistrationClass } from './registration-classes-config.js'
import { withScopeClaimMutex } from './scope-claim-core.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { createHostSessionId, json, timestamp } from './server-util.js'

/**
 * The key-scoped request shape. `processToken` and `evidence` remain accepted
 * for compatibility and are ignored for joining, identity, retry matching and
 * continuation (R6.2) -- they were admission inputs, and there is no admission.
 * Requiring a field HRC no longer reads would refuse a join for nothing.
 */
export type LegacyRegisterParticipantRequest = {
  mode: 'legacy'
  classId: string
  processToken?: string | undefined
  evidence?: JsonValue | undefined
  socketPath?: string | undefined
  participantKey?: string | undefined
  workspaceCwd?: string | undefined
}

/** R6.2's direct request: the participant's own declaration of its address. */
export type DirectRegisterParticipantRequest = { mode: 'direct' } & DirectJoinRequest

export type RegisterParticipantRequest =
  | LegacyRegisterParticipantRequest
  | DirectRegisterParticipantRequest

export type RegisterParticipantResponse =
  | {
      status: 'registered'
      scopeRef: string
      hostSessionId: string
      generation: number
      created: boolean
      resumed: boolean
      /**
       * `attachment_pending` is not a degraded `prepared`. It is the honest
       * answer for a participant whose address exists and whose execution
       * profile does not: `registered` means the address exists, never that
       * input was delivered or a model ran (R6.4).
       */
      observation: { state: 'prepared' | 'attachment_pending' | 'attached'; detail: string }
      /** Present for a direct join: everything needed to compose an attachment. */
      identity?:
        | {
            registrationId: string
            laneRef: string
            runtimeId: string
            attemptId: string
            invocationId: string
            attachEpoch: number
            requestId: string
            operationId: string
          }
        | undefined
      /** R7.3's explicit handoff. Never a claim that native state was restored. */
      continuation?:
        | { carried: boolean; reason: string; selected: unknown; resumeState: string }
        | undefined
    }
  | {
      status: 'pending' | 'rejected'
      reason: string
      detail: string
      /** R7.4's redirect target, when the address's home is another node. */
      observed?: { homeNodeId?: string | undefined } | undefined
    }

function malformed(message: string, field?: string): never {
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    message,
    field === undefined ? {} : { field }
  )
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    malformed(`${field} must be a non-empty string`, field)
  }
  return value.trim()
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

function serializedJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? 'null'
}

function registeredResponse(
  registration: ParticipantRegistration,
  created: boolean,
  attempt: ParticipantAttempt
): RegisterParticipantResponse {
  // The observation reports what is actually durable. With admission gone a
  // registration can legitimately have no execution profile yet, and calling
  // that `prepared` would assert a frozen start tuple that does not exist.
  const observation: { state: 'prepared' | 'attachment_pending'; detail: string } =
    attempt.preparedDescriptorJson === undefined
      ? {
          state: 'attachment_pending',
          detail:
            'participant registration and reserved identities are durable; no execution profile is attached yet',
        }
      : {
          state: 'prepared',
          detail:
            attempt.hostingIntentJson === undefined
              ? 'participant registration and immutable adapter preparation are durable'
              : 'participant registration, adapter preparation, and HRC hosting intent are durable',
        }
  return {
    status: 'registered',
    scopeRef: registration.scopeRef,
    hostSessionId: registration.hostSessionId,
    generation: registration.generation,
    created,
    resumed:
      attempt.activationClassification === 'resume' &&
      attempt.initialActivationConfirmedAt !== undefined,
    observation,
    identity: {
      registrationId: registration.registrationId,
      laneRef: registration.laneRef,
      runtimeId: attempt.runtimeId,
      attemptId: attempt.attemptId,
      invocationId: attempt.invocationId,
      attachEpoch: attempt.attachEpoch,
      requestId: attempt.requestId,
      operationId: attempt.operationId,
    },
  }
}

function hasAbsorbingDisposition(attempt: ParticipantAttempt): boolean {
  return (
    isAbsorbingParticipantAttempt(attempt) && (attempt.dispositionReason?.trim().length ?? 0) > 0
  )
}

function recoverySatisfied(attempt: ParticipantAttempt, evidence: WriterEvidence): boolean {
  return (
    (evidence.priorRecovery.state === 'recovered' &&
      attempt.recoveryDisposition === 'reconciled') ||
    (attempt.recoveryDisposition === 'abandoned' &&
      (attempt.recoveryReason?.trim().length ?? 0) > 0)
  )
}

/**
 * C.8 classification. The comparison is against the registration's retained
 * known evidence — the last evidence an activation accepted — never against
 * whatever candidate the immediately prior attempt happened to carry. An
 * unknown attempt therefore preserves the baseline rather than erasing it, and
 * a candidate that never activated never becomes the baseline it is compared
 * against.
 */
function activationClassification(
  acceptedContinuityEvidenceJson: string | undefined,
  candidateContinuityEvidenceJson: string | undefined
): NonNullable<ParticipantAttempt['activationClassification']> {
  if (candidateContinuityEvidenceJson === undefined) return 'attached_unknown'
  if (acceptedContinuityEvidenceJson === undefined) return 'attached'
  return acceptedContinuityEvidenceJson === candidateContinuityEvidenceJson
    ? 'replacement'
    : 'resume'
}

/**
 * Persist HRC's hosting intent for a prepared attempt.
 *
 * Exported because attachment reuses this exact step rather than growing a
 * second one: R6.4 says an attachment reuses the established work chain, and
 * the establishment worker refuses an attempt with no hosting intent. A live
 * Arris attach exhausted its whole retry budget on "participant attempt is
 * missing hosting intent" before this was shared.
 */
export async function persistHostingIntentIfRequired(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt
): Promise<ParticipantAttempt | null> {
  if (attempt.hostingIntentJson !== undefined) return attempt
  if (attempt.preparedDescriptorJson === undefined || attempt.state !== 'PREPARED') return null

  let descriptor: ParticipantBrokerDescriptor
  try {
    descriptor = parseParticipantBrokerDescriptor(attempt.preparedDescriptorJson)
  } catch {
    return null
  }
  const intent = await createParticipantHostingIntent(server, registration, attempt, descriptor)
  const now = timestamp()
  const persisted = server.db.sqlite.transaction(() => {
    const snapshot = server.db.participantRegistrations.setSnapshotIfAbsent(
      attempt.attemptId,
      'hostingIntentJson',
      serializedJson(intent),
      now
    )
    if (!snapshot) return false
    return server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      ['PREPARED'],
      'HOSTING_INTENT_PERSISTED',
      now
    )
  })()
  if (!persisted) return server.db.participantRegistrations.getAttempt(attempt.attemptId)
  return server.db.participantRegistrations.getAttempt(attempt.attemptId)
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    malformed(`${field} must be a non-empty string when provided`, field)
  }
  return value.trim()
}

function optionalSocketPath(value: unknown): string | undefined {
  const socketPath = optionalNonEmptyString(value, 'socketPath')
  if (socketPath !== undefined && !isAbsolute(socketPath)) {
    malformed('socketPath must be an absolute unix socket path when provided', 'socketPath')
  }
  return socketPath
}

const LEGACY_FIELDS = [
  'classId',
  'processToken',
  'evidence',
  'socketPath',
  'participantKey',
  'workspaceCwd',
]

const DIRECT_FIELDS = [
  'registrationMode',
  'requestedSessionRef',
  'hostIncarnationId',
  'laneRef',
  'classId',
  'participantKey',
  'workspaceCwd',
  'socketPath',
  'processToken',
  'evidence',
  'expectedPredecessor',
]

function rejectUnsupportedFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(body).find((field) => !allowed.includes(field))
  if (unsupported !== undefined) {
    malformed(`unsupported participant registration field "${unsupported}"`, unsupported)
  }
}

export function parseRegisterParticipantRequest(input: unknown): RegisterParticipantRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    malformed('request body must be an object')
  }
  const body = input as Record<string, unknown>

  // R6.2: absence of `registrationMode` selects the existing key-scoped request
  // shape for compatibility -- not its old admit gate, which is gone from both.
  const registrationMode = body['registrationMode']
  if (registrationMode !== undefined && registrationMode !== 'direct') {
    malformed('registrationMode must be "direct" when provided', 'registrationMode')
  }

  if (registrationMode === 'direct') {
    rejectUnsupportedFields(body, DIRECT_FIELDS)
    const requestedSessionRef = requiredNonEmptyString(
      body['requestedSessionRef'],
      'requestedSessionRef'
    )
    // An unparseable address is a malformed message; an address that policy or
    // occupancy refuses is a typed rejection further down. Keeping the two
    // apart is what lets a participant tell a typo from a conflict.
    const validation = validateScopeRef(requestedSessionRef)
    if (!validation.ok) {
      malformed(
        `requestedSessionRef must be a valid ScopeRef: ${validation.error}`,
        'requestedSessionRef'
      )
    }
    const evidence = body['evidence']
    if (evidence !== undefined && !isJsonValue(evidence)) {
      malformed('evidence must be JSON-serializable when provided', 'evidence')
    }
    let expectedPredecessor: DirectJoinRequest['expectedPredecessor']
    if (body['expectedPredecessor'] !== undefined) {
      const raw = body['expectedPredecessor']
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        malformed('expectedPredecessor must be an object', 'expectedPredecessor')
      }
      const predecessor = raw as Record<string, unknown>
      const keys = Object.keys(predecessor).sort()
      if (keys.join(',') !== 'generation,hostIncarnationId,runtimeId') {
        malformed(
          'expectedPredecessor must contain exactly hostIncarnationId, runtimeId, and generation',
          'expectedPredecessor'
        )
      }
      if (
        !Number.isInteger(predecessor['generation']) ||
        (predecessor['generation'] as number) < 1
      ) {
        malformed(
          'expectedPredecessor.generation must be a positive integer',
          'expectedPredecessor'
        )
      }
      expectedPredecessor = {
        hostIncarnationId: requiredNonEmptyString(
          predecessor['hostIncarnationId'],
          'expectedPredecessor.hostIncarnationId'
        ),
        runtimeId: requiredNonEmptyString(
          predecessor['runtimeId'],
          'expectedPredecessor.runtimeId'
        ),
        generation: predecessor['generation'] as number,
      }
    }
    return {
      mode: 'direct',
      requestedSessionRef,
      hostIncarnationId: requiredNonEmptyString(body['hostIncarnationId'], 'hostIncarnationId'),
      laneRef: optionalNonEmptyString(body['laneRef'], 'laneRef') ?? 'main',
      ...(optionalNonEmptyString(body['classId'], 'classId') === undefined
        ? {}
        : { classId: optionalNonEmptyString(body['classId'], 'classId') }),
      ...(optionalNonEmptyString(body['participantKey'], 'participantKey') === undefined
        ? {}
        : { participantKey: optionalNonEmptyString(body['participantKey'], 'participantKey') }),
      ...(optionalNonEmptyString(body['workspaceCwd'], 'workspaceCwd') === undefined
        ? {}
        : { workspaceCwd: optionalNonEmptyString(body['workspaceCwd'], 'workspaceCwd') }),
      ...(optionalSocketPath(body['socketPath']) === undefined
        ? {}
        : { socketPath: optionalSocketPath(body['socketPath']) }),
      ...(expectedPredecessor === undefined ? {} : { expectedPredecessor }),
    }
  }

  rejectUnsupportedFields(body, LEGACY_FIELDS)
  const classId = requiredNonEmptyString(body['classId'], 'classId')
  const evidence = body['evidence']
  if (evidence !== undefined && !isJsonValue(evidence)) {
    malformed('evidence must be JSON-serializable when provided', 'evidence')
  }
  const processToken = optionalNonEmptyString(body['processToken'], 'processToken')
  const participantKey = optionalNonEmptyString(body['participantKey'], 'participantKey')
  const workspaceCwd = optionalNonEmptyString(body['workspaceCwd'], 'workspaceCwd')
  const socketPath = optionalSocketPath(body['socketPath'])
  return {
    mode: 'legacy',
    classId,
    ...(processToken === undefined ? {} : { processToken }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(participantKey === undefined ? {} : { participantKey }),
    ...(workspaceCwd === undefined ? {} : { workspaceCwd }),
  }
}

/**
 * R6.1-R6.4's direct join, as an HTTP answer.
 *
 * A redirect is 409 with `observed.homeNodeId`: successful routing information,
 * not a completed registration, and emphatically not a forwarded request. The
 * participant resolves that home through existing federation discovery and
 * retries the same address and incarnation there.
 */
async function handleDirectRegistration(
  server: HrcServerInstanceForHandlers,
  body: DirectRegisterParticipantRequest
): Promise<Response> {
  const result = await registerDirectParticipant(server, {
    requestedSessionRef: body.requestedSessionRef,
    hostIncarnationId: body.hostIncarnationId,
    laneRef: body.laneRef,
    ...(body.classId === undefined ? {} : { classId: body.classId }),
    ...(body.participantKey === undefined ? {} : { participantKey: body.participantKey }),
    ...(body.workspaceCwd === undefined ? {} : { workspaceCwd: body.workspaceCwd }),
    ...(body.socketPath === undefined ? {} : { socketPath: body.socketPath }),
    ...(body.expectedPredecessor === undefined
      ? {}
      : { expectedPredecessor: body.expectedPredecessor }),
  })

  if (result.outcome === 'refused' && result.status === 'pending') {
    const registration = server.db.participantRegistrations.getRegistrationByScopeRef(
      body.requestedSessionRef
    )
    const attempt =
      registration === null
        ? null
        : server.db.participantRegistrations.getAttemptByRegistrationId(registration.registrationId)
    if (registration !== null && attempt?.replacementIntentJson !== undefined) {
      scheduleParticipantEstablishment(server, registration, attempt)
    }
  }

  if (result.outcome === 'redirect') {
    return json(
      {
        status: 'rejected',
        reason: result.reason,
        detail: result.detail,
        observed: { ...(result.homeNodeId === undefined ? {} : { homeNodeId: result.homeNodeId }) },
      } satisfies RegisterParticipantResponse,
      409
    )
  }
  if (result.outcome === 'refused') {
    return json(
      {
        status: result.status,
        reason: result.reason,
        detail: result.detail,
      } satisfies RegisterParticipantResponse,
      result.status === 'rejected' ? 409 : 200
    )
  }

  const { identity, continuation } = result
  return json({
    status: 'registered',
    scopeRef: identity.scopeRef,
    hostSessionId: identity.hostSessionId,
    generation: identity.generation,
    created: result.created,
    resumed: identity.generation > 1 && continuation.carried,
    observation: result.attached
      ? {
          state: 'attached',
          detail: 'the participant address and its execution profile are durable',
        }
      : {
          state: 'attachment_pending',
          detail:
            'the participant address and reserved identities are durable; attach a broker endpoint and profile to make its work runnable',
        },
    identity: {
      registrationId: identity.registrationId,
      laneRef: identity.laneRef,
      runtimeId: identity.runtimeId,
      attemptId: identity.attemptId,
      invocationId: identity.invocationId,
      attachEpoch: identity.attachEpoch,
      requestId: identity.requestId,
      operationId: identity.operationId,
    },
    continuation,
  } satisfies RegisterParticipantResponse)
}

/**
 * Allocate a successor attempt for a key-scoped registration.
 *
 * Extracted from the registration mutex so the two halves stay separately
 * readable: everything here is the writer-retirement and recovery gate, which
 * R6.5 keeps required for REPLACEMENT of an existing writer even though R6.1
 * removed admission from first join. It returns a refusal response, or the new
 * attempt for the caller to adopt.
 */
async function allocateKeyedSuccessor(
  server: HrcServerInstanceForHandlers,
  adapter: ParticipantAdapter | undefined,
  registration: ParticipantRegistration,
  priorAttempt: ParticipantAttempt,
  body: LegacyRegisterParticipantRequest
): Promise<{ successor: ParticipantAttempt } | { refusal: RegisterParticipantResponse }> {
  let attempt: ParticipantAttempt | null = priorAttempt
  // The retirement/recovery gate is producer-owned evidence, so it
  // needs the adapter that owns the prior writer. Removing admit did
  // not make HRC able to retire someone else's write path, and an
  // absent adapter is an unproven retirement, not a free pass.
  const evidence =
    adapter === undefined
      ? null
      : await obtainParticipantWriterEvidence(server, adapter, registration, attempt)
  if (evidence === null) {
    return {
      refusal: {
        status: 'pending',
        reason: 'host_retirement_unproven',
        detail: 'the exact prior writer has no valid owner-produced retirement evidence',
      },
    }
  }
  const now = timestamp()
  const retirementSatisfied =
    evidence.writePath.state === 'retired' || evidence.liveness.state === 'dead'
  server.db.participantRegistrations.recordWriterEvidence(
    attempt.attemptId,
    attempt.attachEpoch,
    serializedJson(evidence),
    now
  )
  if (!retirementSatisfied) {
    return {
      refusal: {
        status:
          evidence.writePath.state === 'writable' && evidence.liveness.state === 'live'
            ? 'rejected'
            : 'pending',
        reason:
          evidence.writePath.state === 'writable' && evidence.liveness.state === 'live'
            ? 'host_binding_conflict'
            : 'host_retirement_unproven',
        detail: 'the exact prior writer remains writable/live or has unknown retirement',
      },
    }
  }
  if (!isAbsorbingParticipantAttempt(attempt)) {
    const abandoned = server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      [attempt.state],
      'ABANDONED',
      now,
      evidence.writePath.state === 'retired'
        ? `writer-retired:${evidence.writePath.reason}`
        : `writer-dead:${evidence.liveness.reason}`
    )
    if (!abandoned) {
      return {
        refusal: {
          status: 'pending',
          reason: 'participant_prior_disposition_unresolved',
          detail: 'the prior participant attempt could not record its absorbing disposition',
        },
      }
    }
    attempt = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  }
  if (attempt === null || !hasAbsorbingDisposition(attempt)) {
    return {
      refusal: {
        status: 'pending',
        reason: 'participant_prior_disposition_unresolved',
        detail: 'the prior participant attempt has no absorbing disposition',
      },
    }
  }
  if (
    attempt.recoveryDisposition === 'unresolved' &&
    evidence.priorRecovery.state === 'recovered'
  ) {
    server.db.participantRegistrations.recordRecoveryDisposition(
      attempt.attemptId,
      'reconciled',
      `writer-evidence:${evidence.priorRecovery.reason}`,
      now
    )
    attempt = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  }
  if (attempt === null || !recoverySatisfied(attempt, evidence)) {
    return {
      refusal: {
        status: 'pending',
        reason: 'participant_prior_recovery_unresolved',
        detail: 'the prior invocation recovery is neither reconciled nor explicitly abandoned',
      },
    }
  }

  const successor: ParticipantAttempt = {
    attemptId: `participant-attempt-${randomUUID()}`,
    registrationId: registration.registrationId,
    attachEpoch: attempt.attachEpoch + 1,
    requestId: `req-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    invocationId: `inv-${randomUUID()}`,
    runtimeId: `rt-${randomUUID()}`,
    state: 'IDENTITY_MINTED',
    activationClassification: activationClassification(
      registration.continuityEvidenceJson,
      undefined
    ),
    recoveryDisposition: 'unresolved',
    establishmentWorkState: 'pending',
    establishmentAttemptCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  const priorAttemptId = attempt.attemptId
  const registrationId = registration.registrationId
  const allocated = server.db.sqlite.transaction(() => {
    const currentPrior = server.db.participantRegistrations.getAttempt(priorAttemptId)
    const latestPrior =
      server.db.participantRegistrations.getAttemptByRegistrationId(registrationId)
    if (
      currentPrior === null ||
      latestPrior?.attemptId !== currentPrior.attemptId ||
      !hasAbsorbingDisposition(currentPrior) ||
      !recoverySatisfied(currentPrior, evidence) ||
      currentPrior.writerEvidenceJson !== serializedJson(evidence)
    ) {
      return false
    }
    if (
      !server.db.participantRegistrations.updateRegistrationForSuccessor({
        registrationId,
        ...(body.workspaceCwd === undefined ? {} : { workspaceCwd: body.workspaceCwd }),
        ...(body.socketPath === undefined ? {} : { socketPath: body.socketPath }),
        updatedAt: now,
      })
    ) {
      throw new Error('participant successor registration update raced')
    }
    server.db.participantRegistrations.insertAttempt(successor)
    return true
  })()
  if (!allocated) {
    return {
      refusal: {
        status: 'pending',
        reason: 'participant_successor_gate_changed',
        detail: 'the prior writer or recovery gate changed before successor allocation',
      },
    }
  }
  return { successor }
}

export async function handleRegisterParticipant(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    malformed('request body must be valid JSON')
  }
  const body = parseRegisterParticipantRequest(rawBody)

  if (body.mode === 'direct') {
    return await handleDirectRegistration(this, body)
  }

  const registrationClass = this.options.registrationClasses?.find(
    (candidate) => candidate.classId === body.classId
  )
  if (registrationClass === undefined || !isParticipantRegistrationClass(registrationClass)) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_REGISTRATION_CLASS,
      `participant registration class "${body.classId}" is not configured`,
      { classId: body.classId }
    )
  }
  if (registrationClass.join === 'participant-served' && body.socketPath === undefined) {
    malformed('socketPath is required for a participant-served participant', 'socketPath')
  }

  // R6.1/R6.9 remove the admit call from this pre-existing generic path too.
  // An adapter is a delivery mechanism, not admission authority, so its absence
  // no longer refuses a join -- it only means no post-join preparation helper
  // is available and the participant must attach for itself.
  const adapter = this.options.participantAdapterRegistry?.get(registrationClass.adapterId)

  // HRC no longer discovers a permanent key by running adapter code. A supplied
  // key is used; otherwise HRC allocates one and returns it, and the caller must
  // retain it. A new keyless request is a CREATION, not an idempotent retry --
  // a caller that loses this reply has not converged, it has no key.
  const participantKey = body.participantKey ?? `participant-key-${randomUUID()}`
  let birthEvent: HrcLifecycleEvent | undefined

  const result = await withScopeClaimMutex(
    this,
    `roster:${registrationClass.scopeTemplate.agent}:${registrationClass.scopeTemplate.project}`,
    async (): Promise<RegisterParticipantResponse> => {
      let registration = this.db.participantRegistrations.getRegistrationByClassAndKey(
        registrationClass.classId,
        participantKey
      )
      let attempt =
        registration === null
          ? null
          : this.db.participantRegistrations.getAttemptByRegistrationId(registration.registrationId)
      let created = false

      if (registration === null) {
        if (
          this.db.participantRegistrations.countRegistrationsByClassId(registrationClass.classId) >=
          registrationClass.maxInstances
        ) {
          return {
            status: 'pending',
            reason: 'participant_registration_capacity_exhausted',
            detail: `participant class "${registrationClass.classId}" has no permanent registration capacity`,
          }
        }

        const now = timestamp()
        const hostSessionId = createHostSessionId()
        const registrationId = `participant-registration-${randomUUID()}`
        const attemptId = `participant-attempt-${randomUUID()}`
        const requestId = `req-${randomUUID()}`
        const operationId = `op-${randomUUID()}`
        const runtimeId = `rt-${randomUUID()}`
        const invocationId = `inv-${randomUUID()}`
        const scopeRef = buildScopeRef({
          agentId: registrationClass.scopeTemplate.agent,
          projectId: registrationClass.scopeTemplate.project,
          taskId: `participant-${randomUUID()}`,
        })
        const newRegistration: ParticipantRegistration = {
          registrationId,
          classId: registrationClass.classId,
          adapterId: registrationClass.adapterId,
          join: registrationClass.join,
          registrationMode: 'legacy',
          participantKey,
          scopeRef,
          laneRef: 'main',
          hostSessionId,
          generation: 1,
          // Optional metadata now, not an adapter-certified fact. A driver
          // that needs a workspace reports an attachment error if it is absent;
          // HRC does not inspect its files during join (R6.2).
          ...(body.workspaceCwd === undefined ? {} : { workspaceCwd: body.workspaceCwd }),
          ...(body.socketPath === undefined ? {} : { socketPath: body.socketPath }),
          // The registration's continuity evidence is the last ACTIVATED known
          // evidence. A fresh registration has activated nothing, so it starts
          // with no accepted baseline; the candidate lives on the attempt.
          createdAt: now,
          updatedAt: now,
        }
        const newAttempt: ParticipantAttempt = {
          attemptId,
          registrationId,
          attachEpoch: 1,
          requestId,
          operationId,
          invocationId,
          runtimeId,
          state: 'IDENTITY_MINTED',
          activationClassification: activationClassification(undefined, undefined),
          recoveryDisposition: 'unresolved',
          establishmentWorkState: 'pending',
          establishmentAttemptCount: 0,
          createdAt: now,
          updatedAt: now,
        }
        birthEvent = this.db.sqlite.transaction(() => {
          this.db.sessions.insert({
            hostSessionId,
            scopeRef,
            laneRef: newRegistration.laneRef,
            generation: newRegistration.generation,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            parsedScopeJson: parseScopeRef(scopeRef) as unknown as Record<string, unknown>,
            ancestorScopeRefs: [],
          })
          this.db.continuities.upsert({
            scopeRef,
            laneRef: newRegistration.laneRef,
            activeHostSessionId: hostSessionId,
            updatedAt: now,
          })
          this.db.participantRegistrations.insertRegistration(newRegistration)
          this.db.participantRegistrations.insertAttempt(newAttempt)
          return appendHrcEvent(this.db, 'session.created', {
            ts: now,
            hostSessionId,
            scopeRef,
            laneRef: newRegistration.laneRef,
            generation: newRegistration.generation,
            payload: { created: true },
          })
        })()
        registration = newRegistration
        attempt = newAttempt
        created = true
      } else if (attempt !== null) {
        // R6.6 withdrew the adapter's continuity candidate, which was the
        // other half of this signal. What remains is the already-landed keyed
        // behavior: an attempt that has reached an absorbing disposition is the
        // one case where a retry is asking for a successor, and it still has to
        // pass the whole writer-retirement and recovery gate below.
        if (isAbsorbingParticipantAttempt(attempt)) {
          const allocation = await allocateKeyedSuccessor(
            this,
            adapter,
            registration,
            attempt,
            body
          )
          if ('refusal' in allocation) return allocation.refusal
          registration = this.db.participantRegistrations.getRegistrationById(
            registration.registrationId
          )
          attempt = allocation.successor
          created = false
        }
      }

      if (registration === null || attempt === null) {
        return {
          status: 'pending',
          reason: 'participant_attempt_unavailable',
          detail: 'registered participant has no durable attempt to prepare',
        }
      }
      const resolvedRegistration = registration
      const resolvedAttempt = attempt
      if (resolvedAttempt.preparedDescriptorJson !== undefined) {
        const withHostingIntent = await persistHostingIntentIfRequired(
          this,
          resolvedRegistration,
          resolvedAttempt
        )
        if (withHostingIntent === null) {
          return {
            status: 'pending',
            reason: 'participant_hosting_intent_unavailable',
            detail: 'prepared participant attempt cannot persist its HRC hosting intent',
          }
        }
        return registeredResponse(resolvedRegistration, created, withHostingIntent)
      }

      // R6.4: a locally configured `prepare` helper may compose the profile
      // AFTER join, from the participant's supplied metadata and the identities
      // HRC already allocated. It is not required, has no admit call and no
      // authority to undo the registration -- so when it or its inputs are
      // absent, the participant stays registered with its work pending and
      // attaches for itself. Fabricating a workspace to reach the helper is
      // exactly what R7.1 forbids.
      if (
        adapter === undefined ||
        resolvedRegistration.classId === undefined ||
        resolvedRegistration.participantKey === undefined ||
        resolvedRegistration.workspaceCwd === undefined
      ) {
        return registeredResponse(resolvedRegistration, created, resolvedAttempt)
      }
      const preparationRequest = {
        classId: resolvedRegistration.classId,
        join: resolvedRegistration.join,
        participantKey: resolvedRegistration.participantKey,
        workspaceCwd: resolvedRegistration.workspaceCwd,
        preparation:
          resolvedRegistration.preparationJson === undefined
            ? null
            : (JSON.parse(resolvedRegistration.preparationJson) as JsonValue),
        identity: {
          requestId: resolvedAttempt.requestId,
          operationId: resolvedAttempt.operationId,
          hostSessionId: resolvedRegistration.hostSessionId,
          generation: resolvedRegistration.generation,
          runtimeId: resolvedAttempt.runtimeId,
          invocationId: resolvedAttempt.invocationId,
        },
        scopeRef: resolvedRegistration.scopeRef,
        laneRef: resolvedRegistration.laneRef,
        attachEpoch: resolvedAttempt.attachEpoch,
      } as ParticipantAdapterPreparationRequest
      const prepared = validateParticipantAdapterPreparation(
        preparationRequest,
        await adapter.prepare(preparationRequest)
      )
      if (!prepared.ok) {
        return {
          status: 'pending',
          reason: 'participant_adapter_preparation_invalid',
          detail: prepared.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        }
      }
      const preparedValue = prepared.value
      if (preparedValue.status !== 'prepared') {
        return {
          status: preparedValue.status,
          reason: preparedValue.reason,
          detail: `participant adapter ${preparedValue.status} registration preparation`,
        }
      }

      const now = timestamp()
      const frozen = this.db.sqlite.transaction(() => {
        const didFreeze = this.db.participantRegistrations.freezePreparedDescriptorIfAbsent(
          resolvedAttempt.attemptId,
          serializedJson(preparedValue.descriptor),
          serializedJson(preparedValue.dispatchEnv),
          now
        )
        if (!didFreeze) return false
        return this.db.participantRegistrations.transitionAttempt(
          resolvedAttempt.attemptId,
          ['IDENTITY_MINTED'],
          'PREPARED',
          now
        )
      })()
      if (!frozen) {
        const current = this.db.participantRegistrations.getAttempt(resolvedAttempt.attemptId)
        if (current?.preparedDescriptorJson !== undefined)
          return registeredResponse(resolvedRegistration, false, current)
        return {
          status: 'pending',
          reason: 'participant_preparation_race',
          detail: 'participant preparation could not be durably frozen',
        }
      }

      const preparedAttempt = this.db.participantRegistrations.getAttempt(resolvedAttempt.attemptId)
      if (preparedAttempt === null) {
        return {
          status: 'pending',
          reason: 'participant_attempt_unavailable',
          detail: 'prepared participant attempt disappeared before hosting intent persistence',
        }
      }
      const withHostingIntent = await persistHostingIntentIfRequired(
        this,
        resolvedRegistration,
        preparedAttempt
      )
      if (withHostingIntent === null) {
        return {
          status: 'pending',
          reason: 'participant_hosting_intent_unavailable',
          detail: 'prepared participant attempt cannot persist its HRC hosting intent',
        }
      }
      return registeredResponse(resolvedRegistration, created, withHostingIntent)
    }
  )
  // Publish only an event that survived the session/continuity/registration
  // transaction. A keyed retry never assigns birthEvent, so it remains one
  // durable fact for one actual participant identity mint.
  if (birthEvent !== undefined) this.notifyEvent(birthEvent)
  if (result.status === 'registered') {
    const registration = this.db.participantRegistrations.getRegistrationByScopeRef(result.scopeRef)
    const attempt =
      registration === null
        ? null
        : this.db.participantRegistrations.getAttemptByRegistrationId(registration.registrationId)
    if (registration !== null && attempt !== null) {
      scheduleParticipantEstablishment(this, registration, attempt)
    }
  }
  return json(result)
}

export const participantRegistrationHandlersMethods = {
  handleRegisterParticipant,
}

export type ParticipantRegistrationHandlersMethods = typeof participantRegistrationHandlersMethods
