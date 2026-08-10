import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { buildScopeRef } from 'agent-scope'
import { HrcBadRequestError, HrcConflictError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'

import { externalRegistrationPlacementAdvisory } from './federation/summon-gate-server.js'
import { MAX_EXTERNAL_REGISTRATION_TTL_SECONDS } from './registration-classes-config.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { json } from './server-util.js'

export type CreateExternalRegistrationRequest = {
  classId: string
  socketPath: string
  ttlSeconds?: number | undefined
  provisioner: Record<string, unknown>
}

export type CreateExternalRegistrationResponse = {
  registrationId: string
  derivedScope: string
  credential: string
  expiresAt: string
  placementAdvisory?: string | undefined
}

function malformed(message: string, field?: string): never {
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REGISTRATION,
    message,
    field === undefined ? {} : { field }
  )
}

function parseCreateExternalRegistrationRequest(input: unknown): CreateExternalRegistrationRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    malformed('request body must be an object')
  }
  const body = input as Record<string, unknown>
  const allowed = new Set(['classId', 'socketPath', 'ttlSeconds', 'provisioner'])
  const unsupported = Object.keys(body).find((field) => !allowed.has(field))
  if (unsupported !== undefined) {
    malformed(`unsupported registration field "${unsupported}"`, unsupported)
  }

  const rawClassId = body['classId']
  if (typeof rawClassId !== 'string' || rawClassId.trim().length === 0) {
    malformed('classId must be a non-empty string', 'classId')
  }
  const rawSocketPath = body['socketPath']
  if (
    typeof rawSocketPath !== 'string' ||
    rawSocketPath.trim().length === 0 ||
    rawSocketPath.includes('\0') ||
    !isAbsolute(rawSocketPath.trim())
  ) {
    malformed('socketPath must be an absolute unix socket path', 'socketPath')
  }
  const ttlSeconds = body['ttlSeconds']
  if (
    ttlSeconds !== undefined &&
    (!Number.isInteger(ttlSeconds) ||
      (ttlSeconds as number) < 1 ||
      (ttlSeconds as number) > MAX_EXTERNAL_REGISTRATION_TTL_SECONDS)
  ) {
    malformed(
      `ttlSeconds must be an integer from 1 through ${MAX_EXTERNAL_REGISTRATION_TTL_SECONDS}`,
      'ttlSeconds'
    )
  }
  const provisioner = body['provisioner']
  if (typeof provisioner !== 'object' || provisioner === null || Array.isArray(provisioner)) {
    malformed('provisioner must be a metadata object', 'provisioner')
  }

  return {
    classId: rawClassId.trim(),
    socketPath: rawSocketPath.trim(),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds: ttlSeconds as number }),
    provisioner: provisioner as Record<string, unknown>,
  }
}

export function hashRegistrationCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex')
}

export async function handleCreateExternalRegistration(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    malformed('request body must be valid JSON')
  }
  const body = parseCreateExternalRegistrationRequest(rawBody)
  const registrationClass = this.options.registrationClasses?.find(
    (candidate) => candidate.classId === body.classId
  )
  if (registrationClass === undefined) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_REGISTRATION_CLASS,
      `registration class "${body.classId}" is not configured`,
      { classId: body.classId }
    )
  }

  const createdAt = new Date()
  const ttlSeconds = body.ttlSeconds ?? registrationClass.defaultTtl
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1_000).toISOString()
  const registrationId = `registration-${randomUUID()}`
  const instanceId = `reg-${randomBytes(12).toString('hex')}`
  const derivedScope = buildScopeRef({
    agentId: registrationClass.scopeTemplate.agent,
    projectId: registrationClass.scopeTemplate.project,
    taskId: instanceId,
  })
  const credential = `epr_${randomBytes(32).toString('base64url')}`
  const grant: ExternalRegistrationGrant = {
    registrationId,
    classId: registrationClass.classId,
    derivedScope,
    socketPath: body.socketPath,
    credentialHash: hashRegistrationCredential(credential),
    expiresAt,
    consumed: false,
    turnsAllowed: registrationClass.turnsAllowed,
    provisioner: body.provisioner,
    createdAt: createdAt.toISOString(),
  }

  const issued = this.db.externalRegistrationGrants.issueWithinCapacity(
    grant,
    registrationClass.maxInstances,
    grant.createdAt
  )
  if (issued.outcome === 'instances-exhausted') {
    throw new HrcConflictError(
      HrcErrorCode.REGISTRATION_INSTANCES_EXHAUSTED,
      `registration class "${registrationClass.classId}" has no available instances`,
      {
        classId: registrationClass.classId,
        maxInstances: registrationClass.maxInstances,
        occupied: issued.occupied,
      }
    )
  }

  const placementAdvisory = await externalRegistrationPlacementAdvisory(this, derivedScope)

  // The credential must reach the provisioner before the participant can answer
  // hello. Schedule (rather than await) the daemon-owned dial; its retry loop
  // bridges response delivery and participant readiness without delaying grant
  // issuance or making registry availability part of local mint.
  queueMicrotask(() => this.scheduleExternalRegistrationRendezvous(registrationId))

  return json({
    registrationId,
    derivedScope,
    credential,
    expiresAt,
    ...(placementAdvisory === undefined ? {} : { placementAdvisory }),
  } satisfies CreateExternalRegistrationResponse)
}

export const registrationHandlersMethods = {
  handleCreateExternalRegistration,
}

export type RegistrationHandlersMethods = typeof registrationHandlersMethods
