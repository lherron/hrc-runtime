/**
 * Resolve a target handle to an HrcRuntimeIntent.
 *
 * The harness→intent assembly is owned by hrc-sdk's `buildHrcRuntimeIntent`
 * (the single authority shared with hrc-cli and agent-loop). This module only
 * does the hrcchat-specific bit: parse the target string and resolve its
 * placement paths, then hand them to the shared assembler with hrcchat's
 * non-interactive turn semantics.
 */
import type { ProvisioningScalars } from 'agent-scope'
import { CliUsageError } from 'cli-kit'
import type { HrcRuntimeIntent } from 'hrc-core'
import {
  type ProfileAwareResolvedScopeInput,
  buildHrcRuntimeIntent,
  formatAgentNotFound,
  writePlacementWarnings,
} from 'hrc-sdk'

import { resolveMessagingScope, resolveScope } from './normalize.js'

export function resolveRuntimeIntentForTarget(targetInput: string): HrcRuntimeIntent {
  const resolved = resolveScope(targetInput)
  return buildRuntimeIntentForResolvedScope(resolved)
}

function buildRuntimeIntentForResolvedScope(
  resolved: ProfileAwareResolvedScopeInput
): HrcRuntimeIntent {
  const scope = resolved.parsed

  const paths = resolved.placement
  writePlacementWarnings('hrcchat', paths.warnings)
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
    // T-07398: the handle's `+` block. `agent-scope` parses it off the input and
    // hands it back here; carrying it onto the intent is what makes the daemon's
    // validation and overlay reachable at all. Omitted entirely when the input
    // carried no block, so "no directives" never reads as an empty declaration.
    ...(resolved.directives === undefined ? {} : { provision: resolved.directives }),
  })
}

/**
 * The runtime intent for a dm to a scope that ALREADY EXISTS and carries a
 * directive block (T-07398 cycle 2, item 2).
 *
 * Deliberately provision-ONLY. T-07151 established that existing-scope delivery
 * sends no placement intent, so a drifted checkout can still be corrected by
 * dm; building a full intent here would re-impose strict task-worktree
 * placement on exactly that path and trade one defect for that regression.
 * The directive still has to reach the daemon, because whether it is admissible
 * is a property of the REQUEST — the pin and the peer registry live server-side
 * and only the daemon can rule on them.
 *
 * The partial shape is safe on this path by construction: it is built only when
 * the target resolved, so nothing downstream needs placement to birth a
 * session. It is also strictly more information than this path sent before,
 * which was no intent at all.
 */
export function directiveOnlyRuntimeIntent(
  directives: Partial<ProvisioningScalars>
): HrcRuntimeIntent {
  return { provision: directives } as unknown as HrcRuntimeIntent
}

/** Resolve an hrcchat messaging target once, with association drift advisory. */
export function resolveMessagingTarget(
  targetInput: string,
  options?: { withCallerTaskId?: boolean }
): {
  resolved: ProfileAwareResolvedScopeInput
  sessionRef: string
} {
  const resolved = resolveMessagingScope(targetInput, options)
  return {
    resolved,
    sessionRef: `${resolved.scopeRef}/lane:${resolved.laneId}`,
  }
}

/** Resolve a launch/turn target once under strict task-worktree placement. */
export function resolveLaunchTarget(targetInput: string): {
  resolved: ProfileAwareResolvedScopeInput
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
} {
  const resolved = resolveScope(targetInput)
  return {
    resolved,
    sessionRef: `${resolved.scopeRef}/lane:${resolved.laneId}`,
    runtimeIntent: buildRuntimeIntentForResolvedScope(resolved),
  }
}
