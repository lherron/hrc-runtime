import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'

import { establishExternalRegistrationPlacement } from './federation/summon-gate-server.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

const DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_MS = 1_000
const DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_BUDGET = 12
const COLLECTIVE_ESTABLISHMENT_MAX_RETRY_MS = 60_000
// A registration whose minted runtime reached one of these states can never
// establish; its participant is gone and only a fresh registration revives it.
const ABANDONED_RUNTIME_STATUSES: ReadonlySet<string> = new Set(['terminated', 'disposed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertMinted(
  grant: ExternalRegistrationGrant
): asserts grant is ExternalRegistrationGrant & {
  runtimeId: string
} {
  if (!grant.consumed || grant.runtimeId === undefined) {
    throw new Error(`registration ${grant.registrationId} has no durable minted identity`)
  }
}

function projectCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant & { runtimeId: string },
  projection: Record<string, unknown>
): void {
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null) throw new Error(`external runtime ${grant.runtimeId} is missing`)
  const external = runtime.runtimeStateJson?.['externalRegistration']
  const externalRegistration = isRecord(external) ? { ...external } : {}
  const now = timestamp()
  server.db.runtimes.update(grant.runtimeId, {
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      externalRegistration: {
        ...externalRegistration,
        collectiveEstablishment: { ...projection, updatedAt: now },
      },
      updatedAt: now,
    },
    updatedAt: now,
  })
}

function collectiveEstablishmentProjection(
  runtimeStateJson: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const external = runtimeStateJson?.['externalRegistration']
  if (!isRecord(external)) return undefined
  const collective = external['collectiveEstablishment']
  return isRecord(collective) ? collective : undefined
}

type CollectiveEstablishmentAttempt = {
  attemptCount: number
  attemptBudget: number
}

export async function reconcileExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string,
  attempt?: CollectiveEstablishmentAttempt
): Promise<'pending' | 'canonical' | 'noncanonical' | 'abandoned'> {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) throw new Error(`registration ${registrationId} is unknown`)
  assertMinted(grant)
  const mintedRuntime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (
    grant.retiredAt !== undefined ||
    mintedRuntime === null ||
    ABANDONED_RUNTIME_STATUSES.has(mintedRuntime.status)
  ) {
    writeServerLog('INFO', 'external_registration.collective_establishment.abandoned', {
      registrationId,
      scopeRef: grant.derivedScope,
      ...(grant.retiredAt === undefined ? {} : { retiredAt: grant.retiredAt }),
      runtimeId: grant.runtimeId,
      runtimeStatus: mintedRuntime?.status ?? 'missing',
    })
    return 'abandoned'
  }
  const result = await establishExternalRegistrationPlacement(server, {
    scopeRef: grant.derivedScope,
    registrationId: grant.registrationId,
    classId: grant.classId,
  })
  if (result.outcome === 'canonical') {
    projectCollectiveEstablishment(server, grant, {
      state: 'CANONICAL',
      bindingState: 'BOUND',
      homeNodeId: result.binding.homeNodeId,
    })
    writeServerLog('INFO', 'external_registration.collective_establishment.canonical', {
      registrationId,
      scopeRef: grant.derivedScope,
      homeNodeId: result.binding.homeNodeId,
    })
    return 'canonical'
  }
  if (result.outcome === 'noncanonical') {
    projectCollectiveEstablishment(server, grant, {
      state: 'NONCANONICAL',
      bindingState: result.binding === undefined ? 'UNBOUND' : 'BOUND',
      cause: result.cause,
      detail: result.detail,
      ...(result.homeNodeId === undefined ? {} : { homeNodeId: result.homeNodeId }),
    })
    writeServerLog('WARN', 'external_registration.collective_establishment.noncanonical', {
      registrationId,
      scopeRef: grant.derivedScope,
      cause: result.cause,
      detail: result.detail,
      ...(result.homeNodeId === undefined ? {} : { homeNodeId: result.homeNodeId }),
    })
    return 'noncanonical'
  }
  const pendingProjection = {
    state: 'PENDING',
    bindingState: 'UNBOUND',
    retryable: true,
    reason: result.reason,
    detail: result.detail,
    ...(attempt === undefined ? {} : attempt),
  }
  // Scheduled retries persist their monotonic attempt count, but an unchanged
  // cause must not re-log. Direct reconciliation without an attempt remains a
  // no-op when the projection is already current.
  const pendingCauseChanged = !pendingCauseCurrent(
    mintedRuntime.runtimeStateJson,
    pendingProjection
  )
  if (!pendingProjectionCurrent(mintedRuntime.runtimeStateJson, pendingProjection)) {
    projectCollectiveEstablishment(server, grant, pendingProjection)
  }
  if (pendingCauseChanged) {
    writeServerLog('WARN', 'external_registration.collective_establishment.pending', {
      registrationId,
      scopeRef: grant.derivedScope,
      reason: result.reason,
      detail: result.detail,
    })
  }
  return 'pending'
}

function pendingProjectionCurrent(
  runtimeStateJson: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>
): boolean {
  const external = runtimeStateJson?.['externalRegistration']
  if (!isRecord(external)) return false
  const current = external['collectiveEstablishment']
  if (!isRecord(current)) return false
  return Object.entries(next).every(([key, value]) => current[key] === value)
}

function pendingCauseCurrent(
  runtimeStateJson: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>
): boolean {
  const current = collectiveEstablishmentProjection(runtimeStateJson)
  return (
    current?.['state'] === 'PENDING' &&
    current['reason'] === next['reason'] &&
    current['detail'] === next['detail']
  )
}

function retryBudget(server: HrcServerInstanceForHandlers): number {
  const configured = server.options.externalParticipantCollectiveEstablishmentRetryBudget
  return configured === undefined || !Number.isFinite(configured)
    ? DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_BUDGET
    : Math.max(1, Math.floor(configured))
}

function durableAttemptCount(server: HrcServerInstanceForHandlers, registrationId: string): number {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant?.runtimeId === undefined) return 0
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  const value = collectiveEstablishmentProjection(runtime?.runtimeStateJson)?.['attemptCount']
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function projectFailedAttempt(
  server: HrcServerInstanceForHandlers,
  registrationId: string,
  detail: string,
  attempt: CollectiveEstablishmentAttempt
): void {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) throw new Error(`registration ${registrationId} is unknown`)
  assertMinted(grant)
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  const projection = {
    state: 'PENDING',
    bindingState: 'UNBOUND',
    retryable: true,
    reason: 'establishment-error',
    detail,
    ...attempt,
  }
  const causeChanged = !pendingCauseCurrent(runtime?.runtimeStateJson, projection)
  projectCollectiveEstablishment(server, grant, projection)
  if (causeChanged) {
    writeServerLog('WARN', 'external_registration.collective_establishment.retry', {
      registrationId,
      error: detail,
    })
  }
}

function quarantineExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string,
  attempt: CollectiveEstablishmentAttempt
): void {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) throw new Error(`registration ${registrationId} is unknown`)
  assertMinted(grant)
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  const current = collectiveEstablishmentProjection(runtime?.runtimeStateJson)
  const quarantinedAt = timestamp()
  projectCollectiveEstablishment(server, grant, {
    state: 'QUARANTINED',
    bindingState: 'UNBOUND',
    retryable: false,
    reason: current?.['reason'] ?? 'establishment-pending',
    detail: current?.['detail'] ?? 'collective establishment retry budget exhausted',
    ...attempt,
    quarantinedAt,
  })
  writeServerLog('WARN', 'external_registration.collective_establishment.quarantined', {
    registrationId,
    scopeRef: grant.derivedScope,
    ...attempt,
    quarantinedAt,
  })
}

function registrationIsQuarantined(
  server: HrcServerInstanceForHandlers,
  registrationId: string
): boolean {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant?.runtimeId === undefined) return false
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  return collectiveEstablishmentProjection(runtime?.runtimeStateJson)?.['state'] === 'QUARANTINED'
}

async function runExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string
): Promise<void> {
  const retryMs =
    server.options.externalParticipantCollectiveEstablishmentRetryMs ??
    DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_MS
  const attemptBudget = retryBudget(server)
  let attemptCount = durableAttemptCount(server, registrationId)
  if (attemptCount >= attemptBudget) {
    quarantineExternalRegistrationCollectiveEstablishment(server, registrationId, {
      attemptCount,
      attemptBudget,
    })
    return
  }
  let delayMs = retryMs
  while (!server.stopping && attemptCount < attemptBudget) {
    const attempt = { attemptCount: attemptCount + 1, attemptBudget }
    const outcome = await reconcileExternalRegistrationCollectiveEstablishment(
      server,
      registrationId,
      attempt
    ).catch((error: unknown) => {
      projectFailedAttempt(
        server,
        registrationId,
        error instanceof Error ? error.message : String(error),
        attempt
      )
      return 'pending' as const
    })
    if (outcome !== 'pending') return
    attemptCount = attempt.attemptCount
    if (attemptCount >= attemptBudget) {
      quarantineExternalRegistrationCollectiveEstablishment(server, registrationId, attempt)
      return
    }
    await Bun.sleep(delayMs)
    delayMs = Math.min(delayMs * 2, Math.max(retryMs, COLLECTIVE_ESTABLISHMENT_MAX_RETRY_MS))
  }
}

export function scheduleExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string
): void {
  const config = server.options.federationConfig
  if (config === undefined || !config.sourceExists || config.gate.mode === 'off') return
  if (registrationIsQuarantined(server, registrationId)) return
  if (server.externalRegistrationEstablishmentOperations.has(registrationId)) return
  const operation = runExternalRegistrationCollectiveEstablishment(server, registrationId).finally(
    () => server.externalRegistrationEstablishmentOperations.delete(registrationId)
  )
  server.externalRegistrationEstablishmentOperations.set(registrationId, operation)
}
