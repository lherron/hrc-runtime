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
import type {
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
  HrcChildDispatchIntent,
  SummonIntent,
} from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'
import { markRuntimeStale } from '../startup-reconcile/runtime-mutations.js'
import { validateRuntimeBirthCredential } from './birth-credential.js'
import { establishLocalPlacement } from './establishment.js'
import type { FederationConfig } from './federation-config.js'
import {
  type ResolvePlacementPolicyOptions,
  createPlacementPolicyResolver,
} from './placement-policy.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryRefusedError } from './registry-client.js'
import { resolveFederationRegistryClient } from './registry-resolution.js'
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
    ledger,
    registry:
      server.registryClient ??
      resolveFederationRegistryClient(config, server.bindingRegistryEndpoint?.registryClient),
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
  childDispatchIntent?: HrcChildDispatchIntent | undefined
  capabilityHint?: SummonCapabilityHint | undefined
}

async function commitAuthorizedEstablishment(input: {
  deps: SummonGateDeps
  request: SummonAuthorityRequest
  mode: SummonGateResult['mode']
  homeNodeId: string
  birthClass: FederationBirthClass
  authorityProvenance: BirthAuthorityProvenance
  establishmentProvenance: Exclude<EstablishmentProvenance, 'rebind'>
  label: 'policy' | 'child-birth'
}): Promise<void> {
  let established: Awaited<ReturnType<typeof establishLocalPlacement>>
  try {
    established = await establishLocalPlacement({
      registry: input.deps.registry,
      ledger: input.deps.ledger,
      request: {
        scopeRef: input.request.scopeRef,
        homeNodeId: input.homeNodeId,
        birthClass: input.birthClass,
        authorityProvenance: input.authorityProvenance,
        establishmentProvenance: input.establishmentProvenance,
        now: new Date().toISOString(),
      },
    })
  } catch (error) {
    const refused = error instanceof RegistryRefusedError
    const detail = error instanceof Error ? error.message : String(error)
    const reason = refused ? 'registry-refused' : 'registry-unreachable'
    const retryable = !refused
    const diagnostic = refused
      ? `The binding registry refused ${input.label} establishment for ${input.request.scopeRef} (${detail}). Check this node's peer entry and bearer token in federation.json.`
      : `Cannot establish ${input.label} authority for ${input.request.scopeRef} at the binding registry (${detail}). Refusing to mint without a collective binding; retry once the registry is reachable.`
    writeServerLog('WARN', 'federation.summon_gate.refusal', {
      path: input.request.path,
      scopeRef: input.request.scopeRef,
      reason,
      wouldBeDecision: 'refuse',
      enforced: true,
      mode: input.mode,
      retryable,
      localNodeId: input.deps.localNodeId,
      intent: input.request.intent,
      birthCredentialPresent: input.request.birthCredential !== undefined,
      childDispatchIntentPresent: input.request.childDispatchIntent !== undefined,
      diagnostic,
    })
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason,
      retryable,
    })
  }

  if (established.outcome === 'bound-elsewhere') {
    const diagnostic = `${input.request.scopeRef} became bound on ${established.binding.homeNodeId} while ${input.label} establishment was being committed on ${input.deps.localNodeId}; the existing birth wins. Summon it on ${established.binding.homeNodeId}.`
    writeServerLog('WARN', 'federation.summon_gate.refusal', {
      path: input.request.path,
      scopeRef: input.request.scopeRef,
      reason: 'bound-elsewhere',
      wouldBeDecision: 'refuse',
      enforced: true,
      mode: input.mode,
      retryable: false,
      localNodeId: input.deps.localNodeId,
      homeNodeId: established.binding.homeNodeId,
      intent: input.request.intent,
      birthCredentialPresent: input.request.birthCredential !== undefined,
      childDispatchIntentPresent: input.request.childDispatchIntent !== undefined,
      diagnostic,
    })
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason: 'bound-elsewhere',
      retryable: false,
      homeNodeId: established.binding.homeNodeId,
    })
  }
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
    ...(request.childDispatchIntent === undefined
      ? {}
      : { childDispatchIntent: request.childDispatchIntent }),
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
    result.evaluation.reason === 'virgin-establishment' &&
    result.evaluation.homeNodeId !== undefined &&
    result.evaluation.establishmentProvenance !== undefined
  ) {
    const source = result.evaluation.establishmentProvenance
    await commitAuthorizedEstablishment({
      deps,
      request,
      mode: result.mode,
      homeNodeId: result.evaluation.homeNodeId,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source },
      establishmentProvenance: source,
      label: 'policy',
    })
  }

  if (
    result.evaluation.decision === 'allow' &&
    result.evaluation.reason === 'child-birth' &&
    result.evaluation.homeNodeId !== undefined &&
    result.evaluation.authorityProvenance !== undefined
  ) {
    await commitAuthorizedEstablishment({
      deps,
      request,
      mode: result.mode,
      homeNodeId: result.evaluation.homeNodeId,
      birthClass: 'mechanism-born',
      authorityProvenance: result.evaluation.authorityProvenance,
      // Establishment provenance is descriptive for policy-born scopes. The
      // mechanism's exact chain lives in authorityProvenance; this existing
      // value is the registry schema's local one-shot establishment marker.
      establishmentProvenance: 'explicit_local',
      label: 'child-birth',
    })
  }

  return result
}

export type LivePlacementRepairSummary = {
  scanned: number
  repaired: number
  alreadyBound: number
  unresolved: number
}

export type LivePlacementRepairCandidate = {
  readonly scopeRef: string
  readonly capabilityHint?: SummonCapabilityHint | undefined
}

function fenceUnresolvedRepairCandidate(
  server: SummonGateServerContext,
  scopeRef: string,
  detail: string
): void {
  for (const runtime of server.db.runtimes.listAll()) {
    if (runtime.scopeRef !== scopeRef || isRuntimeUnavailableStatus(runtime.status)) continue
    const session = server.db.sessions.getByHostSessionId(runtime.hostSessionId)
    if (session === null) continue
    markRuntimeStale(server.db, session, runtime, {
      reason: 'placement_repair_refused',
      detail,
    })
  }
}

/**
 * Snapshot scopes that were live when startup opened the database.
 *
 * Startup reconciliation may conservatively mark an otherwise-repairable
 * runtime stale before the federation endpoints are constructed. Capturing at
 * this boundary preserves that scope for binding repair without ever sweeping
 * older stale/dead/terminated rows into the candidate set.
 */
export function captureLivePlacementRepairCandidates(
  db: HrcDatabase
): readonly LivePlacementRepairCandidate[] {
  const candidates = new Map<string, LivePlacementRepairCandidate>()
  for (const runtime of db.runtimes.listAll()) {
    if (isRuntimeUnavailableStatus(runtime.status) || !runtime.scopeRef.startsWith('agent:')) {
      continue
    }
    const session = db.sessions.getByHostSessionId(runtime.hostSessionId)
    if (session?.status !== 'active') continue
    candidates.set(runtime.scopeRef, {
      scopeRef: runtime.scopeRef,
      ...(session.lastAppliedIntentJson === undefined
        ? {}
        : {
            capabilityHint: {
              placement: session.lastAppliedIntentJson.placement,
              harness: session.lastAppliedIntentJson.harness,
            },
          }),
    })
  }
  return [...candidates.values()]
}

/**
 * Rollout repair for T-06697's already-running unbound policy births.
 *
 * Existing-session delivery does not re-enter the summon gate. Before a
 * restarted daemon is reported ready, replay every locally live agent scope
 * through the implicit policy path. The normal gate remains the sole decision
 * authority, and the normal registry-first commit remains the sole writer.
 */
export async function repairLiveUnboundPlacements(
  server: SummonGateServerContext,
  candidates = captureLivePlacementRepairCandidates(server.db)
): Promise<LivePlacementRepairSummary> {
  const summary: LivePlacementRepairSummary = {
    scanned: 0,
    repaired: 0,
    alreadyBound: 0,
    unresolved: 0,
  }
  if (candidates.length === 0) return summary

  const deps = gateDepsFor(server)
  if (deps === undefined) return summary

  for (const candidate of candidates) {
    const { scopeRef } = candidate
    summary.scanned += 1
    if (deps.ledger.activeAuthority(scopeRef) !== undefined) {
      summary.alreadyBound += 1
      continue
    }

    // A collective binding already naming this node is the crash-recovery
    // authority. Install it before capability observation: these candidates
    // were already running at the startup boundary, so materialization checks
    // for a future launch (for example, an agent home since removed after a
    // soak probe ran) must not prevent the exact registry row from healing the
    // local ledger or wedge the whole daemon at boot.
    try {
      const registry = await deps.registry.consult(scopeRef)
      if (registry.outcome === 'bound' && registry.binding.homeNodeId === deps.localNodeId) {
        deps.ledger.installActive(registry.binding)
        summary.repaired += 1
        continue
      }

      await assertSummonAuthority(server, {
        scopeRef,
        path: 'ensure-target',
        intent: 'implicit',
        ...(candidate.capabilityHint === undefined
          ? {}
          : { capabilityHint: candidate.capabilityHint }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      fenceUnresolvedRepairCandidate(server, scopeRef, detail)
      summary.unresolved += 1
      writeServerLog('WARN', 'federation.placement_repair.refused', {
        scopeRef,
        localNodeId: deps.localNodeId,
        mode: deps.mode,
        detail,
      })
      continue
    }

    const repaired = deps.ledger.activeAuthority(scopeRef)
    if (repaired?.homeNodeId === deps.localNodeId) {
      summary.repaired += 1
      continue
    }

    summary.unresolved += 1
    writeServerLog('WARN', 'federation.placement_repair.unresolved', {
      scopeRef,
      localNodeId: deps.localNodeId,
      mode: deps.mode,
    })
    fenceUnresolvedRepairCandidate(
      server,
      scopeRef,
      `live placement repair left ${scopeRef} without local collective authority on ${deps.localNodeId}`
    )
  }

  writeServerLog('INFO', 'federation.placement_repair.completed', {
    localNodeId: deps.localNodeId,
    ...summary,
  })
  return summary
}

/**
 * Refuses a locally retired scope before an existing target row can bypass the
 * summon gate entirely.
 *
 * This is deliberately retirement-only: target selection also handles
 * established local sessions and legitimate remote routing, neither of which
 * may be forced through virgin-placement or capability evaluation merely to
 * check for a node-local hard stop. When no exact local mark exists, this does
 * one local lookup and leaves the pre-existing path byte-for-byte unchanged.
 */
export async function assertScopeNotRetired(
  server: SummonGateServerContext,
  request: {
    scopeRef: string
    path: Exclude<SummonPath, 'resolve-session'>
    /** True only when the same request is guaranteed to enter the full gate later. */
    advisoryCoveredByDownstreamGate?: (() => boolean) | undefined
  }
): Promise<SummonGateResult | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const retirement = deps.retirementFor?.(request.scopeRef)
  if (retirement === undefined || retirement.retiredNodeId !== deps.localNodeId) {
    return undefined
  }

  // Enforce never invokes this callback: the hard stop below still runs before
  // any target lookup. Advisory is observational, so an archived/new target
  // already guaranteed to enter the full summon gate should keep its existing
  // single event instead of emitting a duplicate at both seams.
  if (deps.mode === 'advisory' && request.advisoryCoveredByDownstreamGate?.()) {
    return undefined
  }

  // Re-enter the canonical gate only after proving that retirement applies.
  // Omitting a caller birth credential is intentional: retirement is a
  // node-local hard stop and must win before any authority mechanism is read.
  return await assertSummonAuthority(server, {
    scopeRef: request.scopeRef,
    path: request.path,
    intent: 'implicit',
  })
}
