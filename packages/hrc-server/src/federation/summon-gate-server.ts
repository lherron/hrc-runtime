/**
 * Server-side wiring for the summon gate (T-06608).
 *
 * The gate itself (`summon-gate.ts`) is a pure decision over injected
 * dependencies. This module is the one place that builds those dependencies
 * from live daemon state and the one call the five session-creation paths make,
 * so a path can never accidentally ask a differently-configured gate.
 *
 * Cost discipline: the gate context is built LAZILY and memoized. A daemon with
 * no federation config never constructs a ledger repository, never opens the
 * placement table, and never resolves placement policy — `assertSummonAuthority`
 * returns on its first branch. That is what "flag-gated" has to mean for a
 * change that sits on every session-creation path.
 */

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { FederationConfig } from './federation-config.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryUnreachableError, createBindingRegistryClient } from './registry-client.js'
import {
  type ProvisionalSummonIntent,
  type SummonGateDeps,
  type SummonGatePolicy,
  type SummonGateResult,
  type SummonPath,
  evaluateSummonGate,
} from './summon-gate.js'

/**
 * Fallback used when this node has no peer entry for the registry host.
 *
 * It fails CLOSED rather than returning `unbound`: an advisory daemon logs
 * exactly what it would have refused, and an enforce daemon refuses rather than
 * establishing a binding against a registry it cannot reach. A fallback that
 * answered `unbound` would mint authority on evidence it never had.
 */
export function createUnavailableRegistryClient(reason: string): BindingRegistryClient {
  return {
    async consult() {
      throw new RegistryUnreachableError(reason)
    },
    async establish() {
      throw new RegistryUnreachableError(reason)
    },
  }
}

/**
 * Picks the peer that hosts the binding registry.
 *
 * A node that hosts the registry itself still consults over HTTP here rather
 * than in-process: one code path, one set of semantics, and the registry host
 * is reachable from itself by construction. Optimizing that into a direct call
 * would create a second consult path with different failure modes.
 */
function resolveRegistryClient(config: FederationConfig): BindingRegistryClient {
  const peers = [...config.peers.values()]
  const solePeer = peers[0]
  if (solePeer === undefined) {
    return createUnavailableRegistryClient(
      `node "${config.nodeId}" declares no peers, so the binding registry cannot be consulted; add the registry host to "peers" in ${config.sourcePath}`
    )
  }

  const declared = config.gate.registryHost
  if (declared !== undefined) {
    const host = peers.find((peer) => peer.nodeId === declared)
    if (host === undefined) {
      return createUnavailableRegistryClient(
        `gate.registryHost is "${declared}" but no peer by that nodeId is declared in ${config.sourcePath}`
      )
    }
    return createBindingRegistryClient(host)
  }

  // Exactly one peer is unambiguous. More than one is not, and picking for the
  // operator would silently change answer the day a second peer is added.
  if (peers.length > 1) {
    return createUnavailableRegistryClient(
      `${config.sourcePath} declares ${peers.length} peers but no "gate.registryHost", so which node holds the binding registry is ambiguous. Fix: add "gate": {"registryHost": "<nodeId>"} naming the registry host.`
    )
  }
  return createBindingRegistryClient(solePeer)
}

export type SummonGateServerContext = {
  readonly db: HrcDatabase
  /**
   * The live daemon carries its resolved federation config on `options`
   * (index.ts threads it in at startup). Tests may pass it at the top level.
   */
  readonly options?: { readonly federationConfig?: FederationConfig | undefined } | undefined
  readonly federationConfig?: FederationConfig | undefined
  /** Injected by tests; production builds one from the federation config. */
  readonly registryClient?: BindingRegistryClient | undefined
  readonly policyFor?: ((scopeRef: string) => Promise<SummonGatePolicy | undefined>) | undefined
}

const gateDepsCache = new WeakMap<object, SummonGateDeps | undefined>()

function buildGateDeps(server: SummonGateServerContext): SummonGateDeps | undefined {
  const config = server.federationConfig ?? server.options?.federationConfig
  if (config === undefined || !config.sourceExists) return undefined
  if (config.gate.mode === 'off') return undefined

  return {
    mode: config.gate.mode,
    federationConfigured: true,
    localNodeId: config.nodeId,
    ledger: createPlacementLedgerRepository(server.db.sqlite),
    registry: server.registryClient ?? resolveRegistryClient(config),
    // Node-local, synchronous, and undefined before the table exists
    // (T-06614 C-11125 / larry #190). Checked before all authority logic.
    retirementFor: (scopeRef) => readScopeRetirement(server.db.sqlite, scopeRef),
    // Placement policy resolution is injected. Until the resolver is wired to
    // spaces-config on this path, treating policy as undeclared produces a
    // VISIBLE refusal naming the stanza line — never a silent local fallback.
    policyFor: server.policyFor ?? (async () => undefined),
    log: writeServerLog,
  }
}

function gateDepsFor(server: SummonGateServerContext): SummonGateDeps | undefined {
  const cached = gateDepsCache.get(server as object)
  if (cached !== undefined || gateDepsCache.has(server as object)) return cached
  const deps = buildGateDeps(server)
  gateDepsCache.set(server as object, deps)
  return deps
}

/**
 * Asks the gate whether this node may summon `scopeRef`, and enforces the
 * answer only when the flag says to.
 *
 * Advisory mode returns normally after logging the would-be refusal — the
 * caller proceeds exactly as it did before this task existed.
 */
export async function assertSummonAuthority(
  server: SummonGateServerContext,
  request: { scopeRef: string; path: SummonPath; intent: ProvisionalSummonIntent }
): Promise<SummonGateResult | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const result = await evaluateSummonGate({
    scopeRef: request.scopeRef,
    path: request.path,
    intent: request.intent,
    deps,
  })

  if (result.enforced && result.evaluation.decision === 'refuse') {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, result.evaluation.diagnostic, {
      scopeRef: request.scopeRef,
      path: request.path,
      reason: result.evaluation.reason,
      retryable: result.evaluation.retryable,
      ...(result.evaluation.homeNodeId === undefined
        ? {}
        : { homeNodeId: result.evaluation.homeNodeId }),
    })
  }

  return result
}
