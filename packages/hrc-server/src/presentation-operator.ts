/**
 * T-08553 — per-request operator presentation (docs/aspd-headless-codex-integration.md
 * §1.1, hrc-runtime.aspd-prepared-execution-release).
 *
 * `intent.presentation.operator: 'none'` declines the node's operator viewer for
 * a NEW execution and selects headless execution. It overrides the node's
 * headless presentation default and exempts a Codex dispatch from the node's
 * Codex interactive redirect; an absent choice leaves both node defaults
 * exactly as they were. It can never select a viewer and never changes a live
 * runtime: a scope whose live runtime already presents one refuses the request.
 */
import {
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeIntent,
  type HrcRuntimeSnapshot,
  HrcUnprocessableEntityError,
} from 'hrc-core'

import { parseBrokerRuntimeHostingState } from './broker/runtime-hosting.js'
import { isRuntimeUnavailableStatus } from './server-util.js'

export type OperatorPresentationSource = 'request' | 'node-default'

/** True when the request explicitly declined the operator viewer. */
export function requestsNoOperatorViewer(intent: HrcRuntimeIntent): boolean {
  return intent.presentation?.operator === 'none'
}

export function operatorPresentationSource(intent: HrcRuntimeIntent): OperatorPresentationSource {
  return requestsNoOperatorViewer(intent) ? 'request' : 'node-default'
}

function unsupported(reason: string, detail: Record<string, unknown>): never {
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.PRESENTATION_OPERATOR_UNSUPPORTED,
    `presentation.operator 'none' is honored only on the headless broker route (${reason})`,
    { field: 'presentation.operator', reason, ...detail }
  )
}

/**
 * Refuse an explicit no-viewer choice that cannot be honored, before any
 * runtime, operation or hosting effect: an interactive intent, an intent the
 * Claude interactive redirect would rewrite, or any other resolution that is
 * not the headless broker route. A no-op when the choice is absent.
 */
export function assertOperatorPresentationRoutable(
  intent: HrcRuntimeIntent,
  resolution: {
    claudeRedirect: boolean
    headlessTransport: boolean
    headlessRoute?: string | undefined
  }
): void {
  if (!requestsNoOperatorViewer(intent)) return
  const detail = { provider: intent.harness.provider, harnessId: intent.harness.id }
  if (intent.harness.interactive === true || intent.execution?.preferredMode === 'interactive') {
    unsupported('interactive-intent', detail)
  }
  if (resolution.claudeRedirect) unsupported('claude-interactive-redirect', detail)
  if (!resolution.headlessTransport) unsupported('not-headless-transport', detail)
  if (resolution.headlessRoute !== undefined && resolution.headlessRoute !== 'broker') {
    unsupported(`headless-route-${resolution.headlessRoute}`, detail)
  }
}

/**
 * A same-key retry resumes a frozen preparation whose presentation was fixed at
 * boundary P. Carry that recorded choice onto the retry so the node defaults are
 * not re-evaluated between the door and the frozen attempt.
 */
export function withFrozenOperatorPresentation(
  intent: HrcRuntimeIntent,
  frozen: HrcRuntimeIntent | undefined
): HrcRuntimeIntent {
  if (frozen?.presentation?.operator !== 'none') return intent
  return { ...intent, presentation: { operator: 'none' } }
}

/**
 * The presentation a live runtime shows its operator; undefined when not live.
 * A live broker runtime whose hosting state cannot be read is `unknown`, which
 * is not provably `none` and therefore conflicts (fail closed).
 */
export function liveRuntimePresentation(
  runtime: HrcRuntimeSnapshot
): 'none' | 'tmux-tui' | 'interactive' | 'unknown' | undefined {
  if (isRuntimeUnavailableStatus(runtime.status)) return undefined
  if (runtime.transport === 'tmux') return 'interactive'
  if (runtime.controllerKind !== 'harness-broker') return 'none'
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting === undefined) return 'unknown'
  return hosting.presentation.kind === 'tmux-tui' ? 'tmux-tui' : 'none'
}

/**
 * An explicit no-viewer request against a scope whose live runtime presents a
 * viewer or an interactive surface is refused before delivery, stale-marking or
 * reprovision; the live runtime is left untouched. Absent or matching choices
 * never conflict.
 */
export function assertNoOperatorPresentationConflict(
  intent: HrcRuntimeIntent,
  runtimes: readonly HrcRuntimeSnapshot[]
): void {
  if (!requestsNoOperatorViewer(intent)) return
  for (const runtime of runtimes) {
    const presentation = liveRuntimePresentation(runtime)
    if (presentation === undefined || presentation === 'none') continue
    throw new HrcConflictError(
      HrcErrorCode.PRESENTATION_CONFLICT,
      `scope has a live runtime presenting '${presentation}'; presentation.operator 'none' applies only to a new execution`,
      {
        field: 'presentation.operator',
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        livePresentation: presentation,
      }
    )
  }
}
