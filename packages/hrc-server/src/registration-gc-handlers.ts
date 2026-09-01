import {
  HrcBadRequestError,
  HrcErrorCode,
  type ListRegistrationGcCandidatesResponse,
  type RegistrationGcCandidate,
  type RegistrationGcResult,
  type RetireRegistrationScopesRequest,
  type RetireRegistrationScopesResponse,
} from 'hrc-core'
import { type ExternalRegistrationGrant, createPlacementLedgerRepository } from 'hrc-store-sqlite'

import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS } from './external-registration-rendezvous.js'
import { retireFederationScope } from './federation/retirement.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'

const RETIREMENT_REASON = 'external_registration_gc' as const

function terminalExternalRegistrationCandidate(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  nowMs: number,
  lingerMs: number
): RegistrationGcCandidate | undefined {
  if (
    grant.retiredAt !== undefined ||
    grant.hostSessionId === undefined ||
    grant.runtimeId === undefined
  ) {
    return undefined
  }
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (
    runtime === null ||
    !isExternalLifecycleOwner(runtime) ||
    runtime.status === 'detached' ||
    (!isRuntimeUnavailableStatus(runtime.status) && runtime.status !== 'failed')
  ) {
    return undefined
  }
  const session = server.db.sessions.getByHostSessionId(grant.hostSessionId)
  if (runtime.continuation !== undefined || session?.continuation !== undefined) return undefined

  const state = runtime.runtimeStateJson?.['externalRegistration']
  const external = isRecord(state) ? state : undefined
  const finalizedAt = external?.['finalizedAt']
  const terminalAt =
    typeof finalizedAt === 'string' && Number.isFinite(Date.parse(finalizedAt))
      ? finalizedAt
      : (runtime.statusChangedAt ?? runtime.updatedAt)
  const terminalMs = Date.parse(terminalAt)
  if (!Number.isFinite(terminalMs)) return undefined
  const storedDeadline = external?.['lingerDeadlineAt']
  const storedDeadlineMs =
    typeof storedDeadline === 'string' ? Date.parse(storedDeadline) : Number.NaN
  const eligibleMs = Number.isFinite(storedDeadlineMs)
    ? Math.max(terminalMs, storedDeadlineMs)
    : terminalMs + lingerMs
  if (nowMs < eligibleMs) return undefined

  const projectedReason =
    runtime.lifecycleTerminalReason ?? runtime.runtimeStateJson?.['terminalReason']
  return {
    registrationId: grant.registrationId,
    classId: grant.classId,
    scopeRef: grant.derivedScope,
    hostSessionId: grant.hostSessionId,
    runtimeId: grant.runtimeId,
    runtimeStatus: runtime.status,
    terminalReason:
      typeof projectedReason === 'string' && projectedReason.length > 0
        ? projectedReason
        : 'terminal',
    terminalAt,
    eligibleAt: new Date(eligibleMs).toISOString(),
  }
}

export function projectRegistrationGcCandidates(
  server: HrcServerInstanceForHandlers,
  now = timestamp()
): ListRegistrationGcCandidatesResponse {
  const lingerMs =
    server.options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS
  const nowMs = Date.parse(now)
  const candidates = server.db.externalRegistrationGrants
    .listMinted()
    .map((grant) => terminalExternalRegistrationCandidate(server, grant, nowMs, lingerMs))
    .filter((candidate): candidate is RegistrationGcCandidate => candidate !== undefined)
    .sort((left, right) => left.scopeRef.localeCompare(right.scopeRef))
  return { generatedAt: now, lingerMs, candidates }
}

function parseRetirementRequest(value: unknown): RetireRegistrationScopesRequest {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'scopeRefs')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'registration GC retirement body must contain only scopeRefs'
    )
  }
  const scopeRefs = value['scopeRefs']
  if (
    !Array.isArray(scopeRefs) ||
    scopeRefs.length === 0 ||
    scopeRefs.some((scopeRef) => typeof scopeRef !== 'string' || scopeRef.trim().length === 0)
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'registration GC retirement requires at least one exact scopeRef'
    )
  }
  const normalized = scopeRefs.map((scopeRef) => String(scopeRef).trim())
  if (new Set(normalized).size !== normalized.length) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'registration GC retirement scopeRefs must be unique'
    )
  }
  return { scopeRefs: normalized }
}

async function retireCandidate(
  server: HrcServerInstanceForHandlers,
  scopeRef: string
): Promise<RegistrationGcResult> {
  const grant = server.db.externalRegistrationGrants
    .listMinted()
    .find((candidate) => candidate.derivedScope === scopeRef)
  if (grant?.retirementReason === RETIREMENT_REASON) {
    return { scopeRef, registrationId: grant.registrationId, status: 'idempotent' }
  }
  const candidate = projectRegistrationGcCandidates(server).candidates.find(
    (entry) => entry.scopeRef === scopeRef
  )
  if (grant === undefined || candidate === undefined) return { scopeRef, status: 'not_candidate' }
  const registry = server.federationRegistryClient
  const localNodeId = server.options.federationConfig?.nodeId
  if (registry === undefined || localNodeId === undefined) {
    return {
      scopeRef,
      registrationId: grant.registrationId,
      status: 'authority_unavailable',
      detail: 'federation retirement authority is unavailable',
    }
  }
  const retiredAt = timestamp()
  const result = await retireFederationScope(
    {
      owner: server as object,
      localNodeId,
      ledger: createPlacementLedgerRepository(server.db.sqlite),
      registry,
      liveRuntimeIds: () => [],
      log: writeServerLog,
      now: () => retiredAt,
    },
    { scopeRef, reason: RETIREMENT_REASON }
  )
  if (!result.ok) {
    return {
      scopeRef,
      registrationId: grant.registrationId,
      status:
        result.outcome === 'refused' || result.outcome === 'conflict'
          ? 'authority_conflict'
          : 'authority_unavailable',
      detail: result.detail,
    }
  }
  server.db.externalRegistrationGrants.markRetired(grant.registrationId, retiredAt)
  return {
    scopeRef,
    registrationId: grant.registrationId,
    status: result.outcome === 'idempotent' ? 'idempotent' : 'retired',
  }
}

export async function handleListRegistrationGcCandidates(
  this: HrcServerInstanceForHandlers
): Promise<Response> {
  return json(projectRegistrationGcCandidates(this))
}

export async function handleRetireRegistrationScopes(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const parsed = parseRetirementRequest(await parseJsonBody(request))
  const results: RegistrationGcResult[] = []
  for (const scopeRef of parsed.scopeRefs) results.push(await retireCandidate(this, scopeRef))
  const response: RetireRegistrationScopesResponse = {
    results,
    summary: {
      requested: results.length,
      retired: results.filter((result) => result.status === 'retired').length,
      idempotent: results.filter((result) => result.status === 'idempotent').length,
      skipped: results.filter((result) => result.status === 'not_candidate').length,
      errors: results.filter(
        (result) =>
          result.status === 'authority_conflict' || result.status === 'authority_unavailable'
      ).length,
    },
  }
  return json(response)
}

export const registrationGcHandlersMethods = {
  handleListRegistrationGcCandidates,
  handleRetireRegistrationScopes,
}

export type RegistrationGcHandlersMethods = typeof registrationGcHandlersMethods
