/**
 * Resolve a target handle to an HrcRuntimeIntent.
 * Overlaps with target/resolve.ts intentionally until a later refactor.
 *
 * The harness→intent assembly is owned by hrc-sdk's `buildHrcRuntimeIntent`
 * (the single authority shared with hrc-cli and agent-loop). This module only
 * does the turn-specific bit: parse the target string and resolve its
 * placement paths, then hand them to the shared assembler with hrc's
 * non-interactive turn semantics.
 */
import { CliUsageError } from 'cli-kit'
import type { HrcRuntimeIntent } from 'hrc-core'
import {
  type ProfileAwareResolvedScopeInput,
  buildHrcRuntimeIntent,
  formatAgentNotFound,
  writePlacementWarnings,
} from 'hrc-sdk'

import { resolveMessagingScope, resolveScope } from './normalize.js'

async function buildRuntimeIntentForResolvedScope(
  resolved: ProfileAwareResolvedScopeInput
): Promise<HrcRuntimeIntent> {
  const scope = resolved.parsed

  const paths = resolved.placement
  writePlacementWarnings('hrc', paths.warnings)
  const agentRoot = paths.agentRoot
  if (!agentRoot) {
    throw new CliUsageError(formatAgentNotFound(scope.agentId, paths.searchedAgentRoots))
  }

  return await buildHrcRuntimeIntent({
    agentId: scope.agentId,
    agentRoot,
    ...(paths.projectRoot ? { projectRoot: paths.projectRoot } : {}),
    cwd: paths.cwd ?? agentRoot,
    runMode: 'task',
    interactive: false,
    preferredMode: 'nonInteractive',
    // T-07398: the handle's `+` block. `agent-scope` parses it off the input and
    // hands it back here; carrying it onto the intent is what makes the daemon's
    // validation and overlay reachable at all. Omitted entirely when the input
    // carried no block, so "no directives" never reads as an empty declaration.
    ...(resolved.directives === undefined ? {} : { provision: resolved.directives }),
  })
}

/** Resolve a messaging target once, with association drift advisory. */
export async function resolveMessagingTarget(
  targetInput: string,
  options?: { withCallerTaskId?: boolean }
): Promise<{
  resolved: ProfileAwareResolvedScopeInput
  sessionRef: string
}> {
  const resolved = await resolveMessagingScope(targetInput, options)
  return {
    resolved,
    sessionRef: `${resolved.scopeRef}/lane:${resolved.laneId}`,
  }
}

/** Resolve a launch/turn target once under strict task-worktree placement. */
export async function resolveLaunchTarget(targetInput: string): Promise<{
  resolved: ProfileAwareResolvedScopeInput
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
}> {
  const resolved = await resolveScope(targetInput)
  return {
    resolved,
    sessionRef: `${resolved.scopeRef}/lane:${resolved.laneId}`,
    runtimeIntent: await buildRuntimeIntentForResolvedScope(resolved),
  }
}
