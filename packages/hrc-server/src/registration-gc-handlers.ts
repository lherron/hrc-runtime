import {
  HrcBadRequestError,
  HrcErrorCode,
  type ListRegistrationGcCandidatesResponse,
  type RegistrationGcCandidate,
  type RegistrationGcResult,
  type RetireRegistrationScopesRequest,
  type RetireRegistrationScopesResponse,
} from 'hrc-core'
import {
  type ExternalRegistrationGrant,
  createScopeRetirementRepository,
  readScopeRetirement,
} from 'hrc-store-sqlite'

import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS } from './external-registration-rendezvous.js'
import { withScopeAuthorityLock } from './federation/authority-lock.js'
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

function provenanceMatchesRegistration(provenance: unknown, registrationId: string): boolean {
  return (
    isRecord(provenance) &&
    provenance['kind'] === 'external-registration' &&
    provenance['registrationId'] === registrationId
  )
}

async function retireCandidate(
  server: HrcServerInstanceForHandlers,
  scopeRef: string
): Promise<RegistrationGcResult> {
  return await withScopeAuthorityLock(server as object, scopeRef, async () => {
    const grant = server.db.externalRegistrationGrants
      .listMinted()
      .find((candidate) => candidate.derivedScope === scopeRef)
    if (grant?.retirementReason === RETIREMENT_REASON) {
      return { scopeRef, registrationId: grant.registrationId, status: 'idempotent' }
    }
    const candidate = projectRegistrationGcCandidates(server).candidates.find(
      (entry) => entry.scopeRef === scopeRef
    )
    if (grant === undefined || candidate === undefined) {
      return { scopeRef, status: 'not_candidate' }
    }

    const registry = server.federationRegistryClient
    if (registry === undefined || registry.retire === undefined) {
      return {
        scopeRef,
        registrationId: grant.registrationId,
        status: 'authority_unavailable',
        detail: 'the federation binding registry retirement client is unavailable',
      }
    }

    try {
      const consulted = await registry.consult(scopeRef)
      if (consulted.outcome === 'retired') {
        const localNodeId = server.options.federationConfig?.nodeId
        if (
          localNodeId === undefined ||
          consulted.retirement.reason !== RETIREMENT_REASON ||
          consulted.retirement.retiredHomeNodeId !== localNodeId ||
          !provenanceMatchesRegistration(
            consulted.retirement.authorityProvenance,
            grant.registrationId
          )
        ) {
          return {
            scopeRef,
            registrationId: grant.registrationId,
            status: 'authority_conflict',
            detail: 'scope is already retired under different authority',
          }
        }
        const existingFence = readScopeRetirement(server.db.sqlite, scopeRef)
        if (
          existingFence !== undefined &&
          (existingFence.retiredNodeId !== localNodeId ||
            existingFence.retiredPlacementEpoch !== consulted.retirement.placementEpoch ||
            existingFence.successorNodeId !== null ||
            existingFence.reason !== RETIREMENT_REASON)
        ) {
          return {
            scopeRef,
            registrationId: grant.registrationId,
            status: 'authority_conflict',
            detail: 'scope has a conflicting node-local retirement fence',
          }
        }
        createScopeRetirementRepository(server.db.sqlite).retire({
          scopeRef,
          retiredNodeId: localNodeId,
          retiredPlacementEpoch: consulted.retirement.placementEpoch,
          successorNodeId: null,
          reason: RETIREMENT_REASON,
          retiredAt: consulted.retirement.retiredAt,
        })
        server.db.externalRegistrationGrants.markRetired(
          grant.registrationId,
          consulted.retirement.retiredAt
        )
        return { scopeRef, registrationId: grant.registrationId, status: 'idempotent' }
      }
      if (consulted.outcome === 'unbound') {
        return {
          scopeRef,
          registrationId: grant.registrationId,
          status: 'authority_conflict',
          detail: 'scope has no active registry binding to retire',
        }
      }
      const binding = consulted.binding
      const localNodeId = server.options.federationConfig?.nodeId
      if (
        localNodeId === undefined ||
        binding.homeNodeId !== localNodeId ||
        !provenanceMatchesRegistration(binding.authorityProvenance, grant.registrationId)
      ) {
        return {
          scopeRef,
          registrationId: grant.registrationId,
          status: 'authority_conflict',
          detail: `registry binding is not this registration's local authority`,
        }
      }

      const existingFence = readScopeRetirement(server.db.sqlite, scopeRef)
      const retiredAt = existingFence?.retiredAt ?? timestamp()
      if (
        existingFence !== undefined &&
        (existingFence.retiredNodeId !== localNodeId ||
          existingFence.retiredPlacementEpoch !== binding.placementEpoch ||
          existingFence.successorNodeId !== null ||
          existingFence.reason !== RETIREMENT_REASON)
      ) {
        return {
          scopeRef,
          registrationId: grant.registrationId,
          status: 'authority_conflict',
          detail: 'scope has a conflicting node-local retirement fence',
        }
      }
      createScopeRetirementRepository(server.db.sqlite).retire({
        scopeRef,
        retiredNodeId: localNodeId,
        retiredPlacementEpoch: binding.placementEpoch,
        successorNodeId: null,
        reason: RETIREMENT_REASON,
        retiredAt,
      })

      const retired = await registry.retire({
        scopeRef,
        expectedHomeNodeId: localNodeId,
        expectedPlacementEpoch: binding.placementEpoch,
        successorNodeId: null,
        reason: RETIREMENT_REASON,
        retiredAt,
      })
      if (retired.outcome !== 'retired' && retired.outcome !== 'idempotent') {
        return {
          scopeRef,
          registrationId: grant.registrationId,
          status: 'authority_conflict',
          detail: `registry retirement returned ${retired.outcome}`,
        }
      }
      server.db.externalRegistrationGrants.markRetired(grant.registrationId, retiredAt)
      writeServerLog('INFO', 'external_registration.gc.retired', {
        registrationId: grant.registrationId,
        scopeRef,
        homeNodeId: localNodeId,
        placementEpoch: binding.placementEpoch,
        retiredAt,
      })
      return {
        scopeRef,
        registrationId: grant.registrationId,
        status: retired.outcome === 'retired' ? 'retired' : 'idempotent',
      }
    } catch (error) {
      return {
        scopeRef,
        registrationId: grant.registrationId,
        status: 'authority_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })
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
