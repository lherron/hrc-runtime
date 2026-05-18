/**
 * Address normalization and resolution for hrcchat CLI.
 */
import { formatSessionHandle, resolveQualifiedScopeInput } from 'agent-scope'
import { splitSessionRef } from 'hrc-core'
import type { HrcMessageAddress } from 'hrc-core'
import { inferProjectIdFromCwd } from 'spaces-config'

/**
 * Extract a taskId from HRC_SESSION_REF, when the caller is already running
 * inside a task-scoped session. Returns undefined when the env var is unset
 * or does not carry a `task:<id>` segment.
 */
function inferTaskIdFromCallerSession(): string | undefined {
  const raw = process.env['HRC_SESSION_REF']
  if (!raw) return undefined
  // Strip lane suffix and scan for `:task:<id>`.
  const scopePart = raw.split('/')[0] ?? raw
  const parts = scopePart.split(':')
  const taskIdx = parts.indexOf('task')
  if (taskIdx >= 0 && parts[taskIdx + 1]) {
    return parts[taskIdx + 1]
  }
  return undefined
}

/**
 * Resolve a CLI target string to a canonical sessionRef.
 * Accepts: SessionHandle (e.g. cody@demo~lane), ScopeHandle, or raw scopeRef.
 *
 * When the input omits a project qualifier (e.g. bare "clod"), the project is
 * inferred from ASP_PROJECT env or cwd. When the input omits a task qualifier
 * the canonical default `primary` is applied so the sessionRef is always
 * agent+project+task qualified.
 */
export function resolveTargetToSessionRef(input: string): string {
  const fallbackProjectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const fallbackTaskId = inferTaskIdFromCallerSession()

  const resolved = resolveQualifiedScopeInput(input, {
    defaultLaneId: 'main',
    ...(fallbackProjectId !== undefined ? { projectId: fallbackProjectId } : {}),
    ...(fallbackTaskId !== undefined ? { taskId: fallbackTaskId } : {}),
  })

  return `${resolved.scopeRef}/lane:${resolved.laneId}`
}

/**
 * Resolve a CLI address string to an HrcMessageAddress.
 * Accepts: "human", "system", "me", or a target handle.
 */
export function resolveAddress(
  input: string,
  callerSessionRef?: string | undefined
): HrcMessageAddress {
  const lower = input.toLowerCase()

  if (lower === 'human') {
    return { kind: 'entity', entity: 'human' }
  }

  if (lower === 'system') {
    return { kind: 'entity', entity: 'system' }
  }

  if (lower === 'me') {
    if (callerSessionRef) {
      return { kind: 'session', sessionRef: callerSessionRef }
    }
    return { kind: 'entity', entity: 'human' }
  }

  return {
    kind: 'session',
    sessionRef: resolveTargetToSessionRef(input),
  }
}

/**
 * Determine the caller's "me" address from HRC_SESSION_REF env.
 */
export function resolveCallerAddress(): HrcMessageAddress {
  const raw = process.env['HRC_SESSION_REF']
  if (raw) {
    // Normalize legacy format (scopeRef/laneId) to canonical (scopeRef/lane:laneId)
    const sessionRef = raw.includes('/lane:') ? raw : raw.replace(/\/([^/]+)$/, '/lane:$1')
    return { kind: 'session', sessionRef }
  }
  return { kind: 'entity', entity: 'human' }
}

/**
 * Resolve project ID from explicit value, ASP_PROJECT env, or cwd.
 */
export function resolveProjectId(explicit?: string): string | undefined {
  if (explicit) return explicit
  return process.env['ASP_PROJECT'] ?? undefined
}

/**
 * Format an HrcMessageAddress for human display.
 */
export function formatAddress(addr: HrcMessageAddress): string {
  if (addr.kind === 'entity') return addr.entity
  try {
    const { scopeRef, laneRef } = splitSessionRef(addr.sessionRef)
    return formatSessionHandle({
      scopeRef,
      laneRef: laneRef === 'main' ? 'main' : `lane:${laneRef}`,
    })
  } catch {
    return addr.sessionRef
  }
}
