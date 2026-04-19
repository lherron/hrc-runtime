/**
 * Address normalization and resolution for hrcchat CLI.
 */
import { formatSessionHandle, resolveScopeInput } from 'agent-scope'
import { splitSessionRef } from 'hrc-core'
import type { HrcMessageAddress } from 'hrc-core'
import { inferProjectIdFromCwd } from 'spaces-config'

/**
 * Resolve a CLI target string to a canonical sessionRef.
 * Accepts: SessionHandle (e.g. cody@demo~lane), ScopeHandle, or raw scopeRef.
 *
 * When the input omits a project qualifier (e.g. bare "clod"), the project is
 * inferred from ASP_PROJECT env or cwd so that the sessionRef matches the
 * control-plane's project-qualified sessions.
 */
export function resolveTargetToSessionRef(input: string): string {
  const resolved = resolveScopeInput(input, 'main')
  let scopeRef = resolved.scopeRef

  // Qualify with project when not already present
  if (resolved.parsed.kind === 'agent') {
    const projectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
    if (projectId) {
      scopeRef = `${scopeRef}:project:${projectId}`
    }
  }

  return `${scopeRef}/lane:${resolved.laneId}`
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
 * Infer project ID from --project flag, ASP_PROJECT env, or cwd.
 */
export function resolveProjectId(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      return args[i + 1]
    }
  }
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
