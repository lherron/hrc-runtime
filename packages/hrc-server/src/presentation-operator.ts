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
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { configuredAspdEndpoint } from './agent-spaces-adapter/aspd-preparation-client.js'
import {
  decideInteractiveBrokerAdmission,
  toLatestRuntimeAdmissionView,
} from './broker-decisions.js'
import { parseBrokerRuntimeHostingState } from './broker/runtime-hosting.js'
import { getReusableHeadlessRuntimeForSession } from './runtime-select.js'
import { isRuntimeUnavailableStatus } from './server-util.js'

export type OperatorPresentationSource = 'request' | 'node-default'

/** The request's explicit operator presentation, if it made a choice. */
export function requestedOperatorPresentation(
  intent: HrcRuntimeIntent
): 'none' | 'tmux-tui' | 'observer' | undefined {
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
  // ASP validates whether the requested presentation can be fulfilled by its
  // selected execution. HRC has no pre-compile driver map to consult here.
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
export function scopeHasLiveHeadlessBrokerRuntime(db: HrcDatabase, hostSessionId: string): boolean {
  const runtime = getReusableHeadlessRuntimeForSession(db, hostSessionId)
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
): 'none' | 'tmux-tui' | 'observer' | 'interactive' | 'unknown' | undefined {
  if (isRuntimeUnavailableStatus(runtime.status) || runtime.status === 'failed') return undefined
  if (runtime.transport === 'tmux') return 'interactive'
  if (runtime.controllerKind !== 'harness-broker') return 'none'
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting === undefined) return 'unknown'
  if (hosting.presentation.kind === 'tmux-tui') return 'tmux-tui'
  if (hosting.presentation.kind === 'observer') return 'observer'
  return 'none'
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

/**
 * T-08555 — how an omitted-choice, non-interactive Codex request is routed on a
 * node whose Codex interactive redirect is OFF
 * (docs/aspd-headless-codex-integration.md §1.3, rules 3–5). The scope's
 * established runtime selects the admission; that admission alone decides
 * reuse, birth join, refusal or fenced replacement. With nothing established,
 * the request runs headless with the node presentation default.
 */
export type RedirectOffCodexRoute = 'interactive' | 'headless'

/**
 * The most recently created harness-broker runtime of the host session whose
 * status is neither unavailable nor failed — of any provider, harness, driver or
 * invocation state (a `starting`/`stopping` runtime is still established).
 */
export function findEstablishedBrokerRuntime(
  runtimes: readonly HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot | undefined {
  return runtimes
    .filter(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' &&
        runtime.status !== 'failed' &&
        !isRuntimeUnavailableStatus(runtime.status)
    )
    .at(-1)
}

/** True for the Codex requests §1.3 routes: non-interactive openai codex-cli. */
export function isOmittedChoiceCodexRequest(intent: HrcRuntimeIntent): boolean {
  return (
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli') &&
    intent.harness.interactive !== true &&
    intent.execution?.preferredMode !== 'interactive' &&
    !requestsOperatorPresentation(intent)
  )
}

/**
 * Rules 3–5 for a request `isOmittedChoiceCodexRequest` admits: a tmux
 * established runtime of any harness selects interactive admission; a headless
 * one of the same provider and harness selects the headless route; a headless
 * one of any other provider or harness is refused before any effect, since the
 * headless start door replaces only a same-harness runtime and proceeding would
 * start a second writer beside it.
 */
export function decideRedirectOffCodexRoute(
  intent: HrcRuntimeIntent,
  runtimes: readonly HrcRuntimeSnapshot[]
): RedirectOffCodexRoute {
  const established = findEstablishedBrokerRuntime(runtimes)
  if (established === undefined) return 'headless'
  if (established.transport === 'tmux') return 'interactive'
  const requestedHarness = intent.harness.id ?? 'codex-cli'
  if (established.provider === 'openai' && established.harness === requestedHarness) {
    return 'headless'
  }
  throw new HrcRuntimeUnavailableError(
    'scope has an established broker runtime of another harness; terminate it before starting codex here',
    {
      reason: 'established_runtime_harness_mismatch',
      runtimeId: established.runtimeId,
      hostSessionId: established.hostSessionId,
      establishedProvider: established.provider,
      establishedHarness: established.harness,
      establishedTransport: established.transport,
      requestedHarness,
    }
  )
}

/**
 * T-08555 — the birth an in-flight start has chosen: its transport AND its
 * provider/harness. A redirect-off dispatch crossing a start is routed by that
 * birth exactly as it would be by the established runtime it becomes, except
 * that a foreign-harness birth refuses (a newborn is never admission-replaced,
 * T-07693). Only the DECISION is awaited, never the boot, so a same-harness
 * headless boot still queues a crossing prompt behind itself. A start that
 * records no birth is not treated as absent: the dispatch awaits its boot and
 * then routes by the rows it left.
 */
export type StartBirth = {
  transport: 'tmux' | 'headless'
  provider: string
  harness: string | undefined
}

const startBirthDecisions = new WeakMap<
  Promise<HrcRuntimeSnapshot>,
  Promise<StartBirth | undefined>
>()

export type StartBirthDecision = {
  readonly decided: Promise<StartBirth | undefined>
  decide(birth: StartBirth | undefined): void
}

/** A decision a start door settles once it has chosen its birth. */
export function createStartBirthDecision(): StartBirthDecision {
  let settle!: (birth: StartBirth | undefined) => void
  const decided = new Promise<StartBirth | undefined>((resolve) => {
    settle = resolve
  })
  return { decided, decide: (birth) => settle(birth) }
}

/** The birth an intent starts on a transport. */
export function startBirthOfIntent(
  transport: StartBirth['transport'],
  intent: HrcRuntimeIntent
): StartBirth | undefined {
  const provider = intent.harness.provider
  if (provider === undefined) return undefined
  return { transport, provider, harness: intent.harness.id }
}

/** The birth a reattach of an existing runtime resumes. */
export function startBirthOfRuntime(runtime: HrcRuntimeSnapshot): StartBirth {
  if (runtime.provider === undefined) {
    throw new HrcRuntimeUnavailableError(
      'producer-selected runtime has no legacy provider identity for interactive reuse',
      { reason: 'producer_selected_runtime_not_legacy_interactive' }
    )
  }
  return {
    transport: runtime.transport === 'tmux' ? 'tmux' : 'headless',
    provider: runtime.provider,
    harness: runtime.harness,
  }
}

/** Bind a start operation to its birth (known now, or a pending decision). */
export function recordStartBirth(
  operation: Promise<HrcRuntimeSnapshot>,
  birth: StartBirth | undefined | Promise<StartBirth | undefined>
): void {
  startBirthDecisions.set(operation, Promise.resolve(birth))
}

/** The in-flight start's chosen birth; undefined when it recorded none. */
export async function startBirthOf(
  operation: Promise<HrcRuntimeSnapshot>
): Promise<StartBirth | undefined> {
  return await (startBirthDecisions.get(operation) ?? Promise.resolve(undefined))
}

/**
 * Rules 3–4 for a dispatch crossing an in-flight birth: a same-harness birth
 * selects its transport's admission (the T-07693 join or the headless
 * queue-behind-boot); a foreign-harness birth refuses before any effect.
 */
export function decideCrossingBirthRoute(
  intent: HrcRuntimeIntent,
  birth: StartBirth
): RedirectOffCodexRoute {
  const requestedHarness = intent.harness.id ?? 'codex-cli'
  if (birth.provider === 'openai' && birth.harness === requestedHarness) {
    return birth.transport === 'tmux' ? 'interactive' : 'headless'
  }
  throw new HrcRuntimeUnavailableError(
    'scope has a start in flight for another harness; retry once it has settled',
    {
      reason:
        birth.transport === 'headless'
          ? 'established_runtime_harness_mismatch'
          : 'start_in_flight_harness_mismatch',
      birthTransport: birth.transport,
      birthProvider: birth.provider,
      birthHarness: birth.harness,
      requestedHarness,
    }
  )
}

/**
 * T-08555 — the authority a redirect-off crossing dispatch carries to every
 * point that joins an in-flight start. The route was classified from one
 * birth; the operation actually joined may be a later one (turnover), so each
 * join re-derives the route from the birth it joins and admits a tmux newborn
 * only through interactive admission.
 */
export type RedirectOffBirthJoin = {
  route: RedirectOffCodexRoute
  claudeCodeTmuxBrokerEnabled: boolean
  piTuiTmuxBrokerEnabled: boolean
  museCliTmuxBrokerEnabled: boolean
  establishedBrokerInvocationId?: string | undefined
}

/** Before joining: the joined start's recorded birth must route as classified. */
export async function assertBirthJoinRoute(
  intent: HrcRuntimeIntent,
  operation: Promise<HrcRuntimeSnapshot>,
  join: RedirectOffBirthJoin
): Promise<void> {
  const birth = await startBirthOf(operation)
  if (birth === undefined) {
    throw new HrcRuntimeUnavailableError(
      'scope has an unclassified start in flight; retry once it has settled',
      { reason: 'start_in_flight_unclassified', classifiedRoute: join.route }
    )
  }
  const route = decideCrossingBirthRoute(intent, birth)
  if (route !== join.route) {
    throw new HrcRuntimeUnavailableError(
      'the start in flight changed transport after routing; retry once it has settled',
      { reason: 'start_in_flight_changed', classifiedRoute: join.route, joinedRoute: route }
    )
  }
}

/** After a tmux birth settles: only interactive admission's broker-reuse joins it. */
export function assertBirthJoinAdmitted(
  intent: HrcRuntimeIntent,
  newborn: HrcRuntimeSnapshot,
  join: RedirectOffBirthJoin,
  /** T-08556: the attached-run door judges the newborn's actual dispatchability. */
  inputDispatchable = true
): void {
  const admission = decideInteractiveBrokerAdmission(
    intent,
    toLatestRuntimeAdmissionView(newborn, inputDispatchable),
    {
      claudeCodeTmuxBrokerEnabled: join.claudeCodeTmuxBrokerEnabled,
      piTuiTmuxBrokerEnabled: join.piTuiTmuxBrokerEnabled,
      museCliTmuxBrokerEnabled: join.museCliTmuxBrokerEnabled,
      ...(join.establishedBrokerInvocationId !== undefined
        ? { establishedBrokerInvocationId: join.establishedBrokerInvocationId }
        : {}),
    }
  )
  if (admission.decision === 'broker-reuse') return
  throw new HrcRuntimeUnavailableError(
    admission.decision === 'runtime-unavailable'
      ? admission.reason
      : 'the newborn in flight is not reusable by this request',
    {
      reason:
        admission.decision === 'runtime-unavailable'
          ? admission.reason
          : 'start_in_flight_not_reusable',
      runtimeId: newborn.runtimeId,
      hostSessionId: newborn.hostSessionId,
      admissionDecision: admission.decision,
      route: 'interactive-broker-birth-join',
    }
  )
}

/**
 * T-08556 (§1.4) — the attached-run door (`hrc run`, `hrc resume`) selects its
 * producer-selected runtime inside the start singleflight on a node that
 * declares an aspd endpoint.  The retained export name is a wire-door shim;
 * it deliberately does not inspect the request's provider or harness.
 */
export function isAttachedRunAspdCodexIntent(
  _intent: HrcRuntimeIntent,
  env: Record<string, string | undefined> = process.env
): boolean {
  return configuredAspdEndpoint(env) !== undefined
}

/**
 * §1.4 rule 3 — the attached-run door against a headless subject (the joined
 * start's runtime, or the established runtime). It never stale-marks, replaces
 * or starts beside it: a settled, operator-attachable Codex runtime is reused;
 * every unattachable headless runtime refuses before any effect and stays
 * untouched.  Attachability is an admitted hosting fact, never an input
 * harness/driver predicate.
 */
export function assertAttachedRunReusesHeadless(
  runtime: HrcRuntimeSnapshot,
  options: { transitional: boolean }
): void {
  const detail = {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    establishedProvider: runtime.provider,
    establishedHarness: runtime.harness,
    establishedTransport: runtime.transport,
  }
  if (options.transitional) {
    throw new HrcRuntimeUnavailableError(
      'scope has a headless codex runtime that is starting or stopping; retry once it settles',
      { reason: 'attached_run_runtime_transitional', ...detail }
    )
  }
  const surface = parseBrokerRuntimeHostingState(runtime)?.presentation.kind
  if (surface !== 'tmux-tui' && surface !== 'observer') {
    throw new HrcConflictError(
      HrcErrorCode.PRESENTATION_CONFLICT,
      'scope has a live runtime without an admitted presentation surface; hrc run cannot attach without replacement',
      {
        field: 'presentation.operator',
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        livePresentation: surface ?? 'none',
      }
    )
  }
}
