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

import { parseScopeRef } from 'agent-scope'
import type { EstablishmentProvenance, PlacementLedgerRepository } from 'hrc-store-sqlite'

import { formatCanonicalScopeRef } from 'hrc-core'
import type { SummonIntent } from 'hrc-core'

import { isReservedNodeId } from './node-id.js'
import { RegistryRefusedError, RegistryUnreachableError } from './registry-client.js'
import type { BindingRegistryClient } from './registry-client.js'

/** Structured-log sink. Matches `writeServerLog` (server-log.ts) by shape. */
export type SummonGateLog = (
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  details?: Record<string, unknown>
) => void

/** Single greppable event for the soak and for life after the enforce flip. */
export const SUMMON_GATE_REFUSAL_EVENT = 'federation.summon_gate.refusal'

export type SummonGateMode = 'off' | 'advisory' | 'enforce'

/**
 * The five session-creation paths the gate covers (enumerated on T-06608).
 *
 * `rotateSessionContext` and the sweep-summary row are deliberately NOT here:
 * a rotation continues an already-summoned agent rather than summoning one, and
 * the sweep row is synthetic bookkeeping under `system:hrc/sweep`, not an agent.
 * Both exemptions are documented rather than silent because `rotateSessionContext`
 * fires via `maybeAutoRotateStaleSession` on nearly every ingress.
 */
export type SummonPath =
  | 'ensure-target'
  | 'archived-successor'
  | 'resolve-session'
  | 'command-run'
  | 'app-session'

/**
 * Why this node was asked to summon (T-06609). Re-exported from the wire
 * contract so the gate and the HTTP surface can never drift apart on the
 * spelling of a value the whole placement rule turns on.
 *
 * This replaces T-06608's provisional derivation from the `create` /
 * `createIfMissing` booleans, and with it the `intentSource: 'legacy-boolean'`
 * tag those events carried.
 */
export type { SummonIntent }

/** Node-local retirement mark written by reconciliation (T-06614 C-11125). */
export type ScopeRetirement = {
  retiredNodeId: string
  canonicalHomeNodeId: string
  canonicalPlacementEpoch: number
  reason: string
}

export type SummonGateAllowReason =
  | 'gate-dark'
  | 'non-agent-scope'
  | 'local-authority'
  | 'registry-bound-local'
  | 'virgin-establishment'

export type SummonGateRefuseReason =
  | 'scope-retired'
  | 'bound-elsewhere'
  | 'pin-mismatch'
  | 'invalid-pin'
  | 'routed-elsewhere'
  | 'undeclared-placement'
  | 'policy-unavailable'
  | 'registry-unreachable'
  | 'registry-refused'

export type SummonGateEvaluation =
  | {
      decision: 'allow'
      reason: SummonGateAllowReason
      homeNodeId?: string | undefined
      establishmentProvenance?: Exclude<EstablishmentProvenance, 'rebind'> | undefined
    }
  | {
      decision: 'refuse'
      reason: SummonGateRefuseReason
      /** Whether retrying can plausibly succeed without an operator edit. */
      retryable: boolean
      /** Operator-facing text. Always names the next action. */
      diagnostic: string
      homeNodeId?: string | undefined
    }

export type SummonGateResult = {
  evaluation: SummonGateEvaluation
  /** True only when a refusal actually bites — i.e. enforce mode. */
  enforced: boolean
  mode: SummonGateMode
}

/** Compiled placement policy (spaces-config `ResolvedAgentPolicy`, C-11100). */
export type SummonGatePolicy = {
  placement?:
    | {
        defaultHomeNode?: string | undefined
        pins: Record<string, string>
      }
    | undefined
  claimsTask: boolean
}

export type SummonGateDeps = {
  mode: SummonGateMode
  /** False when federation.json is absent — the dark path. */
  federationConfigured: boolean
  localNodeId: string
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority'>
  registry: BindingRegistryClient
  /**
   * Compiled placement policy for the scope. `undefined` means the profile
   * declares none — `agentPolicy` omitted entirely, which per C-11100 IS the
   * undeclared-placement signal for legacy profiles.
   */
  policyFor: (scopeRef: string) => Promise<SummonGatePolicy | undefined>
  /** Node-local retirement lookup (T-06614). Absent until that task lands. */
  retirementFor?: ((scopeRef: string) => ScopeRetirement | undefined) | undefined
  log?: SummonGateLog | undefined
}

export type SummonGateRequest = {
  scopeRef: string
  path: SummonPath
  intent: SummonIntent
  deps: SummonGateDeps
}

/**
 * The exact `project:task` scope key a `[placement]` pin is written against.
 *
 * Returns undefined for scopes with no task — pins are exact task-scope keys,
 * so agent- and project-scoped summons route by `default_home_node` alone.
 */
export function placementPinKey(scopeRef: string): string | undefined {
  let parsed: ReturnType<typeof parseScopeRef>
  try {
    parsed = parseScopeRef(scopeRef)
  } catch {
    return undefined
  }
  if (parsed.projectId === undefined || parsed.taskId === undefined) return undefined
  return `${parsed.projectId}:${parsed.taskId}`
}

function allow(
  reason: SummonGateAllowReason,
  extra: {
    homeNodeId?: string
    establishmentProvenance?: Exclude<EstablishmentProvenance, 'rebind'>
  } = {}
): SummonGateEvaluation {
  return { decision: 'allow', reason, ...extra }
}

function refuse(
  reason: SummonGateRefuseReason,
  diagnostic: string,
  options: { retryable?: boolean; homeNodeId?: string } = {}
): SummonGateEvaluation {
  return {
    decision: 'refuse',
    reason,
    retryable: options.retryable ?? false,
    diagnostic,
    ...(options.homeNodeId === undefined ? {} : { homeNodeId: options.homeNodeId }),
  }
}

/**
 * The refusal text for a profile that never declared where its scopes live.
 *
 * §5 requires this name the exact stanza line to add rather than reporting a
 * bare "not configured" — an operator reading this should be able to paste the
 * fix without opening the spec.
 */
function undeclaredPlacementDiagnostic(scopeRef: string, localNodeId: string): string {
  return [
    `No placement declared for ${scopeRef}, so this node cannot establish it.`,
    '',
    "Add to the agent's agent-profile.toml:",
    '',
    '  [placement]',
    `  default_home_node = "${localNodeId}"`,
    '',
    'Or pin this exact scope to a node:',
    '',
    '  [placement]',
    `  "${placementPinKey(scopeRef) ?? '<project>:<task>'}" = "${localNodeId}"`,
  ].join('\n')
}

/**
 * Resolves where placement says a VIRGIN scope should be born.
 *
 * Precedence, highest first:
 *
 *   1. **pin** — a hard constraint on every path (§5). Nothing overrides it,
 *      explicitness included.
 *   2. **explicit_local** — for an unpinned scope, the operator's start at this
 *      node IS the placement declaration (§5 "explicit operator start wins").
 *   3. **default_home_node** — where implicit summons route. `"local"` is the
 *      reserved sentinel meaning "the node accepting this birth", resolved ONCE
 *      here to the daemon's own configured nodeId and never reinterpreted
 *      downstream.
 *
 * Reaching this function at all already means the registry answered `unbound`,
 * which is what confines explicit-start-wins to genuinely virgin scopes: it
 * decides where a scope with no binding is born, never who takes one that
 * exists. The candidate home for an explicit start is `localNodeId` — this
 * daemon's OWN configured id — never anything the caller supplied.
 */
function resolveDesignatedHome(
  scopeRef: string,
  policy: SummonGatePolicy | undefined,
  localNodeId: string,
  intent: SummonIntent
):
  | { homeNodeId: string; provenance: Exclude<EstablishmentProvenance, 'rebind'> }
  | SummonGateEvaluation {
  const placement = policy?.placement

  const pinKey = placementPinKey(scopeRef)
  const pin = pinKey === undefined ? undefined : placement?.pins[pinKey]

  if (pin !== undefined) {
    // A pin meaning "wherever" is not a pin (§5).
    if (isReservedNodeId(pin)) {
      return refuse(
        'invalid-pin',
        `Placement pin "${pinKey}" = "${pin}" is invalid: "local" is the reserved default_home_node sentinel and cannot be used as a pin. Name a real node, or move the value to default_home_node.`
      )
    }
    return { homeNodeId: pin, provenance: 'pin' }
  }

  // The scope is virgin and unpinned, and a human ran `hrc run`/`hrc start`
  // right here. That is a legitimate one-shot declaration (§5), so it needs no
  // pre-declared policy — including on a profile with no [placement] stanza at
  // all. The undeclared-placement refusal below exists to stop an IMPLICIT
  // summon falling back silently; an explicit start is not a fallback.
  if (intent === 'explicit_local') {
    return { homeNodeId: localNodeId, provenance: 'explicit_local' }
  }

  if (placement === undefined) {
    return refuse('undeclared-placement', undeclaredPlacementDiagnostic(scopeRef, localNodeId))
  }

  const fallback = placement.defaultHomeNode
  if (fallback === undefined) {
    return refuse('undeclared-placement', undeclaredPlacementDiagnostic(scopeRef, localNodeId))
  }

  if (isReservedNodeId(fallback)) {
    // Resolved once, here, to this daemon's own configured nodeId.
    return { homeNodeId: localNodeId, provenance: 'default_home_node(local)' }
  }
  return { homeNodeId: fallback, provenance: 'default_home_node' }
}

function isEvaluation(value: unknown): value is SummonGateEvaluation {
  return typeof value === 'object' && value !== null && 'decision' in value
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

  // (1) Retirement, before any authority logic (T-06614 C-11125).
  //
  // Ordering is load-bearing: on a losing node the retirement mark is precisely
  // what must override an ACTIVE local ledger row. That node established the
  // scope independently pre-federation, so it legitimately holds authority —
  // check it after the ledger and the loser allows, and reconciliation never binds.
  const retirement = deps.retirementFor?.(scopeRef)
  if (retirement !== undefined && retirement.retiredNodeId === deps.localNodeId) {
    return refuse(
      'scope-retired',
      `${scopeRef} was retired on this node (${deps.localNodeId}) by namespace reconciliation. Its canonical home is ${retirement.canonicalHomeNodeId} (epoch ${retirement.canonicalPlacementEpoch}); summon it there.`,
      { homeNodeId: retirement.canonicalHomeNodeId }
    )
  }

  // (2) Local ledger — the hot path, deliberately free of network.
  const local = deps.ledger.activeAuthority(scopeRef)
  if (local !== undefined) {
    if (local.homeNodeId === deps.localNodeId) {
      return allow('local-authority', { homeNodeId: local.homeNodeId })
    }
    return refuse(
      'bound-elsewhere',
      `${scopeRef} is homed on ${local.homeNodeId} (epoch ${local.placementEpoch}), not this node (${deps.localNodeId}). Summon it on ${local.homeNodeId}; moving it requires a rebind.`,
      { homeNodeId: local.homeNodeId }
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
      return allow('registry-bound-local', { homeNodeId: bound.homeNodeId })
    }
    return refuse(
      'bound-elsewhere',
      `${scopeRef} is already established on ${bound.homeNodeId} (epoch ${bound.placementEpoch}). A placement policy edit alone never grants this node authority — summon it on ${bound.homeNodeId}, or rebind it.`,
      { homeNodeId: bound.homeNodeId }
    )
  }

  // (4) Virgin: placement policy decides where it is born.
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

  const designated = resolveDesignatedHome(scopeRef, policy, deps.localNodeId, request.intent)
  if (isEvaluation(designated)) return designated

  if (designated.homeNodeId === deps.localNodeId) {
    return allow('virgin-establishment', {
      homeNodeId: designated.homeNodeId,
      establishmentProvenance: designated.provenance,
    })
  }

  if (designated.provenance === 'pin') {
    // Pins are hard constraints on EVERY path — an explicit operator start at
    // the wrong node does not override one.
    return refuse(
      'pin-mismatch',
      `${scopeRef} is pinned to ${designated.homeNodeId}; it establishes and summons only there. This node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}, or change the pin.`,
      { homeNodeId: designated.homeNodeId }
    )
  }

  return refuse(
    'routed-elsewhere',
    `${scopeRef} routes to ${designated.homeNodeId} by default_home_node; this node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}.`,
    { homeNodeId: designated.homeNodeId }
  )
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
      intent: request.intent,
      // Retained after T-06609 so soak records stay self-describing: a line
      // reading `legacy-boolean` came from the T-06608 derivation, a line
      // reading `typed` from a signal the caller actually sent.
      intentSource: 'typed',
      diagnostic: evaluation.diagnostic,
    })
  }

  return { evaluation, enforced, mode: deps.mode }
}
