import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcRuntimeControllerKind, HrcRuntimeIntent } from 'hrc-core'
import { shouldUseHeadlessSdkExecutor } from './broker-decisions-harness.js'
import {
  shouldConsiderClaudeCodeTmuxBrokerDispatch,
  shouldConsiderCodexCliTmuxBrokerDispatch,
  shouldConsiderMuseCliTmuxBrokerDispatch,
  shouldConsiderPiTuiTmuxBrokerDispatch,
  shouldUseHeadlessTransport,
} from './broker-decisions-intent.js'
import type {
  InteractiveBrokerAdmissionDecision,
  InteractiveTmuxBrokerDriver,
  InteractiveTmuxBrokerStartRoute,
  LatestRuntimeAdmissionView,
} from './broker-decisions-types.js'
import {
  HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
  HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
  HRC_MUSE_CLI_TMUX_BROKER_ENABLED_ENV,
  HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
} from './server-constants.js'
import { isRuntimeUnavailableStatus } from './server-util.js'

export {
  isProducerSelectedOrdinaryBirth,
  deriveInteractiveHarness,
  toRuntimeContinuationRef,
  deriveSdkHarness,
  shouldUseHeadlessSdkExecutor,
} from './broker-decisions-harness.js'
export type {
  InteractiveTmuxBrokerDriver,
  LatestRuntimeAdmissionView,
  InteractiveBrokerAdmissionDecision,
  InteractiveTmuxBrokerStartRoute,
} from './broker-decisions-types.js'
export {
  filterBrokerDispatchEnvForLockedEnv,
  extractPiSdkBrokerCredentialEnv,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
  shouldConsiderClaudeCodeTmuxBrokerDispatch,
  shouldRedirectClaudeToInteractiveBroker,
  normalizeClaudeInteractiveBrokerIntent,
  shouldRedirectCodexToInteractiveBroker,
  normalizeCodexInteractiveBrokerIntent,
  shouldBlockForBrokerTurnCompletion,
  decideInteractiveTmuxBrokerContinuation,
  shouldConsiderCodexCliTmuxBrokerDispatch,
  shouldConsiderPiTuiTmuxBrokerDispatch,
  shouldConsiderMuseCliTmuxBrokerDispatch,
  isInteractiveTmuxBrokerDriver,
  isMatchingInteractiveTmuxBrokerRuntime,
  getBrokerRuntimeDriver,
  toLatestRuntimeAdmissionView,
  toLiveInteractiveRuntimeReuseView,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  getBrokerRuntimeTmuxSocketPath,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxLeasedPaneId,
  isInteractiveTmuxBrokerIntent,
  isTruthyFeatureFlag,
  isFalsyFeatureFlag,
  normalizeRuntimeProvisionIntent,
} from './broker-decisions-intent.js'
export type { LiveInteractiveRuntimeReuseView } from './broker-decisions-intent.js'

export type HeadlessExecutionRoute = 'sdk' | 'broker' | 'legacy-exec'

export function decideHeadlessExecutionRoute(
  intent: HrcRuntimeIntent,
  options: { brokerFlagEnabled: boolean; museBrokerFlagEnabled: boolean }
): HeadlessExecutionRoute {
  if (shouldUseHeadlessSdkExecutor(intent.harness)) {
    return 'sdk'
  }

  const isHeadlessPiSdkCandidate =
    shouldUseHeadlessTransport(intent) &&
    intent.harness.interactive !== true &&
    intent.harness.id === 'pi-sdk'

  if (isHeadlessPiSdkCandidate) {
    return 'broker'
  }

  const isHeadlessCodexCandidate =
    options.brokerFlagEnabled &&
    shouldUseHeadlessTransport(intent) &&
    intent.harness.interactive !== true &&
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli')

  if (isHeadlessCodexCandidate) {
    return 'broker'
  }

  const isHeadlessMuseCandidate =
    options.museBrokerFlagEnabled &&
    shouldUseHeadlessTransport(intent) &&
    intent.harness.interactive !== true &&
    intent.harness.provider === 'meta' &&
    (intent.harness.id === undefined || intent.harness.id === 'muse-cli')

  return isHeadlessMuseCandidate ? 'broker' : 'legacy-exec'
}

export async function runHeadlessRoute<T>(
  route: HeadlessExecutionRoute,
  executors: {
    sdk: () => Promise<T>
    broker: () => Promise<T>
    legacyExec: () => Promise<T>
  }
): Promise<T> {
  switch (route) {
    case 'sdk':
      return await executors.sdk()
    case 'broker':
      return await executors.broker()
    case 'legacy-exec':
      return await executors.legacyExec()
  }
}

export type InteractiveTmuxExecutionRoute = 'broker' | 'legacy-tmux'

export type BrokerDurableInteractiveRoute = 'durable-ipc' | 'legacy'

/**
 * T-01810 (T-01801 Phase 1) — select the durable-interactive broker route only
 * when the durable-IPC flag is ON and the persisted broker endpoint rides a Unix
 * socket. Any other combination (flag off, or a stdio endpoint) keeps the legacy
 * route. Gated additionally on an interactive interaction mode — the durable
 * route is for the persistent interactive TUI, not a headless turn. Pure.
 */
export function decideBrokerDurableInteractiveRoute(input: {
  durableIpcEnabled: boolean
  endpointKind: 'stdio-jsonrpc-ndjson' | 'unix-jsonrpc-ndjson'
  interactionMode: 'interactive' | 'headless'
}): BrokerDurableInteractiveRoute {
  if (
    input.durableIpcEnabled &&
    input.endpointKind === 'unix-jsonrpc-ndjson' &&
    input.interactionMode === 'interactive'
  ) {
    return 'durable-ipc'
  }
  return 'legacy'
}

/**
 * T-04921 (T-04905 Phase A) — the HRC-owned operator-presentation policy for a
 * headless broker runtime. `tmux-tui` requests the dual-tmux viewer route (a
 * broker window + an operator-attachable TUI pane); `none` is ordinary headless.
 */
export type OperatorPresentation = 'tmux-tui' | 'observer' | 'none'

/**
 * T-04921 (T-04905 Phase A) — pure route decision for the codex-app-server
 * tmux-tui route. The SEMANTIC TRIGGER is the POLICY
 * (`operatorPresentation`), never the driver name: a codex-app-server profile
 * with NO policy stays ordinary headless (`none`). Driver identity is only the
 * APPLICABILITY gate — the policy can request a viewer ONLY for a driver that can
 * present one (codex-app-server). The operator-presentation substrate is a
 * hosting decision and therefore does not depend on whether the in-daemon
 * a presentation actuator is enabled. HARD CONSTRAINT (daedalus DM #8645):
 * must NOT key off hardcoded agent names, and must NOT treat
 * `brokerDriver === 'codex-app-server'` alone as sufficient.
 */
export function decideCodexAppServerPresentation(input: {
  operatorPresentation: string | undefined
  brokerDriver: string
  /** T-08553/T-08554: an explicit per-request `presentation.operator` replaces the node policy. */
  requestedOperator?: 'none' | 'tmux-tui' | 'observer' | undefined
}): OperatorPresentation {
  // Applicability gate: only the codex-app-server driver can host a viewer. A
  // policy aimed at any other driver is inert (the policy is not APPLICABLE).
  if (input.brokerDriver !== 'codex-app-server') {
    return 'none'
  }
  // A request can decline or select the viewer for its own new execution;
  // absent, the node policy decides exactly as before. 'observer' is the
  // muse-serve viewer and never selects the codex one.
  if (input.requestedOperator !== undefined) {
    return input.requestedOperator === 'tmux-tui' ? 'tmux-tui' : 'none'
  }
  // The policy is the trigger: only an explicit `tmux-tui` selects the viewer.
  return input.operatorPresentation === 'tmux-tui' ? 'tmux-tui' : 'none'
}

/**
 * T-01760 (Wave C) — the minimal view the daemon-startup legacy sweep consults
 * for one persisted runtime. Derived from HrcRuntimeSnapshot:
 *   controllerKind / transport / status → direct snapshot fields
 *   brokerTmuxSocketPath = getBrokerRuntimeTmuxSocketPath(runtime)
 *       (PRESENCE only — NEVER compared against the legacy default
 *        <runtimeRoot>/tmux.sock; broker leases live under <runtimeRoot>/btmux/)
 *   hasAttachDescriptor = whether an attach descriptor persists for it
 */
export type LegacyStartupRuntimeView = {
  controllerKind: HrcRuntimeControllerKind | undefined
  transport: string
  status: string
  brokerTmuxSocketPath: string | undefined
  hasAttachDescriptor: boolean
}

export type LegacyStartupReconciliationDecision =
  | {
      disposition: 'stale'
      reason: 'legacy_no_controller_kind' | 'legacy_non_broker_controller_kind'
    }
  | {
      disposition: 'preserve'
      reason: 'broker_tmux_lease' | 'broker_attach_descriptor' | 'broker_runtime'
    }
  | { disposition: 'noop' }

/**
 * Decide how the daemon-startup legacy sweep treats one persisted runtime.
 *
 * Wave B (T-01755/56/58) made dispatch/ensure/attach broker-only + fail-closed,
 * so no NEW legacy non-broker runtime is created or reused. T-01760 cleans up
 * EXISTING state: on startup, legacy harness runtimes (controllerKind unset OR
 * != 'harness-broker') are marked stale so they can never be reused for a
 * harness turn — WHILE preserving broker tmux LEASE runtimes and attach
 * descriptors (those are reconciled by the dedicated broker pass).
 *
 * Evaluated in this order:
 *   1. status unavailable (terminated/dead/stale) → noop (idempotent).
 *   2. controllerKind === 'harness-broker' → preserve. The legacy sweep NEVER
 *      touches a broker runtime; the path VALUE is never inspected (LANDMINE
 *      C-03008: a broker tmux lease off the old default socket is still preserved).
 *   3. otherwise (controllerKind unset, or any non-broker kind) → stale.
 */
export function decideLegacyRuntimeStartupDisposition(
  view: LegacyStartupRuntimeView
): LegacyStartupReconciliationDecision {
  if (isRuntimeUnavailableStatus(view.status)) {
    return { disposition: 'noop' }
  }
  if (view.controllerKind === 'harness-broker') {
    if (view.brokerTmuxSocketPath !== undefined) {
      return { disposition: 'preserve', reason: 'broker_tmux_lease' }
    }
    if (view.hasAttachDescriptor) {
      return { disposition: 'preserve', reason: 'broker_attach_descriptor' }
    }
    return { disposition: 'preserve', reason: 'broker_runtime' }
  }
  if (view.controllerKind === undefined) {
    return { disposition: 'stale', reason: 'legacy_no_controller_kind' }
  }
  return { disposition: 'stale', reason: 'legacy_non_broker_controller_kind' }
}

/**
 * T-07397 — the admission `reason` for a dispatch that refused surface reuse
 * against a scope whose live surface is healthy. Distinguishes "scope occupied
 * and you refused reuse — use a fresh scope or drop the refusal" from generic
 * runtime unavailability; carried into the HrcRuntimeUnavailableError detail.
 */
export const CALLER_SURFACE_REUSE_REFUSAL = 'caller-surface-reuse-refusal'

/**
 * T-07397 — does this caller refuse delivery into an EXISTING interactive
 * surface? Reads the RAW flag and nothing else.
 *
 * MUST STAY MODE-INDEPENDENT. Do NOT entangle this with
 * `execution.preferredMode` or `harness.interactive`: this predicate is
 * evaluated on the POST-redirect intent, and
 * `normalizeClaudeInteractiveBrokerIntent` rewrites exactly those two fields
 * (`harness.interactive: true`, `preferredMode: 'interactive'`). A mode-entangled
 * reading flips to false across that rewrite and silently readmits an autonomous
 * dispatch into a live operator TUI — the original T-07397 Flaw 1. Reading only
 * `allowInteractiveSurfaceReuse` is normalization-invariant by construction.
 *
 * Distinct from the handler-local `disallowsInteractiveSurfaceReuse`, which is
 * deliberately mode-entangled and serves the headless/SDK route gate.
 */
export function refusesSurfaceReuse(intent: HrcRuntimeIntent): boolean {
  return intent.execution?.allowInteractiveSurfaceReuse === false
}

/**
 * T-07397 — did THIS dispatch establish the live surface it is being routed at?
 * True only on exact identity between the carried proof and the runtime's active
 * broker invocation. Deliberately strict: no prefix/substring matching, no
 * falling back to "same host session" (a colliding scope shares the session but
 * not the surface), and an absent id on either side is never a match.
 */
function ownsLiveSurface(
  options: { establishedBrokerInvocationId?: string | undefined },
  latestRuntime: NonNullable<LatestRuntimeAdmissionView>
): boolean {
  const carried = options.establishedBrokerInvocationId
  const active = latestRuntime.activeInvocationId
  return carried !== undefined && active !== undefined && carried === active
}

export function decideInteractiveBrokerAdmission(
  intent: HrcRuntimeIntent,
  latestRuntime: LatestRuntimeAdmissionView,
  options: {
    claudeCodeTmuxBrokerEnabled: boolean
    piTuiTmuxBrokerEnabled: boolean
    museCliTmuxBrokerEnabled: boolean
    /** T-07397 surface-ownership proof carried by the dispatch, if any. */
    establishedBrokerInvocationId?: string | undefined
  }
): InteractiveBrokerAdmissionDecision {
  const resolved = resolveInteractiveBrokerAdmissionDriver(intent, options)
  if (!resolved) {
    return {
      decision: 'runtime-unavailable',
      reason: 'runtime intent is not broker-admissible',
    }
  }

  if (!latestRuntime || isRuntimeUnavailableStatus(latestRuntime.status)) {
    return {
      decision: 'broker-start',
      flagEnvName: resolved.flagEnvName,
      allowedBrokerDriver: resolved.allowedBrokerDriver,
    }
  }

  if (
    latestRuntime.controllerKind === 'harness-broker' &&
    latestRuntime.transport === 'tmux' &&
    latestRuntime.provider === intent.harness.provider &&
    // T-08139: routing policy selects the driver for the NEXT seat, not a
    // license to kill this one. A healthy broker remains the scope's writer
    // until natural rotation even when today's policy would provision a
    // different driver. Reprovisioning it in-place leaves the old broker alive
    // with the continuation's writer lock, so the replacement cannot start.
    latestRuntime.brokerDriver !== undefined &&
    // T-05358: never broker-REUSE a runtime whose broker invocation is
    // transitioning (starting/stopping). It matches on driver/provider but
    // cannot accept input right now; fall through to stale-and-reprovision so a
    // FRESH interactive runtime is spun up instead of dispatching into the
    // teardown window.
    latestRuntime.inputDispatchable
  ) {
    // T-07397: the caller refused delivery into an existing surface, and this
    // healthy runtime IS a surface. The refusal means "not a surface I did not
    // establish" — NOT "not any surface" — so the caller may continue its OWN
    // broker invocation, and only that one. Proof is exact identity: the id it
    // carries must equal this runtime's ACTIVE invocation. Anything else —
    // absent id (a first turn owns nothing), or an id naming some other
    // invocation — refuses.
    //
    // Without this, a multi-turn session is refused its own pane from turn 2
    // onward, because turn 1 makes the scope non-free (falsified live, C-15300).
    // Refusal remains NEGATIVE ROUTING AUTHORITY ONLY: 'runtime-unavailable' is
    // handled before both the broker-reuse and stale-and-reprovision branches,
    // so no markRuntimeStaleForBrokerReprovision, no runtime.stale, activeRunId
    // and durable status intact, any in-flight operator turn unharmed.
    //
    // T-08540: a carried proof is itself a claim to own this surface, so it is
    // checked whether or not the intent refuses reuse. Without this a forged or
    // stale id was ignored whenever `allowInteractiveSurfaceReuse` was absent
    // and the turn was delivered into a surface the caller claimed, falsely, to
    // own. No proof and no refusal still reuses (DM-into-open-TUI).
    const claimsOwnership = options.establishedBrokerInvocationId !== undefined
    if (
      (refusesSurfaceReuse(intent) || claimsOwnership) &&
      !ownsLiveSurface(options, latestRuntime)
    ) {
      return {
        decision: 'runtime-unavailable',
        reason: CALLER_SURFACE_REUSE_REFUSAL,
      }
    }
    return {
      decision: 'broker-reuse',
      // This field drives existing-driver behavior at the call site (notably
      // the non-blocking codex-cli/pi paths), so report the driver actually
      // being reused rather than the policy's next-rotation selection.
      allowedBrokerDriver: latestRuntime.brokerDriver,
    }
  }

  // Fall-through: the runtime is unhealthy / non-matching by the EXISTING rules
  // above. It is invalidated because of its own state — a caller's refusal is
  // never the cause, and `refusesSurfaceReuse` deliberately appears nowhere in
  // this branch (T-07397 Flaw 2).

  return {
    decision: 'stale-and-reprovision',
    flagEnvName: resolved.flagEnvName,
    allowedBrokerDriver: resolved.allowedBrokerDriver,
  }
}

export function resolveInteractiveBrokerAdmissionDriver(
  intent: HrcRuntimeIntent,
  options: {
    claudeCodeTmuxBrokerEnabled: boolean
    piTuiTmuxBrokerEnabled: boolean
    museCliTmuxBrokerEnabled: boolean
  }
): { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver } | undefined {
  if (
    options.claudeCodeTmuxBrokerEnabled &&
    intent.harness.provider === 'anthropic' &&
    (intent.harness.id === undefined || intent.harness.id === 'claude-code')
  ) {
    return {
      flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'claude-code-tmux',
    }
  }

  // T-08555: HRC_CODEX_CLI_TMUX_BROKER_ENABLED governs only the omitted-choice
  // Codex redirect. An explicit interactive Codex intent, and reuse of a live
  // codex-tui runtime, stay admissible on a node that turns the redirect off
  // (docs/aspd-headless-codex-integration.md §1.3, decision 1).
  if (
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli')
  ) {
    return {
      flagEnvName: HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'codex-app-server',
    }
  }

  if (
    options.piTuiTmuxBrokerEnabled &&
    intent.harness.provider === 'openai' &&
    (intent.harness.id === 'pi' || intent.harness.id === 'pi-cli')
  ) {
    return {
      flagEnvName: HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'pi-tui-tmux',
    }
  }

  if (
    options.museCliTmuxBrokerEnabled &&
    intent.harness.provider === 'meta' &&
    (intent.harness.id === undefined || intent.harness.id === 'muse-cli')
  ) {
    return {
      flagEnvName: HRC_MUSE_CLI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'muse-cli-tmux',
    }
  }

  return undefined
}

export function decideInteractiveTmuxBrokerStartRoute(
  intent: HrcRuntimeIntent,
  options: {
    claudeCodeTmuxBrokerEnabled: boolean
    piTuiTmuxBrokerEnabled: boolean
    museCliTmuxBrokerEnabled: boolean
  }
): InteractiveTmuxBrokerStartRoute {
  if (options.claudeCodeTmuxBrokerEnabled && shouldConsiderClaudeCodeTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'claude-code-tmux',
    }
  }

  // T-08555: independent of the Codex redirect control (§1.3, decision 1).
  if (shouldConsiderCodexCliTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'codex-app-server',
    }
  }

  if (options.piTuiTmuxBrokerEnabled && shouldConsiderPiTuiTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'pi-tui-tmux',
    }
  }

  if (options.museCliTmuxBrokerEnabled && shouldConsiderMuseCliTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_MUSE_CLI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'muse-cli-tmux',
    }
  }

  return { route: 'legacy-tmux' }
}

export async function runInteractiveTmuxRoute<T>(
  route: InteractiveTmuxExecutionRoute,
  executors: {
    broker: () => Promise<T>
    legacyTmux?: () => Promise<T>
  }
): Promise<T> {
  switch (route) {
    case 'broker':
      return await executors.broker()
    case 'legacy-tmux':
      if (!executors.legacyTmux) {
        throw new HrcRuntimeUnavailableError('interactive legacy tmux execution is unavailable', {
          route,
        })
      }
      return await executors.legacyTmux()
  }
}
