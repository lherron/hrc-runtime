import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type ResolvedScopeInput, resolveQualifiedScopeInput } from 'agent-scope'
import { type ResolveAgentPlacementPathsOptions, parseAgentProfile } from 'spaces-config'

import {
  type HrcResolvedAgentPlacementPaths,
  resolveHrcAgentPlacementPaths,
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
  placement?: Omit<ResolveAgentPlacementPathsOptions, 'agentId' | 'projectId'> | undefined
  /** Whether the project came from the target itself or caller-side inference. */
  projectOrigin?: ProjectOrigin | undefined
}

export interface ProfileAwareResolvedScopeInput extends ResolvedScopeInput {
  placement: HrcResolvedAgentPlacementPaths
  projectOrigin: ProjectOrigin
  defaultRoleName?: string | undefined
}

function readDefaultScopeRole(agentRoot: string | undefined): string | undefined {
  if (agentRoot === undefined) return undefined

  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return undefined

  const source = readFileSync(profilePath, 'utf8').replace(
    /^(\s*)schema_version(\s*=)/m,
    '$1schemaVersion$2'
  )
  return parseAgentProfile(source, profilePath).identity?.default_scope_role
}

/**
 * Resolve a user-facing scope through one profile-aware orchestration path:
 * parse identity, select placement, read that placement's profile, then run
 * the pure scope resolver with the selected profile's default role.
 */
export function resolveProfileAwareScopeInput(
  input: string,
  options: ResolveProfileAwareScopeInputOptions = {}
): ProfileAwareResolvedScopeInput {
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
  const placement = resolveHrcAgentPlacementPaths({
    ...options.placement,
    agentId: initial.parsed.agentId,
    ...(projectId !== undefined ? { projectId } : {}),
    projectOrigin,
    ...(initial.parsed.taskId !== undefined ? { taskId: initial.parsed.taskId } : {}),
  })
  const defaultRoleName = readDefaultScopeRole(placement.agentRoot)
  const resolved =
    defaultRoleName !== undefined
      ? resolveQualifiedScopeInput(input, { ...scopeDefaults, defaultRoleName })
      : initial

  return {
    ...resolved,
    placement,
    projectOrigin,
    ...(defaultRoleName !== undefined ? { defaultRoleName } : {}),
  }
}
