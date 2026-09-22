import type { HrcRuntimeIntent } from 'hrc-core'

/**
 * A persisted session intent carries HRC-owned placement and policy history,
 * not a second selection authority. Doors that need that history for a later
 * dispatch deliberately erase producer-facing selection before compiling: ASP
 * receives omission and either reuses the frozen runtime or resolves a new
 * execution under its own precedence.
 */
export function omitPersistedSelectionForReuse(intent: HrcRuntimeIntent): HrcRuntimeIntent
export function omitPersistedSelectionForReuse(intent: null | undefined): undefined
export function omitPersistedSelectionForReuse(
  intent: HrcRuntimeIntent | null | undefined
): HrcRuntimeIntent | undefined
export function omitPersistedSelectionForReuse(
  intent: HrcRuntimeIntent | null | undefined
): HrcRuntimeIntent | undefined
export function omitPersistedSelectionForReuse(
  intent: HrcRuntimeIntent | null | undefined
): HrcRuntimeIntent | undefined {
  if (intent === null || intent === undefined) return undefined
  const { selection: _selection, summonDirectives: _summonDirectives, ...policy } = intent
  return policy
}
