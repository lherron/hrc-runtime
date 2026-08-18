import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'

import { establishExternalRegistrationPlacement } from './federation/summon-gate-server.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

const DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_MS = 1_000
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

export async function reconcileExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string
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
      placementEpoch: result.binding.placementEpoch,
    })
    writeServerLog('INFO', 'external_registration.collective_establishment.canonical', {
      registrationId,
      scopeRef: grant.derivedScope,
      homeNodeId: result.binding.homeNodeId,
      placementEpoch: result.binding.placementEpoch,
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
      ...(result.binding === undefined ? {} : { placementEpoch: result.binding.placementEpoch }),
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
  }
  // Retries with an unchanged cause must not rewrite the runtime row or re-log:
  // a permanently unresolvable placement would otherwise emit one DB write and
  // one WARN per retry tick, indefinitely.
  if (!pendingProjectionCurrent(mintedRuntime.runtimeStateJson, pendingProjection)) {
    projectCollectiveEstablishment(server, grant, pendingProjection)
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

async function runExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string
): Promise<void> {
  const retryMs =
    server.options.externalParticipantCollectiveEstablishmentRetryMs ??
    DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_MS
  let delayMs = retryMs
  while (!server.stopping) {
    const outcome = await reconcileExternalRegistrationCollectiveEstablishment(
      server,
      registrationId
    ).catch((error: unknown) => {
      writeServerLog('WARN', 'external_registration.collective_establishment.retry', {
        registrationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return 'pending' as const
    })
    if (outcome !== 'pending') return
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
  if (server.externalRegistrationEstablishmentOperations.has(registrationId)) return
  const operation = runExternalRegistrationCollectiveEstablishment(server, registrationId).finally(
    () => server.externalRegistrationEstablishmentOperations.delete(registrationId)
  )
  server.externalRegistrationEstablishmentOperations.set(registrationId, operation)
}
