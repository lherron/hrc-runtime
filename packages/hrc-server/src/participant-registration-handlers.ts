import { isAbsolute } from 'node:path'

import { HrcBadRequestError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import { type JsonValue, validateParticipantAdapterAdmission } from 'spaces-runtime-contracts'

import { isParticipantRegistrationClass } from './registration-classes-config.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { json } from './server-util.js'

/** The callback contract in T-08344 C.2; adapter-owned fields remain opaque. */
export type RegisterParticipantRequest = {
  classId: string
  processToken: string
  evidence?: JsonValue
  socketPath?: string
  participantKey?: string
}

export type RegisterParticipantResponse = {
  status: 'pending' | 'rejected'
  reason: string
  detail: string
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

export function parseRegisterParticipantRequest(input: unknown): RegisterParticipantRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    malformed('request body must be an object')
  }
  const body = input as Record<string, unknown>
  const allowed = new Set(['classId', 'processToken', 'evidence', 'socketPath', 'participantKey'])
  const unsupported = Object.keys(body).find((field) => !allowed.has(field))
  if (unsupported !== undefined) {
    malformed(`unsupported participant registration field "${unsupported}"`, unsupported)
  }
  const classId = requiredNonEmptyString(body['classId'], 'classId')
  const processToken = requiredNonEmptyString(body['processToken'], 'processToken')
  const evidence = body['evidence']
  if (evidence !== undefined && !isJsonValue(evidence)) {
    malformed('evidence must be JSON-serializable when provided', 'evidence')
  }
  const participantKey = body['participantKey']
  if (
    participantKey !== undefined &&
    (typeof participantKey !== 'string' || participantKey.trim().length === 0)
  ) {
    malformed('participantKey must be a non-empty string when provided', 'participantKey')
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
  return {
    classId,
    processToken,
    ...(evidence === undefined ? {} : { evidence }),
    ...(socketPath === undefined ? {} : { socketPath: socketPath.trim() }),
    ...(participantKey === undefined ? {} : { participantKey: participantKey.trim() }),
  }
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
  if (registrationClass.join === 'hrc-hosted' && body.socketPath !== undefined) {
    malformed('socketPath is forbidden for an hrc-hosted participant', 'socketPath')
  }
  if (registrationClass.join === 'participant-served' && body.socketPath === undefined) {
    malformed('socketPath is required for a participant-served participant', 'socketPath')
  }

  const adapter = this.options.participantAdapterRegistry?.get(registrationClass.adapterId)
  if (adapter === undefined) {
    // createHrcServer rejects this composition error. Retain a truthful local
    // refusal for embedded instances that did not pass through construction.
    return json({
      status: 'pending',
      reason: 'participant_adapter_unavailable',
      detail: `configured participant adapter "${registrationClass.adapterId}" is unavailable`,
    } satisfies RegisterParticipantResponse)
  }

  const admission = validateParticipantAdapterAdmission(
    await adapter.admit({
      classId: registrationClass.classId,
      join: registrationClass.join,
      ...(body.participantKey === undefined ? {} : { participantKey: body.participantKey }),
      ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
    })
  )
  if (!admission.ok) {
    return json({
      status: 'pending',
      reason: 'participant_adapter_admission_invalid',
      detail: admission.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    } satisfies RegisterParticipantResponse)
  }
  if (admission.value.status !== 'admitted') {
    return json({
      status: admission.value.status,
      reason: admission.value.reason,
      detail: `participant adapter ${admission.value.status} registration admission`,
    } satisfies RegisterParticipantResponse)
  }

  // T-08346 owns broker.installIdentity / broker.ensureInvocation. Until the
  // generic lifecycle transaction allocates/persists the admitted address and
  // preparation, no registration row or lifecycle effect is created: returning
  // a retryable pending result cannot manufacture recovery or activation.
  return json({
    status: 'pending',
    reason: 'participant_activation_unavailable',
    detail: 'generic participant admission is available; activation effects are not yet wired',
  } satisfies RegisterParticipantResponse)
}

export const participantRegistrationHandlersMethods = {
  handleRegisterParticipant,
}

export type ParticipantRegistrationHandlersMethods = typeof participantRegistrationHandlersMethods
