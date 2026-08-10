/**
 * Address normalization and resolution for hrcchat CLI.
 */
import { formatSessionHandle } from 'agent-scope'
import { resolveQualifiedScopeInput } from 'agent-scope'
import { splitSessionRef } from 'hrc-core'
import type { HrcMessageAddress } from 'hrc-core'
import { resolveProfileAwareScopeInput } from 'hrc-sdk'
import type { ProfileAwareResolvedScopeInput } from 'hrc-sdk'
import { inferProjectIdFromCwd } from 'spaces-config'

import { taskIdFromSessionRef } from './taskId.js'

/**
 * Extract a taskId from HRC_SESSION_REF, when the caller is already running
 * inside a task-scoped session. Returns undefined when the env var is unset
 * or does not carry a `task:<id>` segment.
 */
function inferTaskIdFromCallerSession(): string | undefined {
  const raw = process.env['HRC_SESSION_REF']
  if (!raw) return undefined
  return taskIdFromSessionRef(raw)
}

/**
 * Resolve a CLI target string to a fully-qualified scope bundle.
 *
 * Centralizes the `ASP_PROJECT ?? inferProjectIdFromCwd()` project-fallback plus
 * `resolveQualifiedScopeInput` idiom that was previously repeated across the CLI.
 * When `withCallerTaskId` is set the caller's task qualifier (from
 * HRC_SESSION_REF) is applied as the task fallback so a bare agent input resolves
 * into the caller's task scope.
 */
export function resolveScope(
  input: string,
  options?: { withCallerTaskId?: boolean; worktreeAssociation?: 'strict' | 'advisory' }
): ProfileAwareResolvedScopeInput {
  const fallbackProjectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const fallbackTaskId = options?.withCallerTaskId ? inferTaskIdFromCallerSession() : undefined
  const scope = {
    defaultLaneId: 'main',
    ...(fallbackProjectId !== undefined ? { projectId: fallbackProjectId } : {}),
    ...(fallbackTaskId !== undefined ? { taskId: fallbackTaskId } : {}),
  }
  const projectOrigin = input.includes('@') || /(^|:)project:/.test(input) ? 'explicit' : 'inferred'

  try {
    return resolveProfileAwareScopeInput(input, { scope, projectOrigin })
  } catch (error) {
    const association = parseWorktreeAssociationError(error)
    if (options?.worktreeAssociation !== 'advisory' || association === undefined) throw error

    // Messaging is the recovery channel for a worker whose checkout drifted,
    // so a path/branch association mismatch cannot be a delivery gate. Probe
    // the canonical project with a non-task token (which deliberately skips
    // task-worktree refinement), then retry the real target against that root.
    const initial = resolveQualifiedScopeInput(input, scope)
    const projectId = initial.parsed.projectId
    if (projectId === undefined) throw error
    const canonicalProbe = resolveProfileAwareScopeInput(
      `${initial.parsed.agentId}@${projectId}:primary`,
      { scope: { defaultLaneId: 'main' }, projectOrigin: 'explicit' }
    )
    const canonicalRoot =
      canonicalProbe.placement.resolution.canonicalRoot ?? canonicalProbe.placement.projectRoot
    if (canonicalRoot === undefined) throw error

    process.stderr.write(`[hrcchat] warning: ${formatWorktreeAssociationWarning(association)}\n`)
    return resolveProfileAwareScopeInput(input, {
      scope,
      projectOrigin,
      placement: { projectRoot: canonicalRoot },
    })
  }
}

type WorktreeAssociationMismatch = {
  path: string
  taskId: string
  branch?: string | undefined
}

function parseWorktreeAssociationError(error: unknown): WorktreeAssociationMismatch | undefined {
  if (!(error instanceof Error)) return undefined
  const match =
    /^worktree at (.+) appears associated with (T-\d+) but its branch (.+) does not carry it$/.exec(
      error.message
    )
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return {
    path: match[1],
    taskId: match[2],
    ...(match[3] === 'detached' ? {} : { branch: match[3] }),
  }
}

function formatWorktreeAssociationWarning(mismatch: WorktreeAssociationMismatch): string {
  if (mismatch.branch) {
    return `worktree at ${mismatch.path} appears associated with ${mismatch.taskId} but branch ${mismatch.branch} does not carry ${mismatch.taskId}; using canonical checkout for messaging`
  }
  return `worktree at ${mismatch.path} appears associated with ${mismatch.taskId} but is detached HEAD (no branch); using canonical checkout for messaging`
}

/** Resolve a messaging target without allowing worktree drift to block delivery. */
export function resolveMessagingScope(
  input: string,
  options?: { withCallerTaskId?: boolean }
): ProfileAwareResolvedScopeInput {
  return resolveScope(input, { ...options, worktreeAssociation: 'advisory' })
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
  const resolved = resolveScope(input, { withCallerTaskId: true })
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

export type ResolvedSender = {
  address: HrcMessageAddress
  source: 'explicit' | 'envelope' | 'human-fallback'
}

/**
 * Resolve the sender for a semantic send. An explicit `--as` wins; otherwise
 * the session envelope; otherwise the human seat — but that fallback is only
 * appropriate on an interactive operator terminal, so callers must gate on
 * `source` (2026-07-25 attribution ruling: four scripted node probes silently
 * went out as the human seat).
 */
export function resolveSenderAddress(asInput?: string | undefined): ResolvedSender {
  if (asInput !== undefined && asInput.trim().length > 0) {
    return { address: resolveAddress(asInput, process.env['HRC_SESSION_REF']), source: 'explicit' }
  }
  const fromEnvelope = resolveCallerAddress()
  if (fromEnvelope.kind === 'session') {
    return { address: fromEnvelope, source: 'envelope' }
  }
  return { address: fromEnvelope, source: 'human-fallback' }
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
