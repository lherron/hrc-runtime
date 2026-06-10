/**
 * Resolve a target handle to an HrcRuntimeIntent using spaces-config.
 *
 * Mirrors hrc-cli's buildManagedRuntimeIntent but defaults to
 * non-interactive mode for hrcchat semantic turns.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CliUsageError } from 'cli-kit'
import type { HrcHarness, HrcRuntimeIntent } from 'hrc-core'
import {
  type TargetDefinition,
  buildRuntimeBundleRef,
  mergeAgentWithProjectTarget,
  normalizeHarnessFrontend,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPlacementPaths,
  resolveAgentPrimingPrompt,
  resolveHarnessProvider,
} from 'spaces-config'

import { resolveScope } from './normalize.js'

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

function writePlacementWarnings(warnings: string[] | undefined): void {
  if (!warnings || warnings.length === 0) return
  for (const warning of warnings) {
    process.stderr.write(`[hrcchat] warning: ${warning}\n`)
  }
}

function formatAgentNotFound(agentId: string, searchedAgentRoots: string[] | undefined): string {
  if (searchedAgentRoots && searchedAgentRoots.length > 0) {
    return `agent "${agentId}" not found; searched: ${searchedAgentRoots.join(', ')}`
  }
  return `agent "${agentId}" not found; no agent roots configured.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.`
}

/**
 * Normalize a harness name from agent-profile.toml (e.g. "pi-sdk", "agent-sdk",
 * "claude-code") to the canonical HrcHarness frontend id understood by the
 * dispatcher. Mirrors hrc-cli's `harnessStringToHarnessId`; duplicated locally
 * to avoid an hrcchat → hrc-cli dep.
 */
function harnessStringToHarnessId(harness: string | undefined): HrcHarness | undefined {
  return normalizeHarnessFrontend(harness) as HrcHarness | undefined
}

type AgentHarnessResolution = {
  provider: 'anthropic' | 'openai'
  harness: string | undefined
}

function resolveAgentHarness(
  agentRoot: string,
  agentName: string,
  projectRoot?: string
): AgentHarnessResolution {
  const projectTarget = loadProjectTarget(projectRoot, agentName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return {
      provider: resolveProviderForHarness(projectTarget?.harness),
      harness: projectTarget?.harness,
    }
  }
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
    return {
      provider: resolveProviderForHarness(effective.harness),
      harness: effective.harness,
    }
  } catch {
    return {
      provider: resolveProviderForHarness(projectTarget?.harness),
      harness: projectTarget?.harness,
    }
  }
}

export function resolveRuntimeIntentForTarget(targetInput: string): HrcRuntimeIntent {
  const resolved = resolveScope(targetInput)
  const scope = resolved.parsed

  const projectId = scope.projectId

  const paths = resolveAgentPlacementPaths({
    agentId: scope.agentId,
    projectId,
  })
  writePlacementWarnings(paths.warnings)
  const agentRoot = paths.agentRoot
  if (!agentRoot) {
    throw new CliUsageError(formatAgentNotFound(scope.agentId, paths.searchedAgentRoots))
  }
  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? agentRoot
  const bundle = buildRuntimeBundleRef({
    agentName: scope.agentId,
    agentRoot,
    projectRoot,
  })
  const { provider, harness: harnessString } = resolveAgentHarness(
    agentRoot,
    scope.agentId,
    projectRoot
  )
  const harnessId = harnessStringToHarnessId(harnessString)

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
      ...(harnessId !== undefined ? { id: harnessId } : {}),
    },
    execution: {
      preferredMode: 'nonInteractive' as const,
    },
  }
}
