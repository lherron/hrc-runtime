/**
 * T-08597 — daemon-backed profile-aware scope resolution.
 *
 * Same names and result shapes; the authoritative profile (default role) and
 * placement now come from the installed daemon (`POST /v1/placements/resolve`,
 * aspd-observed) instead of local `spaces-config` parsing. Scope parsing
 * itself stays local and pure (`agent-scope`). A missing/unreachable daemon
 * socket is a typed `runtime_unavailable` HrcDomainError.
 */

import { type ResolvedScopeInput, resolveQualifiedScopeInput } from 'agent-scope'

import type { ResolvePlacementResponse } from 'hrc-core'
import {
  type HrcResolvedAgentPlacementPaths,
  type ResolveHrcAgentPlacementPathsOptions,
  isAgentNotFoundError,
  resolvePlacementObservation,
  toMissedPaths,
  toResolvedPaths,
} from './project-placement.js'

export interface ProfileAwareScopeDefaults {
  defaultLaneId?: string
  projectId?: string
  taskId?: string
  defaultTaskId?: string
}

export type ProjectOrigin = 'explicit' | 'inferred'

export interface ResolveProfileAwareScopeInputOptions {
  /** Pure scope defaults applied after the authoritative profile is selected. */
  scope?: ProfileAwareScopeDefaults | undefined
  /** Placement overrides used to locate the authoritative agent profile. */
  placement?:
    | Omit<
        ResolveHrcAgentPlacementPathsOptions,
        'agentId' | 'projectId' | 'projectOrigin' | 'taskId'
      >
    | undefined
  /** Whether the project came from the target itself or caller-side inference. */
  projectOrigin?: ProjectOrigin | undefined
  /** Test/operator seam for the scratch-daemon proof; production discovers the socket. */
  socketPath?: string | undefined
}

export interface ProfileAwareResolvedScopeInput extends ResolvedScopeInput {
  placement: HrcResolvedAgentPlacementPaths
  projectOrigin: ProjectOrigin
  defaultRoleName?: string | undefined
}

/**
 * Resolve a user-facing scope through one profile-aware orchestration path:
 * parse identity, observe placement + authoritative profile from the daemon,
 * then run the pure scope resolver with the observed default role.
 */
/**
 * Pure scope assembly from an already-observed placement (pinned hermetically
 * by unit tests): run the pure scope resolver with the observed default role,
 * then attach the mapped placement. No socket.
 */
export function applyScopeObservation(
  input: string,
  scopeDefaults: ProfileAwareScopeDefaults,
  projectOrigin: ProjectOrigin,
  observation: ResolvePlacementResponse
): ProfileAwareResolvedScopeInput {
  const initial = resolveQualifiedScopeInput(input, scopeDefaults)
  const defaultRoleName = observation.identity.role
  const resolved =
    defaultRoleName !== undefined
      ? resolveQualifiedScopeInput(input, { ...scopeDefaults, defaultRoleName })
      : initial

  return {
    ...resolved,
    placement: toResolvedPaths(observation),
    projectOrigin,
    ...(defaultRoleName !== undefined ? { defaultRoleName } : {}),
  }
}

export async function resolveProfileAwareScopeInput(
  input: string,
  options: ResolveProfileAwareScopeInputOptions = {}
): Promise<ProfileAwareResolvedScopeInput> {
  // Extract agentId/projectId for profile placement by resolving WITH the
  // caller's scope defaults (projectId fallback, lane). Using the bare
  // `resolveScopeInput` here would re-throw on the project-deferred shorthand
  // (`mable:BLAH`) before the projectId fallback is ever applied — the fallback
  // is exactly what makes that shorthand legal. If no project is resolvable this
  // still throws with the actionable "requires a project" message, as intended.
  const scopeDefaults = options.scope ?? {}
  const initial = resolveQualifiedScopeInput(input, scopeDefaults)
  const projectOrigin =
    options.projectOrigin ??
    (input.includes('@') || /(^|:)project:/.test(input) ? 'explicit' : 'inferred')
  const projectId = initial.parsed.projectId ?? scopeDefaults.projectId
  let observation: ResolvePlacementResponse
  try {
    observation = await resolvePlacementObservation({
      ...options.placement,
      agentId: initial.parsed.agentId,
      ...(projectId !== undefined ? { projectId } : {}),
      projectOrigin,
      ...(initial.parsed.taskId !== undefined ? { taskId: initial.parsed.taskId } : {}),
      ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
    })
  } catch (error) {
    // An unknown agent resolves WITHOUT placement (searched roots retained),
    // exactly as the local resolver returned: no profile, no default role.
    if (!isAgentNotFoundError(error)) throw error
    return {
      ...initial,
      placement: toMissedPaths(
        { projectId },
        error.detail as
          | {
              searchedAgentRoots?: string[] | undefined
              projectRoot?: string | undefined
              cwd?: string | undefined
            }
          | undefined
      ),
      projectOrigin,
    }
  }
  return applyScopeObservation(input, scopeDefaults, projectOrigin, observation)
}
