/**
 * Resolve a target handle to an HrcRuntimeIntent.
 *
 * The harness→intent assembly is owned by hrc-sdk's `buildHrcRuntimeIntent`
 * (the single authority shared with hrc-cli and agent-loop). This module only
 * does the hrcchat-specific bit: parse the target string and resolve its
 * placement paths, then hand them to the shared assembler with hrcchat's
 * non-interactive turn semantics.
 */
import { CliUsageError } from 'cli-kit'
import type { HrcRuntimeIntent } from 'hrc-core'
import { buildHrcRuntimeIntent } from 'hrc-sdk'

import { resolveScope } from './normalize.js'

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

export function resolveRuntimeIntentForTarget(targetInput: string): HrcRuntimeIntent {
  const resolved = resolveScope(targetInput)
  const scope = resolved.parsed

  const paths = resolved.placement
  writePlacementWarnings(paths.warnings)
  const agentRoot = paths.agentRoot
  if (!agentRoot) {
    throw new CliUsageError(formatAgentNotFound(scope.agentId, paths.searchedAgentRoots))
  }

  return buildHrcRuntimeIntent({
    agentId: scope.agentId,
    agentRoot,
    ...(paths.projectRoot ? { projectRoot: paths.projectRoot } : {}),
    cwd: paths.cwd ?? agentRoot,
    runMode: 'task',
    interactive: false,
    preferredMode: 'nonInteractive',
  })
}
