import type { HrcRuntimeIntent } from 'hrc-core'

/**
 * A persisted session intent carries HRC-owned placement and policy history,
 * not a second selection authority. Doors that need that history for a later
 * dispatch deliberately erase producer-facing selection and birth-only operator
 * presentation before compiling: ASP
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
  // T-10183: a birth-time operator choice is not an explicit choice on the
  // next delivery. Preserve viewer placement and the original stored intent.
  if (policy.presentation?.operator === undefined) return policy
  const { operator: _operator, ...presentation } = policy.presentation
  return { ...policy, presentation }
}
