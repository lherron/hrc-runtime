import { parseScopeRef } from 'agent-scope'
import type { HrcServerLifecycleAction, HrcServerLifecycleCallerKind } from 'hrc-core'
import { HRC_LIFECYCLE_BREAK_GLASS, splitSessionRef } from 'hrc-core'

import type { LifecycleCredentialBinding } from './server-lifecycle-credentials.js'

/**
 * T-09861 §2 — who may stop or restart an HRC server, decided server-side only.
 *
 *  A. `mable@<any project>:primary` (any lane), verified by the ORIGIN daemon
 *     from a credential it minted; any target node.
 *  B. A CLOSED allowlist fixed in code: a Mable node-local seat on its own node
 *     only, admitted only when this daemon's DECLARED nodeId is the entry's
 *     node. Placement config plays no part, so no profile, pin, home or policy
 *     edit can widen it; a new entry is a reviewed code change. Never forwarded.
 *  C. Operator (Lance) — D1 is open, so the fail-closed base refuses every
 *     credential-less request and points at a Mable primary or break-glass.
 *
 * Env scope strings are attribution only. This enforcement stops accidental
 * and doctrinal violations and makes deliberate ones detectable and
 * attributable; it does not stop a determined same-uid actor.
 */

type NodeLocalLifecycleSeat = {
  readonly agentId: 'mable'
  /** undefined = any project. */
  readonly projectId: string | undefined
  readonly taskId: string
  readonly nodeId: string
  /** Rendered in refusals as "this node's Mable seat (<seat>)". */
  readonly seat: string
}

export const NODE_LOCAL_LIFECYCLE_SEATS: readonly NodeLocalLifecycleSeat[] = Object.freeze([
  {
    agentId: 'mable',
    projectId: undefined,
    taskId: 'minisvc',
    nodeId: 'svc',
    seat: 'mable@<project>:minisvc',
  },
  {
    agentId: 'mable',
    projectId: 'hrc-runtime',
    taskId: 'hrcdev',
    nodeId: 'hrcdev',
    seat: 'mable@hrc-runtime:hrcdev',
  },
])

export type LifecycleRefusalCode =
  | 'credential_missing'
  | 'credential_unknown'
  | 'credential_revoked'
  | 'credential_mismatch'
  | 'not_authorized'
  | 'node_local_cross_node'
  | 'reason_required'
  | 'unknown_node'
  | 'attestation_refused'
  | 'lifecycle_in_progress'
  | 'executor_unavailable'

export type LifecycleRefusal = {
  readonly allowed: false
  readonly code: LifecycleRefusalCode
  readonly message: string
}

export type LifecycleAuthorization =
  | {
      readonly allowed: true
      readonly callerKind: HrcServerLifecycleCallerKind
      /** The credential's bound scopeRef — the verified identity. */
      readonly requestedBy: string
      readonly projectId: string
    }
  | LifecycleRefusal

export type LifecycleCallerPresentation = {
  readonly runtimeId: string | undefined
  readonly credential: string | undefined
  /** Attribution only (the caller's HRC_SESSION_REF); the binding check compares it. */
  readonly attributedSessionRef: string | undefined
}

export type LifecycleAuthorityNode = {
  readonly nodeId: string
  /** Rule B admits only a node identity read from federation config, never a hostname derivation. */
  readonly nodeIdDeclared: boolean
}

function parseAgentScope(
  scopeRef: string
): { agentId: string; projectId?: string; taskId?: string; roleName?: string } | undefined {
  try {
    const parsed = parseScopeRef(scopeRef)
    return {
      agentId: parsed.agentId,
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }),
      ...(parsed.roleName === undefined ? {} : { roleName: parsed.roleName }),
    }
  } catch {
    return undefined
  }
}

/** Rule A's shape: agent mable, task primary, a project, no role. */
export function isMablePrimaryScope(scopeRef: string): boolean {
  const parsed = parseAgentScope(scopeRef)
  return (
    parsed !== undefined &&
    parsed.agentId === 'mable' &&
    parsed.taskId === 'primary' &&
    parsed.projectId !== undefined &&
    parsed.roleName === undefined
  )
}

function nodeLocalSeatFor(
  scopeRef: string,
  node: LifecycleAuthorityNode
): NodeLocalLifecycleSeat | undefined {
  const parsed = parseAgentScope(scopeRef)
  if (parsed === undefined || parsed.roleName !== undefined || parsed.projectId === undefined) {
    return undefined
  }
  if (!node.nodeIdDeclared) return undefined
  return NODE_LOCAL_LIFECYCLE_SEATS.find(
    (entry) =>
      entry.agentId === parsed.agentId &&
      entry.taskId === parsed.taskId &&
      (entry.projectId === undefined || entry.projectId === parsed.projectId) &&
      entry.nodeId === node.nodeId
  )
}

function callerProject(scopeRef: string | undefined): string {
  if (scopeRef === undefined) return '<project>'
  return parseAgentScope(scopeRef)?.projectId ?? '<project>'
}

function attributedScope(sessionRef: string | undefined): string | undefined {
  if (sessionRef === undefined || sessionRef.trim().length === 0) return undefined
  try {
    return splitSessionRef(sessionRef.trim()).scopeRef
  } catch {
    return undefined
  }
}

/**
 * The doctrine refusal (T-09862): names the TARGET node's authorized callers.
 * `project` is the caller's project when known, so "request it from" names a
 * concrete primary.
 */
export function lifecycleRefusalText(input: {
  readonly action: HrcServerLifecycleAction
  readonly targetNodeId: string
  readonly project: string
}): string {
  const nodeSeat = NODE_LOCAL_LIFECYCLE_SEATS.find((entry) => entry.nodeId === input.targetNodeId)
  const seat = nodeSeat === undefined ? '' : `, this node's Mable seat (${nodeSeat.seat})`
  return (
    `only mable@<project>:primary${seat} or Lance may ${input.action} the HRC server on ` +
    `${input.targetNodeId}; request it from mable@${input.project}:primary`
  )
}

function breakGlassSuffix(): string {
  return `; Lance acts through a Mable primary or the documented break-glass (${HRC_LIFECYCLE_BREAK_GLASS}), which the next boot records as unattributed`
}

export type LifecycleCredentialRefusalCode =
  | 'credential_missing'
  | 'credential_unknown'
  | 'credential_revoked'
  | 'credential_mismatch'

export type LifecycleCallerVerification =
  | { readonly ok: true; readonly binding: LifecycleCredentialBinding }
  | {
      readonly ok: false
      readonly code: LifecycleCredentialRefusalCode
      readonly detail: string
      /** The scopeRef to name in the refusal: the binding's when known, else the attributed one. */
      readonly scopeRef: string | undefined
    }

/**
 * Identify the caller from the credential this daemon minted: presented,
 * recognized, still live with its bound identity, and attributed to the same
 * seat. Says WHO is calling, never what they may do. Shared by the server
 * lifecycle authority (T-09861) and `hrc restartme` (T-09872).
 */
export function verifyLifecycleCaller(input: {
  readonly caller: LifecycleCallerPresentation
  readonly verifyCredential: (
    runtimeId: string,
    value: string
  ) => LifecycleCredentialBinding | undefined
  readonly isLive: (binding: LifecycleCredentialBinding) => boolean
}): LifecycleCallerVerification {
  const attributed = attributedScope(input.caller.attributedSessionRef)
  const runtimeId = input.caller.runtimeId?.trim()
  const value = input.caller.credential?.trim()
  if (!runtimeId || !value) {
    return {
      ok: false,
      code: 'credential_missing',
      detail: 'no lifecycle credential: this caller is not a runtime this daemon launched',
      scopeRef: attributed,
    }
  }
  const binding = input.verifyCredential(runtimeId, value)
  if (binding === undefined) {
    return {
      ok: false,
      code: 'credential_unknown',
      detail: 'lifecycle credential not recognized by this daemon',
      scopeRef: attributed,
    }
  }
  if (!input.isLive(binding)) {
    return {
      ok: false,
      code: 'credential_revoked',
      detail: 'lifecycle credential revoked: its runtime is not live',
      scopeRef: attributed,
    }
  }
  if (attributed === undefined || attributed !== binding.scopeRef) {
    return {
      ok: false,
      code: 'credential_mismatch',
      detail: 'lifecycle credential is bound to a different seat than HRC_SESSION_REF',
      scopeRef: binding.scopeRef,
    }
  }
  return { ok: true, binding }
}

/**
 * Verify the caller locally (Rules A and B). `isLive` re-reads the store: a
 * credential is valid only while its runtime is live with the bound identity.
 * Target-node rules (B never forwarded) are applied by the caller of this.
 */
export function authorizeLocalLifecycleCaller(input: {
  readonly action: HrcServerLifecycleAction
  readonly targetNodeId: string
  readonly caller: LifecycleCallerPresentation
  readonly node: LifecycleAuthorityNode
  readonly verifyCredential: (
    runtimeId: string,
    value: string
  ) => LifecycleCredentialBinding | undefined
  readonly isLive: (binding: LifecycleCredentialBinding) => boolean
}): LifecycleAuthorization {
  const refusal = (code: LifecycleRefusalCode, detail: string, project: string) =>
    ({
      allowed: false,
      code,
      message: `${lifecycleRefusalText({
        action: input.action,
        targetNodeId: input.targetNodeId,
        project,
      })} (${detail})`,
    }) as const

  const verification = verifyLifecycleCaller(input)
  if (!verification.ok) {
    const suffix = verification.code === 'credential_missing' ? breakGlassSuffix() : ''
    return refusal(
      verification.code,
      `${verification.detail}${suffix}`,
      callerProject(verification.scopeRef)
    )
  }
  const binding = verification.binding

  const project = callerProject(binding.scopeRef)
  if (isMablePrimaryScope(binding.scopeRef)) {
    return {
      allowed: true,
      callerKind: 'mable-primary',
      requestedBy: binding.scopeRef,
      projectId: project,
    }
  }
  if (nodeLocalSeatFor(binding.scopeRef, input.node) !== undefined) {
    return {
      allowed: true,
      callerKind: 'mable-node-local',
      requestedBy: binding.scopeRef,
      projectId: project,
    }
  }
  return refusal('not_authorized', `caller ${binding.scopeRef} is not authorized`, project)
}

/**
 * The target's check of a federation attestation (§5 step 3). The peer is
 * already token-authenticated; this re-checks the claim itself.
 */
export function checkLifecycleAttestation(input: {
  readonly authenticatedNodeId: string
  readonly originNode: string
  readonly callerKind: string
  readonly requestedBy: string
  readonly action: HrcServerLifecycleAction
  readonly localNodeId: string
}): LifecycleRefusal | undefined {
  const refuse = (detail: string): LifecycleRefusal => ({
    allowed: false,
    code: 'attestation_refused',
    message: `${lifecycleRefusalText({
      action: input.action,
      targetNodeId: input.localNodeId,
      project: callerProject(input.requestedBy),
    })} (${detail})`,
  })
  if (input.originNode !== input.authenticatedNodeId) {
    return refuse(
      `attested originNode ${input.originNode} is not the authenticated peer ${input.authenticatedNodeId}`
    )
  }
  if (input.callerKind !== 'mable-primary') {
    return refuse(`callerKind ${input.callerKind} may not act across nodes`)
  }
  if (!isMablePrimaryScope(input.requestedBy)) {
    return refuse(`attested requestedBy ${input.requestedBy} is not a Mable primary`)
  }
  return undefined
}
