import { CliUsageError } from 'cli-kit'
import type { HrcRuntimeIntent } from 'hrc-core'
import {
  type ProfileAwareResolvedScopeInput,
  buildHrcRuntimeIntent,
  formatAgentNotFound,
  resolveProfileAwareScopeInput,
  writePlacementWarnings,
} from 'hrc-sdk'
import { inferProjectIdFromCwd } from 'spaces-config'

/**
 * Target resolution for the live-runtime verbs `hrc` absorbed from `hrcchat`
 * (T-07612 §9.2): summon, send, peek, doctor.
 *
 * These are execution verbs — materialize a target, inject keystrokes, read a
 * pane, check reachability — so they belong to `hrc` and not to a messaging
 * CLI. Messaging itself moves the other way, to `wrkc`, because it is
 * collaboration and wrkq owns that.
 *
 * The semantics are carried over deliberately unchanged: the project falls back
 * to `ASP_PROJECT` then cwd, the caller's own task qualifies a bare agent name,
 * and placement drift is ADVISORY on the messaging-shaped verbs (send, peek,
 * doctor) but STRICT on summon, which actually births.
 */

/** Extract the caller's task, so a bare `cody` means "cody on my task". */
function callerTaskId(): string | undefined {
  const raw = process.env['HRC_SESSION_REF']
  if (!raw) return undefined
  return /:task:([^:/]+)/.exec(raw)?.[1]
}

export function resolveTargetScope(
  input: string,
  options?: { withCallerTaskId?: boolean; worktreeAssociation?: 'strict' | 'advisory' }
): ProfileAwareResolvedScopeInput {
  const fallbackProjectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const fallbackTaskId = options?.withCallerTaskId ? callerTaskId() : undefined
  const scope = {
    defaultLaneId: 'main',
    ...(fallbackProjectId !== undefined ? { projectId: fallbackProjectId } : {}),
    ...(fallbackTaskId !== undefined ? { taskId: fallbackTaskId } : {}),
  }
  const projectOrigin = input.includes('@') || /(^|:)project:/.test(input) ? 'explicit' : 'inferred'
  return resolveProfileAwareScopeInput(input, {
    scope,
    projectOrigin,
    placement: { taskWorktreeAssociation: options?.worktreeAssociation ?? 'strict' },
  })
}

/** Resolve an EXISTING target, where worktree drift must not block reachability. */
export function resolveLiveTargetToSessionRef(input: string): string {
  const resolved = resolveTargetScope(input, {
    withCallerTaskId: true,
    worktreeAssociation: 'advisory',
  })
  writePlacementWarnings('hrc', resolved.placement.warnings)
  return `${resolved.scopeRef}/lane:${resolved.laneId}`
}

/** Resolve a target that may have to be BORN, under strict placement. */
export function resolveSummonTarget(input: string): {
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
} {
  const resolved = resolveTargetScope(input, { withCallerTaskId: true })
  const paths = resolved.placement
  writePlacementWarnings('hrc', paths.warnings)
  const agentRoot = paths.agentRoot
  if (!agentRoot) {
    throw new CliUsageError(formatAgentNotFound(resolved.parsed.agentId, paths.searchedAgentRoots))
  }
  return {
    sessionRef: `${resolved.scopeRef}/lane:${resolved.laneId}`,
    runtimeIntent: buildHrcRuntimeIntent({
      agentId: resolved.parsed.agentId,
      agentRoot,
      ...(paths.projectRoot ? { projectRoot: paths.projectRoot } : {}),
      cwd: paths.cwd ?? agentRoot,
      runMode: 'task',
      interactive: false,
      preferredMode: 'nonInteractive',
      // T-07398: the handle's `+` block. Omitted entirely when the input carried
      // none, so "no directives" never reads as an empty declaration.
      ...(resolved.directives === undefined ? {} : { provision: resolved.directives }),
    }),
  }
}
