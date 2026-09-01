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
import type { ProvisioningScalars } from 'agent-scope'
import type {
  BirthDesignationRecord,
  BirthDesignationResult,
  FederationPlacementSource,
  PlacementBinding,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'
import { ROSTER_SLOT_TOKENS, type RuntimePlacement } from 'spaces-config'

import { formatCanonicalScopeRef } from 'hrc-core'
import type { HrcHarnessIntent, SummonIntent } from 'hrc-core'

import { isReservedNodeId, isValidNodeId } from './node-id.js'
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
  | `capability-${SummonCapabilityName}-missing`
  | 'capability-project-root-unresolvable'
  | 'capability-observation-failed'
  | 'zombie-runtime'
  /**
   * T-07398 — the three directive refusals. They are refusals of the REQUEST,
   * not of this node's authority, so the server maps them to their own typed
   * wire codes rather than folding them into `stale_context`.
   */
  | 'placement-directive-conflict'
  | 'unknown-node'
  | 'invalid-provision-value'
  /**
   * T-07655 — the two tier-5 birth-designation refusals. Neither is a race
   * lost: they are what stops every node that tailed one ledger insert from
   * racing for the same virgin birth.
   *
   * `birth-designated-elsewhere` means the registry designated another node,
   * which will birth it from the same insert. `designated-home-unreachable`
   * means the designated node is not a peer this daemon knows, so nobody here
   * can act and an operator has to see it.
   */
  | 'birth-designated-elsewhere'
  | 'designated-home-unreachable'
  /** The establish fence itself, when a designated birth loses the CAS. */
  | 'birth-designation-mismatch'

/** Node-local facts required to materialize an agent scope (§5). */
export type SummonCapabilityName =
  | 'project-checkout'
  | 'agent-home-skills'
  | 'credentials'
  | 'harness'

/**
 * Observation made only after this node has summon authority.
 *
 * Capability is deliberately unable to name another node or return authority:
 * it can preserve the authority decision or turn it into a visible refusal,
 * never grant, move, or route authority.
 */
export type SummonCapabilityObservation =
  | { outcome: 'capable' }
  | {
      outcome: 'incapable'
      capability: SummonCapabilityName
      diagnostic: string
      capabilityReason?: 'project-root-unresolvable' | undefined
      retryable?: boolean | undefined
      capabilitySource?: 'presence-heuristic' | undefined
    }

/** Materialization inputs already resolved by an ingress such as hrcchat. */
export type SummonCapabilityHint = {
  placement?: RuntimePlacement | undefined
  harness?: HrcHarnessIntent | undefined
}

export type SummonGateEvaluation =
  | {
      decision: 'allow'
      reason: SummonGateAllowReason
      homeNodeId?: string | undefined
      placementSource?: FederationPlacementSource | undefined
      /** Registry authority to install locally after a registry-first crash. */
      registryBinding?: PlacementBinding | undefined
      /** Exact local authority observed by the placement resolver. */
      placementBinding?: PlacementBinding | undefined
    }
  | {
      decision: 'refuse'
      reason: SummonGateRefuseReason
      /** Whether retrying can plausibly succeed without an operator edit. */
      retryable: boolean
      /** Operator-facing text. Always names the next action. */
      diagnostic: string
      homeNodeId?: string | undefined
      capability?: SummonCapabilityName | undefined
      capabilitySource?: 'presence-heuristic' | undefined
      /** Exact established remote authority; present only for bound-elsewhere. */
      placementBinding?: PlacementBinding | undefined
      /** The live tier-5 designation this refusal is about (T-07655). */
      birthDesignation?: BirthDesignationRecord | undefined
      /** Policy provenance for an unbound implicit request naming a remote home. */
      candidateFederationPlacementSource?:
        | Exclude<FederationPlacementSource, 'explicit_local' | 'default_home_node(local)'>
        | undefined
    }

/**
 * Closed placement result shared by every summon-capable ingress.
 *
 * This is a decision only. Consumers may route, establish, or refuse from the
 * result, but the resolver itself never writes authority, enqueues delivery,
 * or mints a session.
 */
export type PlacementDisposition =
  | {
      outcome: 'local-bound'
      binding: PlacementBinding
      source: 'local-ledger' | 'registry'
    }
  | {
      outcome: 'local-establish'
      kind: 'virgin-policy'
      homeNodeId: string
      provenance: FederationPlacementSource
    }
  | {
      outcome: 'remote-bound'
      binding: PlacementBinding
    }
  | {
      outcome: 'remote-establish'
      kind: 'virgin-policy'
      candidateHomeNodeId: string
      reason: 'pin-mismatch' | 'routed-elsewhere'
      policyProvenance: Exclude<
        FederationPlacementSource,
        'explicit_local' | 'default_home_node(local)'
      >
    }
  | {
      outcome: 'refuse'
      reason: SummonGateRefuseReason
      retryable: boolean
      diagnostic: string
      homeNodeId?: string | undefined
    }

export type SummonGateResult = {
  evaluation: SummonGateEvaluation
  /** Undefined only for the flag-dark and synthetic non-agent abstentions. */
  placement?: PlacementDisposition | undefined
  /** True only when a refusal actually bites — i.e. enforce mode. */
  enforced: boolean
  mode: SummonGateMode
}

/** Compiled placement policy (spaces-config `ResolvedAgentPolicy`, C-11100). */
export type SummonGatePolicy = {
  provisioning?:
    | {
        node?: string | undefined
      }
    | undefined
  placement?:
    | {
        pins: Record<string, string>
        homes: Record<string, string>
      }
    | undefined
  claimsTask: boolean
}

export type SummonGateDeps = {
  mode: SummonGateMode
  /** False when federation.json is absent — the dark path. */
  federationConfigured: boolean
  localNodeId: string
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority' | 'installActive'> &
    Partial<Pick<PlacementLedgerRepository, 'get'>>
  registry: BindingRegistryClient
  /**
   * Compiled placement policy for the scope. `undefined` means the profile
   * declares none — `agentPolicy` omitted entirely, which per C-11100 IS the
   * undeclared-placement signal for legacy profiles.
   */
  policyFor: (scopeRef: string) => Promise<SummonGatePolicy | undefined>
  /** Observes node-local materialization facts after authority allows. */
  capabilityFor?:
    | ((
        scopeRef: string,
        hint?: SummonCapabilityHint | undefined
      ) => Promise<SummonCapabilityObservation>)
    | undefined
  /**
   * Every node id this daemon knows: its own, plus its configured peers
   * (T-07398). A `node=` directive is validated against it at BOTH origin and
   * receiver — the receiver re-runs this derivation on its OWN registry rather
   * than trusting the resolution the origin forwarded.
   */
  knownNodeIds?: readonly string[] | undefined
  log?: SummonGateLog | undefined
}

export type SummonGateRequest = {
  scopeRef: string
  path: SummonPath
  intent: SummonIntent
  /** Remote bare addressing can route to an existing scope, never create claim authority. */
  origin?: 'local' | 'federated-ingress' | 'federated-establish' | 'startup-repair' | undefined
  /** Daemon-owned proof that the summon is a successor of a known local session. */
  knownSession?: boolean | undefined
  deps: SummonGateDeps
  capabilityHint?: SummonCapabilityHint | undefined
  /**
   * T-07398 — the explicit provisioning directive block carried by the request
   * body. `node=` is the only member placement reads, and it is admissible only
   * where `[placement]` is silent. This is a DECLARED request field, never an
   * ambient caller assertion: nothing here reads the caller's own node, its
   * transport, or its environment.
   */
  provision?: Partial<ProvisioningScalars> | undefined
}

/**
 * A key used by one of the two scoped placement policy levels.
 *
 * Exact pins use `project:task`; placement homes use only `task` and therefore
 * match that task name in every project. Returns undefined when the requested
 * key cannot be formed from the scope.
 */
export function placementPinKey(
  scopeRef: string,
  level: 'exact' | 'task-default' = 'exact'
): string | undefined {
  let parsed: ReturnType<typeof parseScopeRef>
  try {
    parsed = parseScopeRef(scopeRef)
  } catch {
    return undefined
  }
  if (parsed.taskId === undefined) return undefined
  if (level === 'task-default') return parsed.taskId
  if (parsed.projectId === undefined) return undefined
  return `${parsed.projectId}:${parsed.taskId}`
}

export function placementHomeDeclaration(
  scopeRef: string,
  homes: Record<string, string> | undefined
): { key: string; nodeId: string; inherited: boolean } | undefined {
  if (homes === undefined) return undefined
  const taskId = placementPinKey(scopeRef, 'task-default')
  if (taskId === undefined) return undefined
  const exact = homes[taskId]
  if (exact !== undefined) return { key: taskId, nodeId: exact, inherited: false }

  for (const suffix of ROSTER_SLOT_TOKENS) {
    const marker = `-${suffix}`
    if (!taskId.endsWith(marker)) continue
    const base = taskId.slice(0, -marker.length)
    const inherited = homes[base]
    if (inherited !== undefined) return { key: base, nodeId: inherited, inherited: true }
  }
  return undefined
}

function allow(
  reason: SummonGateAllowReason,
  extra: {
    homeNodeId?: string
    placementSource?: FederationPlacementSource
    registryBinding?: PlacementBinding
    placementBinding?: PlacementBinding
  } = {}
): Extract<SummonGateEvaluation, { decision: 'allow' }> {
  return { decision: 'allow', reason, ...extra }
}

function refuse(
  reason: SummonGateRefuseReason,
  diagnostic: string,
  options: {
    retryable?: boolean
    homeNodeId?: string
    capability?: SummonCapabilityName
    capabilitySource?: 'presence-heuristic'
    placementBinding?: PlacementBinding
    candidateFederationPlacementSource?: Exclude<
      FederationPlacementSource,
      'explicit_local' | 'default_home_node(local)'
    >
    birthDesignation?: BirthDesignationRecord
  } = {}
): SummonGateEvaluation {
  return {
    decision: 'refuse',
    reason,
    retryable: options.retryable ?? false,
    diagnostic,
    ...(options.homeNodeId === undefined ? {} : { homeNodeId: options.homeNodeId }),
    ...(options.capability === undefined ? {} : { capability: options.capability }),
    ...(options.capabilitySource === undefined
      ? {}
      : { capabilitySource: options.capabilitySource }),
    ...(options.placementBinding === undefined
      ? {}
      : { placementBinding: options.placementBinding }),
    ...(options.candidateFederationPlacementSource === undefined
      ? {}
      : { candidateFederationPlacementSource: options.candidateFederationPlacementSource }),
    ...(options.birthDesignation === undefined
      ? {}
      : { birthDesignation: options.birthDesignation }),
  }
}

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
    '  [provisioning]',
    `  node = "${localNodeId}"`,
    '',
    'Or pin this exact scope to a node:',
    '',
    '  [placement.pins]',
    `  "${placementPinKey(scopeRef) ?? '<project>:<task>'}" = "${localNodeId}"`,
  ].join('\n')
}

/**
 * Resolves where placement says a VIRGIN scope should be born.
 *
 * Precedence, highest first (T-07398 amended law, praesidium-root 913bfcd):
 *
 *   1. **exact pin** — a hard constraint on every path (§5).
 *   2. **placement home** — cross-project task-name policy with the same matched
 *      constraint semantics as a pin, including the reserved-family derivation
 *      (a declared base reserves its roster-slot names). Neither is overridden
 *      by explicitness.
 *   3. **`node=` directive** — an explicit, typed, dual-validated request field.
 *      It FILLS GAPS: admissible only where `[placement]` is silent, and a
 *      disagreement with tier 1 or 2 is a hard typed failure rather than a
 *      silent demotion. This is not the forbidden ambient caller assertion —
 *      nothing about placement is inferred from the caller's node, transport or
 *      environment; the directive is a field of the request, re-derived here on
 *      the receiver against the receiver's OWN policy and registry.
 *   4. **explicit_local** — for a scope no declaration and no directive reaches,
 *      the operator's start at this node IS the placement declaration (§5
 *      "explicit operator start wins"). A directive is more specific than
 *      "here", which is why it sits above this.
 *   5. **provisioning.node** — where implicit summons route.
 *
 * Reaching this function at all already means the registry answered `unbound`,
 * which is what confines explicit-start-wins to genuinely virgin scopes: it
 * decides where a scope with no binding is born, never who takes one that
 * exists. The candidate home for an explicit start is `localNodeId` — this
 * daemon's OWN configured id — never anything the caller supplied.
 */
type DesignatedHome = {
  homeNodeId: string
  provenance: FederationPlacementSource
  matchedConstraint?:
    | { kind: 'pin'; key: string }
    | { kind: 'task-default'; key: string }
    | undefined
  /** Present only for a tier-5 home that came from a birth designation. */
  designation?: BirthDesignationRecord | undefined
}

/**
 * Validate the `node=` member of a directive block against node grammar and the
 * federation registry, INDEPENDENTLY of what the scope's policy says.
 *
 * Validation is deliberately first, ahead of every precedence tier: a directive
 * naming a node that does not exist is wrong whether or not the scope it names
 * happens to be pinned, and an operator debugging a typo should be told about
 * the typo rather than about a conflict.
 *
 * Returns `undefined` when the block carries no `node=` at all.
 */
export function resolvePlacementDirectiveNode(
  provision: Partial<ProvisioningScalars> | undefined,
  knownNodeIds: readonly string[] | undefined
): { nodeId: string } | SummonGateEvaluation | undefined {
  const raw = provision?.node
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return refuse(
      'invalid-provision-value',
      'The provisioning directive "node" must name a node id. Spell it as node=<nodeId>.'
    )
  }
  const nodeId = raw.trim()
  if (isReservedNodeId(nodeId)) {
    return refuse(
      'invalid-provision-value',
      `The provisioning directive node="${nodeId}" is invalid: "local" is not a node id — the sentinel was deleted, and omitting the directive is what means "here". Name a real node.`
    )
  }
  if (!isValidNodeId(nodeId)) {
    return refuse(
      'invalid-provision-value',
      `The provisioning directive node="${nodeId}" is not a valid node id (allowed: A-Z a-z 0-9 . _ -, up to 64 characters).`
    )
  }
  if (knownNodeIds !== undefined && !knownNodeIds.includes(nodeId)) {
    return refuse(
      'unknown-node',
      `The provisioning directive node="${nodeId}" names no node this daemon knows. Known nodes: ${knownNodeIds.join(', ')}. Add it to the federation peer registry, or name one of those.`
    )
  }
  return { nodeId }
}

function directiveConflict(
  scopeRef: string,
  declared: { kind: 'pin' | 'placement home'; key: string; nodeId: string },
  directedNodeId: string
): SummonGateEvaluation {
  return refuse(
    'placement-directive-conflict',
    `${scopeRef} is declared by ${declared.kind} "${declared.key}" = "${declared.nodeId}", but the request directs node="${directedNodeId}". A directive fills a gap in [placement]; it never moves a declared scope. Summon it on ${declared.nodeId}, or change that declaration.`,
    { homeNodeId: declared.nodeId }
  )
}

function resolveDesignatedHome(
  scopeRef: string,
  policy: SummonGatePolicy | undefined,
  localNodeId: string,
  intent: SummonIntent,
  directiveInput?:
    | {
        provision?: Partial<ProvisioningScalars> | undefined
        knownNodeIds?: readonly string[] | undefined
      }
    | undefined
): DesignatedHome | SummonGateEvaluation {
  const placement = policy?.placement

  const directive = resolvePlacementDirectiveNode(
    directiveInput?.provision,
    directiveInput?.knownNodeIds
  )
  if (isEvaluation(directive)) return directive

  const pinKey = placementPinKey(scopeRef)
  const pin = pinKey === undefined ? undefined : placement?.pins[pinKey]

  if (pinKey !== undefined && pin !== undefined) {
    // A pin meaning "wherever" is not a pin (§5).
    if (isReservedNodeId(pin)) {
      return refuse(
        'invalid-pin',
        `Placement pin "${pinKey}" = "${pin}" is invalid: "local" is not a node id. Name a real node.`
      )
    }
    if (directive !== undefined && directive.nodeId !== pin) {
      return directiveConflict(
        scopeRef,
        { kind: 'pin', key: pinKey, nodeId: pin },
        directive.nodeId
      )
    }
    return {
      homeNodeId: pin,
      provenance: 'pin',
      matchedConstraint: { kind: 'pin', key: pinKey },
    }
  }

  const home = placementHomeDeclaration(scopeRef, placement?.homes)
  if (home !== undefined) {
    if (isReservedNodeId(home.nodeId)) {
      return refuse(
        'invalid-pin',
        `Placement home [placement.homes] "${home.key}" = "${home.nodeId}" is invalid: "local" is not a node id. Name a real node.`
      )
    }
    if (directive !== undefined && directive.nodeId !== home.nodeId) {
      return directiveConflict(
        scopeRef,
        { kind: 'placement home', key: home.key, nodeId: home.nodeId },
        directive.nodeId
      )
    }
    return {
      homeNodeId: home.nodeId,
      provenance: 'task_default',
      matchedConstraint: { kind: 'task-default', key: home.key },
    }
  }

  // Nothing in [placement] speaks for this scope, so the directive places it.
  // `matchedConstraint` stays absent on purpose: a directive is a defaults-tier
  // input, not a declared constraint, so it must not acquire pin-mismatch
  // diagnostics or pin-grade authority anywhere downstream.
  if (directive !== undefined) {
    return { homeNodeId: directive.nodeId, provenance: 'default_home_node' }
  }

  // The scope is virgin and unconstrained, and a human ran `hrc run`/`hrc start`
  // right here. That is a legitimate one-shot declaration (§5), so it needs no
  // pre-declared policy — including on a profile with no [placement] stanza at
  // all.
  if (intent === 'explicit_local') {
    return { homeNodeId: localNodeId, provenance: 'explicit_local' }
  }

  const fallback = policy?.provisioning?.node
  if (fallback === undefined && policy !== undefined) {
    // T-07398 v3: OMISSION MEANS LOCAL. v3 deleted the
    // `default_home_node = "local"` sentinel and moved its meaning onto the
    // absent key, so a profile with no `provisioning.node` is not silent about
    // placement — it is saying "born here". The pre-v3 refusal on this branch
    // was the other half of a sentinel that no longer exists, and leaving it
    // meant every implicit summon of a fresh scope died with
    // "No placement declared ...", i.e. every `hrcchat dm` to a task scope
    // nobody had declared (C-15413 D1). `explicit_local` already fell through
    // above, which is exactly why `hrc start` kept working while the dm/ensure
    // door did not.
    //
    // This is the LAST tier, reached only when no pin, no home and no directive
    // spoke: every declaration above still wins, and a directive still cannot
    // move a declared scope.
    //
    // Scoped to a RESOLVED policy on purpose. `policyFor` returning undefined is
    // a different fact from a profile that omits the key: per the C-11100 note
    // on `SummonGateDeps.policyFor` it means no agent policy could be determined
    // at all, and a real v3 profile — even a bare `version = 3` — resolves to a
    // policy OBJECT (see placement-policy.ts: only `not-an-agent-scope` yields
    // undefined; a missing or unreadable profile throws into `policy-unavailable`
    // instead). So "omitted" here means what the addendum says it means — a
    // profile that declares no node — and the undeclared refusal below still
    // covers the case where the daemon could not establish any policy to read.
    return { homeNodeId: localNodeId, provenance: 'default_home_node(local)' }
  }

  if (fallback === undefined) {
    return refuse('undeclared-placement', undeclaredPlacementDiagnostic(scopeRef, localNodeId))
  }

  if (isReservedNodeId(fallback)) {
    return refuse(
      'invalid-pin',
      `Provisioning node "${fallback}" is invalid: "local" is not a node id. Name a real node.`
    )
  }
  return { homeNodeId: fallback, provenance: 'default_home_node' }
}

/**
 * Resolves the named home in declared policy without consulting authority or
 * capability. EPR grant issuance uses this projection only for its optional,
 * non-gating advisory; reconciliation still runs the full placement resolver.
 */
export function resolveDeclaredPlacementHome(
  scopeRef: string,
  policy: SummonGatePolicy | undefined,
  localNodeId: string,
  directiveInput?:
    | {
        provision?: Partial<ProvisioningScalars> | undefined
        knownNodeIds?: readonly string[] | undefined
      }
    | undefined
):
  | {
      homeNodeId: string
      provenance: FederationPlacementSource
    }
  | undefined {
  const resolved = resolveDeclaredPlacementHomeOrRefusal(
    scopeRef,
    policy,
    localNodeId,
    directiveInput
  )
  return resolved === undefined || 'decision' in resolved ? undefined : resolved
}

/**
 * The same projection, but WITH the refusal a directive can produce.
 *
 * Callers that carry a directive block need the typed refusal rather than the
 * bare `undefined` a policy-only projection collapses it to — otherwise a
 * `node=` disagreeing with a declared family home reads downstream as "the base
 * declares no home here", which is a different fact with a different fix.
 * Delegating keeps ONE implementation of the precedence; this only chooses how
 * much of its answer the caller can see.
 */
export function resolveDeclaredPlacementHomeOrRefusal(
  scopeRef: string,
  policy: SummonGatePolicy | undefined,
  localNodeId: string,
  directiveInput?:
    | {
        provision?: Partial<ProvisioningScalars> | undefined
        knownNodeIds?: readonly string[] | undefined
      }
    | undefined
):
  | {
      homeNodeId: string
      provenance: FederationPlacementSource
    }
  | Extract<SummonGateEvaluation, { decision: 'refuse' }>
  | undefined {
  const designated = resolveDesignatedHome(
    scopeRef,
    policy,
    localNodeId,
    'implicit',
    directiveInput
  )
  if (isEvaluation(designated)) {
    return designated.decision === 'refuse' ? designated : undefined
  }
  return { homeNodeId: designated.homeNodeId, provenance: designated.provenance }
}

function isEvaluation(value: unknown): value is SummonGateEvaluation {
  return typeof value === 'object' && value !== null && 'decision' in value
}

function nodeLocalRemoteEstablishRefusal(
  request: SummonGateRequest,
  scopeRef: string,
  provenance: FederationPlacementSource
): SummonGateEvaluation | undefined {
  if (
    request.origin !== 'federated-establish' ||
    (provenance !== 'explicit_local' && provenance !== 'default_home_node(local)')
  ) {
    return undefined
  }
  return refuse(
    'routed-elsewhere',
    `${scopeRef} has no concrete named-node policy granting remote establishment authority; ${provenance} is node-local only.`,
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
  if (designated.provenance !== 'default_home_node(local)') return designated
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
    provenance: designation.provenance,
    designation,
  }
}

async function decideVirginPolicyPlacement(
  request: SummonGateRequest,
  scopeRef: string,
  designated: DesignatedHome
): Promise<SummonGateEvaluation> {
  const { deps } = request
  const remotePolicyRefusal = nodeLocalRemoteEstablishRefusal(
    request,
    scopeRef,
    designated.provenance
  )
  if (remotePolicyRefusal !== undefined) return remotePolicyRefusal

  if (designated.homeNodeId === deps.localNodeId) {
    return await requireMaterializationCapability(
      request,
      allow('virgin-establishment', {
        homeNodeId: designated.homeNodeId,
        placementSource: designated.provenance,
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
          candidateFederationPlacementSource: 'task_default',
        }
      )
    }
    return refuse(
      'pin-mismatch',
      `${scopeRef} is pinned to ${designated.homeNodeId}; it establishes and summons only there. This node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}, or change the pin.`,
      {
        homeNodeId: designated.homeNodeId,
        candidateFederationPlacementSource: 'pin',
      }
    )
  }

  return refuse(
    'routed-elsewhere',
    `${scopeRef} routes to ${designated.homeNodeId} by provisioning.node; this node is ${deps.localNodeId}. Summon it on ${designated.homeNodeId}.`,
    {
      homeNodeId: designated.homeNodeId,
      ...(designated.provenance === 'explicit_local' ||
      designated.provenance === 'default_home_node(local)'
        ? {}
        : { candidateFederationPlacementSource: designated.provenance }),
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
      evaluation.candidateFederationPlacementSource !== undefined &&
      (evaluation.reason === 'pin-mismatch' || evaluation.reason === 'routed-elsewhere')
    ) {
      return {
        outcome: 'remote-establish',
        kind: 'virgin-policy',
        candidateHomeNodeId: evaluation.homeNodeId,
        reason: evaluation.reason,
        policyProvenance: evaluation.candidateFederationPlacementSource,
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
  if (
    evaluation.reason === 'virgin-establishment' &&
    evaluation.homeNodeId !== undefined &&
    evaluation.placementSource !== undefined
  ) {
    return {
      outcome: 'local-establish',
      kind: 'virgin-policy',
      homeNodeId: evaluation.homeNodeId,
      provenance: evaluation.placementSource,
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
