/**
 * Origin-side federation binding cache (spec §5).
 *
 * Values in this module are deliberately named and branded as routing hints.
 * They contain none of the birth/provenance/state fields used by the summon
 * gate, and learning one never writes the placement ledger. A hint can choose
 * where to forward an envelope; it can never authorize materialization.
 */

import { formatCanonicalScopeRef } from 'hrc-core'

export type FederationRoutingBinding = Readonly<{
  readonly purpose: 'routing-hint'
  readonly scopeRef: string
  readonly homeNodeId: string
  readonly placementEpoch: number
}>

export type FederationRoutingBindingInput = Readonly<{
  readonly scopeRef: string
  readonly homeNodeId: string
  readonly placementEpoch: number
}>

export type BindingCacheUpdateResult = Readonly<{
  readonly outcome: 'stored' | 'advanced' | 'unchanged' | 'ignored_stale'
  readonly current: FederationRoutingBinding
}>

export interface BindingHintCache {
  get(scopeRef: string, minimumPlacementEpoch?: number): FederationRoutingBinding | undefined
  learn(binding: FederationRoutingBindingInput): BindingCacheUpdateResult
}

export class BindingCacheConflictError extends Error {
  constructor(
    readonly scopeRef: string,
    readonly placementEpoch: number,
    readonly currentHomeNodeId: string,
    readonly attemptedHomeNodeId: string
  ) {
    super(
      `conflicting routing bindings for ${scopeRef} at placement epoch ${placementEpoch}: ` +
        `${currentHomeNodeId} vs ${attemptedHomeNodeId}`
    )
    this.name = 'BindingCacheConflictError'
  }
}

function requireEpoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

function normalizeBinding(input: FederationRoutingBindingInput): FederationRoutingBinding {
  const homeNodeId = input.homeNodeId.trim()
  if (homeNodeId.length === 0) throw new Error('homeNodeId must not be empty')
  return {
    purpose: 'routing-hint',
    scopeRef: formatCanonicalScopeRef({ scopeRef: input.scopeRef }),
    homeNodeId,
    placementEpoch: requireEpoch(input.placementEpoch, 'placementEpoch'),
  }
}

export class InMemoryBindingHintCache implements BindingHintCache {
  readonly #bindings = new Map<string, FederationRoutingBinding>()

  get(scopeRef: string, minimumPlacementEpoch = 1): FederationRoutingBinding | undefined {
    const canonical = formatCanonicalScopeRef({ scopeRef })
    const minimum = requireEpoch(minimumPlacementEpoch, 'minimumPlacementEpoch')
    const binding = this.#bindings.get(canonical)
    return binding !== undefined && binding.placementEpoch >= minimum ? binding : undefined
  }

  learn(input: FederationRoutingBindingInput): BindingCacheUpdateResult {
    const attempted = normalizeBinding(input)
    const current = this.#bindings.get(attempted.scopeRef)
    if (current === undefined) {
      this.#bindings.set(attempted.scopeRef, attempted)
      return { outcome: 'stored', current: attempted }
    }
    if (attempted.placementEpoch < current.placementEpoch) {
      return { outcome: 'ignored_stale', current }
    }
    if (attempted.placementEpoch === current.placementEpoch) {
      if (attempted.homeNodeId !== current.homeNodeId) {
        throw new BindingCacheConflictError(
          attempted.scopeRef,
          attempted.placementEpoch,
          current.homeNodeId,
          attempted.homeNodeId
        )
      }
      return { outcome: 'unchanged', current }
    }

    this.#bindings.set(attempted.scopeRef, attempted)
    return { outcome: 'advanced', current: attempted }
  }
}

/**
 * The narrow T-06619 integration seam. The accept client calls this only when
 * a receiver returns stale_placement with a redirect. Epoch monotonicity stays
 * inside the cache rather than being reimplemented at that call site.
 */
export type StalePlacementRedirectHandler = (
  scopeRef: string,
  newHomeNodeId: string,
  newPlacementEpoch: number
) => BindingCacheUpdateResult

export function createStalePlacementRedirectHandler(
  cache: BindingHintCache
): StalePlacementRedirectHandler {
  return (scopeRef, newHomeNodeId, newPlacementEpoch) =>
    cache.learn({
      scopeRef,
      homeNodeId: newHomeNodeId,
      placementEpoch: newPlacementEpoch,
    })
}
