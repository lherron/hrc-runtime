import type {
  HrcContinuationRef,
  HrcProvider,
  HrcRuntimeControllerKind,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import { type InvocationStartRequest, isCredentialEnvKey } from 'spaces-harness-broker-protocol'
import { deriveInteractiveHarness } from './broker-decisions-harness.js'
import type {
  InteractiveTmuxBrokerDriver,
  LatestRuntimeAdmissionView,
} from './broker-decisions-types.js'
import { parseBrokerRuntimeHostingState } from './broker/runtime-hosting.js'
import { isRecord } from './server-parsers.js'
import { isRuntimeUnavailableStatus } from './server-util.js'

export function filterBrokerDispatchEnvForLockedEnv(
  dispatchEnv: Record<string, string> | undefined,
  startRequest: InvocationStartRequest
): Record<string, string> | undefined {
  if (dispatchEnv === undefined) {
    return undefined
  }

  const lockedEnv = startRequest.spec.process.lockedEnv ?? {}
  const filtered = Object.fromEntries(
    Object.entries(dispatchEnv).filter(
      ([key]) => !(key in lockedEnv) && !isPiSdkCredentialEnvKey(key, startRequest)
    )
  )
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

/**
 * The broker protocol forbids credential keys on dispatchEnv. The in-process
 * pi-sdk driver consumes them from the broker process's credential channel, so
 * HRC lifts only those keys into the per-runtime broker launch environment.
 * The returned values are never hashed, persisted, or placed on the wire.
 */
export function extractPiSdkBrokerCredentialEnv(
  dispatchEnv: Record<string, string> | undefined,
  startRequest: InvocationStartRequest
): Record<string, string> | undefined {
  if (dispatchEnv === undefined || brokerDriverKind(startRequest) !== 'pi-sdk') {
    return undefined
  }
  const credentials = Object.fromEntries(
    Object.entries(dispatchEnv).filter(([key]) => isCredentialEnvKey(key))
  )
  return Object.keys(credentials).length > 0 ? credentials : undefined
}

function isPiSdkCredentialEnvKey(key: string, startRequest: InvocationStartRequest): boolean {
  return brokerDriverKind(startRequest) === 'pi-sdk' && isCredentialEnvKey(key)
}

function brokerDriverKind(startRequest: InvocationStartRequest): string | undefined {
  return (startRequest.spec.driver as { kind?: string } | undefined)?.kind
}

export function shouldUseHeadlessTransport(intent: HrcRuntimeIntent): boolean {
  const preferredMode = intent.execution?.preferredMode
  if (preferredMode === 'headless') return true
  if (preferredMode === 'nonInteractive') return true
  return false
}

export function shouldUseSdkTransport(intent: HrcRuntimeIntent): boolean {
  if (shouldUseHeadlessTransport(intent)) {
    return false
  }
  return (
    intent.harness.interactive === false || intent.execution?.preferredMode === 'nonInteractive'
  )
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
 *   - agent-spaces-native: {harness.id claude-code-cli} — run-compile.ts emits
 *     preferredHarnessRuntime='claude-code-cli' for EVERY claude-code agent, so
 *     a dispatch adapter passing it through (T-05077) lands on legacy-exec → 503
 *     unless it remaps first. Accepting it here closes the silent trap at the
 *     source (backstop to the adapter's 'claude-code-cli'→'claude-code' map).
 * All must move to the interactive claude-code-tmux broker. We key on
 * deriveInteractiveHarness resolving to 'claude-code' (the normalize target) so
 * openai/codex intents (incl. openai pi-sdk → codex-cli) are NOT captured here —
 * those keep the headless-codex / Codex broker routes. The second clause
 * restricts to the SDK-shaped / claude-code id set so an interactive `pi`/`pi-cli`
 * intent is left untouched.
 */
export function shouldRedirectClaudeToInteractiveBroker(intent: HrcRuntimeIntent): boolean {
  const harness = intent.harness
  // 'claude-code-cli' is NOT a member of HrcHarness — it is the agent-spaces
  // preferredHarnessRuntime value that compile-adapter.ts maps to 'claude-code'.
  // A raw-passthrough dispatch adapter can leak it as an out-of-type harness.id,
  // so widen the local to match it defensively (deriveInteractiveHarness already
  // resolves it to 'claude-code', and normalize rewrites the id to 'claude-code').
  const id: string | undefined = harness.id
  return (
    deriveInteractiveHarness(harness) === 'claude-code' &&
    (id === undefined ||
      id === 'claude-code' ||
      id === 'claude-code-cli' ||
      id === 'agent-sdk' ||
      id === 'pi-sdk')
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
 * T-08338. Admit dispatched Codex CLI intents into the stock Codex TUI broker
 * path. Keep this separate from the Claude redirect: OpenAI is shared by the
 * Pi and SDK routes, so the harness id is the discriminant.
 *
 * The id-less shape has no broker-era population yet, but the downstream
 * `shouldConsiderCodexCliTmuxBrokerDispatch` contract already admits it. Keep
 * the two predicates aligned so a normalized intent cannot be refused by the
 * route it targets.
 */
export function shouldRedirectCodexToInteractiveBroker(intent: HrcRuntimeIntent): boolean {
  return (
    intent.harness.provider === 'openai' &&
    (intent.harness.id === undefined || intent.harness.id === 'codex-cli')
  )
}

/** Rewrite a dispatched Codex intent into the codex-tui interactive shape. */
export function normalizeCodexInteractiveBrokerIntent(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  return {
    ...intent,
    harness: {
      ...intent.harness,
      id: 'codex-cli',
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
 *
 * THE STEER DOOR IS EXEMPT HERE, AND NOT AS A CONVENIENCE (T-08108). A steer
 * either joins the turn that is already running or starts one (T-08533), and
 * when it joins, its own run never completes: it is settled `coalesced` into the
 * owner run, so blocking on it held the caller until the 10-minute deadline and
 * then failed `interactive broker turn timed out` on a delivery that actually
 * worked. Observed on max3 2026-09-06, run `run-63fe3229`.
 *
 * A caller that wants to block on a steer asks the submission door for `wait`,
 * which follows the broker disposition (`executed` or `absorbed`) to the turn it
 * names and waits for THAT turn's terminal (`waitForSubmissionTerminal`). This
 * exemption only keeps the run-completion wait from being the one that answers.
 */
export function shouldBlockForBrokerTurnCompletion(
  waitForCompletion: boolean | undefined,
  submissionDoor?: string | undefined
): boolean {
  if (submissionDoor === 'steer') return false
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
 *
 * T-04836 Part B / T-08342: Codex continuation shape is driver-specific.
 * codex-app-server emits provider 'codex', kind 'thread', and consumes that UUID
 * as driver.resumeThreadId without constructing CLI resume argv. The deprecated
 * codex-cli-tmux driver emits provider 'openai', kind 'session', and retains its
 * safe explicit-id `codex resume <SESSION_ID>` path until removal. Pi stays
 * blocked. Claude keeps its existing behavior and, when a provider is present
 * on the stored ref, requires 'anthropic'.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function decideInteractiveTmuxBrokerContinuation(options: {
  allowedBrokerDriver: InteractiveTmuxBrokerDriver
  sessionContinuation: HrcContinuationRef | undefined
}): HrcContinuationRef | undefined {
  const continuation = options.sessionContinuation
  if (continuation?.key === undefined) {
    return undefined
  }

  if (options.allowedBrokerDriver === 'claude-code-tmux') {
    // Claude: stored keys resume via `claude --resume <uuid>`. When a provider
    // is recorded it must be anthropic; legacy rows without a provider stay
    // compatible.
    if (continuation.provider !== undefined && continuation.provider !== 'anthropic') {
      return undefined
    }
    return continuation
  }

  if (options.allowedBrokerDriver === 'codex-app-server') {
    // App server: only the driver's native Codex thread UUID is safe. The
    // compiler passes it to driver.resumeThreadId; no CLI resume argv is built.
    // Continuation providers are producer-owned labels, so every driver
    // narrows provider, kind, and key before it uses a persisted record.
    if (continuation.provider !== 'codex') {
      return undefined
    }
    if (continuation.kind !== 'thread') {
      return undefined
    }
    if (!UUID_RE.test(continuation.key)) {
      return undefined
    }
    return continuation
  }

  if (options.allowedBrokerDriver === 'codex-cli-tmux') {
    // Deprecated CLI-tmux: only its hook-reported OpenAI session UUID is safe;
    // the compiler places it in `codex resume <uuid>`.
    if (continuation.provider !== 'openai') {
      return undefined
    }
    if (continuation.kind !== 'session') {
      return undefined
    }
    if (!UUID_RE.test(continuation.key)) {
      return undefined
    }
    return continuation
  }

  // pi-tui-tmux and any other driver remain blocked.
  return undefined
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

export function shouldConsiderMuseCliTmuxBrokerDispatch(intent: HrcRuntimeIntent): boolean {
  return (
    isInteractiveTmuxBrokerIntent(intent) &&
    intent.harness.provider === 'meta' &&
    (intent.harness.id === undefined || intent.harness.id === 'muse-cli')
  )
}

export function isInteractiveTmuxBrokerDriver(
  brokerDriver: string | undefined
): brokerDriver is InteractiveTmuxBrokerDriver {
  return (
    brokerDriver === 'claude-code-tmux' ||
    brokerDriver === 'codex-app-server' ||
    brokerDriver === 'codex-cli-tmux' ||
    brokerDriver === 'pi-tui-tmux' ||
    brokerDriver === 'muse-cli-tmux'
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
  runtime: HrcRuntimeSnapshot | null,
  // T-05358: the caller computes input-dispatchability (needs db to read the
  // active broker invocation state); defaults true so a non-broker / unknown
  // runtime is unaffected and the existing status/driver gates still apply.
  inputDispatchable = true
): LatestRuntimeAdmissionView {
  if (!runtime) {
    return null
  }

  // Producer-selected v2 rows intentionally have no HRC legacy provider
  // projection. They cannot enter legacy interactive reuse admission.
  if (runtime.provider === undefined) return null

  const brokerDriver = getBrokerRuntimeDriver(runtime)
  return {
    controllerKind: runtime.controllerKind,
    transport: runtime.transport,
    status: runtime.status,
    provider: runtime.provider,
    brokerDriver: isInteractiveTmuxBrokerDriver(brokerDriver) ? brokerDriver : undefined,
    inputDispatchable,
    // T-07397: surfaced so admission can match a refusing caller's ownership
    // proof against the invocation this runtime is actually driving.
    ...(runtime.activeInvocationId !== undefined
      ? { activeInvocationId: runtime.activeInvocationId }
      : {}),
  }
}

/**
 * Minimal view of the session's latest runtime needed to decide whether a
 * headless-preferred turn should be delivered into a live interactive broker
 * runtime instead of spawning a competing headless run. `hasLiveSurface` mirrors
 * the tmuxJson liveness check. Admission state is deliberately
 * absent; the selected broker door owns that decision.
 */
export type LiveInteractiveRuntimeReuseView = {
  controllerKind: HrcRuntimeControllerKind | undefined
  transport: string
  provider: HrcProvider
  status: string
  hasLiveSurface: boolean
} | null

export function toLiveInteractiveRuntimeReuseView(
  runtime: HrcRuntimeSnapshot | null
): LiveInteractiveRuntimeReuseView {
  if (!runtime) {
    return null
  }
  if (runtime.provider === undefined) return null
  return {
    controllerKind: runtime.controllerKind,
    transport: runtime.transport,
    provider: runtime.provider,
    status: runtime.status,
    hasLiveSurface: runtime.tmuxJson !== undefined,
  }
}

/**
 * True when executeAdmittedTurn should SKIP the headless branch and fall
 * through to decideInteractiveBrokerAdmission (→ broker-reuse), delivering the
 * turn INTO a live interactive broker runtime rather than spawning a competing
 * headless run on the same continuation thread. Restricted to a harness-broker
 * runtime whose provider matches the intent so admission resolves to
 * broker-reuse, not an interactive reprovision of a genuinely-headless target.
 *
 * NOT gated on idle: an active interactive TUI must still receive the turn. A
 * busy interactive broker queues the input and drains it on
 * the next turn.completed — forking a parallel headless run, or rejecting
 * RUNTIME_BUSY, both leave the human-visible TUI silently without the message.
 * The broker-reuse call site queues vs. rejects based on the active invocation's
 * explicit queue capability; the interactive tmux drivers advertise queue
 * admission so a busy TUI is held by the broker rather than rejected.
 * Pure; the SDK branch keeps its own equivalent guard.
 */
export function shouldDeferHeadlessToInteractiveBrokerReuse(
  intent: HrcRuntimeIntent,
  latestRuntime: LiveInteractiveRuntimeReuseView
): boolean {
  return (
    latestRuntime !== null &&
    intent.execution?.allowInteractiveSurfaceReuse !== false &&
    latestRuntime.controllerKind === 'harness-broker' &&
    latestRuntime.transport === 'tmux' &&
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

  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux') {
    return hosting.substrate.tmuxSocketPath
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

  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.presentation.kind === 'tmux-tui' && hosting.substrate.kind === 'leased-tmux') {
    return hosting.substrate.sessionName
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

  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.presentation.kind === 'tmux-tui' && hosting.substrate.kind === 'leased-tmux') {
    return `${hosting.substrate.sessionName}:tui`
  }

  return sessionName
}

// The leased tmux pane id used to PROBE a durable broker runtime's liveness
// (reconcileBrokerTmuxRuntimeLiveness). For legacy/normal durable runtimes the
// pane is recorded in `tmuxJson.paneId` (it mirrors the tui pane). For the
// codex-app-server viewer FLAT shape (T-04905) `tmuxJson` is empty — the lease
// lives in `runtimeStateJson.broker.{brokerWindow,tuiWindow}` — so without this
// fallback the reconcile read undefined, treated the live session as "missing",
// and killed the lease server out from under the running broker (SIGHUP),
// crashing it ~40ms into a turn (T-04928). The broker WINDOW (where the durable
// harness-broker process always runs for the runtime's lifetime) is the robust
// liveness signal: it avoids the renderer-startup race the tui pane would have.
export function getBrokerRuntimeTmuxLeasedPaneId(runtime: HrcRuntimeSnapshot): string | undefined {
  const paneId = runtime.tmuxJson?.['paneId']
  if (typeof paneId === 'string' && paneId.length > 0) {
    return paneId
  }

  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux') {
    return hosting.substrate.brokerWindow.paneId
  }

  return undefined
}

export function isInteractiveTmuxBrokerIntent(intent: HrcRuntimeIntent): boolean {
  return (
    intent.harness.interactive === true &&
    !shouldUseHeadlessTransport(intent) &&
    !shouldUseSdkTransport(intent)
  )
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
