/**
 * The summon gate (federation spec §5, rollout §11 F0).
 *
 * EVERY summon path asks one question first: *does this node hold authority for
 * this scope?* This module is that question, isolated from the five call sites
 * that ask it so the answer cannot drift between them. (Today's nearest
 * equivalent, `isCodexAppOwnedScopeRef`, is duplicated at three sites — the
 * pattern this deliberately does not repeat.)
 *
 * ADVISORY DURING F0. `evaluateSummonGate` returns a decision AND whether that
 * decision is enforced. During the soak `mode: 'advisory'` evaluates fully,
 * logs every would-be refusal as soak data (T-06615), and enforces nothing.
 * `mode: 'enforce'` changes only whether the refusal bites — never what the
 * decision is. The flip is T-06616, not this task.
 *
 * DARK IS GENUINELY DARK. With no federation config the gate returns before
 * touching the ledger, the registry, the retirement table, or placement policy,
 * and logs nothing. An unconfigured daemon must behave byte-identically to one
 * built before this file existed; that is the whole flag-gating doctrine of F0,
 * which touches every session-creation path for zero payoff until F1.
 *
 * FAILS CLOSED, ALWAYS VISIBLY. Every refusal carries a diagnostic that names
 * what to do next — the bound node, or the exact stanza line to add. A silent
 * fallback is the one behavior §5 forbids outright, and an exception escaping
 * into session creation would be a silent fallback with extra steps, so nothing
 * here throws: unexpected failures become visible retryable refusals.
 */

import type { BirthDesignationResult } from 'hrc-store-sqlite'

import { formatCanonicalScopeRef } from 'hrc-core'
import { RegistryRefusedError, RegistryUnreachableError } from './registry-client.js'
import type { BindingRegistryClient } from './registry-client.js'
import {
  allow,
  designationDecisionFor,
  isEvaluation,
  permitsRemoteEstablishment,
  refuse,
  resolveDesignatedHome,
} from './summon-gate-placement.js'
import type { DesignatedHome } from './summon-gate-placement.js'
import { SUMMON_GATE_REFUSAL_EVENT } from './summon-gate-types.js'
import type {
  PlacementDisposition,
  SummonCapabilityObservation,
  SummonGateEvaluation,
  SummonGatePolicy,
  SummonGateRefuseReason,
  SummonGateRequest,
  SummonGateResult,
} from './summon-gate-types.js'

// Every name this module exported before the split stays importable from here.
export {
  placementHomeDeclaration,
  placementPinKey,
  resolveDeclaredPlacementHome,
  resolveDeclaredPlacementHomeOrRefusal,
  resolvePlacementDirectiveNode,
} from './summon-gate-placement.js'
export { SUMMON_GATE_REFUSAL_EVENT } from './summon-gate-types.js'
export type {
  PlacementDisposition,
  SummonCapabilityHint,
  SummonCapabilityName,
  SummonCapabilityObservation,
  SummonGateAllowReason,
  SummonGateDeps,
  SummonGateEvaluation,
  SummonGatePolicy,
  SummonGateLog,
  SummonGateMode,
  SummonGateRefuseReason,
  SummonGateRequest,
  SummonGateResult,
  SummonIntent,
  SummonPath,
} from './summon-gate-types.js'

async function requireMaterializationCapability(
  request: SummonGateRequest,
  authority: Extract<SummonGateEvaluation, { decision: 'allow' }>
): Promise<SummonGateEvaluation> {
  const observer = request.deps.capabilityFor
  // Compatibility for direct unit consumers while the server always injects
  // the real observer. Absence cannot occur on a configured production daemon.
  if (observer === undefined) return authority

  let observation: SummonCapabilityObservation
  try {
    observation = await observer(request.scopeRef, request.capabilityHint)
  } catch (error) {
    return refuse(
      'capability-observation-failed',
      `Could not observe materialization capability for ${request.scopeRef}: ${error instanceof Error ? error.message : String(error)}. Refusing rather than silently rerouting or assuming this node is capable.`,
      {
        retryable: true,
        ...(authority.homeNodeId === undefined ? {} : { homeNodeId: authority.homeNodeId }),
      }
    )
  }

  if (observation.outcome === 'capable') return authority

  const reason: SummonGateRefuseReason =
    observation.capabilityReason === 'project-root-unresolvable'
      ? 'capability-project-root-unresolvable'
      : `capability-${observation.capability}-missing`
  return refuse(reason, observation.diagnostic, {
    retryable: observation.retryable ?? false,
    ...(authority.homeNodeId === undefined ? {} : { homeNodeId: authority.homeNodeId }),
    capability: observation.capability,
    capabilitySource: observation.capabilitySource ?? 'presence-heuristic',
  })
}

function nodeLocalRemoteEstablishRefusal(
  request: SummonGateRequest,
  scopeRef: string,
  designated: DesignatedHome
): SummonGateEvaluation | undefined {
  if (request.origin !== 'federated-establish' || permitsRemoteEstablishment(designated)) {
    return undefined
  }
  return refuse(
    'routed-elsewhere',
    `${scopeRef} has no concrete named-node policy granting remote establishment authority; ${designated.selection} is node-local only.`,
    { homeNodeId: request.deps.localNodeId }
  )
}

/**
 * The tier-5 birth designation (T-07655): where does a VIRGIN scope get born
 * when nothing has declared a home for it?
 *
 * Today's answer is "right here", on every node at once. Since wave 3 every
 * daemon's mail kicker tails the same wrkq ledger, so one insert addressed to a
 * virgin scope makes every live kicker attempt a local birth simultaneously and
 * the registry arbitrates first-commit-wins. The losers logged
 * `drive_failed "became bound on <winner>"`, and three task scopes dispatched
 * from max3 seats were observed being born on three different nodes.
 *
 * The fix is to make the answer the SAME on every node instead of arbitrating
 * afterwards. The registry host — one writer, already serialized per scope —
 * reads the scope's birth envelope from wrkq ITSELF and follows the home of the
 * scope that sent it. Every kicker asks the same host and gets the same node.
 *
 * WHY THIS IS NOT THE FORBIDDEN AMBIENT CALLER ASSERTION. Nothing is read from
 * the socket, the peer, or the environment. The sender's home is a REGISTRY
 * FACT recorded when that scope was established, and the sender itself comes
 * off a ledger row the registry reads directly — the request carries only the
 * target, so a caller cannot steer it.
 *
 * IT IS A DEFAULT, NOT A CONSTRAINT. It is reached only where tiers 1-4 are
 * silent, and a tier-1-4 establishment anywhere supersedes it rather than being
 * refused by it. That is enforced in the registry transaction, not here.
 */
async function applyBirthDesignation(
  request: SummonGateRequest,
  scopeRef: string,
  designated: DesignatedHome
): Promise<DesignatedHome | SummonGateEvaluation> {
  const { deps } = request
  // Only the last tier is designatable. A declared pin, home, directive, or an
  // operator's explicit start already answered, and must not be re-asked.
  if (designated.selection !== 'local-default') return designated
  // Mail-triggered implicit summons only. An operator start is `explicit_local`
  // and never reaches here; a federated-establish is a peer acting on a
  // decision this tier does not produce.
  if (request.intent !== 'implicit' || request.origin === 'federated-establish') return designated
  // Absent only in direct unit consumers; the server always injects a real
  // client. Absence means today's tier 5, which is the pre-T-07655 law.
  const designateBirth = deps.registry.designateBirth
  if (designateBirth === undefined) return designated

  let result: BirthDesignationResult
  try {
    result = await designateBirth.call(deps.registry, scopeRef)
  } catch (error) {
    // No local fallback for a scoped sender. Establishing here on an outage is
    // exactly the racing birth this tier exists to prevent, and it would be
    // unrecoverable: a birth cannot be taken back.
    const refused = error instanceof RegistryRefusedError
    return refuse(
      refused ? 'registry-refused' : 'registry-unreachable',
      `Cannot designate a birth node for ${scopeRef}: ${error instanceof Error ? error.message : String(error)}. Refusing to birth it locally, because a local fallback on every node is the simultaneous birth this designation exists to prevent.`,
      { retryable: !refused }
    )
  }

  // No birth envelope, a scope-less sender, or a sender the registry does not
  // know. Nothing was recorded, and today's tier 5 is the pre-existing law for
  // that class — explicitly out of scope of this change.
  if (result.kind === 'none') return designated

  const designation = result.designation
  const known = deps.knownNodeIds
  if (known !== undefined && !known.includes(designation.homeNodeId)) {
    return refuse(
      'designated-home-unreachable',
      `${scopeRef} is designated to ${designation.homeNodeId} (from the home of ${designation.senderScopeRef}, birth envelope ${designation.birthEnvelopeId}), which is not a peer this node knows. Nothing here can birth it. Add that peer, or start the scope explicitly on a node that can reach it — an explicit start supersedes the designation.`,
      { retryable: true, homeNodeId: designation.homeNodeId, birthDesignation: designation }
    )
  }

  return {
    homeNodeId: designation.homeNodeId,
    selection: 'birth-designation',
    designation,
  }
}

async function decideVirginPolicyPlacement(
  request: SummonGateRequest,
  scopeRef: string,
  designated: DesignatedHome
): Promise<SummonGateEvaluation> {
  const { deps } = request
  const remotePolicyRefusal = nodeLocalRemoteEstablishRefusal(request, scopeRef, designated)
  if (remotePolicyRefusal !== undefined) return remotePolicyRefusal

  if (designated.homeNodeId === deps.localNodeId) {
    const birthDesignation = designationDecisionFor(designated)
    return await requireMaterializationCapability(
      request,
      allow('virgin-establishment', {
        homeNodeId: designated.homeNodeId,
        ...(birthDesignation === undefined ? {} : { birthDesignation }),
      })
    )
  }

  const designation = designated.designation
  if (designation !== undefined) {
    // Not `routed-elsewhere`: that reason invites a remote-establish
    // disposition, and a designated birth is deliberately NOT delegated. The
    // designated node's own kicker births it from the same ledger insert, its
    // own capability check runs there, and a failure is then visible on exactly
    // one node instead of racing across every node that tailed the insert.
    return refuse(
      'birth-designated-elsewhere',
      `${scopeRef} is designated to be born on ${designation.homeNodeId}, following the home of ${designation.senderScopeRef}, which sent its birth envelope ${designation.birthEnvelopeId}. This node is ${deps.localNodeId} and takes no part in the birth; ${designation.homeNodeId} births it from the same ledger insert. An explicit start, a pin, or a +node= dispatch supersedes the designation.`,
      { homeNodeId: designation.homeNodeId, birthDesignation: designation }
    )
  }

  if (designated.matchedConstraint !== undefined) {
    if (designated.matchedConstraint.kind === 'task-default') {
      const taskKey = designated.matchedConstraint.key
      return refuse(
        'pin-mismatch',
        `${scopeRef} matches placement home [placement.homes] "${taskKey}" = "${designated.homeNodeId}"; it establishes and summons only there. This node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}, or change that home line.`,
        {
          homeNodeId: designated.homeNodeId,
          remoteEstablishmentAllowed: true,
        }
      )
    }
    return refuse(
      'pin-mismatch',
      `${scopeRef} is pinned to ${designated.homeNodeId}; it establishes and summons only there. This node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}, or change the pin.`,
      {
        homeNodeId: designated.homeNodeId,
        remoteEstablishmentAllowed: true,
      }
    )
  }

  return refuse(
    'routed-elsewhere',
    `${scopeRef} routes to ${designated.homeNodeId} by provisioning.node; this node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}.`,
    {
      homeNodeId: designated.homeNodeId,
      ...(permitsRemoteEstablishment(designated) ? { remoteEstablishmentAllowed: true } : {}),
    }
  )
}

async function decide(request: SummonGateRequest): Promise<SummonGateEvaluation> {
  const { deps } = request

  // Synthetic, non-agent scopes (`app:<appId>` gateway containers) are not
  // policy-born agent summons: they have no agent profile, therefore no
  // [placement] stanza, and no ledger binding could ever be written for them.
  // Placement is meaningless here, so the gate abstains rather than manufacturing
  // an undeclared-placement refusal for a scope that can never declare one.
  //
  // This is NOT a hole in the coverage: a gateway summoning a real AGENT does it
  // through /v1/messages/dm, which is gated on the `ensure-target` path. Only the
  // app container itself lands here.
  let scopeRef: string
  try {
    scopeRef = formatCanonicalScopeRef({ scopeRef: request.scopeRef })
  } catch {
    return allow('non-agent-scope')
  }

  // The permanent local retirement fence is checked before every other source
  // of authority. Federation v1.3 never permits a later epoch to supersede it.
  const localRecord = deps.ledger.get?.(scopeRef)
  if (localRecord?.state === 'retired') {
    return refuse(
      'scope-retired',
      `${scopeRef} is permanently retired on ${deps.localNodeId}; establish it fresh on another node after the shared binding is absent.`
    )
  }
  const local =
    deps.ledger.get === undefined
      ? deps.ledger.activeAuthority(scopeRef)
      : localRecord?.state === 'active'
        ? localRecord
        : undefined
  if (local !== undefined) {
    if (local.homeNodeId === deps.localNodeId) {
      return await requireMaterializationCapability(
        request,
        allow('local-authority', {
          homeNodeId: local.homeNodeId,
          placementBinding: local,
        })
      )
    }
    return refuse(
      'bound-elsewhere',
      `${scopeRef} is homed on ${local.homeNodeId}, not this node (${deps.localNodeId}). Summon it there.`,
      { homeNodeId: local.homeNodeId, placementBinding: local }
    )
  }

  // (3) No local row is NOT the virgin predicate (§5) — the registry is.
  let consult: Awaited<ReturnType<BindingRegistryClient['consult']>>
  try {
    consult = await deps.registry.consult(scopeRef)
  } catch (error) {
    if (error instanceof RegistryRefusedError) {
      return refuse(
        'registry-refused',
        `The binding registry refused this node's consult for ${scopeRef} (${error.status} ${error.code}). This is a configuration defect, not a transient failure — retrying will not help. Check this node's peer entry and bearer token in federation.json.`,
        { retryable: false }
      )
    }
    // Every unclassified failure lands here on purpose. An unclassified error
    // reading as `unbound` would mint a second authority for this scope.
    const detail = error instanceof RegistryUnreachableError ? error.message : String(error)
    return refuse(
      'registry-unreachable',
      `Cannot reach the binding registry to establish ${scopeRef} (${detail}). Refusing rather than risking a second authority for this scope; retry once the registry node is reachable.`,
      { retryable: true }
    )
  }

  if (consult.outcome === 'bound') {
    const bound = consult.binding
    if (bound.homeNodeId === deps.localNodeId) {
      // Registered here but no local row: the crash window in registry-first
      // establishment. Converging is correct; this is not a virgin birth.
      return await requireMaterializationCapability(
        request,
        allow('registry-bound-local', {
          homeNodeId: bound.homeNodeId,
          registryBinding: bound,
        })
      )
    }
    return refuse(
      'bound-elsewhere',
      `${scopeRef} is already established on ${bound.homeNodeId}. A placement policy edit alone never grants this node authority.`,
      { homeNodeId: bound.homeNodeId, placementBinding: bound }
    )
  }

  // The registry proved the scope unbound: normal policy chooses a fresh home.
  let policy: SummonGatePolicy | undefined
  try {
    policy = await deps.policyFor(scopeRef)
  } catch (error) {
    return refuse(
      'policy-unavailable',
      `Cannot resolve placement policy for ${scopeRef}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }

  if (!request.participantClaim && policy?.placement?.launch === 'participant-only') {
    return refuse(
      'participant-only',
      `${scopeRef} is participant-only, no seat registered. Register its direct participant before sending mail to this scope.`
    )
  }

  const declared = resolveDesignatedHome(scopeRef, policy, deps.localNodeId, request.intent, {
    provision: request.provision,
    knownNodeIds: deps.knownNodeIds,
  })
  if (isEvaluation(declared)) return declared
  const designated = await applyBirthDesignation(request, scopeRef, declared)
  if (isEvaluation(designated)) return designated
  return await decideVirginPolicyPlacement(request, scopeRef, designated)
}

function placementDispositionFor(
  request: SummonGateRequest,
  evaluation: SummonGateEvaluation
): PlacementDisposition | undefined {
  if (evaluation.decision === 'refuse') {
    if (evaluation.reason === 'bound-elsewhere' && evaluation.placementBinding !== undefined) {
      return { outcome: 'remote-bound', binding: evaluation.placementBinding }
    }
    if (
      request.intent === 'implicit' &&
      evaluation.homeNodeId !== undefined &&
      evaluation.remoteEstablishmentAllowed === true &&
      (evaluation.reason === 'pin-mismatch' || evaluation.reason === 'routed-elsewhere')
    ) {
      return {
        outcome: 'remote-establish',
        kind: 'virgin-policy',
        candidateHomeNodeId: evaluation.homeNodeId,
        reason: evaluation.reason,
      }
    }
    return {
      outcome: 'refuse',
      reason: evaluation.reason,
      retryable: evaluation.retryable,
      diagnostic: evaluation.diagnostic,
      ...(evaluation.homeNodeId === undefined ? {} : { homeNodeId: evaluation.homeNodeId }),
    }
  }

  if (evaluation.reason === 'local-authority' && evaluation.placementBinding !== undefined) {
    return {
      outcome: 'local-bound',
      binding: evaluation.placementBinding,
      source: 'local-ledger',
    }
  }
  if (evaluation.reason === 'registry-bound-local' && evaluation.registryBinding !== undefined) {
    return {
      outcome: 'local-bound',
      binding: evaluation.registryBinding,
      source: 'registry',
    }
  }
  if (evaluation.reason === 'virgin-establishment' && evaluation.homeNodeId !== undefined) {
    return {
      outcome: 'local-establish',
      kind: 'virgin-policy',
      homeNodeId: evaluation.homeNodeId,
      ...(evaluation.birthDesignation === undefined
        ? {}
        : { birthDesignation: evaluation.birthDesignation }),
    }
  }
  return undefined
}

/**
 * Evaluates the gate for one session-creation attempt.
 *
 * Never throws: a session-creation path must always get a decision back, and an
 * escaping exception would be an invisible failure on the exact paths F0 exists
 * to make visible.
 */
export async function evaluateSummonGate(request: SummonGateRequest): Promise<SummonGateResult> {
  const { deps } = request

  // Dark first, before any I/O. An unconfigured daemon must be byte-identical
  // to one built before this file existed.
  if (deps.mode === 'off' || !deps.federationConfigured) {
    return { evaluation: allow('gate-dark'), enforced: false, mode: deps.mode }
  }

  let evaluation: SummonGateEvaluation
  try {
    evaluation = await decide(request)
  } catch (error) {
    evaluation = refuse(
      'policy-unavailable',
      `Summon gate evaluation failed for ${request.scopeRef}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }

  const enforced = deps.mode === 'enforce' && evaluation.decision === 'refuse'

  if (evaluation.decision === 'refuse') {
    // One event name across advisory and enforce so a single grep pattern
    // covers the soak and everything after the flip.
    deps.log?.('WARN', SUMMON_GATE_REFUSAL_EVENT, {
      path: request.path,
      scopeRef: request.scopeRef,
      reason: evaluation.reason,
      wouldBeDecision: 'refuse',
      enforced,
      mode: deps.mode,
      retryable: evaluation.retryable,
      localNodeId: deps.localNodeId,
      ...(evaluation.homeNodeId === undefined ? {} : { homeNodeId: evaluation.homeNodeId }),
      ...(evaluation.capability === undefined ? {} : { capability: evaluation.capability }),
      ...(evaluation.capabilitySource === undefined
        ? {}
        : { capability_source: evaluation.capabilitySource }),
      intent: request.intent,
      // Retained after T-06609 so soak records stay self-describing: a line
      // reading `legacy-boolean` came from the T-06608 derivation, a line
      // reading `typed` from a signal the caller actually sent.
      intentSource: 'typed',
      diagnostic: evaluation.diagnostic,
    })
  }

  const placement = placementDispositionFor(request, evaluation)
  return {
    evaluation,
    ...(placement === undefined ? {} : { placement }),
    enforced,
    mode: deps.mode,
  }
}

export async function resolvePlacementDisposition(
  request: SummonGateRequest
): Promise<PlacementDisposition | undefined> {
  return (await evaluateSummonGate(request)).placement
}
