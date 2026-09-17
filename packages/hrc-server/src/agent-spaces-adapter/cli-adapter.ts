/**
 * HRC launch-environment helpers for the agent-spaces adapter.
 *
 * T-08584 retired the in-process direct preview builder (`buildCliInvocation`
 * and its spec-builder machinery): real births and turns go through the
 * broker/tmux routes, and dry-run previews observe the broker plan. What
 * remains here is the launch env policy shared by the broker launch paths.
 *
 * References: T-00960, T-00946, T-08584
 */

import { type LaneRef, formatSessionHandle, normalizeLaneRef, parseScopeRef } from 'agent-scope'
import type { HrcLaunchEnvConfig, HrcRuntimeIntent } from 'hrc-core'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Env merging
// ---------------------------------------------------------------------------

/**
 * Merge environment variables according to HRC launch env policy:
 * 1. Start with base env
 * 2. Apply `launch.env` overrides (overwrites existing keys)
 * 3. Remove keys listed in `launch.unsetEnv`
 * 4. Prepend `launch.pathPrepend` entries to PATH
 */
export function mergeEnv(
  baseEnv: Record<string, string>,
  launchConfig?: HrcLaunchEnvConfig | undefined
): Record<string, string> {
  const merged = { ...baseEnv }

  if (!launchConfig) return merged

  // Apply overrides
  if (launchConfig.env) {
    for (const [k, v] of Object.entries(launchConfig.env)) {
      merged[k] = v
    }
  }

  // Remove unset keys
  if (launchConfig.unsetEnv) {
    for (const key of launchConfig.unsetEnv) {
      delete merged[key]
    }
  }

  // Prepend to PATH
  if (launchConfig.pathPrepend && launchConfig.pathPrepend.length > 0) {
    const currentPath = merged['PATH'] ?? ''
    const prepend = launchConfig.pathPrepend.join(':')
    merged['PATH'] = currentPath ? `${prepend}:${currentPath}` : prepend
  }

  return merged
}

// ---------------------------------------------------------------------------
// Internal: build HRC correlation env vars from placement
// ---------------------------------------------------------------------------

export function buildHrcCorrelationEnv(intent: HrcRuntimeIntent): Record<string, string> {
  const env: Record<string, string> = {}
  const correlation = intent.placement?.correlation
  const taskContext = intent.taskContext

  if (correlation?.sessionRef) {
    const { scopeRef, laneRef } = correlation.sessionRef
    const normalizedLaneRef = normalizeCorrelationLaneRef(laneRef)
    const laneId = normalizedLaneRef === 'main' ? 'main' : normalizedLaneRef.slice('lane:'.length)
    const sessionRef = `${scopeRef}/lane:${laneId}`
    env['AGENT_SCOPE_REF'] = scopeRef
    env['AGENT_LANE_REF'] = normalizedLaneRef
    env['AGENT_LANE'] = laneId
    env['AGENT_SESSION_REF'] = sessionRef
    env['HRC_SESSION_REF'] = sessionRef
    env['ASP_SCOPE_REF'] = scopeRef
    const parsed = parseScopeRef(scopeRef)
    if (parsed.agentId) {
      env['AGENT_ID'] = parsed.agentId
      env['AGENT_ACTOR'] = parsed.agentId
      env['WRKQ_ACTOR'] = parsed.agentId
      env['ASP_AGENT_ID'] = parsed.agentId
    }
    if (parsed.projectId) {
      env['AGENT_PROJECT'] = parsed.projectId
      env['ASP_PROJECT'] = parsed.projectId
    }
    if (parsed.taskId) {
      env['AGENT_TASK'] = parsed.taskId
      env['ASP_TASK_ID'] = parsed.taskId
    }
    env['ASP_HANDLE'] = formatSessionHandle({ scopeRef, laneRef: normalizedLaneRef })
  }

  if (correlation?.hostSessionId) {
    env['AGENT_HOST_SESSION_ID'] = correlation.hostSessionId
    env['HRC_HOST_SESSION_ID'] = correlation.hostSessionId
  }

  if (correlation?.runId) {
    env['AGENT_RUN_ID'] = correlation.runId
    env['HRC_RUN_ID'] = correlation.runId
  }

  if (correlation?.generation !== undefined) {
    const generation = String(correlation.generation)
    env['AGENT_GENERATION'] = generation
    env['HRC_GENERATION'] = generation
  }

  if (intent.placement?.projectRoot) {
    env['AGENT_PROJECT_ROOT'] = intent.placement.projectRoot
    env['ASP_PROJECT_ROOT'] = intent.placement.projectRoot
  }

  if (taskContext?.taskId) {
    env['HRC_TASK_ID'] = taskContext.taskId
    env['ASP_TASK_ID'] ??= taskContext.taskId
  }

  if (taskContext?.phase) {
    env['HRC_TASK_PHASE'] = taskContext.phase
  }

  if (taskContext?.role) {
    env['HRC_TASK_ROLE'] = taskContext.role
  }

  if (taskContext?.requiredEvidenceKinds) {
    env['HRC_TASK_REQUIRED_EVIDENCE'] = taskContext.requiredEvidenceKinds.join(',')
  }

  if (taskContext?.hintsText) {
    env['HRC_TASK_HINTS'] = taskContext.hintsText
  }

  return env
}

function normalizeCorrelationLaneRef(laneRef: string): LaneRef {
  if (laneRef === 'main' || laneRef === 'lane:main') {
    return 'main'
  }
  return normalizeLaneRef(laneRef.startsWith('lane:') ? laneRef : `lane:${laneRef}`)
}
