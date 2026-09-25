/**
 * Declared placement policy, observed from the agent's declaration (T-08597).
 *
 * `hrc target locate` has to answer "what does policy SAY" independently of
 * "what actually happened", because the whole point of skew is that those two
 * can disagree. The summon gate consumes the same shape via
 * `SummonGateDeps.policyFor`, so this module produces exactly `SummonGatePolicy`
 * rather than a locate-private parallel type — a second spelling of the pin
 * table is how locate would start reporting a policy the gate never applied.
 *
 * Both locate and the live summon gate call this module. Locate consumes the
 * typed outcome so it can render profile failures; the gate adapter throws on
 * those failures so `evaluateSummonGate` emits `policy-unavailable` instead of
 * manufacturing an `undeclared-placement` refusal.
 *
 * NON-FATAL BY CONSTRUCTION. Every observation failure becomes a typed
 * outcome, never a throw: an operator running locate on a broken profile needs
 * to SEE "this profile is unreadable, here is why" alongside the ledger truth,
 * not lose the whole report to an exception.
 *
 * T-08597: the `[placement]` stanza (pins/homes), `claims_task`, and the
 * provisioning node arrive via the daemon's in-process aspd declaration
 * observation — HRC no longer parses `agent-profile.toml` itself. Agent-root
 * discovery stays HRC policy (explicit override, then observation search).
 */

import { parseScopeRef } from 'agent-scope'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { ResolvePlacementResponse } from 'hrc-core'

import { resolvePlacementInProcess } from '../placements-resolve.js'
import type { SummonGatePolicy } from './summon-gate.js'

/** Filename of the agent runtime profile, relative to an agent root. */
export const AGENT_PROFILE_FILENAME = 'agent-profile.toml'

export type PlacementPolicyResolution =
  | { outcome: 'resolved'; policy: SummonGatePolicy; profilePath: string }
  /** The scope names no agent (or is not a canonical agent scope) — no profile can exist. */
  | { outcome: 'not-an-agent-scope'; detail: string }
  /** The agent root resolved but carries no profile: legacy agent, no declaration. */
  | { outcome: 'no-profile'; detail: string; searchedAgentRoots: readonly string[] }
  /** The profile exists but could not be read or parsed. Visible, never silent. */
  | { outcome: 'unreadable'; detail: string; profilePath?: string | undefined }

export type PlacementPolicyObservation = (
  input: Parameters<typeof resolvePlacementInProcess>[0]
) => Promise<ResolvePlacementResponse>

export type ResolvePlacementPolicyOptions = {
  /** Overrides agent-root discovery. Tests pass this; production omits it. */
  agentRoot?: string | undefined
  cwd?: string | undefined
  env?: Record<string, string | undefined> | undefined
  /** Test seam; production observes via the in-process placements resolver. */
  observe?: PlacementPolicyObservation | undefined
}

function profilePathFor(agentRoot: string): string {
  return `${agentRoot.replace(/\/+$/, '')}/${AGENT_PROFILE_FILENAME}`
}

/**
 * Resolves the `[placement]` stanza declared for `scopeRef`'s agent.
 *
 * Placement is declared per AGENT, not per task: the pin table is keyed by
 * `project:task` inside one agent's profile, so the lookup is agent-scoped even
 * though the question is asked about a task scope.
 */
export async function resolvePlacementPolicy(
  scopeRef: string,
  options: ResolvePlacementPolicyOptions = {}
): Promise<PlacementPolicyResolution> {
  let agentId: string | undefined
  let projectId: string | undefined
  let taskId: string | undefined
  try {
    const parsed = parseScopeRef(scopeRef)
    agentId = parsed.agentId
    projectId = parsed.projectId
    taskId = parsed.taskId
  } catch {
    return {
      outcome: 'not-an-agent-scope',
      detail: `"${scopeRef}" is not a parseable scope ref, so no agent profile can declare placement for it.`,
    }
  }

  if (agentId === undefined || agentId.trim().length === 0) {
    return {
      outcome: 'not-an-agent-scope',
      detail: `"${scopeRef}" names no agent, so no agent profile can declare placement for it.`,
    }
  }

  let observation: ResolvePlacementResponse
  const observe = options.observe ?? resolvePlacementInProcess
  try {
    observation = await observe({
      agentId,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      cwd: options.cwd ?? process.cwd(),
      ...(options.agentRoot !== undefined ? { agentRoot: options.agentRoot } : {}),
      runMode: 'task',
    })
  } catch (error) {
    // The daemon searched and found no agent home: that is the no-profile
    // outcome (same detail the local resolver produced), not an unreadable
    // declaration.
    if (
      error instanceof HrcDomainError &&
      error.code === HrcErrorCode.DECLARATION_INVALID &&
      (error.detail as { producerCode?: unknown } | undefined)?.producerCode === 'agent_not_found'
    ) {
      const searched = error.detail as { searchedAgentRoots?: readonly string[] } | undefined
      return {
        outcome: 'no-profile',
        detail: `No agent root found for "${agentId}", so no [placement] stanza could be read.`,
        searchedAgentRoots: searched?.searchedAgentRoots ?? [],
      }
    }
    return {
      outcome: 'unreadable',
      detail: `Could not observe a declaration for "${agentId}": ${errorText(error)}`,
    }
  }

  const agentRoot = observation.agentRoot
  const searchedAgentRoots = observation.searchedAgentRoots
  if (agentRoot === undefined) {
    return {
      outcome: 'no-profile',
      detail: `No agent root found for "${agentId}", so no [placement] stanza could be read.`,
      searchedAgentRoots,
    }
  }

  const profilePath = profilePathFor(agentRoot)
  const source = observation.source
  if (source.agentProfile === 'absent') {
    return {
      outcome: 'no-profile',
      detail: `${profilePath} does not exist, so this agent declares no placement.`,
      searchedAgentRoots,
    }
  }
  if (source.agentProfile === 'invalid' || source.projectTargets === 'invalid') {
    const diagnostics = observation.warnings.join(' ')
    const profilePath = profilePathFor(agentRoot)
    return {
      outcome: 'unreadable',
      detail: `Could not interpret the declaration for "${agentId}" at ${profilePath}: ${diagnostics || 'invalid source'}`,
      profilePath,
    }
  }

  const policy = observation.policy
  return {
    outcome: 'resolved',
    profilePath,
    policy: {
      claimsTask: policy.claimsTask,
      ...(policy.provisioningNode === undefined
        ? {}
        : { provisioning: { node: policy.provisioningNode } }),
      placement: {
        ...(policy.placement.launch !== undefined ? { launch: policy.placement.launch } : {}),
        pins: { ...policy.placement.pins },
        homes: { ...policy.placement.homes },
      },
    },
  }
}

/**
 * Adapts the resolver to `SummonGateDeps.policyFor`.
 *
 * Kept here so that wiring the gate to real policy is a one-line change at the
 * injection site rather than a reimplementation of profile discovery.
 */
export function createPlacementPolicyResolver(
  options: ResolvePlacementPolicyOptions = {}
): (scopeRef: string) => Promise<SummonGatePolicy | undefined> {
  return async (scopeRef: string) => {
    const resolution = await resolvePlacementPolicy(scopeRef, options)
    if (resolution.outcome === 'resolved') return resolution.policy

    // The gate has already filtered synthetic app scopes before consulting
    // policy. Keep this adapter total for direct callers without inventing a
    // profile failure for a scope that cannot carry an agent policy.
    if (resolution.outcome === 'not-an-agent-scope') return undefined

    // A profile that exists and omits [placement] resolves successfully above
    // with empty pins/homes; that is the one real undeclared-placement signal.
    // Missing or unreadable materialization is a different fact and the gate's
    // catch path makes it visibly retryable.
    throw new Error(resolution.detail)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
