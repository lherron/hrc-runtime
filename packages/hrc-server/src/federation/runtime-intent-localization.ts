import { isAbsolute, join, relative, sep } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import { buildRuntimeBundleRef } from 'spaces-config'

import type { HrcRuntimeIntent } from 'hrc-core'

import { resolveNodeLocalPlacement } from './summon-capability.js'

export type FederatedRuntimeIntentLocalizationOptions = {
  env?: Record<string, string | undefined> | undefined
  cwd?: string | undefined
}

function localRelativeCwd(
  sourceProjectRoot: string | undefined,
  sourceCwd: string | undefined,
  localProjectRoot: string | undefined,
  fallback: string
): string {
  if (
    sourceProjectRoot === undefined ||
    sourceCwd === undefined ||
    localProjectRoot === undefined
  ) {
    return fallback
  }
  const suffix = relative(sourceProjectRoot, sourceCwd)
  if (suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))) {
    return suffix === '' ? localProjectRoot : join(localProjectRoot, suffix)
  }
  return fallback
}

/** Rebase origin-node absolute placement paths onto the accepting node. */
export function localizeFederatedRuntimeIntent(
  scopeRef: string,
  intent: HrcRuntimeIntent,
  options: FederatedRuntimeIntentLocalizationOptions = {}
): HrcRuntimeIntent {
  const resolved = resolveNodeLocalPlacement(scopeRef, {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  })
  if (resolved.placement === undefined) {
    const detail = resolved.unresolvableProjectPath
      ? `project checkout could not be resolved from ${resolved.unresolvableProjectPath}`
      : `agent home could not be resolved (${resolved.missingAgentPath ?? 'unknown search path'})`
    throw new Error(`cannot localize federated runtime placement for ${scopeRef}: ${detail}`)
  }

  const parsed = parseScopeRef(scopeRef)
  const local = resolved.placement
  const cwd = localRelativeCwd(
    intent.placement.projectRoot,
    intent.placement.cwd,
    local.projectRoot,
    local.cwd ?? local.projectRoot ?? local.agentRoot
  )
  return {
    ...intent,
    placement: {
      agentRoot: local.agentRoot,
      ...(local.projectRoot === undefined ? {} : { projectRoot: local.projectRoot }),
      cwd,
      runMode: intent.placement.runMode ?? 'task',
      bundle: buildRuntimeBundleRef({
        agentName: parsed.agentId,
        agentRoot: local.agentRoot,
        ...(local.projectRoot === undefined ? {} : { projectRoot: local.projectRoot }),
      }),
      dryRun: false,
    },
  }
}
