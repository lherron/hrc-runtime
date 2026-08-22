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

import type { ProvisioningScalars } from 'agent-scope'
import {
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  formatCanonicalScopeRef,
} from 'hrc-core'
import type {
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
  FederationRemoteEstablishResult,
  SummonIntent,
} from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase, PlacementBinding, SessionTaskClaimAuthority } from 'hrc-store-sqlite'

import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { assertLocalPersonaAllowed } from '../local-persona-policy.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'
import { markRuntimeStale } from '../startup-reconcile/runtime-mutations.js'
import { withScopeSummonLock, withSessionMintLock } from './authority-lock.js'
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
  type PlacementDisposition,
  type SummonCapabilityHint,
  type SummonCapabilityObservation,
  type SummonGateDeps,
  type SummonGateEvaluation,
  type SummonGatePolicy,
  type SummonGateResult,
  type SummonPath,
  evaluateSummonGate,
  resolveDeclaredPlacementHome,
  resolveDeclaredPlacementHomeOrRefusal,
  resolvePlacementDirectiveNode,
  resolvePlacementDisposition,
} from './summon-gate.js'
import {
  type TaskClaimAuthority,
  type TaskClaimClient,
  createTaskClaimClient,
  taskClaimRequestForScope,
} from './task-claim-client.js'

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
  /** Injected by tests; production crosses the wrkq CLI/RPC boundary. */
  readonly taskClaimClient?: TaskClaimClient | undefined
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
 * T-07398 — the refusals that are about the REQUEST's directive block rather
 * than about this node's authority over the scope. They earn their own wire
 * codes: a caller that mistyped a node id, named a denied placement, or asked
 * for a node the registry has never heard of needs to be able to tell those
 * three apart from "that scope lives somewhere else", and none of them should
 * read as a retryable placement race.
 */
const DIRECTIVE_REFUSAL_CODES: Partial<
  Record<Extract<SummonGateEvaluation, { decision: 'refuse' }>['reason'], HrcErrorCode>
> = {
  'placement-directive-conflict': HrcErrorCode.PLACEMENT_DIRECTIVE_CONFLICT,
  'unknown-node': HrcErrorCode.UNKNOWN_NODE,
  'invalid-provision-value': HrcErrorCode.INVALID_PROVISION_VALUE,
}

function isRefusal(
  value: { nodeId: string } | SummonGateEvaluation
): value is Extract<SummonGateEvaluation, { decision: 'refuse' }> {
  return 'decision' in value && value.decision === 'refuse'
}

function throwRosterPlacementRefusal(
  scopeRef: string,
  evaluation: Extract<SummonGateEvaluation, { decision: 'refuse' }>
): never {
  const detail = {
    scopeRef,
    reason: evaluation.reason,
    retryable: evaluation.retryable,
    ...(evaluation.homeNodeId === undefined ? {} : { homeNodeId: evaluation.homeNodeId }),
  }
  const directiveCode = DIRECTIVE_REFUSAL_CODES[evaluation.reason]
  if (directiveCode !== undefined) {
    throw new HrcDomainError(directiveCode, evaluation.diagnostic, detail)
  }
  if (evaluation.retryable) {
    throw new HrcRuntimeUnavailableError(evaluation.diagnostic, detail)
  }
  throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, evaluation.diagnostic, detail)
}

/**
 * Refuse an INADMISSIBLE provisioning directive before the caller's request is
 * allowed to have any effect (T-07398 cycle 1, D3).
 *
 * The shape/deny boundary in `parsers/provision.ts` cannot answer this question:
 * it sees the block, never the scope, so it cannot know about pins, homes or the
 * peer registry. Placement admissibility needs the target, which is why it lives
 * here beside the derivation it has to agree with.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SUMMON GATE. The gate runs on the BIRTH
 * path. A DM to an already-live scope never reaches it, so before this an
 * invalid directive at a live target was simply delivered — the operator was
 * told it "did not apply" when it should have been told it was refused. The two
 * spec clauses only look like they disagree: "never blocks" governs a VALID
 * directive that cannot apply yet (birth-only ⇒ `directivesApplied: false`),
 * while "hard typed failure ... before any session or message row" governs an
 * input that was never admissible. Liveness decides whether a valid directive
 * APPLIES; it never decides whether an invalid one is accepted.
 *
 * Deliberately silent about values (model, reasoning, ...): those validate
 * against the resolved harness vocabulary at the sender, and re-litigating them
 * here without the profile in hand would refuse legitimate requests.
 */
export async function assertProvisionDirectiveAdmissible(
  server: SummonGateServerContext,
  request: {
    readonly scopeRef: string
    readonly provision?: Partial<ProvisioningScalars> | undefined
  }
): Promise<void> {
  if (request.provision?.node === undefined) return
  const deps = gateDepsFor(server)
  // No enforced gate ⇒ no registry and no policy to validate against. Refusing
  // here would invent a constraint an unfederated daemon never declared.
  if (deps === undefined) return

  const directive = resolvePlacementDirectiveNode(request.provision, deps.knownNodeIds)
  if (directive !== undefined && isRefusal(directive)) {
    throwRosterPlacementRefusal(request.scopeRef, directive)
  }

  let policy: SummonGatePolicy | undefined
  try {
    policy = await deps.policyFor(request.scopeRef)
  } catch {
    // An unreadable profile is not the directive's fault. Stay silent and let
    // the ordinary path surface `policy-unavailable` in its own terms.
    return
  }

  const resolved = resolveDeclaredPlacementHomeOrRefusal(
    request.scopeRef,
    policy,
    deps.localNodeId,
    {
      provision: request.provision,
      knownNodeIds: deps.knownNodeIds,
    }
  )
  if (resolved !== undefined && 'decision' in resolved) {
    throwRosterPlacementRefusal(request.scopeRef, resolved)
  }
}

/**
 * Resolve the home of one implicitly-summoned scope without establishing or
 * mutating anything. Shared by the suffix roster base (T-07118) and the exact
 * scope (T-07302) — in both cases the ORIGIN resolves placement and the caller
 * asserts no node.
 */
export async function resolveImplicitScopeHome(
  server: SummonGateServerContext,
  request: {
    readonly scopeRef: string
    readonly capabilityHint: SummonCapabilityHint
    /** T-07398 — the request's explicit directive block, if it carried one. */
    readonly provision?: Partial<ProvisioningScalars> | undefined
  }
): Promise<string> {
  assertLocalPersonaAllowed(server, request.scopeRef)
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    throw new HrcRuntimeUnavailableError(
      'implicit scope provisioning requires the enforced federation placement gate',
      { scopeRef: request.scopeRef, retryable: true }
    )
  }
  const result = await evaluateSummonGate({
    scopeRef: request.scopeRef,
    path: 'resolve-session',
    intent: 'implicit',
    deps,
    capabilityHint: request.capabilityHint,
    ...(request.provision === undefined ? {} : { provision: request.provision }),
  })
  const placement = result.placement
  if (placement?.outcome === 'remote-bound') return placement.binding.homeNodeId
  if (placement?.outcome === 'remote-establish') return placement.candidateHomeNodeId
  if (result.evaluation.decision === 'refuse') {
    throwRosterPlacementRefusal(request.scopeRef, result.evaluation)
  }
  if (placement === undefined || placement.outcome === 'refuse') {
    throw new HrcRuntimeUnavailableError('implicit scope placement did not resolve', {
      scopeRef: request.scopeRef,
      retryable: true,
    })
  }
  switch (placement.outcome) {
    case 'local-bound':
      return placement.binding.homeNodeId
    case 'local-establish':
      return placement.homeNodeId
  }
}

/**
 * Fail-closed, read-only whole-family preflight for a home-local roster start.
 * Every finite member must name this node through an exact task-default and
 * independently pass retirement, binding, authority, and materialization
 * checks before the roster mutex is allowed to mutate anything.
 */
export async function preflightSuffixRosterFamily(
  server: SummonGateServerContext,
  request: {
    readonly baseScopeRef: string
    readonly scopeRefs: readonly string[]
    readonly capabilityHint: SummonCapabilityHint
    readonly origin: 'local' | 'federated-ingress'
    /**
     * T-07398 — a directive on an UNDECLARED family places the WHOLE family.
     * Family-wide is the point: the same-home property the one-family-one-mutex
     * claim discipline rests on has to hold by construction, so this block is
     * applied to the base AND to every reserved member below, never to the one
     * member that happens to be claimed.
     */
    readonly provision?: Partial<ProvisioningScalars> | undefined
  }
): Promise<void> {
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    throw new HrcRuntimeUnavailableError(
      'suffix-roster family preflight requires the enforced federation placement gate',
      { retryable: true }
    )
  }
  // Validate the directive before the family home is derived, so a bad node id
  // is reported as itself rather than as "the base does not declare this node".
  const directive = resolvePlacementDirectiveNode(request.provision, deps.knownNodeIds)
  if (directive !== undefined && isRefusal(directive)) {
    throwRosterPlacementRefusal(request.baseScopeRef, directive)
  }
  let basePolicy: SummonGatePolicy | undefined
  try {
    basePolicy = await deps.policyFor(request.baseScopeRef)
  } catch (error) {
    throw new HrcRuntimeUnavailableError('suffix-roster placement policy is unavailable', {
      scopeRef: request.baseScopeRef,
      retryable: true,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const resolvedFamilyHome = resolveDeclaredPlacementHomeOrRefusal(
    request.baseScopeRef,
    basePolicy,
    deps.localNodeId,
    { provision: request.provision, knownNodeIds: deps.knownNodeIds }
  )
  // A directive disagreeing with the family's DECLARED home is that refusal,
  // reported as itself: collapsing it into "the base does not declare this
  // node" would name the wrong fix.
  if (resolvedFamilyHome !== undefined && 'decision' in resolvedFamilyHome) {
    throwRosterPlacementRefusal(request.baseScopeRef, resolvedFamilyHome)
  }
  const familyHome = resolvedFamilyHome
  if (familyHome?.homeNodeId !== deps.localNodeId) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      `suffix-roster base ${request.baseScopeRef} must declare ${deps.localNodeId} as its home`,
      {
        scopeRef: request.baseScopeRef,
        declaredHomeNodeId: familyHome?.homeNodeId ?? null,
        requiredHomeNodeId: deps.localNodeId,
        retryable: false,
      }
    )
  }
  for (const scopeRef of request.scopeRefs) {
    assertLocalPersonaAllowed(server, scopeRef)
    const result = await evaluateSummonGate({
      scopeRef,
      path: 'resolve-session',
      intent: 'implicit',
      origin: request.origin,
      deps,
      capabilityHint: request.capabilityHint,
      ...(request.provision === undefined ? {} : { provision: request.provision }),
    })
    if (result.evaluation.decision === 'refuse') {
      throwRosterPlacementRefusal(scopeRef, result.evaluation)
    }
    if (result.evaluation.homeNodeId !== deps.localNodeId) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `suffix-roster member ${scopeRef} is not authoritative on ${deps.localNodeId}`,
        {
          scopeRef,
          homeNodeId: result.evaluation.homeNodeId ?? null,
          requiredHomeNodeId: deps.localNodeId,
          retryable: false,
        }
      )
    }
  }
}

/**
 * Fail-closed, read-only preflight for ONE exact scope on its authoritative
 * home (T-07302).
 *
 * The suffix roster derives all eleven members from the explicit base scope and
 * its declared family home. An exact claim touches exactly the scope the person
 * named, so it needs that scope's own declared or inherited placement
 * to name this node. That is precisely what lets an arbitrary custom name work
 * while `cody@hrc-runtime:hrcdev` still routes by its pin.
 *
 * Everything else is identical to the family preflight and is re-derived HERE,
 * on the receiver, from this node's own retirement marks, ledger, registry,
 * policy and capability observation: an origin's routing decision is a request,
 * never authority.
 */
export async function preflightExactScope(
  server: SummonGateServerContext,
  request: {
    readonly scopeRef: string
    readonly capabilityHint: SummonCapabilityHint
    readonly origin: 'local' | 'federated-ingress'
    /**
     * T-07398 — the directive block as the request carried it. At
     * `federated-ingress` this is the receiver's half of dual validation: the
     * origin's resolution buys nothing here, so the same derivation is re-run
     * against THIS node's registry and THIS node's `[placement]`, and a
     * directive the origin blessed is refused if it disagrees with either.
     */
    readonly provision?: Partial<ProvisioningScalars> | undefined
  }
): Promise<void> {
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    throw new HrcRuntimeUnavailableError(
      'exact-scope preflight requires the enforced federation placement gate',
      { scopeRef: request.scopeRef, retryable: true }
    )
  }
  assertLocalPersonaAllowed(server, request.scopeRef)
  try {
    await deps.policyFor(request.scopeRef)
  } catch (error) {
    throw new HrcRuntimeUnavailableError('exact-scope placement policy is unavailable', {
      scopeRef: request.scopeRef,
      retryable: true,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const result = await evaluateSummonGate({
    scopeRef: request.scopeRef,
    path: 'resolve-session',
    intent: 'implicit',
    origin: request.origin,
    deps,
    capabilityHint: request.capabilityHint,
    ...(request.provision === undefined ? {} : { provision: request.provision }),
  })
  if (result.evaluation.decision === 'refuse') {
    throwRosterPlacementRefusal(request.scopeRef, result.evaluation)
  }
  if (result.evaluation.homeNodeId !== deps.localNodeId) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      `exact scope ${request.scopeRef} is not authoritative on ${deps.localNodeId}`,
      {
        scopeRef: request.scopeRef,
        homeNodeId: result.evaluation.homeNodeId ?? null,
        requiredHomeNodeId: deps.localNodeId,
        retryable: false,
      }
    )
  }
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
  origin?: 'local' | 'federated-ingress' | 'federated-establish' | 'startup-repair' | undefined
  /** True only when this daemon owns the predecessor session being continued. */
  knownSession?: boolean | undefined
  /** Present at session-mint call sites to serialize exactly one continuity birth. */
  laneRef?: string | undefined
  /**
   * T-07398 — the request's explicit provisioning directive block. Placement
   * reads `node=` from it (gap-filling only, strictly below `[placement]`); the
   * rest of the block is carried on the intent and applied at birth.
   */
  provision?: Partial<ProvisioningScalars> | undefined
}

export type SummonAuthorityResult = SummonGateResult & {
  /** Fresh authority exists only on the invocation that won wrkq claim. */
  claimAuthority?: TaskClaimAuthority | undefined
}

export type ExternalRegistrationPlacementResult =
  | { outcome: 'pending'; reason: string; detail: string }
  | { outcome: 'canonical'; binding: PlacementBinding }
  | {
      outcome: 'noncanonical'
      cause: 'placement_refused' | 'binding_conflict'
      detail: string
      homeNodeId?: string | undefined
      binding?: PlacementBinding | undefined
    }

/**
 * Best-effort issuance-time policy projection. It deliberately does not touch
 * the registry or return a refusal: placement never gates EPR grant issuance.
 */
export async function externalRegistrationPlacementAdvisory(
  server: SummonGateServerContext,
  scopeRef: string
): Promise<string | undefined> {
  const config = server.federationConfig ?? server.options?.federationConfig
  if (config === undefined || !config.sourceExists || config.gate.mode === 'off') return undefined

  try {
    const policyFor =
      server.policyFor ?? createPlacementPolicyResolver(server.placementPolicyOptions)
    const designated = resolveDeclaredPlacementHome(
      scopeRef,
      await policyFor(scopeRef),
      config.nodeId
    )
    if (designated === undefined || designated.homeNodeId === config.nodeId) return undefined
    return `policy designates ${designated.homeNodeId} as home; this registration will be noncanonical on ${config.nodeId}`
  } catch {
    // Missing/unreadable policy is reconciled visibly after local mint. An
    // optional advisory must never become an issuance refusal.
    return undefined
  }
}

/**
 * Post-mint EPR placement reconciliation.
 *
 * The participant is already materialized, so this deliberately reuses the
 * normal placement decision without its future-launch capability observation.
 * Authority still goes through the exact registry-first establishment writer.
 */
export async function establishExternalRegistrationPlacement(
  server: SummonGateServerContext,
  request: { scopeRef: string; registrationId: string; classId: string }
): Promise<ExternalRegistrationPlacementResult> {
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    return {
      outcome: 'pending',
      reason: 'federation_not_configured',
      detail: 'collective placement is not enabled on this node',
    }
  }

  return await withScopeSummonLock(server as object, request.scopeRef, async () => {
    const placement = await resolvePlacementDisposition({
      scopeRef: request.scopeRef,
      path: 'resolve-session',
      // Registration is mechanism-born, not an operator declaration that this
      // node should own the scope. Resolve pins/task defaults/default home.
      intent: 'implicit',
      origin: 'local',
      // Local mint already proved materialization. Capability probing here
      // would incorrectly ask whether HRC can launch the external process.
      // This bounded controller owns cause-change and terminal logging. Letting
      // the generic gate log here would emit a second WARN on every retry tick.
      deps: { ...deps, capabilityFor: undefined, log: undefined },
    })

    if (placement === undefined) {
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: `placement did not resolve for ${request.scopeRef}`,
      }
    }
    if (placement.outcome === 'local-bound') {
      try {
        const declared = resolveDeclaredPlacementHome(
          request.scopeRef,
          await deps.policyFor(request.scopeRef),
          deps.localNodeId
        )
        if (declared !== undefined && declared.homeNodeId !== deps.localNodeId) {
          return {
            outcome: 'noncanonical',
            cause: 'placement_refused',
            detail: `placement policy designates ${declared.homeNodeId} for ${request.scopeRef}`,
            homeNodeId: declared.homeNodeId,
            binding: placement.binding,
          }
        }
      } catch (error) {
        return {
          outcome: 'pending',
          reason: 'policy-unavailable',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      if (placement.source === 'registry') deps.ledger.installActive(placement.binding)
      return { outcome: 'canonical', binding: placement.binding }
    }
    if (placement.outcome === 'remote-bound') {
      return {
        outcome: 'noncanonical',
        cause: 'binding_conflict',
        detail: `${request.scopeRef} is already bound on ${placement.binding.homeNodeId}`,
        homeNodeId: placement.binding.homeNodeId,
        binding: placement.binding,
      }
    }
    if (placement.outcome === 'remote-establish') {
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: `placement policy designates ${placement.candidateHomeNodeId} for ${request.scopeRef}`,
        homeNodeId: placement.candidateHomeNodeId,
      }
    }
    if (placement.outcome === 'refuse') {
      if (placement.retryable) {
        return {
          outcome: 'pending',
          reason: placement.reason,
          detail: placement.diagnostic,
        }
      }
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: placement.diagnostic,
        ...(placement.homeNodeId === undefined ? {} : { homeNodeId: placement.homeNodeId }),
      }
    }
    if (placement.kind !== 'virgin-policy' || typeof placement.provenance !== 'string') {
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: `placement selected unsupported ${placement.kind} authority for external registration ${request.registrationId}`,
        homeNodeId: placement.homeNodeId,
      }
    }

    try {
      const established = await establishLocalPlacement({
        registry: deps.registry,
        ledger: deps.ledger,
        request: {
          scopeRef: request.scopeRef,
          homeNodeId: deps.localNodeId,
          birthClass: 'mechanism-born',
          authorityProvenance: {
            kind: 'external-registration',
            registrationId: request.registrationId,
            classId: request.classId,
          },
          establishmentProvenance: placement.provenance,
          now: new Date().toISOString(),
        },
      })
      if (established.outcome === 'retired') {
        return {
          outcome: 'noncanonical',
          cause: 'placement_refused',
          detail: `${request.scopeRef} is retired at epoch ${established.retirement.placementEpoch}`,
          ...(established.retirement.successorNodeId === null
            ? {}
            : { homeNodeId: established.retirement.successorNodeId }),
        }
      }
      if (established.outcome === 'bound-elsewhere') {
        return {
          outcome: 'noncanonical',
          cause: 'binding_conflict',
          detail: `${request.scopeRef} became bound on ${established.binding.homeNodeId}`,
          homeNodeId: established.binding.homeNodeId,
          binding: established.binding,
        }
      }
      return { outcome: 'canonical', binding: established.binding }
    } catch (error) {
      return {
        outcome: 'pending',
        reason: error instanceof RegistryRefusedError ? 'registry-refused' : 'establishment_failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

/** Decision-only server seam shared by message prechecks and summon execution. */
export async function resolvePlacementOnServer(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest
): Promise<PlacementDisposition | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined
  return await resolvePlacementDisposition({
    scopeRef: request.scopeRef,
    path: request.path,
    intent: request.intent ?? 'implicit',
    ...(request.birthCredential === undefined ? {} : { birthCredential: request.birthCredential }),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    ...(request.knownSession === undefined ? {} : { knownSession: request.knownSession }),
    deps,
    ...(request.capabilityHint === undefined ? {} : { capabilityHint: request.capabilityHint }),
    ...(request.provision === undefined ? {} : { provision: request.provision }),
  })
}

function remoteEstablishRefusal(input: {
  status?: number | undefined
  code?: 'stale_context' | 'runtime_unavailable' | undefined
  message: string
  reason: string
  retryable: boolean
  homeNodeId?: string | undefined
}): Extract<FederationRemoteEstablishResult, { outcome: 'refused' }> {
  return {
    outcome: 'refused',
    status: input.status ?? 409,
    code: input.code ?? 'stale_context',
    message: input.message,
    reason: input.reason,
    retryable: input.retryable,
    ...(input.homeNodeId === undefined ? {} : { homeNodeId: input.homeNodeId }),
  }
}

/**
 * Authenticated authority-only half of remote delivery.
 *
 * The receiver re-runs the same gate from current facts. This function may
 * install authority through the registry-first CAS; it never inserts a
 * message, mints a session, or accepts origin-side placement assertions.
 */
export async function establishRemotePolicyAuthority(
  server: SummonGateServerContext,
  request: { scopeRef: string; correlationId: string }
): Promise<FederationRemoteEstablishResult> {
  const scopeRef = formatCanonicalScopeRef({ scopeRef: request.scopeRef })
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    return remoteEstablishRefusal({
      message: 'remote policy establishment is not enabled on this node',
      reason: 'undeclared-placement',
      retryable: false,
    })
  }

  return await withScopeSummonLock(server as object, scopeRef, async () => {
    const placement = await resolvePlacementDisposition({
      scopeRef,
      path: 'ensure-target',
      intent: 'implicit',
      origin: 'federated-establish',
      deps,
    })
    if (placement === undefined) {
      return remoteEstablishRefusal({
        message: 'remote policy establishment requires an agent scope',
        reason: 'undeclared-placement',
        retryable: false,
      })
    }

    if (placement.outcome === 'local-bound') {
      if (placement.source === 'registry') deps.ledger.installActive(placement.binding)
      return {
        outcome: 'existing',
        correlationId: request.correlationId,
        binding: placement.binding,
      }
    }
    if (placement.outcome === 'remote-bound') {
      return {
        outcome: 'existing',
        correlationId: request.correlationId,
        binding: placement.binding,
      }
    }
    if (placement.outcome === 'remote-establish') {
      return remoteEstablishRefusal({
        message: 'remote policy establishment is not authorized on this node',
        reason: placement.reason,
        retryable: false,
        homeNodeId: placement.candidateHomeNodeId,
      })
    }
    if (placement.outcome === 'refuse') {
      const unavailable = placement.reason === 'registry-unreachable'
      return remoteEstablishRefusal({
        status: unavailable ? 503 : 409,
        code: unavailable ? 'runtime_unavailable' : 'stale_context',
        message: unavailable
          ? 'remote policy establishment is temporarily unavailable'
          : 'remote policy establishment refused',
        reason: placement.reason,
        retryable: placement.retryable,
        ...(placement.homeNodeId === undefined ? {} : { homeNodeId: placement.homeNodeId }),
      })
    }
    if (
      placement.kind !== 'virgin-policy' ||
      typeof placement.provenance !== 'string' ||
      placement.provenance === 'explicit_local' ||
      placement.provenance === 'default_home_node(local)'
    ) {
      return remoteEstablishRefusal({
        message: 'remote establishment is restricted to named policy-born virgin scopes',
        reason: 'claim-birth-authority-required',
        retryable: false,
      })
    }

    try {
      const established = await establishLocalPlacement({
        registry: deps.registry,
        ledger: deps.ledger,
        request: {
          scopeRef,
          homeNodeId: deps.localNodeId,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: placement.provenance },
          establishmentProvenance: placement.provenance,
          now: new Date().toISOString(),
        },
      })
      if (established.outcome === 'retired') {
        return remoteEstablishRefusal({
          message: 'remote policy establishment lost to a retirement fence',
          reason: 'scope-retired',
          retryable: false,
          ...(established.retirement.successorNodeId === null
            ? {}
            : { homeNodeId: established.retirement.successorNodeId }),
        })
      }
      return {
        outcome: established.outcome === 'established' ? 'established' : 'existing',
        correlationId: request.correlationId,
        binding: established.binding,
      }
    } catch (error) {
      const refused = error instanceof RegistryRefusedError
      writeServerLog('WARN', 'federation.establish.registry_failure', {
        scopeRef,
        localNodeId: deps.localNodeId,
        reason: refused ? 'registry-refused' : 'registry-unreachable',
        error: error instanceof Error ? error.message : String(error),
      })
      return remoteEstablishRefusal({
        status: refused ? 409 : 503,
        code: refused ? 'stale_context' : 'runtime_unavailable',
        message: refused
          ? 'remote policy establishment was refused by binding authority'
          : 'remote policy establishment is temporarily unavailable',
        reason: refused ? 'registry-refused' : 'registry-unreachable',
        retryable: !refused,
        homeNodeId: deps.localNodeId,
      })
    }
  })
}

function claimClientFor(server: SummonGateServerContext): TaskClaimClient {
  return server.taskClaimClient ?? createTaskClaimClient()
}

async function releaseClaimBestEffort(
  server: SummonGateServerContext,
  authority: TaskClaimAuthority,
  phase: 'establishment' | 'session-mint'
): Promise<void> {
  const parsed = taskClaimRequestForScope(authority.claimedScope)
  if (parsed === undefined) {
    writeServerLog('ERROR', 'federation.claim_birth.release_failed', {
      taskId: authority.taskId,
      claimedNode: authority.claimedNode,
      claimGeneration: authority.claimGeneration,
      phase,
      diagnostic: 'persisted claimedScope is not a project task scope',
      staleClaim: true,
    })
    return
  }
  try {
    await claimClientFor(server).release(authority, parsed.projectId)
    writeServerLog('INFO', 'federation.claim_birth.released_after_failure', {
      taskId: authority.taskId,
      claimedNode: authority.claimedNode,
      claimGeneration: authority.claimGeneration,
      phase,
    })
  } catch (error) {
    writeServerLog('ERROR', 'federation.claim_birth.release_failed', {
      taskId: authority.taskId,
      claimedNode: authority.claimedNode,
      claimGeneration: authority.claimGeneration,
      phase,
      diagnostic: error instanceof Error ? error.message : String(error),
      staleClaim: true,
    })
  }
}

/** Persist bearer authority beside, never inside, the public session record. */
export function persistSessionTaskClaimAuthority(
  server: SummonGateServerContext,
  hostSessionId: string,
  authority: TaskClaimAuthority,
  createdAt: string
): SessionTaskClaimAuthority {
  return server.db.sessionTaskClaimAuthorities.insert({
    hostSessionId,
    taskId: authority.taskId,
    claimedBy: authority.claimedBy,
    claimedScope: authority.claimedScope,
    claimedNode: authority.claimedNode,
    claimedAt: authority.claimedAt,
    claimGeneration: authority.claimGeneration,
    claimToken: authority.claimToken,
    createdAt,
  })
}

async function commitAuthorizedEstablishment(input: {
  deps: SummonGateDeps
  request: SummonAuthorityRequest
  mode: SummonGateResult['mode']
  homeNodeId: string
  birthClass: FederationBirthClass
  authorityProvenance: BirthAuthorityProvenance
  establishmentProvenance: Exclude<EstablishmentProvenance, 'rebind'>
  label: 'policy' | 'child-birth' | 'claim-birth'
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
      diagnostic,
    })
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason,
      retryable,
    })
  }

  if (established.outcome === 'retired') {
    const successor = established.retirement.successorNodeId
    const diagnostic =
      successor === null
        ? `${input.request.scopeRef} became terminally retired while ${input.label} establishment was being committed; it cannot be established again.`
        : `${input.request.scopeRef} became retired toward successor ${successor} while ${input.label} establishment was being committed; summon it on ${successor}.`
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason: 'scope-retired',
      retryable: false,
      ...(successor === null ? {} : { homeNodeId: successor }),
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
): Promise<SummonAuthorityResult | undefined> {
  assertLocalPersonaAllowed(server, request.scopeRef)
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const result = await evaluateSummonGate({
    scopeRef: request.scopeRef,
    path: request.path,
    // Absent ⇒ implicit (spec §5). The default lives here, at the one seam
    // every path funnels through, so no call site can pick a different one.
    intent: request.intent ?? 'implicit',
    ...(request.birthCredential === undefined ? {} : { birthCredential: request.birthCredential }),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    ...(request.knownSession === undefined ? {} : { knownSession: request.knownSession }),
    deps,
    ...(request.capabilityHint === undefined ? {} : { capabilityHint: request.capabilityHint }),
    ...(request.provision === undefined ? {} : { provision: request.provision }),
  })

  if (result.enforced && result.evaluation.decision === 'refuse') {
    // Directive refusals keep their own typed codes here too: the dm/ensure
    // door must not report a mistyped node as `stale_context` when the
    // exact/suffix door reports it as `unknown_node`.
    const directiveCode = DIRECTIVE_REFUSAL_CODES[result.evaluation.reason]
    if (directiveCode !== undefined) {
      throw new HrcDomainError(directiveCode, result.evaluation.diagnostic, {
        scopeRef: request.scopeRef,
        path: request.path,
        reason: result.evaluation.reason,
        retryable: result.evaluation.retryable,
        ...(result.evaluation.homeNodeId === undefined
          ? {}
          : { homeNodeId: result.evaluation.homeNodeId }),
      })
    }
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
    result.evaluation.reason === 'retired-policy-succession' &&
    result.evaluation.registryRetirement !== undefined
  ) {
    const retirement = result.evaluation.registryRetirement
    const activate = deps.registry.activateRetired
    if (activate === undefined) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `The binding registry does not expose retired-scope activation for ${request.scopeRef}; refusing rather than treating the tombstone as virgin.`,
        {
          scopeRef: request.scopeRef,
          path: request.path,
          reason: 'registry-refused',
          retryable: false,
        }
      )
    }

    let activated: Awaited<ReturnType<NonNullable<typeof deps.registry.activateRetired>>>
    try {
      activated = await activate.call(deps.registry, {
        scopeRef: request.scopeRef,
        successorNodeId: deps.localNodeId,
        expectedPlacementEpoch: retirement.placementEpoch,
        now: new Date().toISOString(),
      })
    } catch (error) {
      const refused = error instanceof RegistryRefusedError
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `Cannot activate retired authority for ${request.scopeRef} at the binding registry (${error instanceof Error ? error.message : String(error)}).`,
        {
          scopeRef: request.scopeRef,
          path: request.path,
          reason: refused ? 'registry-refused' : 'registry-unreachable',
          retryable: !refused,
        }
      )
    }

    if (
      (activated.outcome !== 'activated' && activated.outcome !== 'idempotent') ||
      activated.binding === undefined
    ) {
      const diagnostic = `Retired activation for ${request.scopeRef} did not commit (${activated.outcome}); refusing local authority.`
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
        scopeRef: request.scopeRef,
        path: request.path,
        reason: 'scope-retired',
        retryable: false,
        outcome: activated.outcome,
      })
    }
    deps.ledger.installActive(activated.binding)
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

  if (
    result.evaluation.decision === 'allow' &&
    (result.evaluation.reason === 'claim-birth' || result.evaluation.reason === 'claim-rebind')
  ) {
    const claimRequest = taskClaimRequestForScope(request.scopeRef)
    if (claimRequest === undefined) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `Cannot derive task claim authority from ${request.scopeRef}; refusing before session mint.`,
        {
          scopeRef: request.scopeRef,
          path: request.path,
          reason: 'claim-birth-authority-required',
          retryable: false,
        }
      )
    }

    let authority: TaskClaimAuthority
    try {
      authority = await claimClientFor(server).claim(claimRequest)
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error)
      writeServerLog('WARN', 'federation.summon_gate.refusal', {
        path: request.path,
        scopeRef: request.scopeRef,
        reason: 'claim-refused',
        wouldBeDecision: 'refuse',
        enforced: true,
        mode: result.mode,
        retryable: false,
        localNodeId: deps.localNodeId,
        diagnostic,
      })
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
        scopeRef: request.scopeRef,
        path: request.path,
        reason: 'claim-refused',
        retryable: false,
      })
    }

    if (result.evaluation.reason === 'claim-birth') {
      const provenance: BirthAuthorityProvenance = {
        kind: 'claim-birth',
        taskId: authority.taskId,
        claimedBy: authority.claimedBy,
        claimedScope: authority.claimedScope,
        claimedNode: authority.claimedNode,
        claimGeneration: authority.claimGeneration,
      }
      try {
        await commitAuthorizedEstablishment({
          deps,
          request,
          mode: result.mode,
          homeNodeId: deps.localNodeId,
          birthClass: 'mechanism-born',
          authorityProvenance: provenance,
          establishmentProvenance: 'explicit_local',
          label: 'claim-birth',
        })
      } catch (error) {
        await releaseClaimBestEffort(server, authority, 'establishment')
        throw error
      }
    }
    writeServerLog(
      'INFO',
      result.evaluation.reason === 'claim-rebind'
        ? 'federation.claim_birth.reacquired_after_rebind'
        : 'federation.claim_birth.acquired',
      {
        scopeRef: request.scopeRef,
        taskId: authority.taskId,
        claimedNode: authority.claimedNode,
        claimGeneration: authority.claimGeneration,
      }
    )
    return { ...result, claimAuthority: authority }
  }

  return result
}

/** Session-mint boundary: unwind fresh claim authority if provisioning fails. */
export async function withSummonAuthority<T>(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest,
  mint: (claimAuthority: TaskClaimAuthority | undefined) => T | Promise<T>
): Promise<T> {
  return await withScopeSummonLock(server as object, request.scopeRef, async () => {
    const authorizeAndMint = async () => {
      const authority = await assertSummonAuthority(server, request)
      try {
        return await mint(authority?.claimAuthority)
      } catch (error) {
        if (authority?.claimAuthority !== undefined) {
          await releaseClaimBestEffort(server, authority.claimAuthority, 'session-mint')
        }
        throw error
      }
    }
    return request.laneRef === undefined
      ? await authorizeAndMint()
      : await withSessionMintLock(
          server as object,
          request.scopeRef,
          request.laneRef,
          authorizeAndMint
        )
  })
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
    if (isExternalLifecycleOwner(runtime)) continue
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
      if (
        registry.outcome === 'bound' &&
        registry.binding.homeNodeId === deps.localNodeId &&
        registry.binding.establishmentProvenance !== 'rebind'
      ) {
        deps.ledger.installActive(registry.binding)
        summary.repaired += 1
        continue
      }

      await assertSummonAuthority(server, {
        scopeRef,
        path: 'ensure-target',
        intent: 'implicit',
        origin: 'startup-repair',
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
 * Refuses a locally retired or rebind-revoked scope before an existing target
 * row can bypass the summon gate entirely.
 *
 * This is deliberately limited to node-local hard stops: target selection also
 * handles established local sessions and legitimate remote routing, neither of
 * which may be forced through virgin-placement or capability evaluation merely
 * to check the fence. When no exact local mark exists, this does one local
 * lookup and leaves the pre-existing path byte-for-byte unchanged.
 */
export async function assertScopeNotRetired(
  server: SummonGateServerContext,
  request: {
    scopeRef: string
    path: SummonPath
    /** True only when the same request is guaranteed to enter the full gate later. */
    advisoryCoveredByDownstreamGate?: (() => boolean) | undefined
  }
): Promise<SummonGateResult | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const retirement = deps.retirementFor?.(request.scopeRef)
  const localAuthority = deps.ledger.activeAuthority(request.scopeRef)
  const locallyRetired =
    retirement?.retiredNodeId === deps.localNodeId &&
    (localAuthority === undefined ||
      localAuthority.placementEpoch <= retirement.retiredPlacementEpoch)
  const locallyRevoked = deps.ledger.get?.(request.scopeRef)?.state === 'revoked'
  if (!locallyRetired && !locallyRevoked) {
    return undefined
  }

  // Enforce never invokes this callback: the hard stop below still runs before
  // any target lookup. Advisory is observational, so an archived/new target
  // already guaranteed to enter the full summon gate should keep its existing
  // single event instead of emitting a duplicate at both seams.
  if (deps.mode === 'advisory' && request.advisoryCoveredByDownstreamGate?.()) {
    return undefined
  }

  // Re-enter the canonical gate only after proving that a local hard stop applies.
  // Omitting a caller birth credential is intentional: node-local hard stops
  // must win before any authority mechanism is read.
  return await assertSummonAuthority(server, {
    scopeRef: request.scopeRef,
    path: request.path,
    intent: 'implicit',
  })
}
