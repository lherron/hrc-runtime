/** Exact origin routing resolution order from federation spec §5. */

import { formatCanonicalScopeRef } from 'hrc-core'

import type { BindingHintCache, FederationRoutingBinding } from './binding-cache.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryUnreachableError } from './registry-client.js'

type RoutingLedgerRecord = Readonly<{
  scopeRef: string
  homeNodeId: string
  placementEpoch: number
  state: 'active' | 'revoked'
}>

export type FederationRoutingLedger = {
  get(scopeRef: string): RoutingLedgerRecord | undefined
}

export type FederationRoutingBindingSource = 'local-ledger' | 'cache' | 'registry'

export type ResolvedFederationRoutingBinding = FederationRoutingBinding &
  Readonly<{ source: FederationRoutingBindingSource }>

export type ResolveFederationRoutingBindingOptions = {
  readonly scopeRef: string
  readonly minimumPlacementEpoch?: number | undefined
  readonly ledger: FederationRoutingLedger
  readonly cache: BindingHintCache
  readonly registry: Pick<BindingRegistryClient, 'consult'>
}

export type FederationRoutingResolutionErrorCode =
  | 'binding_unbound'
  | 'binding_epoch_stale'
  | 'registry_unreachable'

export class FederationRoutingResolutionError extends Error {
  readonly visible = true
  override readonly cause: unknown | undefined

  constructor(
    readonly code: FederationRoutingResolutionErrorCode,
    readonly scopeRef: string,
    readonly retryable: boolean,
    message: string,
    cause?: unknown
  ) {
    super(message)
    this.name = 'FederationRoutingResolutionError'
    this.cause = cause
  }
}

function requireMinimumEpoch(value: number | undefined): number {
  const epoch = value ?? 1
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error(`minimumPlacementEpoch must be a positive safe integer, got ${String(epoch)}`)
  }
  return epoch
}

function resolved(
  source: FederationRoutingBindingSource,
  binding: Pick<FederationRoutingBinding, 'scopeRef' | 'homeNodeId' | 'placementEpoch'>
): ResolvedFederationRoutingBinding {
  return { purpose: 'routing-hint', source, ...binding }
}

/**
 * Resolves one routing-only binding. The ordering is intentionally linear and
 * visible in the code: active local ledger, epoch-valid cache, registry, then
 * a typed visible/retryable failure for the delivery layer to queue.
 */
export async function resolveFederationRoutingBinding(
  options: ResolveFederationRoutingBindingOptions
): Promise<ResolvedFederationRoutingBinding> {
  const scopeRef = formatCanonicalScopeRef({ scopeRef: options.scopeRef })
  const minimumPlacementEpoch = requireMinimumEpoch(options.minimumPlacementEpoch)

  const local = options.ledger.get(scopeRef)
  if (local?.state === 'active' && local.placementEpoch >= minimumPlacementEpoch) {
    return resolved('local-ledger', {
      scopeRef,
      homeNodeId: local.homeNodeId,
      placementEpoch: local.placementEpoch,
    })
  }

  const cached = options.cache.get(scopeRef, minimumPlacementEpoch)
  if (cached !== undefined) return { ...cached, source: 'cache' }

  let consulted: Awaited<ReturnType<BindingRegistryClient['consult']>>
  try {
    consulted = await options.registry.consult(scopeRef)
  } catch (error) {
    if (error instanceof RegistryUnreachableError) {
      throw new FederationRoutingResolutionError(
        'registry_unreachable',
        scopeRef,
        true,
        `routing binding for ${scopeRef} is uncached and the federation registry is unreachable; delivery may be retried`,
        error
      )
    }
    throw error
  }

  if (consulted.outcome === 'unbound') {
    throw new FederationRoutingResolutionError(
      'binding_unbound',
      scopeRef,
      true,
      `no federation routing binding exists for ${scopeRef}; delivery may be retried`
    )
  }
  if (consulted.binding.placementEpoch < minimumPlacementEpoch) {
    throw new FederationRoutingResolutionError(
      'binding_epoch_stale',
      scopeRef,
      true,
      `registry binding for ${scopeRef} is at epoch ${consulted.binding.placementEpoch}, below required epoch ${minimumPlacementEpoch}; delivery may be retried`
    )
  }

  const learned = options.cache.learn(consulted.binding)
  return resolved('registry', learned.current)
}
