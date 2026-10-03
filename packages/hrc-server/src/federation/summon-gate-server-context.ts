/**
 * Gate-context wiring for the summon gate server (T-06608).
 *
 * The server context shape and the lazy, memoized construction of the gate
 * dependencies from live daemon state. Split out of `summon-gate-server.ts`.
 */

import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { FederationConfig } from './federation-config.js'
import {
  type ResolvePlacementPolicyOptions,
  createPlacementPolicyResolver,
} from './placement-policy.js'
import type { BindingRegistryClient } from './registry-client.js'
import { resolveFederationRegistryClient } from './registry-resolution.js'
import { createSummonCapabilityObserver } from './summon-capability.js'
import type {
  SummonCapabilityHint,
  SummonCapabilityObservation,
  SummonGateDeps,
  SummonGatePolicy,
} from './summon-gate.js'

export type SummonGateServerContext = {
  readonly db: HrcDatabase
  /**
   * The live daemon carries its resolved federation config on `options`
   * (index.ts threads it in at startup). Tests may pass it at the top level.
   */
  readonly options?:
    | {
        readonly federationConfig?: FederationConfig | undefined
        readonly localPersonaAllowlist?: readonly string[] | undefined
      }
    | undefined
  readonly federationConfig?: FederationConfig | undefined
  /** Injected by tests; production builds one from the federation config. */
  readonly registryClient?: BindingRegistryClient | undefined
  /** Production local-authority client owned by the registry endpoint. */
  readonly bindingRegistryEndpoint?: { readonly registryClient: BindingRegistryClient } | undefined
  readonly policyFor?: ((scopeRef: string) => Promise<SummonGatePolicy | undefined>) | undefined
  /** Narrows real-profile discovery in tests without mutating process.env. */
  readonly placementPolicyOptions?: ResolvePlacementPolicyOptions | undefined
  /** Injected by tests; production observes the node's real filesystem/env. */
  readonly capabilityFor?:
    | ((
        scopeRef: string,
        hint?: SummonCapabilityHint | undefined
      ) => Promise<SummonCapabilityObservation>)
    | undefined
}

const gateDepsCache = new WeakMap<object, SummonGateDeps | undefined>()

function buildGateDeps(server: SummonGateServerContext): SummonGateDeps | undefined {
  const config = server.federationConfig ?? server.options?.federationConfig
  if (config === undefined || !config.sourceExists) return undefined
  if (config.gate.mode === 'off') return undefined

  const ledger = createPlacementLedgerRepository(server.db.sqlite)
  return {
    mode: config.gate.mode,
    federationConfigured: true,
    localNodeId: config.nodeId,
    // T-07398: the registry a `node=` directive is validated against — this
    // node plus its configured peers. Built from the SAME config the receiver
    // reads, which is what makes origin and receiver validation independent
    // rather than one trusting the other.
    knownNodeIds: [config.nodeId, ...[...config.peers.values()].map((peer) => peer.nodeId)],
    ledger,
    registry:
      server.registryClient ??
      resolveFederationRegistryClient(config, server.bindingRegistryEndpoint?.registryClient),
    // Locate and the gate deliberately share this one profile reader. The
    // closure is cheap to construct here; actual profile discovery/read stays
    // lazy until a configured, non-dark gate reaches the virgin-policy branch.
    policyFor: server.policyFor ?? createPlacementPolicyResolver(server.placementPolicyOptions),
    capabilityFor: server.capabilityFor ?? createSummonCapabilityObserver(),
    log: writeServerLog,
  }
}

export function gateDepsFor(server: SummonGateServerContext): SummonGateDeps | undefined {
  const cached = gateDepsCache.get(server as object)
  if (cached !== undefined || gateDepsCache.has(server as object)) return cached
  const deps = buildGateDeps(server)
  gateDepsCache.set(server as object, deps)
  return deps
}
