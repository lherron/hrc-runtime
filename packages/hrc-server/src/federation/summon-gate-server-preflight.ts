/**
 * Directive admissibility and roster/exact-scope preflight for the summon gate
 * server. Split out of `summon-gate-server.ts`.
 */

import type { ProvisioningScalars } from 'agent-scope'
import {
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
} from 'hrc-core'

import { assertLocalPersonaAllowed } from '../local-persona-policy.js'
import { type SummonGateServerContext, gateDepsFor } from './summon-gate-server-context.js'
import {
  type SummonCapabilityHint,
  type SummonGateEvaluation,
  type SummonGatePolicy,
  evaluateSummonGate,
  resolveDeclaredPlacementHomeOrRefusal,
  resolvePlacementDirectiveNode,
} from './summon-gate.js'

/**
 * T-07398 — the refusals that are about the REQUEST's directive block rather
 * than about this node's authority over the scope. They earn their own wire
 * codes: a caller that mistyped a node id, named a denied placement, or asked
 * for a node the registry has never heard of needs to be able to tell those
 * three apart from "that scope lives somewhere else", and none of them should
 * read as a retryable placement race.
 */
export const DIRECTIVE_REFUSAL_CODES: Partial<
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
