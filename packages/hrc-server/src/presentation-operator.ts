/**
 * T-08553/T-08554 — per-request operator presentation
 * (docs/aspd-headless-codex-integration.md §1.1–§1.2,
 * hrc-runtime.aspd-prepared-execution-release).
 *
 * `intent.presentation.operator` chooses the operator presentation of a NEW
 * headless execution: `'none'` declines the node's viewer, `'tmux-tui'` selects
 * the codex-app-server renderer viewer. Either overrides the node's headless
 * presentation default and exempts a Codex dispatch from the node's Codex
 * interactive redirect; an absent choice leaves both node defaults exactly as
 * they were. A choice never changes a live runtime: a scope whose live runtime
 * presents something else refuses the request.
 */
import {
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeIntent,
  type HrcRuntimeSnapshot,
  HrcUnprocessableEntityError,
} from 'hrc-core'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { toProfileSelector } from './agent-spaces-adapter/compile-adapter.js'
import { parseBrokerRuntimeHostingState } from './broker/runtime-hosting.js'
import { getReusableHeadlessRuntimeForSession } from './runtime-select.js'
import { isRuntimeUnavailableStatus } from './server-util.js'

export type OperatorPresentationSource = 'request' | 'node-default'

/** The request's explicit operator presentation, if it made a choice. */
export function requestedOperatorPresentation(
  intent: HrcRuntimeIntent
): 'none' | 'tmux-tui' | undefined {
  return intent.presentation?.operator
}

/**
 * True when the request made an explicit operator presentation choice (`none`
 * or, T-08554, the app-server `tmux-tui` viewer). Either keeps a Codex dispatch
 * off the node's interactive redirect.
 */
export function requestsOperatorPresentation(intent: HrcRuntimeIntent): boolean {
  return intent.presentation?.operator !== undefined
}

export function operatorPresentationSource(intent: HrcRuntimeIntent): OperatorPresentationSource {
  return requestsOperatorPresentation(intent) ? 'request' : 'node-default'
}

function unsupported(reason: string, detail: Record<string, unknown>): never {
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.PRESENTATION_OPERATOR_UNSUPPORTED,
    `presentation.operator is honored only on the headless broker route (${reason})`,
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
  const requested = requestedOperatorPresentation(intent)
  if (requested === undefined) return
  const detail = {
    provider: intent.harness.provider,
    harnessId: intent.harness.id,
    requested,
  }
  if (intent.harness.interactive === true || intent.execution?.preferredMode === 'interactive') {
    unsupported('interactive-intent', detail)
  }
  if (resolution.claudeRedirect) unsupported('claude-interactive-redirect', detail)
  if (!resolution.headlessTransport) unsupported('not-headless-transport', detail)
  if (resolution.headlessRoute !== undefined && resolution.headlessRoute !== 'broker') {
    unsupported(`headless-route-${resolution.headlessRoute}`, detail)
  }
  // The presentation decision is driver-gated; a viewer request on any other
  // driver would otherwise silently resolve to none.
  if (requested === 'tmux-tui' && toProfileSelector(intent)?.brokerDriver !== 'codex-app-server') {
    unsupported('driver-has-no-viewer', detail)
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
  const operator = frozen?.presentation?.operator
  if (operator === undefined) return intent
  return { ...intent, presentation: { ...intent.presentation, operator } }
}

/**
 * An omitted choice is delivered to whatever runtime is live. A scope with a
 * live headless broker runtime therefore keeps a Codex start or dispatch off the
 * node's interactive redirect, which would open a competing writer on that
 * runtime's thread instead of delivering into it.
 */
export function scopeHasLiveHeadlessBrokerRuntime(
  db: HrcDatabase,
  hostSessionId: string,
  intent: HrcRuntimeIntent
): boolean {
  const runtime = getReusableHeadlessRuntimeForSession(
    db,
    hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  return runtime?.controllerKind === 'harness-broker'
}

/**
 * The presentation a live runtime shows its operator; undefined when not live
 * (an unavailable status, or a runtime that failed to start).
 * A live broker runtime whose hosting state cannot be read is `unknown`, which
 * is not provably `none` and therefore conflicts (fail closed).
 */
export function liveRuntimePresentation(
  runtime: HrcRuntimeSnapshot
): 'none' | 'tmux-tui' | 'interactive' | 'unknown' | undefined {
  if (isRuntimeUnavailableStatus(runtime.status) || runtime.status === 'failed') return undefined
  if (runtime.transport === 'tmux') return 'interactive'
  if (runtime.controllerKind !== 'harness-broker') return 'none'
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting === undefined) return 'unknown'
  return hosting.presentation.kind === 'tmux-tui' ? 'tmux-tui' : 'none'
}

/**
 * An explicit operator presentation request against a scope whose live runtime
 * presents something else (a viewer, no viewer, an interactive surface, or
 * unreadable hosting) is refused before delivery, stale-marking or reprovision;
 * the live runtime is left untouched. Absent or matching choices never conflict.
 */
export function assertNoOperatorPresentationConflict(
  intent: HrcRuntimeIntent,
  runtimes: readonly HrcRuntimeSnapshot[]
): void {
  const requested = requestedOperatorPresentation(intent)
  if (requested === undefined) return
  for (const runtime of runtimes) {
    const presentation = liveRuntimePresentation(runtime)
    if (presentation === undefined || presentation === requested) continue
    throw new HrcConflictError(
      HrcErrorCode.PRESENTATION_CONFLICT,
      `scope has a live runtime presenting '${presentation}'; presentation.operator '${requested}' applies only to a new execution`,
      {
        field: 'presentation.operator',
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        livePresentation: presentation,
      }
    )
  }
}
