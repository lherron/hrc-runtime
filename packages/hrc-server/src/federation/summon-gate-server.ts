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
import type { SummonIntent } from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import { validateRuntimeBirthCredential } from './birth-credential.js'
import { establishLocalPlacement } from './establishment.js'
import type { FederationConfig } from './federation-config.js'
import {
  type ResolvePlacementPolicyOptions,
  createPlacementPolicyResolver,
} from './placement-policy.js'
import type { BindingRegistryClient } from './registry-client.js'
import {
  RegistryRefusedError,
  RegistryUnreachableError,
  createBindingRegistryClient,
} from './registry-client.js'
import { createSummonCapabilityObserver } from './summon-capability.js'
import {
  type SummonCapabilityHint,
  type SummonCapabilityObservation,
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
    ledger,
    registry: server.registryClient ?? resolveRegistryClient(config),
    // Node-local, synchronous, and undefined before the table exists
    // (T-06614 C-11125 / larry #190). Checked before all authority logic.
    retirementFor: (scopeRef) => readScopeRetirement(server.db.sqlite, scopeRef),
    validateBirthCredential: (credential) => validateRuntimeBirthCredential(server.db, credential),
    // Locate and the gate deliberately share this one profile reader. The
    // closure is cheap to construct here; actual profile discovery/read stays
    // lazy until a configured, non-dark gate reaches the virgin-policy branch.
    policyFor: server.policyFor ?? createPlacementPolicyResolver(server.placementPolicyOptions),
    capabilityFor: server.capabilityFor ?? createSummonCapabilityObserver(),
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
 * The gate request, shaped so `explicit_local` is UNREACHABLE from any path but
 * `resolve-session`.
 *
 * §5's line is that generic SDK and test callers with `create: true` must never
 * become placement declarations. The four non-operator paths — message-driven
 * ensure-target, archived-successor, command-run, app-session — are summons
 * *on behalf of* something else, so none of them can be an operator's start.
 * Encoding that as a union means a future caller cannot hand one of them an
 * explicit intent even by accident: it is a compile error rather than a review
 * catch, on a surface where the review catch would have to hold for years.
 *
 * `resolve-session` is the one arm that can carry either value, because it is
 * the one surface `hrc run` and `hrc start` enter through — and, per T-06608's
 * path-C finding, the same surface every generic SDK caller enters through.
 * Separating those two is the entire reason the typed field exists.
 */
export type SummonAuthorityRequest = (
  | { scopeRef: string; path: 'resolve-session'; intent: SummonIntent }
  | {
      scopeRef: string
      path: Exclude<SummonPath, 'resolve-session'>
      /** Absent ⇒ `implicit`; `implicit` is the only value these paths accept. */
      intent?: 'implicit' | undefined
    }
) & {
  /** Common mint context; neither field widens the typed intent arm. */
  birthCredential?: string | undefined
  capabilityHint?: SummonCapabilityHint | undefined
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
  request: SummonAuthorityRequest
): Promise<SummonGateResult | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const result = await evaluateSummonGate({
    scopeRef: request.scopeRef,
    path: request.path,
    // Absent ⇒ implicit (spec §5). The default lives here, at the one seam
    // every path funnels through, so no call site can pick a different one.
    intent: request.intent ?? 'implicit',
    ...(request.birthCredential === undefined ? {} : { birthCredential: request.birthCredential }),
    deps,
    ...(request.capabilityHint === undefined ? {} : { capabilityHint: request.capabilityHint }),
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
      ...(result.evaluation.capability === undefined
        ? {}
        : { capability: result.evaluation.capability }),
      ...(result.evaluation.capabilitySource === undefined
        ? {}
        : { capability_source: result.evaluation.capabilitySource }),
    })
  }

  // Registry-first establishment deliberately admits this crash window: the
  // collective binding committed but the daemon stopped before its local row.
  // The consulted binding is the authority; install that exact row before the
  // caller can mint a session. This also preserves an existing policy birth
  // when a valid child credential arrives after another node won first birth.
  if (
    result.evaluation.decision === 'allow' &&
    result.evaluation.reason === 'registry-bound-local' &&
    result.evaluation.registryBinding !== undefined
  ) {
    deps.ledger.installActive(result.evaluation.registryBinding)
  }

  if (
    result.evaluation.decision === 'allow' &&
    result.evaluation.reason === 'child-birth' &&
    result.evaluation.homeNodeId !== undefined &&
    result.evaluation.authorityProvenance !== undefined
  ) {
    let established: Awaited<ReturnType<typeof establishLocalPlacement>>
    try {
      established = await establishLocalPlacement({
        registry: deps.registry,
        ledger: deps.ledger,
        request: {
          scopeRef: request.scopeRef,
          homeNodeId: result.evaluation.homeNodeId,
          birthClass: 'mechanism-born',
          authorityProvenance: result.evaluation.authorityProvenance,
          // Establishment provenance is descriptive for policy-born scopes. The
          // mechanism's exact chain lives in authorityProvenance; this existing
          // value is the registry schema's local one-shot establishment marker.
          establishmentProvenance: 'explicit_local',
          now: new Date().toISOString(),
        },
      })
    } catch (error) {
      const refused = error instanceof RegistryRefusedError
      const detail = error instanceof Error ? error.message : String(error)
      const reason = refused ? 'registry-refused' : 'registry-unreachable'
      const retryable = !refused
      const diagnostic = refused
        ? `The binding registry refused child-birth establishment for ${request.scopeRef} (${detail}). Check this node's peer entry and bearer token in federation.json.`
        : `Cannot establish child-birth authority for ${request.scopeRef} at the binding registry (${detail}). Refusing to mint without a collective binding; retry once the registry is reachable.`
      writeServerLog('WARN', 'federation.summon_gate.refusal', {
        path: request.path,
        scopeRef: request.scopeRef,
        reason,
        wouldBeDecision: 'refuse',
        enforced: true,
        mode: result.mode,
        retryable,
        localNodeId: deps.localNodeId,
        intent: request.intent,
        birthCredentialPresent: true,
        diagnostic,
      })
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
        scopeRef: request.scopeRef,
        path: request.path,
        reason,
        retryable,
      })
    }

    if (established.outcome === 'bound-elsewhere') {
      const diagnostic = `${request.scopeRef} became bound on ${established.binding.homeNodeId} while child-birth was being established on ${deps.localNodeId}; the existing birth wins. Summon it on ${established.binding.homeNodeId}.`
      writeServerLog('WARN', 'federation.summon_gate.refusal', {
        path: request.path,
        scopeRef: request.scopeRef,
        reason: 'bound-elsewhere',
        wouldBeDecision: 'refuse',
        enforced: true,
        mode: result.mode,
        retryable: false,
        localNodeId: deps.localNodeId,
        homeNodeId: established.binding.homeNodeId,
        intent: request.intent,
        birthCredentialPresent: true,
        diagnostic,
      })
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
        scopeRef: request.scopeRef,
        path: request.path,
        reason: 'bound-elsewhere',
        retryable: false,
        homeNodeId: established.binding.homeNodeId,
      })
    }
  }

  return result
}
