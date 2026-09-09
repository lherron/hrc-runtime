import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { buildScopeRef, parseScopeRef } from 'agent-scope'
import { HrcBadRequestError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import {
  type JsonValue,
  type ParticipantAdapterPreparationRequest,
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
} from 'spaces-runtime-contracts'

import { isParticipantRegistrationClass } from './registration-classes-config.js'
import { withScopeClaimMutex } from './scope-claim-core.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { createHostSessionId, json, timestamp } from './server-util.js'

/** The callback contract in T-08344 C.2; adapter-owned fields remain opaque. */
export type RegisterParticipantRequest = {
  classId: string
  processToken: string
  evidence?: JsonValue
  socketPath?: string
  participantKey?: string
}

export type RegisterParticipantResponse =
  | {
      status: 'registered'
      scopeRef: string
      hostSessionId: string
      generation: number
      created: boolean
      resumed: false
      observation: { state: 'prepared'; detail: string }
    }
  | {
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

function serializedJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? 'null'
}

function registeredResponse(
  registration: ParticipantRegistration,
  created: boolean
): RegisterParticipantResponse {
  return {
    status: 'registered',
    scopeRef: registration.scopeRef,
    hostSessionId: registration.hostSessionId,
    generation: registration.generation,
    created,
    resumed: false,
    observation: {
      state: 'prepared',
      detail: 'participant registration and immutable adapter preparation are durable',
    },
  }
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
  const admitted = admission.value
  if (admitted.status !== 'admitted') {
    return json({
      status: admitted.status,
      reason: admitted.reason,
      detail: `participant adapter ${admitted.status} registration admission`,
    } satisfies RegisterParticipantResponse)
  }

  const result = await withScopeClaimMutex(
    this,
    `roster:${registrationClass.scopeTemplate.agent}:${registrationClass.scopeTemplate.project}`,
    async (): Promise<RegisterParticipantResponse> => {
      let registration = this.db.participantRegistrations.getRegistrationByClassAndKey(
        registrationClass.classId,
        admitted.participantKey
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
          participantKey: admitted.participantKey,
          scopeRef,
          laneRef: 'main',
          hostSessionId,
          generation: 1,
          workspaceCwd: admitted.workspaceCwd,
          preparationJson: serializedJson(admitted.preparation),
          ...(admitted.continuityEvidence === undefined
            ? {}
            : { continuityEvidenceJson: serializedJson(admitted.continuityEvidence) }),
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
          createdAt: now,
          updatedAt: now,
        }
        this.db.sqlite.transaction(() => {
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
        })()
        registration = newRegistration
        attempt = newAttempt
        created = true
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
      if (resolvedAttempt.preparedProfileJson !== undefined) {
        return registeredResponse(resolvedRegistration, created)
      }

      const preparationRequest = {
        classId: resolvedRegistration.classId,
        join: resolvedRegistration.join,
        participantKey: resolvedRegistration.participantKey,
        workspaceCwd: resolvedRegistration.workspaceCwd,
        preparation: JSON.parse(resolvedRegistration.preparationJson) as JsonValue,
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
        const didFreeze = this.db.participantRegistrations.freezePreparedBoundaryIfAbsent(
          resolvedAttempt.attemptId,
          serializedJson(preparedValue.profile),
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
        if (current?.preparedProfileJson !== undefined)
          return registeredResponse(resolvedRegistration, false)
        return {
          status: 'pending',
          reason: 'participant_preparation_race',
          detail: 'participant preparation could not be durably frozen',
        }
      }

      return registeredResponse(resolvedRegistration, created)
    }
  )
  return json(result)
}

export const participantRegistrationHandlersMethods = {
  handleRegisterParticipant,
}

export type ParticipantRegistrationHandlersMethods = typeof participantRegistrationHandlersMethods
