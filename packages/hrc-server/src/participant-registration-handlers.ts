import { isAbsolute } from 'node:path'

import { validateScopeRef } from 'agent-scope'
import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { JsonValue, ParticipantBrokerDescriptor } from 'spaces-runtime-contracts'

import { parseParticipantBrokerDescriptor } from './participant-broker-descriptor.js'
import { scheduleParticipantEstablishment } from './participant-establishment.js'
import {
  type DirectJoinRequest,
  registerDirectParticipant,
} from './participant-host-registration.js'
import { createParticipantHostingIntent } from './participant-hosting-intent.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { json, timestamp } from './server-util.js'

/** R6.2's direct request: the participant's own declaration of its address. */
export type DirectRegisterParticipantRequest = { mode: 'direct' } & DirectJoinRequest

export type RegisterParticipantRequest = DirectRegisterParticipantRequest

export type RegisterParticipantResponse =
  | {
      status: 'registered'
      scopeRef: string
      hostSessionId: string
      generation: number
      created: boolean
      resumed: boolean
      /**
       * `attachment_pending` is the honest answer for a participant whose
       * address exists and whose execution profile does not: `registered`
       * means the address exists, never that input was delivered or a model
       * ran (R6.4).
       */
      observation: { state: 'attachment_pending' | 'attached'; detail: string }
      /** Everything needed to compose an attachment. */
      identity: {
        registrationId: string
        laneRef: string
        runtimeId: string
        attemptId: string
        invocationId: string
        attachEpoch: number
        requestId: string
        operationId: string
      }
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

  // The key-scoped request shape that predated protocol join is gone; every
  // participant declares its own address.
  if (body['registrationMode'] !== 'direct') {
    malformed('registrationMode must be "direct"', 'registrationMode')
  }
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
    if (!Number.isInteger(predecessor['generation']) || (predecessor['generation'] as number) < 1) {
      malformed('expectedPredecessor.generation must be a positive integer', 'expectedPredecessor')
    }
    expectedPredecessor = {
      hostIncarnationId: requiredNonEmptyString(
        predecessor['hostIncarnationId'],
        'expectedPredecessor.hostIncarnationId'
      ),
      runtimeId: requiredNonEmptyString(predecessor['runtimeId'], 'expectedPredecessor.runtimeId'),
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
  const response = await handleDirectRegistration(this, parseRegisterParticipantRequest(rawBody))
  if (rawBody !== null && typeof rawBody === 'object' && Object.hasOwn(rawBody, 'metadata')) {
    const result = (await response.clone().json()) as {
      status: string
      scopeRef?: string
      identity?: { laneRef: string; registrationId: string }
    }
    if (result.status === 'registered' && result.scopeRef && result.identity) {
      const written = this.db.sessionMetadata.write({
        scopeRef: result.scopeRef,
        laneRef: result.identity.laneRef,
        source: 'launch',
        replace: true,
        set: (rawBody as Record<string, unknown>)['metadata'],
        updatedBy: result.identity.registrationId,
      })
      return json({ ...result, rejectedMetadata: written.rejected }, response.status)
    }
  }
  return response
}

export const participantRegistrationHandlersMethods = {
  handleRegisterParticipant,
}

export type ParticipantRegistrationHandlersMethods = typeof participantRegistrationHandlersMethods
