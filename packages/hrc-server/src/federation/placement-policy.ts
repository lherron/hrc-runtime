/**
 * Declared placement policy, read from the agent profile (T-06613).
 *
 * `hrc target locate` has to answer "what does policy SAY" independently of
 * "what actually happened", because the whole point of skew is that those two
 * can disagree. The summon gate consumes the same shape via
 * `SummonGateDeps.policyFor`, so this module produces exactly `SummonGatePolicy`
 * rather than a locate-private parallel type — a second spelling of the pin
 * table is how locate would start reporting a policy the gate never applied.
 *
 * DELIBERATELY NOT WIRED INTO THE GATE. `summon-gate-server.ts` still injects
 * its `async () => undefined` stub, so gate behavior is byte-identical to
 * before this task. Locate is a read-only observer; turning this resolver into
 * the gate's policy source changes what an advisory daemon would refuse, which
 * is a placement-behavior change and not this task's contract. The seam is one
 * line (`policyFor: createPlacementPolicyResolver(...)`) when that lands.
 *
 * NON-FATAL BY CONSTRUCTION. Every failure to read a profile becomes a typed
 * outcome, never a throw: an operator running locate on a broken profile needs
 * to SEE "this profile is unreadable, here is why" alongside the ledger truth,
 * not lose the whole report to an exception.
 */

import { readFileSync } from 'node:fs'

import { parseScopeRef } from 'agent-scope'
import { parseAgentProfile, resolveAgentPlacementPaths } from 'spaces-config'

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

export type ResolvePlacementPolicyOptions = {
  /** Overrides agent-root discovery. Tests pass this; production omits it. */
  agentRoot?: string | undefined
  cwd?: string | undefined
  env?: Record<string, string | undefined> | undefined
  /** Injected for tests; defaults to a real UTF-8 file read. */
  readFile?: ((path: string) => string) | undefined
}

/**
 * Resolves the `[placement]` stanza declared for `scopeRef`'s agent.
 *
 * Placement is declared per AGENT, not per task: the pin table is keyed by
 * `project:task` inside one agent's profile, so the lookup is agent-scoped even
 * though the question is asked about a task scope.
 */
export function resolvePlacementPolicy(
  scopeRef: string,
  options: ResolvePlacementPolicyOptions = {}
): PlacementPolicyResolution {
  let agentId: string | undefined
  let projectId: string | undefined
  try {
    const parsed = parseScopeRef(scopeRef)
    agentId = parsed.agentId
    projectId = parsed.projectId
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

  let agentRoot = options.agentRoot
  let searchedAgentRoots: readonly string[] = agentRoot === undefined ? [] : [agentRoot]
  if (agentRoot === undefined) {
    let paths: ReturnType<typeof resolveAgentPlacementPaths>
    try {
      paths = resolveAgentPlacementPaths({
        agentId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      })
    } catch (error) {
      return {
        outcome: 'unreadable',
        detail: `Could not locate an agent root for "${agentId}": ${errorText(error)}`,
      }
    }
    agentRoot = paths.agentRoot
    searchedAgentRoots = paths.searchedAgentRoots ?? []
    if (agentRoot === undefined) {
      return {
        outcome: 'no-profile',
        detail: `No agent root found for "${agentId}", so no [placement] stanza could be read.`,
        searchedAgentRoots,
      }
    }
  }

  const profilePath = `${agentRoot.replace(/\/+$/, '')}/${AGENT_PROFILE_FILENAME}`
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))

  let content: string
  try {
    content = read(profilePath)
  } catch (error) {
    if (isNotFound(error)) {
      return {
        outcome: 'no-profile',
        detail: `${profilePath} does not exist, so this agent declares no placement.`,
        searchedAgentRoots,
      }
    }
    return {
      outcome: 'unreadable',
      detail: `Could not read ${profilePath}: ${errorText(error)}`,
      profilePath,
    }
  }

  let profile: ReturnType<typeof parseAgentProfile>
  try {
    profile = parseAgentProfile(content, profilePath)
  } catch (error) {
    return {
      outcome: 'unreadable',
      detail: `Could not parse ${profilePath}: ${errorText(error)}`,
      profilePath,
    }
  }

  const placement = profile.placement
  return {
    outcome: 'resolved',
    profilePath,
    policy: {
      claimsTask: profile.claims_task ?? false,
      ...(placement === undefined
        ? {}
        : {
            placement: {
              ...(placement.default_home_node === undefined
                ? {}
                : { defaultHomeNode: placement.default_home_node }),
              pins: { ...placement.pins },
            },
          }),
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
    const resolution = resolvePlacementPolicy(scopeRef, options)
    return resolution.outcome === 'resolved' ? resolution.policy : undefined
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
