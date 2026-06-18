import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  HrcContinuationRef,
  HrcProvider,
  HrcRuntimeControllerKind,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import { resolveHarnessFrontendForProvider } from 'spaces-config'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile, RuntimeContinuationRef } from 'spaces-runtime-contracts'

import {
  HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
  HRC_CLAUDE_GHOSTTY_ENV,
  HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
  HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
} from './server-constants.js'
import { isRecord } from './server-parsers.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'

export function validateEnsureRuntimeIntent(
  intent: HrcRuntimeIntent,
  options: { allowNonInteractive?: boolean } = {}
): void {
  if (!isRecord(intent.harness)) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'intent.harness is required'
    )
  }

  if (intent.harness.interactive !== true && options.allowNonInteractive !== true) {
    throw new HrcRuntimeUnavailableError(
      'ensureRuntime supports only interactive runtimes in phase 1'
    )
  }
}

export function deriveInteractiveHarness(
  harness: HrcRuntimeIntent['harness']
): HrcRuntimeSnapshot['harness'] {
  if (harness.id === 'pi') {
    return 'pi'
  }
  if (harness.id === 'pi-cli' || harness.id === 'codex-cli' || harness.id === 'claude-code') {
    return harness.id
  }
  return harness.provider === 'openai' ? 'codex-cli' : 'claude-code'
}

export function toRuntimeContinuationRef(
  continuation: HrcContinuationRef | undefined
): RuntimeContinuationRef | undefined {
  if (continuation?.key === undefined) {
    return undefined
  }
  return {
    schemaVersion: 'runtime-continuation/v1',
    hrc: {
      provider: continuation.provider,
      continuationId: continuation.key,
      key: continuation.key,
    },
    source: 'harness-broker',
    observedAt: timestamp(),
  }
}

export function deriveSdkHarness(
  harness: HrcRuntimeIntent['harness']
): HrcRuntimeSnapshot['harness'] {
  if (harness.id === 'agent-sdk' || harness.id === 'pi-sdk') {
    return harness.id
  }
  return resolveHarnessFrontendForProvider(harness.provider, 'sdk') ?? 'agent-sdk'
}

/**
 * Decide whether a headless dispatch (or start) should run through the SDK
 * executor (executeHeadlessSdkTurn / runHeadlessSdkStartLaunch) rather than
 * the CLI executor. Explicit SDK harness ids always win. Id-less Anthropic
 * intents keep the legacy SDK fallback only after the caller has already
 * selected the headless path. Normal Claude dispatch routes through Ghostty
 * only when HRC_CLAUDE_GHOSTTY=1 is set.
 *
 * Exported for unit testing — single-source predicate for dispatch routing,
 * start routing, runtime harness label (`deriveSdkHarness` vs
 * `deriveInteractiveHarness`), and reuse filtering.
 */
export function shouldUseHeadlessSdkExecutor(harness: HrcRuntimeIntent['harness']): boolean {
  if (harness.id === 'agent-sdk' || harness.id === 'pi-sdk') {
    return true
  }
  if (harness.id !== undefined) {
    return false
  }
  return harness.provider === 'anthropic'
}

export type HeadlessExecutionRoute = 'sdk' | 'broker' | 'legacy-exec'

export function decideHeadlessExecutionRoute(
  intent: HrcRuntimeIntent,
  options: { brokerFlagEnabled: boolean }
): HeadlessExecutionRoute {
  if (shouldUseHeadlessSdkExecutor(intent.harness)) {
    return 'sdk'
  }

  const isHeadlessCodexCandidate =
    options.brokerFlagEnabled &&
    shouldUseHeadlessTransport(intent) &&
    intent.harness.interactive !== true &&
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli')

  return isHeadlessCodexCandidate ? 'broker' : 'legacy-exec'
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

export type InteractiveTmuxBrokerDriver = 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux'

export type LatestRuntimeAdmissionView = {
  controllerKind: HrcRuntimeControllerKind | undefined
  transport: string
  status: string
  provider: HrcProvider
  brokerDriver: InteractiveTmuxBrokerDriver | undefined
} | null

export type InteractiveBrokerAdmissionDecision =
  | { decision: 'broker-reuse'; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
  | {
      decision: 'broker-start'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | {
      decision: 'stale-and-reprovision'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | { decision: 'runtime-unavailable'; reason: string }

export type InteractiveTmuxBrokerStartRoute =
  | {
      route: 'broker'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | { route: 'legacy-tmux' }

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

export function decideInteractiveBrokerAdmission(
  intent: HrcRuntimeIntent,
  latestRuntime: LatestRuntimeAdmissionView,
  options: {
    claudeCodeTmuxBrokerEnabled: boolean
    codexCliTmuxBrokerEnabled: boolean
    piTuiTmuxBrokerEnabled: boolean
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
    latestRuntime.brokerDriver === resolved.allowedBrokerDriver
  ) {
    return {
      decision: 'broker-reuse',
      allowedBrokerDriver: resolved.allowedBrokerDriver,
    }
  }

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
    codexCliTmuxBrokerEnabled: boolean
    piTuiTmuxBrokerEnabled: boolean
  }
): { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver } | undefined {
  if (shouldUseGhosttyTransport(intent)) {
    return undefined
  }

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

  if (
    options.codexCliTmuxBrokerEnabled &&
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli')
  ) {
    return {
      flagEnvName: HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'codex-cli-tmux',
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

  return undefined
}

export function decideInteractiveTmuxBrokerStartRoute(
  intent: HrcRuntimeIntent,
  options: {
    claudeCodeTmuxBrokerEnabled: boolean
    codexCliTmuxBrokerEnabled: boolean
    piTuiTmuxBrokerEnabled: boolean
  }
): InteractiveTmuxBrokerStartRoute {
  if (options.claudeCodeTmuxBrokerEnabled && shouldConsiderClaudeCodeTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'claude-code-tmux',
    }
  }

  if (options.codexCliTmuxBrokerEnabled && shouldConsiderCodexCliTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'codex-cli-tmux',
    }
  }

  if (options.piTuiTmuxBrokerEnabled && shouldConsiderPiTuiTmuxBrokerDispatch(intent)) {
    return {
      route: 'broker',
      flagEnvName: HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
      allowedBrokerDriver: 'pi-tui-tmux',
    }
  }

  return { route: 'legacy-tmux' }
}

export function decideInteractiveTmuxExecutionRoute(
  intent: HrcRuntimeIntent,
  profile: BrokerExecutionProfile,
  options: { brokerFlagEnabled: boolean; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
): InteractiveTmuxExecutionRoute {
  if (!options.brokerFlagEnabled) {
    return 'legacy-tmux'
  }
  if (!isInteractiveTmuxBrokerIntent(intent)) {
    return 'legacy-tmux'
  }
  return profile.interactionMode === 'interactive' &&
    profile.brokerDriver === options.allowedBrokerDriver &&
    profile.brokerTerminal?.host === 'tmux'
    ? 'broker'
    : 'legacy-tmux'
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

export function filterBrokerDispatchEnvForLockedEnv(
  dispatchEnv: Record<string, string> | undefined,
  startRequest: InvocationStartRequest
): Record<string, string> | undefined {
  if (dispatchEnv === undefined) {
    return undefined
  }

  const lockedEnv = startRequest.spec.process.lockedEnv ?? {}
  const filtered = Object.fromEntries(
    Object.entries(dispatchEnv).filter(([key]) => !(key in lockedEnv))
  )
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

export function shouldUseHeadlessTransport(intent: HrcRuntimeIntent): boolean {
  const preferredMode = intent.execution?.preferredMode
  if (preferredMode === 'headless') return true
  if (preferredMode === 'nonInteractive') {
    return !(isClaudeGhosttyEnabled() && isGhosttyClaudeIntent(intent))
  }
  return false
}

export function shouldUseSdkTransport(intent: HrcRuntimeIntent): boolean {
  if (shouldUseHeadlessTransport(intent)) {
    return false
  }
  if (shouldUseGhosttyTransport(intent)) {
    return false
  }

  return (
    intent.harness.interactive === false || intent.execution?.preferredMode === 'nonInteractive'
  )
}

export function shouldUseGhosttyTransport(intent: HrcRuntimeIntent): boolean {
  if (!isClaudeGhosttyEnabled()) {
    return false
  }
  if (intent.execution?.preferredMode === 'headless') {
    return false
  }
  if (!isGhosttyClaudeIntent(intent)) {
    return false
  }
  return true
}

export function shouldConsiderClaudeCodeTmuxBrokerDispatch(intent: HrcRuntimeIntent): boolean {
  return (
    isInteractiveTmuxBrokerIntent(intent) &&
    intent.harness.provider === 'anthropic' &&
    (intent.harness.id === undefined || intent.harness.id === 'claude-code')
  )
}

/**
 * T-01770 Phase B (admission). Admit non-interactive Claude turns into the
 * claude-code-tmux broker path EVEN WHEN preferredMode is headless/nonInteractive
 * — the broker pane is HRC-leased, not a user TTY, so "no terminal" is not a
 * blocker. The redirect set is exactly the intents that today lose Claude memory:
 *   - ariadne-class: explicit {provider:anthropic, id:claude-code} dispatched
 *     headless → today lands on legacy exec.ts (no Claude continuation capture).
 *   - SDK-shaped: {harness.id agent-sdk|pi-sdk} or id-less provider:anthropic →
 *     today hits the SDK executor (hard-failed by T-01754).
 * Both must move to the interactive claude-code-tmux broker. We key on
 * deriveInteractiveHarness resolving to 'claude-code' (the normalize target) so
 * openai/codex intents (incl. openai pi-sdk → codex-cli) are NOT captured here —
 * those keep the headless-codex / codex-cli-tmux routes. The second clause
 * restricts to the SDK-shaped / claude-code id set so an interactive `pi`/`pi-cli`
 * intent is left untouched.
 */
export function shouldRedirectClaudeToInteractiveBroker(intent: HrcRuntimeIntent): boolean {
  const harness = intent.harness
  return (
    deriveInteractiveHarness(harness) === 'claude-code' &&
    (harness.id === undefined ||
      harness.id === 'claude-code' ||
      harness.id === 'agent-sdk' ||
      harness.id === 'pi-sdk')
  )
}

/**
 * T-01770 Phase B (normalize). Rewrite a redirected Claude intent into an
 * interactive claude-code-tmux intent so the dispatch predicates send it to the
 * broker branch (and NOT to shouldUseHeadlessTransport/shouldUseSdkTransport).
 * Uses deriveInteractiveHarness for the harness label per the spec; clears the
 * headless/nonInteractive preferredMode that caused the mis-route.
 */
export function normalizeClaudeInteractiveBrokerIntent(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  return {
    ...intent,
    harness: {
      ...intent.harness,
      id: deriveInteractiveHarness(intent.harness),
      interactive: true,
    },
    execution: {
      ...intent.execution,
      preferredMode: 'interactive',
    },
  }
}

/**
 * T-01770 Phase C (block). Headless-parity convention for whether a broker turn
 * blocks the synchronous caller: undefined/true => block until the run reaches a
 * terminal state; false => return status:'started' immediately (the async reply
 * bridge / a polling caller finalizes the turn).
 */
export function shouldBlockForBrokerTurnCompletion(
  waitForCompletion: boolean | undefined
): boolean {
  return waitForCompletion !== false
}

/**
 * T-01770 Phase D (durable continuation, recreate case). startInteractiveTmuxBroker
 * Runtime is only reached when there is no live TUI to reuse (the reuse predicates
 * return an already-live runtime first). A fresh first launch has no captured
 * session id ⇒ undefined ⇒ the adapter does a fresh `--session-id <uuid>` launch.
 * A RECREATE for an existing session that already captured a Claude session id
 * passes that continuation so the claude adapter emits `--resume <uuid>` — which,
 * unlike `--continue`/`codex resume`, does NOT trigger a "choose working directory"
 * picker. This reverses commit 120eb7a's blanket disable ONLY for the safe
 * --resume case: strictly gated on (a) the claude-code-tmux driver and (b) a
 * captured session id key.
 */
export function decideInteractiveTmuxBrokerContinuation(options: {
  allowedBrokerDriver: InteractiveTmuxBrokerDriver
  sessionContinuation: HrcContinuationRef | undefined
}): HrcContinuationRef | undefined {
  if (options.allowedBrokerDriver !== 'claude-code-tmux') {
    return undefined
  }
  if (options.sessionContinuation?.key === undefined) {
    return undefined
  }
  return options.sessionContinuation
}

export function shouldConsiderCodexCliTmuxBrokerDispatch(intent: HrcRuntimeIntent): boolean {
  return (
    isInteractiveTmuxBrokerIntent(intent) &&
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli')
  )
}

export function shouldConsiderPiTuiTmuxBrokerDispatch(intent: HrcRuntimeIntent): boolean {
  return (
    isInteractiveTmuxBrokerIntent(intent) &&
    intent.harness.provider === 'openai' &&
    (intent.harness.id === 'pi' || intent.harness.id === 'pi-cli')
  )
}

export function isInteractiveTmuxBrokerDriver(
  brokerDriver: string | undefined
): brokerDriver is InteractiveTmuxBrokerDriver {
  return (
    brokerDriver === 'claude-code-tmux' ||
    brokerDriver === 'codex-cli-tmux' ||
    brokerDriver === 'pi-tui-tmux'
  )
}

export function isMatchingInteractiveTmuxBrokerRuntime(
  runtime: HrcRuntimeSnapshot,
  intent: HrcRuntimeIntent,
  brokerDriver: InteractiveTmuxBrokerDriver
): boolean {
  return (
    runtime.controllerKind === 'harness-broker' &&
    runtime.transport === 'tmux' &&
    runtime.provider === intent.harness.provider &&
    getBrokerRuntimeDriver(runtime) === brokerDriver
  )
}

export function getBrokerRuntimeDriver(runtime: HrcRuntimeSnapshot): string | undefined {
  const tmuxDriver = runtime.tmuxJson?.['brokerDriver']
  if (typeof tmuxDriver === 'string' && tmuxDriver.length > 0) {
    return tmuxDriver
  }

  const stateTmux = runtime.runtimeStateJson?.['tmux']
  if (isRecord(stateTmux)) {
    const stateDriver = stateTmux['brokerDriver']
    if (typeof stateDriver === 'string' && stateDriver.length > 0) {
      return stateDriver
    }
  }

  return undefined
}

export function toLatestRuntimeAdmissionView(
  runtime: HrcRuntimeSnapshot | null
): LatestRuntimeAdmissionView {
  if (!runtime) {
    return null
  }

  const brokerDriver = getBrokerRuntimeDriver(runtime)
  return {
    controllerKind: runtime.controllerKind,
    transport: runtime.transport,
    status: runtime.status,
    provider: runtime.provider,
    brokerDriver: isInteractiveTmuxBrokerDriver(brokerDriver) ? brokerDriver : undefined,
  }
}

/**
 * Minimal view of the session's latest runtime needed to decide whether a
 * headless-preferred turn should be delivered into a live interactive broker
 * runtime instead of spawning a competing headless run. `hasLiveSurface` mirrors
 * the (tmuxJson || surfaceJson) liveness check; `idle` is activeRunId === undefined.
 */
export type LiveInteractiveRuntimeReuseView = {
  controllerKind: HrcRuntimeControllerKind | undefined
  transport: string
  provider: HrcProvider
  status: string
  hasLiveSurface: boolean
  idle: boolean
} | null

export function toLiveInteractiveRuntimeReuseView(
  runtime: HrcRuntimeSnapshot | null
): LiveInteractiveRuntimeReuseView {
  if (!runtime) {
    return null
  }
  return {
    controllerKind: runtime.controllerKind,
    transport: runtime.transport,
    provider: runtime.provider,
    status: runtime.status,
    hasLiveSurface: runtime.tmuxJson !== undefined || runtime.surfaceJson !== undefined,
    idle: runtime.activeRunId === undefined,
  }
}

/**
 * True when dispatchTurnForSession should SKIP the headless branch and fall
 * through to decideInteractiveBrokerAdmission (→ broker-reuse), delivering the
 * turn INTO a live interactive broker runtime rather than spawning a competing
 * headless run on the same continuation thread. Restricted to a harness-broker
 * runtime whose provider matches the intent so admission resolves to
 * broker-reuse, not an interactive reprovision of a genuinely-headless target.
 *
 * NOT gated on idle: an active interactive TUI must still receive the turn. A
 * busy interactive broker queues the input (whenBusy:'queue') and drains it on
 * the next turn.completed — forking a parallel headless run, or rejecting
 * RUNTIME_BUSY, both leave the human-visible TUI silently without the message.
 * The broker-reuse call site queues vs. rejects based on the active invocation's
 * composed queue capability (isBrokerRuntimeQueueCapable); the interactive tmux
 * drivers advertise input.queue:true so a busy TUI queues rather than rejects.
 * Pure; the SDK branch keeps its own equivalent guard.
 */
export function shouldDeferHeadlessToInteractiveBrokerReuse(
  intent: HrcRuntimeIntent,
  latestRuntime: LiveInteractiveRuntimeReuseView
): boolean {
  return (
    latestRuntime !== null &&
    latestRuntime.controllerKind === 'harness-broker' &&
    (latestRuntime.transport === 'tmux' || latestRuntime.transport === 'ghostty') &&
    latestRuntime.hasLiveSurface &&
    latestRuntime.provider === intent.harness.provider &&
    !isRuntimeUnavailableStatus(latestRuntime.status)
  )
}

export function getBrokerRuntimeTmuxSocketPath(runtime: HrcRuntimeSnapshot): string | undefined {
  const tmuxSocketPath = runtime.tmuxJson?.['socketPath']
  if (typeof tmuxSocketPath === 'string' && tmuxSocketPath.length > 0) {
    return tmuxSocketPath
  }

  const stateTmux = runtime.runtimeStateJson?.['tmux']
  if (isRecord(stateTmux)) {
    const stateSocketPath = stateTmux['socketPath']
    if (typeof stateSocketPath === 'string' && stateSocketPath.length > 0) {
      return stateSocketPath
    }
  }

  return undefined
}

export function getBrokerRuntimeTmuxSessionName(runtime: HrcRuntimeSnapshot): string {
  const sessionName = runtime.tmuxJson?.['sessionName']
  if (typeof sessionName === 'string' && sessionName.length > 0) {
    return sessionName
  }

  return `hrc-${runtime.hostSessionId.slice(0, 12)}`
}

// The tmux target an operator should `attach-session -t` for a broker runtime.
//
// T-01801: a durable broker lease hosts TWO windows under one session — 'broker'
// (the headless harness-broker IPC controller, which renders nothing) and 'tui'
// (the harness the operator actually attaches to). The session is created with the
// 'broker' window active, so a bare `attach-session -t <session>` lands the operator
// on the blank controller window while codex renders unseen in 'tui'. Target the
// recorded leased window explicitly so attach always lands on the harness. Legacy
// single-window broker runtimes record windowName='main', so this stays correct for
// them too; if no window is recorded we fall back to the bare session name.
export function getBrokerRuntimeTmuxAttachTarget(runtime: HrcRuntimeSnapshot): string {
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  const windowName = runtime.tmuxJson?.['windowName']
  if (typeof windowName === 'string' && windowName.length > 0) {
    return `${sessionName}:${windowName}`
  }

  return sessionName
}

export function isInteractiveTmuxBrokerIntent(intent: HrcRuntimeIntent): boolean {
  return (
    intent.harness.interactive === true &&
    !shouldUseHeadlessTransport(intent) &&
    !shouldUseSdkTransport(intent) &&
    !shouldUseGhosttyTransport(intent)
  )
}

export function isGhosttyClaudeIntent(intent: HrcRuntimeIntent): boolean {
  if (intent.harness.provider !== 'anthropic') {
    return false
  }
  return intent.harness.id !== 'agent-sdk' && intent.harness.id !== 'pi-sdk'
}

export function isClaudeGhosttyEnabled(): boolean {
  return isTruthyFeatureFlag(process.env[HRC_CLAUDE_GHOSTTY_ENV])
}

export function isTruthyFeatureFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false
  }
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase())
}

export function isFalsyFeatureFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false
  }
  return ['0', 'false', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase())
}

export function isGhostmuxUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cannot connect to Ghostty UDS|Ghostty API|api\.sock|ghostmux/i.test(message)
}

export function normalizeRuntimeProvisionIntent(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  if (!shouldUseHeadlessTransport(intent) || intent.harness.interactive === true) {
    return intent
  }

  return {
    ...intent,
    harness: {
      ...intent.harness,
      interactive: true,
    },
  }
}
