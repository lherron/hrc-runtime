/** Origin-side home-node routing hints. Hints never grant summon authority. */

import { formatCanonicalScopeRef } from 'hrc-core'

export type FederationRoutingBinding = Readonly<{
  readonly purpose: 'routing-hint'
  readonly scopeRef: string
  readonly homeNodeId: string
}>

export type FederationRoutingBindingInput = Readonly<{
  readonly scopeRef: string
  readonly homeNodeId: string
}>

export type BindingCacheUpdateResult = Readonly<{
  readonly outcome: 'stored' | 'replaced' | 'unchanged'
  readonly current: FederationRoutingBinding
}>

export interface BindingHintCache {
  get(scopeRef: string): FederationRoutingBinding | undefined
  learn(binding: FederationRoutingBindingInput): BindingCacheUpdateResult
  forget(scopeRef: string): boolean
}

function normalizeBinding(input: FederationRoutingBindingInput): FederationRoutingBinding {
  const homeNodeId = input.homeNodeId.trim()
  if (homeNodeId.length === 0) throw new Error('homeNodeId must not be empty')
  return {
    purpose: 'routing-hint',
    scopeRef: formatCanonicalScopeRef({ scopeRef: input.scopeRef }),
    homeNodeId,
  }
}

export class InMemoryBindingHintCache implements BindingHintCache {
  readonly #bindings = new Map<string, FederationRoutingBinding>()

  get(scopeRef: string): FederationRoutingBinding | undefined {
    return this.#bindings.get(formatCanonicalScopeRef({ scopeRef }))
  }

  learn(input: FederationRoutingBindingInput): BindingCacheUpdateResult {
    const attempted = normalizeBinding(input)
    const current = this.#bindings.get(attempted.scopeRef)
    if (current?.homeNodeId === attempted.homeNodeId) return { outcome: 'unchanged', current }
    this.#bindings.set(attempted.scopeRef, attempted)
    return { outcome: current === undefined ? 'stored' : 'replaced', current: attempted }
  }

  forget(scopeRef: string): boolean {
    return this.#bindings.delete(formatCanonicalScopeRef({ scopeRef }))
  }
}

export type StalePlacementRedirectHandler = (
  scopeRef: string,
  newHomeNodeId: string
) => BindingCacheUpdateResult

export function createStalePlacementRedirectHandler(
  cache: BindingHintCache
): StalePlacementRedirectHandler {
  return (scopeRef, newHomeNodeId) => cache.learn({ scopeRef, homeNodeId: newHomeNodeId })
}
