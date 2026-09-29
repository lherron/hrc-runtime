import { parseScopeRef } from 'agent-scope'
import type { ProvisioningScalars } from 'agent-scope'
import { ROSTER_SLOT_TOKENS } from 'hrc-core'
import type {
  BirthDesignationEstablishmentDecision,
  BirthDesignationRecord,
  PlacementBinding,
} from 'hrc-store-sqlite'

import { isReservedNodeId, isValidNodeId } from './node-id.js'
import type {
  SummonCapabilityName,
  SummonGateAllowReason,
  SummonGateEvaluation,
  SummonGatePolicy,
  SummonGateRefuseReason,
  SummonIntent,
} from './summon-gate-types.js'

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

export function allow(
  reason: SummonGateAllowReason,
  extra: {
    homeNodeId?: string
    birthDesignation?: BirthDesignationEstablishmentDecision
    registryBinding?: PlacementBinding
    placementBinding?: PlacementBinding
  } = {}
): Extract<SummonGateEvaluation, { decision: 'allow' }> {
  return { decision: 'allow', reason, ...extra }
}

export function refuse(
  reason: SummonGateRefuseReason,
  diagnostic: string,
  options: {
    retryable?: boolean
    homeNodeId?: string
    capability?: SummonCapabilityName
    capabilitySource?: 'presence-heuristic'
    placementBinding?: PlacementBinding
    remoteEstablishmentAllowed?: true
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
    ...(options.remoteEstablishmentAllowed === undefined
      ? {}
      : { remoteEstablishmentAllowed: options.remoteEstablishmentAllowed }),
    ...(options.birthDesignation === undefined
      ? {}
      : { birthDesignation: options.birthDesignation }),
  }
}

/**
 * The refusal text for a profile that never declared where its scopes live.
 *
 * §5 requires this name the exact stanza line to add rather than reporting a
 * bare "not configured" — an operator reading this should be able to paste the
 * fix without opening the spec.
 */
export function undeclaredPlacementDiagnostic(scopeRef: string, localNodeId: string): string {
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
export type DesignatedHome = {
  homeNodeId: string
  selection:
    | 'pin'
    | 'task-default'
    | 'directive'
    | 'explicit-local'
    | 'local-default'
    | 'configured-default'
    | 'birth-designation'
  matchedConstraint?:
    | { kind: 'pin'; key: string }
    | { kind: 'task-default'; key: string }
    | undefined
  /** Present only for a tier-5 home that came from a birth designation. */
  designation?: BirthDesignationRecord | undefined
}

export function designationDecisionFor(
  home: DesignatedHome
): BirthDesignationEstablishmentDecision | undefined {
  switch (home.selection) {
    case 'pin':
      return { action: 'supersede', supersededBy: 'pin' }
    case 'task-default':
      return { action: 'supersede', supersededBy: 'task_default' }
    case 'directive':
    case 'configured-default':
      return { action: 'supersede', supersededBy: 'default_home_node' }
    case 'explicit-local':
      return { action: 'supersede', supersededBy: 'explicit_local' }
    case 'birth-designation':
      return { action: 'enforce-designated-home' }
    case 'local-default':
      return undefined
  }
}

export function permitsRemoteEstablishment(home: DesignatedHome): boolean {
  return (
    home.selection === 'pin' ||
    home.selection === 'task-default' ||
    home.selection === 'directive' ||
    home.selection === 'configured-default'
  )
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

export function resolveDesignatedHome(
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
      selection: 'pin',
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
      selection: 'task-default',
      matchedConstraint: { kind: 'task-default', key: home.key },
    }
  }

  // Nothing in [placement] speaks for this scope, so the directive places it.
  // `matchedConstraint` stays absent on purpose: a directive is a defaults-tier
  // input, not a declared constraint, so it must not acquire pin-mismatch
  // diagnostics or pin-grade authority anywhere downstream.
  if (directive !== undefined) {
    return { homeNodeId: directive.nodeId, selection: 'directive' }
  }

  // The scope is virgin and unconstrained, and a human ran `hrc run`/`hrc start`
  // right here. That is a legitimate one-shot declaration (§5), so it needs no
  // pre-declared policy — including on a profile with no [placement] stanza at
  // all.
  if (intent === 'explicit_local') {
    return { homeNodeId: localNodeId, selection: 'explicit-local' }
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
    return { homeNodeId: localNodeId, selection: 'local-default' }
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
  return { homeNodeId: fallback, selection: 'configured-default' }
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
): { homeNodeId: string } | undefined {
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
): { homeNodeId: string } | Extract<SummonGateEvaluation, { decision: 'refuse' }> | undefined {
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
  return { homeNodeId: designated.homeNodeId }
}

export function isEvaluation(value: unknown): value is SummonGateEvaluation {
  return typeof value === 'object' && value !== null && 'decision' in value
}
