import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type ResolvedScopeInput, resolveQualifiedScopeInput, resolveScopeInput } from 'agent-scope'
import {
  type ResolveAgentPlacementPathsOptions,
  type ResolvedAgentPlacementPaths,
  parseAgentProfile,
  resolveAgentPlacementPaths,
} from 'spaces-config'

export interface ProfileAwareScopeDefaults {
  defaultLaneId?: string
  projectId?: string
  taskId?: string
  defaultTaskId?: string
}

export interface ResolveProfileAwareScopeInputOptions {
  /** Pure scope defaults applied after the authoritative profile is selected. */
  scope?: ProfileAwareScopeDefaults | undefined
  /** Placement overrides used to locate the authoritative agent profile. */
  placement?: Omit<ResolveAgentPlacementPathsOptions, 'agentId' | 'projectId'> | undefined
}

export interface ProfileAwareResolvedScopeInput extends ResolvedScopeInput {
  placement: ResolvedAgentPlacementPaths
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
  const initial = resolveScopeInput(input, options.scope?.defaultLaneId)
  const projectId = initial.parsed.projectId ?? options.scope?.projectId
  const placement = resolveAgentPlacementPaths({
    ...options.placement,
    agentId: initial.parsed.agentId,
    ...(projectId !== undefined ? { projectId } : {}),
  })
  const defaultRoleName = readDefaultScopeRole(placement.agentRoot)
  const resolved = resolveQualifiedScopeInput(input, {
    ...options.scope,
    ...(defaultRoleName !== undefined ? { defaultRoleName } : {}),
  })

  return {
    ...resolved,
    placement,
    ...(defaultRoleName !== undefined ? { defaultRoleName } : {}),
  }
}
