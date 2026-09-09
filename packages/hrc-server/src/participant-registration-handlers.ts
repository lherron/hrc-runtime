import { isAbsolute } from 'node:path'

import { HrcBadRequestError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'

import { isParticipantRegistrationClass } from './registration-classes-config.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { json } from './server-util.js'

/** The callback contract in T-08344 C.2; adapter-owned fields remain opaque. */
export type RegisterParticipantRequest = {
  classId: string
  processToken: string
  evidence?: unknown
  socketPath?: string
  participantKey?: string
}

export type RegisterParticipantResponse = {
  status: 'pending'
  reason: 'broker_bootstrap_unavailable'
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
    ...(body['evidence'] === undefined ? {} : { evidence: body['evidence'] }),
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

  // T-08346 owns broker.installIdentity / broker.ensureInvocation. Until the
  // published client contract is available, no registration row or lifecycle
  // effect is created: returning a retryable pending result is deliberately
  // non-mutating and cannot manufacture a successful recovery or activation.
  return json({
    status: 'pending',
    reason: 'broker_bootstrap_unavailable',
    detail: 'generic participant activation requires the broker bootstrap protocol',
  } satisfies RegisterParticipantResponse)
}

export const participantRegistrationHandlersMethods = {
  handleRegisterParticipant,
}

export type ParticipantRegistrationHandlersMethods = typeof participantRegistrationHandlersMethods
