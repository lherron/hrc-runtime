import type { HrcTargetRuntimeView, HrcTargetView } from './hrcchat-contracts.js'

/**
 * Ph2 — operator display-state projection for `hrc top` rows.
 *
 * This is a PURE projection over `HrcTargetView` (producer truth) plus
 * optional read-only enrichment facts. It is NOT a second target-state
 * authority:
 *
 * - `busy`, `dormant`, and `broken` are TARGET-TRUTH states preserved verbatim
 *   from `HrcTargetView.state`. They are never re-derived from runtime history.
 * - `input`, `ready`, `starting`, `headless`, `stale`, and `ambiguous` are
 *   REFINEMENTS over the DTO and optional facts (runtime detail status,
 *   attachability, continuation validity, ambiguity).
 *
 * Attachability is derived from the operator attach surface — an attach
 * descriptor (`runtime.operatorAttachable`) OR a broker `presentation` of
 * `tmux-tui` — never from `transport === 'tmux'` alone. Descriptor acquisition
 * is not a read-model probe; callers pass what HRC already exposed.
 */

export type HrcTargetOperatorDisplayState =
  | 'busy'
  | 'input'
  | 'ready'
  | 'starting'
  | 'headless'
  | 'dormant'
  | 'stale'
  | 'broken'
  | 'ambiguous'

/**
 * Optional read-only enrichment facts layered over the target DTO. All fields
 * are optional; the projection falls back to the target's own runtime detail
 * when a fact is absent.
 */
export type HrcTargetOperatorProjectionFacts = {
  /** Selected runtime detail status, e.g. `awaiting_input`, `ready`, `starting`, `terminated`. */
  runtimeStatus?: string | undefined
  /** Whether the operator can attach a TUI to the selected runtime. */
  operatorAttachable?: boolean | undefined
  /** Whether a captured, non-invalidated continuation is available. */
  hasValidContinuation?: boolean | undefined
  /** Whether the handle resolves to multiple plausible runtimes. */
  ambiguous?: boolean | undefined
}

export type HrcTargetOperatorProjection = {
  displayState: HrcTargetOperatorDisplayState
  operatorAttachable: boolean
  runtimeStatus: string | undefined
  hasValidContinuation: boolean
  ambiguous: boolean
}

const TERMINAL_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  'terminated',
  'terminal',
  'dead',
  'exited',
  'stopped',
  'failed',
])

/**
 * Attachable = tmux/ghostty runtime with an attach descriptor
 * (`operatorAttachable`) OR a broker runtime presenting a `tmux-tui`. Transport
 * alone (e.g. `tmux`) is NEVER sufficient; headless durable runtimes may live
 * in tmux internally and still be non-attachable.
 */
function computeAttachable(runtime: HrcTargetRuntimeView | undefined): boolean {
  if (!runtime) return false
  if (runtime.operatorAttachable === true) return true
  if (runtime.presentation === 'tmux-tui') return true
  return false
}

export function projectTargetOperatorState(
  target: HrcTargetView,
  facts?: HrcTargetOperatorProjectionFacts
): HrcTargetOperatorProjection {
  const computedAttachable = computeAttachable(target.runtime)
  const operatorAttachable = facts?.operatorAttachable ?? computedAttachable
  const runtimeStatus = facts?.runtimeStatus ?? target.runtime?.status
  const hasValidContinuation = facts?.hasValidContinuation ?? false
  const ambiguous = facts?.ambiguous ?? false

  const displayState = deriveDisplayState(target, {
    operatorAttachable,
    runtimeStatus,
    hasValidContinuation,
    ambiguous,
  })

  return {
    displayState,
    operatorAttachable,
    runtimeStatus,
    hasValidContinuation,
    ambiguous,
  }
}

function deriveDisplayState(
  target: HrcTargetView,
  resolved: {
    operatorAttachable: boolean
    runtimeStatus: string | undefined
    hasValidContinuation: boolean
    ambiguous: boolean
  }
): HrcTargetOperatorDisplayState {
  // Target-truth states are preserved verbatim — never re-derived from runtime
  // history or enrichment facts.
  if (target.state === 'busy') return 'busy'
  if (target.state === 'dormant') return 'dormant'
  if (target.state === 'broken') return 'broken'

  // Refinements over a non-terminal target view.
  if (resolved.ambiguous) return 'ambiguous'

  const status = resolved.runtimeStatus

  if (status !== undefined && TERMINAL_RUNTIME_STATUSES.has(status)) {
    if (resolved.hasValidContinuation) return 'stale'
  }

  if (status === 'awaiting_input') return 'input'
  if (status === 'starting') return 'starting'

  // A live runtime that the operator cannot attach to is headless.
  if (target.runtime !== undefined && !resolved.operatorAttachable) return 'headless'

  return 'ready'
}
