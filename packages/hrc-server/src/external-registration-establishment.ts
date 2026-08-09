import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'

import { establishExternalRegistrationPlacement } from './federation/summon-gate-server.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

const DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_MS = 1_000

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
): Promise<'pending' | 'canonical' | 'noncanonical'> {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) throw new Error(`registration ${registrationId} is unknown`)
  assertMinted(grant)
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
  projectCollectiveEstablishment(server, grant, {
    state: 'PENDING',
    bindingState: 'UNBOUND',
    retryable: true,
    reason: result.reason,
    detail: result.detail,
  })
  writeServerLog('WARN', 'external_registration.collective_establishment.pending', {
    registrationId,
    scopeRef: grant.derivedScope,
    reason: result.reason,
    detail: result.detail,
  })
  return 'pending'
}

async function runExternalRegistrationCollectiveEstablishment(
  server: HrcServerInstanceForHandlers,
  registrationId: string
): Promise<void> {
  const retryMs =
    server.options.externalParticipantCollectiveEstablishmentRetryMs ??
    DEFAULT_COLLECTIVE_ESTABLISHMENT_RETRY_MS
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
    await Bun.sleep(retryMs)
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
