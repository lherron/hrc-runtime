import type { HrcTargetOperatorDisplayState, HrcTargetView } from 'hrc-core'

/**
 * Ph2 — `hrc top` primary-action policy.
 *
 * This is PRODUCT POLICY: it consumes the operator display-state projection and
 * maps it to the recommended primary action for the `action` column / `o` key.
 * It is NOT a second target-state authority — it never reclassifies target
 * truth, it only decides which existing HRC command (attach / resume / run) or
 * non-mutating lens (focus) the operator should reach for.
 *
 * Invariants (spec §Primary Action Policy):
 * - `attach` targets a CONCRETE runtime id (`hrc attach <runtimeId>`), never a
 *   handle, and only for live operator-attachable runtimes.
 * - `resume` requires a captured, non-invalidated continuation and fails
 *   clearly (`unavailable` / `missing_valid_continuation`) rather than falling
 *   back to an implicit fresh launch.
 * - `run` is offered ONLY for an active target with no runtime and no
 *   continuation.
 * - `focus` is non-mutating and carries no command argv.
 */

export type HrcTopPrimaryActionKind = 'attach' | 'focus' | 'resume' | 'run' | 'unavailable'

export type HrcTopActionInput = {
  /** Canonical operator handle, e.g. `cody@hrc-runtime:T-05404`. */
  handle: string
  /** Producer target view (target truth). */
  target: HrcTargetView
  /** Operator display state from the projection helper. */
  displayState: HrcTargetOperatorDisplayState
  /** Whether the selected runtime is operator-attachable. */
  operatorAttachable: boolean
  /** Whether a captured, non-invalidated continuation is available. */
  hasValidContinuation: boolean
}

export type HrcTopPrimaryAction = {
  kind: HrcTopPrimaryActionKind
  /** Footer copy explaining the recommendation. Always non-empty. */
  reason: string
  /**
   * Canonical command argv — present ONLY for explicit mutating actions
   * (`attach`, `resume`, `run`). `focus` and `unavailable` carry no command.
   */
  command?: string[] | undefined
  /** Concrete runtime id for an `attach` recommendation. */
  runtimeId?: string | undefined
  /** For `starting` focus: whether to tail until the runtime is attachable. */
  waitForAttachable?: boolean | undefined
  /** Machine error code for an `unavailable` recommendation. */
  errorCode?: string | undefined
}

export function recommendPrimaryAction(input: HrcTopActionInput): HrcTopPrimaryAction {
  const { handle, target, displayState, operatorAttachable, hasValidContinuation } = input
  const runtime = target.runtime

  // Live operator-attachable runtime → attach by concrete runtime id.
  if (
    (displayState === 'ready' || displayState === 'busy' || displayState === 'input') &&
    operatorAttachable &&
    runtime?.runtimeId
  ) {
    return {
      kind: 'attach',
      command: ['hrc', 'attach', runtime.runtimeId],
      runtimeId: runtime.runtimeId,
      reason: `Live attachable runtime ${runtime.runtimeId}; attach the operator TUI.`,
    }
  }

  // Starting runtime — attach may race; focus and tail until attachable.
  if (displayState === 'starting') {
    return {
      kind: 'focus',
      command: undefined,
      waitForAttachable: true,
      reason: 'Runtime is starting; focus the row and wait until it is attachable.',
    }
  }

  // Live runtime that is not operator-attachable → focus (event/capture options).
  if (displayState === 'headless') {
    return {
      kind: 'focus',
      command: undefined,
      waitForAttachable: false,
      reason: 'Live headless runtime is not operator-attachable; focus for event/capture options.',
    }
  }

  // Broken or ambiguous → non-mutating inspect lens.
  if (displayState === 'broken' || displayState === 'ambiguous') {
    return {
      kind: 'focus',
      command: undefined,
      reason:
        displayState === 'broken'
          ? 'Target reports broken/non-resumable continuity; focus for a non-mutating inspect lens.'
          : 'Handle resolves to multiple plausible runtimes; focus and choose a runtime candidate.',
    }
  }

  // Dormant or stale → explicit resume, but only with a valid continuation.
  if (displayState === 'dormant' || displayState === 'stale') {
    if (hasValidContinuation) {
      return {
        kind: 'resume',
        command: ['hrc', 'resume', handle],
        reason: `Captured continuation is available; resume ${handle}.`,
      }
    }
    return {
      kind: 'unavailable',
      command: undefined,
      errorCode: 'missing_valid_continuation',
      reason:
        'Resume is unavailable: no captured, non-invalidated continuation exists. ' +
        'hrc top will not fall back to a fresh launch.',
    }
  }

  // Active target with no runtime and no continuation → run (start path).
  if (
    isActiveTargetState(target.state) &&
    !runtime &&
    !hasValidContinuation &&
    !target.continuation
  ) {
    return {
      kind: 'run',
      command: ['hrc', 'run', handle],
      reason: `Active target with no runtime and no continuation; start it with hrc run ${handle}.`,
    }
  }

  // Fallback — non-mutating focus.
  return {
    kind: 'focus',
    command: undefined,
    reason: 'No explicit mutating action applies; focus for a non-mutating inspect lens.',
  }
}

function isActiveTargetState(state: HrcTargetView['state']): boolean {
  return state === 'discoverable' || state === 'summoned' || state === 'bound' || state === 'busy'
}
