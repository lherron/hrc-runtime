import { isAbsolute } from 'node:path'

import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import {
  type BrokerExecutionProfile,
  type ParticipantAdapterPreparationRequest,
  validateParticipantAdapterPreparation,
} from 'spaces-runtime-contracts'

import { scheduleParticipantEstablishment } from './participant-establishment.js'
import { persistHostingIntentIfRequired } from './participant-registration-handlers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { json, timestamp } from './server-util.js'

/**
 * `POST /v1/participants/attach` — the second half of protocol join (R6.4,
 * R7.2, R7.3).
 *
 * Joining made an address durable. Attaching is what makes it runnable, and the
 * split is the point: a participant that has joined but not attached is a real,
 * addressable registration whose work is pending, not a half-written row and
 * not a failure. Everything that could execute a model lives on this side of
 * the line.
 *
 * The message is scoped to one attempt and one epoch. A byte-equivalent retry
 * converges; a different profile under the same identity cannot overwrite a
 * frozen one, because changing a bridge after activation is a replacement
 * operation and not an edit.
 */

export type AttachParticipantResponse =
  | {
      status: 'attached'
      registrationId: string
      attemptId: string
      attachEpoch: number
      /** True when this exact call performed the preparation, not a retry. */
      prepared: boolean
      observation: { state: 'attached'; detail: string }
    }
  | {
      status: 'pending' | 'rejected'
      reason: string
      detail: string
    }

export type AttachParticipantRequest =
  | {
      kind: 'profile'
      registrationId: string
      attemptId: string
      attachEpoch: number
      socketPath?: string | undefined
      profile: BrokerExecutionProfile
      dispatchEnv?: Record<string, string> | undefined
    }
  | {
      kind: 'resume-unsupported'
      registrationId: string
      attemptId: string
      attachEpoch: number
      reason: string
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

function serializedJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? 'null'
}

export function parseAttachParticipantRequest(input: unknown): AttachParticipantRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    malformed('request body must be an object')
  }
  const body = input as Record<string, unknown>
  const allowed = new Set([
    'registrationId',
    'attemptId',
    'attachEpoch',
    'socketPath',
    'profile',
    'dispatchEnv',
    'resumeUnsupported',
    'reason',
  ])
  const unsupported = Object.keys(body).find((field) => !allowed.has(field))
  if (unsupported !== undefined) {
    malformed(`unsupported participant attach field "${unsupported}"`, unsupported)
  }
  const registrationId = requiredNonEmptyString(body['registrationId'], 'registrationId')
  const attemptId = requiredNonEmptyString(body['attemptId'], 'attemptId')
  const attachEpoch = body['attachEpoch']
  if (typeof attachEpoch !== 'number' || !Number.isInteger(attachEpoch) || attachEpoch < 1) {
    malformed('attachEpoch must be a positive integer', 'attachEpoch')
  }

  // R7.3's alternative shape. It is a truthful report that the driver cannot
  // resume native state, NOT an eligibility veto over the address, so it stays
  // a distinct message rather than an optional flag on a profile attachment.
  if (body['resumeUnsupported'] !== undefined) {
    if (body['resumeUnsupported'] !== true) {
      malformed('resumeUnsupported must be true when present', 'resumeUnsupported')
    }
    if (body['profile'] !== undefined || body['socketPath'] !== undefined) {
      malformed(
        'resumeUnsupported cannot be combined with a profile attachment',
        'resumeUnsupported'
      )
    }
    return {
      kind: 'resume-unsupported',
      registrationId,
      attemptId,
      attachEpoch,
      reason: requiredNonEmptyString(body['reason'], 'reason'),
    }
  }

  const profile = body['profile']
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    malformed('profile must be a broker execution profile object', 'profile')
  }
  const socketPath = body['socketPath']
  if (
    socketPath !== undefined &&
    (typeof socketPath !== 'string' ||
      socketPath.trim().length === 0 ||
      socketPath.includes('\0') ||
      !isAbsolute(socketPath.trim()))
  ) {
    malformed('socketPath must be an absolute unix socket path when provided', 'socketPath')
  }
  const dispatchEnv = body['dispatchEnv']
  if (
    dispatchEnv !== undefined &&
    (typeof dispatchEnv !== 'object' ||
      dispatchEnv === null ||
      Array.isArray(dispatchEnv) ||
      !Object.values(dispatchEnv).every((value) => typeof value === 'string'))
  ) {
    malformed('dispatchEnv must be a record of strings when provided', 'dispatchEnv')
  }
  return {
    kind: 'profile',
    registrationId,
    attemptId,
    attachEpoch,
    ...(socketPath === undefined ? {} : { socketPath: (socketPath as string).trim() }),
    profile: profile as BrokerExecutionProfile,
    ...(dispatchEnv === undefined ? {} : { dispatchEnv: dispatchEnv as Record<string, string> }),
  }
}

/**
 * The continuation the profile actually asks the harness for.
 *
 * R7.3 requires this to express exactly what HRC selected, and to be absent
 * when HRC selected nothing. A profile that quietly carries a continuation HRC
 * did not choose would make a resume that HRC never authorized look like the
 * ordinary start it was frozen as.
 */
function profileContinuation(profile: BrokerExecutionProfile): unknown {
  const invocation = (profile as { harnessInvocation?: { startRequest?: { spec?: unknown } } })
    .harnessInvocation
  const spec = invocation?.startRequest?.spec as { continuation?: unknown } | undefined
  return spec?.continuation
}

/**
 * Build the published preparation request this profile is validated against.
 *
 * `validateParticipantAdapterPreparation` reads `join` and `identity` only --
 * it is the existing binding check between a profile and the identities HRC
 * allocated, which is exactly what an attachment needs. The remaining three
 * fields are structural requirements of the published request type that the
 * validator never consults; they carry the registration's real values when it
 * has them rather than inventing any.
 */
function preparationRequestFor(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt
): ParticipantAdapterPreparationRequest {
  return {
    classId: registration.classId ?? '',
    join: registration.join,
    participantKey: registration.participantKey ?? '',
    workspaceCwd: registration.workspaceCwd ?? '',
    preparation: null,
    identity: {
      requestId: attempt.requestId,
      operationId: attempt.operationId,
      hostSessionId: registration.hostSessionId,
      generation: registration.generation,
      runtimeId: attempt.runtimeId,
      invocationId: attempt.invocationId,
    },
    scopeRef: registration.scopeRef,
    laneRef: registration.laneRef,
    attachEpoch: attempt.attachEpoch,
  } as ParticipantAdapterPreparationRequest
}

type Located =
  | { ok: true; registration: ParticipantRegistration; attempt: ParticipantAttempt }
  | { ok: false; response: AttachParticipantResponse }

/**
 * Resolve the attachment's subject and fence it to the current epoch.
 *
 * "Current" is the latest attempt of the registration, not merely the attempt
 * whose id was quoted: an attachment composed against a superseded attempt must
 * not land just because that row still exists.
 */
function locateAttachTarget(
  server: HrcServerInstanceForHandlers,
  request: AttachParticipantRequest
): Located {
  const registration = server.db.participantRegistrations.getRegistrationById(
    request.registrationId
  )
  if (registration === null) {
    return {
      ok: false,
      response: {
        status: 'rejected',
        reason: 'participant_registration_unknown',
        detail: `no participant registration ${request.registrationId}`,
      },
    }
  }
  const current = server.db.participantRegistrations.getAttemptByRegistrationId(
    registration.registrationId
  )
  if (current === null) {
    return {
      ok: false,
      response: {
        status: 'pending',
        reason: 'participant_attempt_unavailable',
        detail: 'the registration has no durable attempt to attach to',
      },
    }
  }
  if (current.attemptId !== request.attemptId || current.attachEpoch !== request.attachEpoch) {
    return {
      ok: false,
      response: {
        status: 'rejected',
        reason: 'participant_attach_epoch_stale',
        detail: `attachment names attempt ${request.attemptId} epoch ${request.attachEpoch}; the current attempt is ${current.attemptId} epoch ${current.attachEpoch}`,
      },
    }
  }
  return { ok: true, registration, attempt: current }
}

export async function handleAttachParticipant(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    malformed('request body must be valid JSON')
  }
  const body = parseAttachParticipantRequest(rawBody)
  const located = locateAttachTarget(this, body)
  if (!located.ok) return json(located.response, located.response.status === 'rejected' ? 409 : 200)
  const { registration, attempt } = located

  if (body.kind === 'resume-unsupported') {
    // Persist the outcome, retain the selection, leave addressed input pending.
    // The participant is not attached and this does not pretend otherwise.
    this.db.participantRegistrations.recordResumeOutcome({
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      resumeState: 'unsupported',
      reason: body.reason,
      updatedAt: timestamp(),
    })
    return json({
      status: 'pending',
      reason: 'participant_resume_unsupported',
      detail: `the driver reported that it cannot resume native state (${body.reason}); the selected continuation is retained and addressed work stays pending`,
    } satisfies AttachParticipantResponse)
  }

  // R7.3's profile/selection agreement, checked BEFORE the profile is frozen.
  // Recomputing hashes to make a mismatched profile fit would conceal a
  // different start request, so the mismatch is refused instead.
  const selection = attempt.continuation
  const carried = selection?.carried === true
  const supplied = profileContinuation(body.profile)
  if (!carried && supplied !== undefined) {
    return json(
      {
        status: 'rejected',
        reason: 'participant_continuation_mismatch',
        detail:
          'HRC selected no continuation for this attempt, so the profile start request must not carry one',
      } satisfies AttachParticipantResponse,
      409
    )
  }
  if (carried) {
    const expected = selection?.selectedJson
    if (expected === undefined || serializedJson(supplied) !== expected) {
      return json(
        {
          status: 'rejected',
          reason: 'participant_continuation_mismatch',
          detail:
            'the profile start request does not express exactly the continuation HRC selected for this attempt',
        } satisfies AttachParticipantResponse,
        409
      )
    }
  }

  const preparationRequest = preparationRequestFor(registration, attempt)
  const validated = validateParticipantAdapterPreparation(preparationRequest, {
    status: 'prepared',
    profile: body.profile,
    ...(body.dispatchEnv === undefined ? {} : { dispatchEnv: body.dispatchEnv }),
  })
  if (!validated.ok) {
    // A failed validation changes neither preparation nor runnable state.
    return json(
      {
        status: 'rejected',
        reason: 'participant_profile_invalid',
        detail: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      } satisfies AttachParticipantResponse,
      409
    )
  }

  // A participant-served registration cannot be hosted without its endpoint.
  // R6.4 lets that endpoint arrive at registration or here, so this checks the
  // union of the two rather than the request alone, and refuses in a typed way
  // instead of failing deeper where the hosting intent is composed.
  if (
    registration.join === 'participant-served' &&
    registration.socketPath === undefined &&
    body.socketPath === undefined
  ) {
    return json(
      {
        status: 'rejected',
        reason: 'participant_serving_endpoint_missing',
        detail:
          'a participant-served registration needs its broker endpoint at registration or on this attachment',
      } satisfies AttachParticipantResponse,
      409
    )
  }

  const now = timestamp()
  const profileJson = serializedJson(body.profile)
  const dispatchEnvJson = serializedJson(body.dispatchEnv)
  const attached = this.db.sqlite.transaction(() => {
    const didAttach = this.db.participantRegistrations.attachPreparedProfile({
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      preparedProfileJson: profileJson,
      adapterDispatchEnvJson: dispatchEnvJson,
      ...(body.socketPath === undefined ? {} : { attachSocketPath: body.socketPath }),
      resumeState: carried ? 'requested' : 'not_requested',
      updatedAt: now,
    })
    if (!didAttach) return false
    if (body.socketPath !== undefined) {
      this.db.participantRegistrations.setServingSocketPathIfAbsent({
        registrationId: registration.registrationId,
        socketPath: body.socketPath,
        updatedAt: now,
      })
    }
    if (attempt.hostBindingId !== undefined) {
      this.db.participantHostBindings.transitionBinding({
        bindingId: attempt.hostBindingId,
        from: ['BINDING', 'DETACHED'],
        to: 'BOUND',
        now,
      })
    }
    return true
  })()

  let persisted = this.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (!attached) {
    // Zero rows changed means the attempt was already prepared. A retry that
    // carries the same bytes converges; different bytes are a replacement
    // request, which is not something an attachment may perform in place.
    if (persisted?.preparedProfileJson === profileJson) {
      return json({
        status: 'attached',
        registrationId: registration.registrationId,
        attemptId: attempt.attemptId,
        attachEpoch: attempt.attachEpoch,
        prepared: false,
        observation: {
          state: 'attached',
          detail: 'an identical attachment was already durable for this attempt',
        },
      } satisfies AttachParticipantResponse)
    }
    return json(
      {
        status: 'rejected',
        reason: 'participant_attach_conflict',
        detail:
          'this attempt already froze a different profile; changing a bridge after activation is a replacement operation, not an attachment',
      } satisfies AttachParticipantResponse,
      409
    )
  }

  // The same hosting-intent step the key-scoped path takes, for the same
  // reason: the establishment worker refuses an attempt without one, so an
  // attachment that skipped it would arm work that could only exhaust.
  if (persisted !== null) {
    const current =
      this.db.participantRegistrations.getRegistrationById(registration.registrationId) ??
      registration
    // A hosting-intent failure is a delivery-configuration problem, not a
    // reason to 500: the profile is already durable, so the truthful answer is
    // that the participant is attached-but-not-yet-hostable and its work waits.
    const withIntent = await persistHostingIntentIfRequired(this, current, persisted).catch(
      () => null
    )
    if (withIntent === null) {
      return json(
        {
          status: 'pending',
          reason: 'participant_hosting_intent_unavailable',
          detail:
            'the attached profile is durable but HRC could not persist its hosting intent; addressed work stays pending',
        } satisfies AttachParticipantResponse,
        200
      )
    }
    persisted = withIntent
    scheduleParticipantEstablishment(this, registration, persisted)
  }
  return json({
    status: 'attached',
    registrationId: registration.registrationId,
    attemptId: attempt.attemptId,
    attachEpoch: attempt.attachEpoch,
    prepared: true,
    observation: {
      state: 'attached',
      detail: 'the participant profile is durable and its establishment work is armed',
    },
  } satisfies AttachParticipantResponse)
}

export const participantAttachHandlersMethods = {
  handleAttachParticipant,
}

export type ParticipantAttachHandlersMethods = typeof participantAttachHandlersMethods
