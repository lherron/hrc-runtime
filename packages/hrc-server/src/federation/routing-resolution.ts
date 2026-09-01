/** Home-node-only routing resolution from federation v1.3 §5. */

import { formatCanonicalScopeRef } from 'hrc-core'

import type { BindingHintCache, FederationRoutingBinding } from './binding-cache.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryUnreachableError } from './registry-client.js'

type RoutingLedgerRecord = Readonly<{
  scopeRef: string
  homeNodeId: string
  state: 'active' | 'retired'
}>

export type FederationRoutingLedger = {
  get(scopeRef: string): RoutingLedgerRecord | undefined
}

export type FederationRoutingBindingSource = 'local-ledger' | 'cache' | 'registry'
export type ResolvedFederationRoutingBinding = FederationRoutingBinding &
  Readonly<{ source: FederationRoutingBindingSource }>

export type ResolveFederationRoutingBindingOptions = {
  readonly scopeRef: string
  readonly excludedHomeNodeId?: string | undefined
  readonly ledger: FederationRoutingLedger
  readonly cache: BindingHintCache
  readonly registry: Pick<BindingRegistryClient, 'consult'>
}

export type FederationRoutingResolutionErrorCode =
  | 'binding_unbound'
  | 'binding_retired'
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

function resolved(
  source: FederationRoutingBindingSource,
  binding: Pick<FederationRoutingBinding, 'scopeRef' | 'homeNodeId'>
): ResolvedFederationRoutingBinding {
  return { purpose: 'routing-hint', source, ...binding }
}

export async function resolveFederationRoutingBinding(
  options: ResolveFederationRoutingBindingOptions
): Promise<ResolvedFederationRoutingBinding> {
  const scopeRef = formatCanonicalScopeRef({ scopeRef: options.scopeRef })
  const local = options.ledger.get(scopeRef)
  if (local?.state === 'active' && local.homeNodeId !== options.excludedHomeNodeId) {
    return resolved('local-ledger', { scopeRef, homeNodeId: local.homeNodeId })
  }

  const cached = options.cache.get(scopeRef)
  if (cached !== undefined && cached.homeNodeId !== options.excludedHomeNodeId) {
    return { ...cached, source: 'cache' }
  }

  let consulted: Awaited<ReturnType<BindingRegistryClient['consult']>>
  try {
    consulted = await options.registry.consult(scopeRef)
  } catch (error) {
    if (error instanceof RegistryUnreachableError) {
      throw new FederationRoutingResolutionError(
        'registry_unreachable',
        scopeRef,
        true,
        `routing binding for ${scopeRef} is uncached and the federation registry is unreachable`,
        error
      )
    }
    throw error
  }
  if (consulted.outcome === 'unbound') {
    throw new FederationRoutingResolutionError(
      local?.state === 'retired' ? 'binding_retired' : 'binding_unbound',
      scopeRef,
      true,
      local?.state === 'retired'
        ? `${scopeRef} is retired on ${local.homeNodeId}; delivery is barred until fresh establishment elsewhere`
        : `no federation routing binding exists for ${scopeRef}`
    )
  }
  if (consulted.binding.homeNodeId === options.excludedHomeNodeId) {
    throw new FederationRoutingResolutionError(
      'binding_retired',
      scopeRef,
      true,
      `registry still names retired home ${consulted.binding.homeNodeId} for ${scopeRef}`
    )
  }
  const learned = options.cache.learn(consulted.binding)
  return resolved('registry', learned.current)
}
