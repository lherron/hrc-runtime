/**
 * Resolve a target handle to an HrcRuntimeIntent using spaces-config.
 *
 * Mirrors hrc-cli's buildManagedRuntimeIntent but defaults to
 * non-interactive mode for hrcchat semantic turns.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveScopeInput } from 'agent-scope'
import { CliUsageError } from 'cli-kit'
import type { HrcRuntimeIntent } from 'hrc-core'
import {
  type TargetDefinition,
  buildRuntimeBundleRef,
  getAgentsRoot,
  inferProjectIdFromCwd,
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPlacementPaths,
  resolveAgentPrimingPrompt,
  resolveHarnessProvider,
} from 'spaces-config'

function loadProjectTarget(
  projectRoot: string | undefined,
  targetName: string
): TargetDefinition | undefined {
  if (!projectRoot) return undefined
  const targetsPath = join(projectRoot, 'asp-targets.toml')
  if (!existsSync(targetsPath)) return undefined
  return parseTargetsToml(readFileSync(targetsPath, 'utf8'), targetsPath).targets[targetName]
}

function resolveProviderForHarness(harness: string | undefined): 'anthropic' | 'openai' {
  return resolveHarnessProvider(harness) ?? 'anthropic'
}

function resolveProviderFromAgent(
  agentRoot: string,
  agentName: string,
  projectRoot?: string
): 'anthropic' | 'openai' {
  const projectTarget = loadProjectTarget(projectRoot, agentName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return resolveProviderForHarness(projectTarget?.harness)
  try {
    const source = readFileSync(profilePath, 'utf8').replace(
      /^(\s*)schema_version(\s*=)/m,
      '$1schemaVersion$2'
    )
    const profile = parseAgentProfile(source, profilePath)
    const primingPrompt = resolveAgentPrimingPrompt(profile, agentRoot)
    const effective = mergeAgentWithProjectTarget(
      {
        ...profile,
        ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
      },
      projectTarget,
      'task'
    )
    return resolveProviderForHarness(effective.harness)
  } catch {
    return resolveProviderForHarness(projectTarget?.harness)
  }
}

export function resolveRuntimeIntentForTarget(targetInput: string): HrcRuntimeIntent {
  const resolved = resolveScopeInput(targetInput, 'main')
  const scope = resolved.parsed

  let projectId = scope.projectId
  if (!projectId) {
    projectId = inferProjectIdFromCwd()
  }

  const agentsRoot = getAgentsRoot()
  if (!agentsRoot) {
    throw new CliUsageError(
      'cannot resolve agent placement — set ASP_AGENTS_ROOT or configure agents-root'
    )
  }

  const agentRoot = join(agentsRoot, scope.agentId)
  if (!existsSync(agentRoot)) {
    throw new CliUsageError(`agent "${scope.agentId}" not found at ${agentRoot}`)
  }

  const paths = resolveAgentPlacementPaths({
    agentId: scope.agentId,
    projectId,
    agentRoot,
  })
  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? agentRoot
  const bundle = buildRuntimeBundleRef({
    agentName: scope.agentId,
    agentRoot,
    projectRoot,
  })
  const provider = resolveProviderFromAgent(agentRoot, scope.agentId, projectRoot)

  return {
    placement: {
      agentRoot,
      ...(projectRoot ? { projectRoot } : {}),
      cwd,
      runMode: 'task' as const,
      bundle,
      dryRun: false,
    },
    harness: {
      provider,
      interactive: false,
    },
    execution: {
      preferredMode: 'nonInteractive' as const,
    },
  }
}
