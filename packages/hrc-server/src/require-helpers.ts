import {
  HrcConflictError,
  HrcErrorCode,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  AppSessionFreshnessFence,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcLifecycleEvent,
  HrcLocalBridgeRecord,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { AppManagedSessionRecord, HrcDatabase } from 'hrc-store-sqlite'
import { isAskUserTool, isCorruptAwaitingRuntime } from './ask-bracket.js'
import type { GhostmuxSurfaceState } from './ghostmux.js'
import { isRecord } from './server-parsers.js'
import { isRuntimeUnavailableStatus } from './server-util.js'
import type { TmuxPaneState } from './tmux.js'

export { isRuntimeUnavailableStatus } from './server-util.js'

export function requireSession(db: HrcDatabase, hostSessionId: string): HrcSessionRecord {
  const session = db.sessions.getByHostSessionId(hostSessionId)
  if (!session) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_HOST_SESSION,
      `unknown host session "${hostSessionId}"`,
      { hostSessionId }
    )
  }

  return session
}

export function requireManagedAppSession(
  db: HrcDatabase,
  selector: HrcAppSessionRef
): AppManagedSessionRecord {
  const managed = db.appManagedSessions.findByKey(selector.appId, selector.appSessionKey)
  if (!managed) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_APP_SESSION,
      `unknown app session "${selector.appId}/${selector.appSessionKey}"`,
      selector
    )
  }

  if (managed.status === 'removed') {
    throw new HrcConflictError(
      HrcErrorCode.APP_SESSION_REMOVED,
      `app session "${selector.appId}/${selector.appSessionKey}" has been removed`,
      selector
    )
  }

  return managed
}

export function findManagedAppSessionForSession(
  db: HrcDatabase,
  session: HrcSessionRecord
): AppManagedSessionRecord | null {
  if (!session.scopeRef.startsWith('app:')) {
    return null
  }

  return db.appManagedSessions.findByKey(session.scopeRef.slice('app:'.length), session.laneRef)
}

export function resolveManagedHarnessIntent(
  managed: AppManagedSessionRecord,
  session: HrcSessionRecord
): HrcRuntimeIntent | undefined {
  if (session.lastAppliedIntentJson) {
    return session.lastAppliedIntentJson
  }

  if (managed.lastAppliedSpec?.kind === 'harness') {
    return managed.lastAppliedSpec.runtimeIntent
  }

  return undefined
}

export function resolveClearContextSpec(
  managed: AppManagedSessionRecord | undefined,
  relaunchSpec: HrcAppSessionSpec | undefined,
  relaunch: boolean
): HrcAppSessionSpec | undefined {
  if (!managed) {
    return undefined
  }

  if (relaunchSpec && relaunchSpec.kind !== managed.kind) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.SESSION_KIND_MISMATCH,
      `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot relaunch as "${relaunchSpec.kind}"`,
      {
        appId: managed.appId,
        appSessionKey: managed.appSessionKey,
        existingKind: managed.kind,
        requestedKind: relaunchSpec.kind,
      }
    )
  }

  if (!relaunch) {
    return relaunchSpec
  }

  const effectiveSpec = relaunchSpec ?? managed.lastAppliedSpec
  if (effectiveSpec) {
    return effectiveSpec
  }

  throw new HrcUnprocessableEntityError(
    managed.kind === 'command'
      ? HrcErrorCode.MISSING_SESSION_SPEC
      : HrcErrorCode.MISSING_RUNTIME_INTENT,
    managed.kind === 'command'
      ? 'cannot relaunch without a prior session spec'
      : 'cannot relaunch without a prior runtime intent',
    {
      appId: managed.appId,
      appSessionKey: managed.appSessionKey,
      kind: managed.kind,
    }
  )
}

export function validateAppSessionFence(
  fence: AppSessionFreshnessFence | undefined,
  session: HrcSessionRecord
): void {
  if (!fence) {
    return
  }

  if (
    fence.expectedHostSessionId !== undefined &&
    fence.expectedHostSessionId !== session.hostSessionId
  ) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      'app session fence no longer matches host session',
      {
        expectedHostSessionId: fence.expectedHostSessionId,
        actualHostSessionId: session.hostSessionId,
      }
    )
  }

  if (fence.expectedGeneration !== undefined && fence.expectedGeneration !== session.generation) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      'app session fence no longer matches generation',
      {
        expectedGeneration: fence.expectedGeneration,
        actualGeneration: session.generation,
      }
    )
  }
}

export function requireContinuity(db: HrcDatabase, session: HrcSessionRecord) {
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  if (!continuity) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_SESSION,
      `unknown continuity for "${session.scopeRef}/lane:${session.laneRef}"`,
      {
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
      }
    )
  }
  return continuity
}

export function requireBridge(db: HrcDatabase, bridgeId: string): HrcLocalBridgeRecord {
  const bridge = db.localBridges.findById(bridgeId)
  if (!bridge) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_BRIDGE, `unknown bridge "${bridgeId}"`, {
      bridgeId,
    })
  }

  return bridge
}

export function requireRuntime(db: HrcDatabase, runtimeId: string): HrcRuntimeSnapshot {
  const runtime = requireKnownRuntime(db, runtimeId)
  if (isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError(`runtime "${runtimeId}" is ${runtime.status}`, {
      runtimeId,
      status: runtime.status,
    })
  }
  return runtime
}

export function requireKnownRuntime(db: HrcDatabase, runtimeId: string): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime "${runtimeId}"`, {
      runtimeId,
    })
  }
  return runtime
}

export function requireTmuxPane(runtime: HrcRuntimeSnapshot): TmuxPaneState {
  const sessionName = runtime.tmuxJson?.['sessionName']
  const sessionId = runtime.tmuxJson?.['sessionId']
  const windowId = runtime.tmuxJson?.['windowId']
  const paneId = runtime.tmuxJson?.['paneId']
  const socketPath = runtime.tmuxJson?.['socketPath']

  if (
    typeof sessionName !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof windowId !== 'string' ||
    typeof paneId !== 'string' ||
    typeof socketPath !== 'string'
  ) {
    throw new HrcRuntimeUnavailableError(`runtime "${runtime.runtimeId}" is missing tmux state`, {
      runtimeId: runtime.runtimeId,
    })
  }

  return {
    socketPath,
    sessionName,
    windowName: 'main',
    sessionId,
    windowId,
    paneId,
  }
}

export function requireGhosttySurface(runtime: HrcRuntimeSnapshot): GhostmuxSurfaceState {
  const surfaceId = runtime.surfaceJson?.['surfaceId']
  const title = runtime.surfaceJson?.['title']
  const anchorSurfaceId = runtime.surfaceJson?.['anchorSurfaceId']

  if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
    throw new HrcRuntimeUnavailableError(
      `runtime "${runtime.runtimeId}" is missing ghostty state`,
      {
        runtimeId: runtime.runtimeId,
      }
    )
  }

  return {
    kind: 'ghostty',
    surfaceId,
    title: typeof title === 'string' ? title : undefined,
    anchorSurfaceId: typeof anchorSurfaceId === 'string' ? anchorSurfaceId : undefined,
    createdBy: 'ghostmux',
  }
}

export function assertRuntimeNotBusy(db: HrcDatabase, runtime: HrcRuntimeSnapshot): void {
  // T-01946 gate 6: a corrupt `awaiting_input` runtime (status set with no active
  // run) must never be treated as reusable readiness — reject rather than admit a
  // turn onto an inconsistent runtime. (Surfaced for repair by the reconcile scan.)
  if (isCorruptAwaitingRuntime(runtime)) {
    throw new HrcConflictError(
      HrcErrorCode.RUNTIME_BUSY,
      'runtime is awaiting_input with no active run (corrupt); not reusable',
      { runtimeId: runtime.runtimeId }
    )
  }

  if (!runtime.activeRunId) {
    return
  }

  const run = db.runs.getByRunId(runtime.activeRunId)
  if (!run || isRunActive(run)) {
    throw new HrcConflictError(HrcErrorCode.RUNTIME_BUSY, 'runtime already has an active run', {
      runtimeId: runtime.runtimeId,
      activeRunId: runtime.activeRunId,
    })
  }
}

// Reads the composed input.queue capability off the runtime's active broker
// invocation. True iff the broker reported (post-start) that this invocation
// accepts FIFO queueing — driverCaps.input.queue && driverCaps.input.user &&
// spec.interaction.inputQueue === 'fifo'. Returns false defensively on any
// error (missing invocation, malformed capabilities_json) so callers fall
// back to the existing reject-if-busy behavior.
export function isBrokerRuntimeQueueCapable(db: HrcDatabase, runtime: HrcRuntimeSnapshot): boolean {
  if (runtime.controllerKind !== 'harness-broker') return false
  if (runtime.activeInvocationId === undefined) return false
  const inv = db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
  if (!inv?.capabilitiesJson) return false
  try {
    const caps = JSON.parse(inv.capabilitiesJson) as { input?: { queue?: boolean } }
    return caps.input?.queue === true
  } catch {
    return false
  }
}

export function isTerminalBrokerInvocationState(state: string | undefined): boolean {
  return state === 'exited' || state === 'failed' || state === 'disposed'
}

/**
 * T-05358: true iff a harness-broker runtime can currently ACCEPT broker input.
 * A runtime whose active invocation is terminal (gone) or in a control-transition
 * state (`starting`/`stopping`) cannot — selecting it for a turn would dispatch
 * input the broker rejects (`Cannot accept input in state: …`), which is exactly
 * the turn-boundary race this task fixes. The interactive (tmux/ghostty) dispatch
 * gates select by runtime-row status (`isRuntimeUnavailableStatus`), which does
 * NOT cover the transient invocation states, so they must layer this check on top
 * — mirroring the headless reuse selector. Non-broker runtimes and broker runtimes
 * with no/unknown active invocation are treated as dispatchable here; the caller's
 * own status/transport/controllerKind gates handle those.
 */
export function isBrokerRuntimeInputDispatchable(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): boolean {
  if (runtime.controllerKind !== 'harness-broker') return true
  if (runtime.activeInvocationId === undefined) return true
  const inv = db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
  if (!inv) return true
  return (
    !isTerminalBrokerInvocationState(inv.invocationState) &&
    !isTransitionalBrokerInvocationState(inv.invocationState)
  )
}

export function isTerminalBrokerInputFailure(message: string): boolean {
  return /Cannot accept input in state: (exited|failed|disposed)/.test(message)
}

/**
 * T-05358: `starting` and `stopping` are CONTROL-TRANSITION invocation states —
 * the broker is spinning up or tearing down and cannot accept a dispatch. They
 * are NOT terminal (the runtime may still settle to `ready` or reach a terminal
 * state), so they are deliberately kept OUT of
 * {@link isTerminalBrokerInvocationState}. But a dispatch/reuse/reattach path
 * that will issue broker input must treat them as non-dispatchable: exclude them
 * from selection, and reprovision on an actual rejection.
 */
export function isTransitionalBrokerInvocationState(state: string | undefined): boolean {
  return state === 'starting' || state === 'stopping'
}

/**
 * T-05358: a broker input rejection BECAUSE the invocation is in a transient
 * non-dispatchable state (`starting`/`stopping`). Distinct from
 * {@link isTerminalBrokerInputFailure} (truly terminal: exited/failed/disposed)
 * — but equally reprovision-worthy: the runtime cannot serve the dispatch, so it
 * must be marked stale and the next turn provisions/recovers a fresh runtime
 * instead of re-selecting the same wedged one (which would loop the failure).
 */
export function isTransientBrokerInputStateFailure(message: string): boolean {
  return /Cannot accept input in state: (starting|stopping)/.test(message)
}

/**
 * Build the user-facing headline + `next:` recommendation for a broker input
 * dispatch failure. Three cases, in priority order:
 *
 *  - reprovisionRequired: the runtime cannot serve the dispatch and was marked
 *    stale — either the broker invocation is in a terminal state
 *    (exited/failed/disposed) OR it was rejected in a transient non-dispatchable
 *    state (starting/stopping, T-05358). Either way a retry provisions/recovers
 *    a fresh runtime rather than re-selecting the same wedged one.
 *  - brokerBindingMissing: the dispatch returned `broker_runtime_not_active`
 *    ("no active broker client …") AND the lazy durable reattach could not
 *    restore the binding within this call. This is almost always transient —
 *    the in-memory controller binding is cold right after a daemon restart, or
 *    the 250ms liveness probe lost a race under load. The durable broker is
 *    typically still alive, so the runtime stays `ready` and the very next turn
 *    reattaches to the SAME runtime (preserving continuity). Tell the operator
 *    to simply retry rather than to go spelunking in the logs.
 *  - otherwise: an unclassified broker rejection; logs are the right next step.
 */
export function classifyBrokerInputFailure(opts: {
  label: 'headless' | 'interactive'
  errorMessage: string
  brokerBindingMissing: boolean
  reprovisionRequired: boolean
}): { headline: string; recommendation: string } {
  const { label, errorMessage, brokerBindingMissing, reprovisionRequired } = opts
  if (reprovisionRequired) {
    // T-04297: reprovision + binding-missing means the broker process is provably
    // gone (e.g. a host reboot killed it) and the reattach reaped the runtime —
    // say that instead of leaking the "no active broker client" jargon.
    if (brokerBindingMissing) {
      return {
        headline: `${label} broker process is gone (likely host reboot or broker crash)`,
        recommendation:
          'retry the turn; HRC marked the stale broker runtime unavailable and the retry provisions a fresh broker on the same session',
      }
    }
    return {
      headline: `${label} broker input failed: ${errorMessage}`,
      recommendation: 'retry the turn; HRC marked the stale broker runtime unavailable',
    }
  }
  if (brokerBindingMissing) {
    return {
      headline: `${label} broker connection was not live`,
      recommendation:
        'usually transient (commonly right after a daemon restart) — just retry; HRC reattaches to the existing runtime on the next turn',
    }
  }
  return {
    headline: `${label} broker input failed: ${errorMessage}`,
    recommendation: 'inspect hrc server logs and retry after the broker is healthy',
  }
}

export function isRunActive(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
}

export function isPendingAskUserQuestionRun(events: HrcLifecycleEvent[]): boolean {
  const pendingToolUseIds = new Set<string>()

  for (const event of events) {
    if (event.eventKind === 'turn.completed') {
      pendingToolUseIds.clear()
      continue
    }

    const payload = isRecord(event.payload) ? event.payload : {}
    const toolUseId = typeof payload['toolUseId'] === 'string' ? payload['toolUseId'] : undefined
    if (event.eventKind === 'turn.tool_call') {
      const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : undefined
      if (isAskUserTool(toolName) && toolUseId !== undefined) {
        pendingToolUseIds.add(toolUseId)
      }
      continue
    }

    if (event.eventKind === 'turn.tool_result' && toolUseId !== undefined) {
      pendingToolUseIds.delete(toolUseId)
    }
  }

  return pendingToolUseIds.size > 0
}
