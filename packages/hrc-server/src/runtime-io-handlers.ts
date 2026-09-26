import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { HrcBadRequestError, HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  CaptureResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  RestartStyle,
} from 'hrc-core'
import {
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
} from './actuator-split.js'
import { hasInitialUserTurn } from './agent-spaces-adapter/compile-adapter.js'
import { assertAppIdentityOwner, issueAppBirthRunGrantForCompile } from './app-session-identity.js'
import {
  decideHeadlessExecutionRoute,
  decideInteractiveTmuxBrokerStartRoute,
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxLeasedPaneId,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  isMatchingInteractiveTmuxBrokerRuntime,
  isProducerSelectedOrdinaryBirth,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeCodexInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldRedirectClaudeToInteractiveBroker,
  shouldRedirectCodexToInteractiveBroker,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
import {
  canOperatorAttach,
  getBrokerPresentationPane,
  hasLeasedBrokerSubstrate,
} from './broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  assertAttachedRunReusesHeadless,
  assertNoOperatorPresentationConflict,
  assertOperatorPresentationRoutable,
  createStartBirthDecision,
  decideCrossingBirthRoute,
  decideRedirectOffCodexRoute,
  findEstablishedBrokerRuntime,
  isOmittedChoiceCodexRequest,
  recordStartBirth,
  requestsOperatorPresentation,
  scopeHasLiveHeadlessBrokerRuntime,
  startBirthOf,
  startBirthOfIntent,
} from './presentation-operator.js'
import {
  isBrokerRuntimeTransitional,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  assertV2SelectionCompatibleForReuse,
  findLatestSessionRuntime,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { AttachBeforeInvocationStartOption, AttachDescriptorResponse } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { automaticContinuationForRuntime } from './session-continuation-reuse.js'
import {
  findPersistedLifecycleTerminalReason,
  findUserInitiatedContinuationClearReason,
  getObservedTmuxSessionName,
  markRuntimeDead,
  markRuntimeStale,
  markRuntimeTerminatedAfterUserExit,
} from './startup-reconcile.js'
import { createTmuxManager } from './tmux.js'

export async function captureRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<Response> {
  const pane =
    runtime.transport === 'tmux' ? requireTmuxPane(runtime) : getBrokerPresentationPane(runtime)
  if (!pane) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'cannot capture a non-interactive runtime; use the runtime event stream instead',
      {
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
      }
    )
  }

  const tmux = this.tmuxForPane(pane)
  const observed = await tmux.inspectPane(pane.paneId)
  if (
    !observed ||
    observed.socketPath !== pane.socketPath ||
    observed.sessionName !== pane.sessionName ||
    observed.windowName !== pane.windowName ||
    observed.sessionId !== pane.sessionId ||
    observed.windowId !== pane.windowId ||
    observed.paneId !== pane.paneId
  ) {
    throw new HrcRuntimeUnavailableError(
      `runtime "${runtime.runtimeId}" presentation pane is unavailable or changed`,
      {
        runtimeId: runtime.runtimeId,
        expected: pane,
        observed,
      }
    )
  }

  const text = await tmux.capture(pane.paneId)

  const now = timestamp()
  this.db.runtimes.update(
    runtime.runtimeId,
    runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'agent-message',
      occurredAt: now,
      updatedAt: now,
    })
  )

  return json({
    text,
  } satisfies CaptureResponse)
}

export async function reconcileTmuxRuntimeLiveness(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<HrcRuntimeSnapshot> {
  if (isExternalLifecycleOwner(runtime)) {
    return runtime
  }
  if (
    runtime.controllerKind === 'harness-broker' &&
    (runtime.transport === 'tmux' || hasLeasedBrokerSubstrate(runtime)) &&
    !isRuntimeUnavailableStatus(runtime.status)
  ) {
    // Precedence (T-01783 WS-D): a broker terminal event (harness.exited /
    // invocation.exited, incl. the future idle-ttl retire) projected by WS-C
    // is the authoritative classification. When the active invocation already
    // carries a persisted lifecycle terminal reason, defer to it and propagate
    // it onto the runtime — do NOT synthesize a generic stale/dead/orphan
    // reason from raw pane/session liveness inspection below.
    const lifecycleTerminalReason = findPersistedLifecycleTerminalReason(this.db, runtime)
    if (lifecycleTerminalReason !== undefined) {
      const session = requireSession(this.db, runtime.hostSessionId)
      const event = markRuntimeStale(this.db, session, runtime, {
        runtimeId: runtime.runtimeId,
        reason: lifecycleTerminalReason,
        classification: 'lifecycle_terminal',
        invocationId: runtime.activeInvocationId ?? null,
      })
      this.notifyEvent(event)
      this.db.runtimes.update(runtime.runtimeId, {
        lifecycleTerminalReason,
        updatedAt: timestamp(),
      })
      return requireKnownRuntime(this.db, runtime.runtimeId)
    }

    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    if (!socketPath) {
      const session = requireSession(this.db, runtime.hostSessionId)
      const payload = {
        runtimeId: runtime.runtimeId,
        reason: 'broker_tmux_socket_missing',
      }
      const userExitReason = findUserInitiatedContinuationClearReason(this.db, runtime)
      const event =
        userExitReason !== undefined
          ? markRuntimeTerminatedAfterUserExit(this.db, session, runtime, {
              ...payload,
              userExitReason,
            })
          : markRuntimeStale(this.db, session, runtime, payload)
      this.notifyEvent(event)
      return requireKnownRuntime(this.db, runtime.runtimeId)
    }

    const brokerTmux = createTmuxManager({ socketPath })
    const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
    // T-01801: a durable broker lease (T-01812) hosts TWO named windows under one
    // session — 'broker' (the harness-broker IPC server) and 'tui' (the harness the
    // operator attaches to) — and has NO 'main' window. `inspectSession` probes
    // `<session>:main`, so for a durable runtime it returns null and this reconcile
    // declares the live session "missing" and kills the lease server out from under
    // the running broker (SIGHUP) on every routine `hrc runtime list`. Probe the
    // runtime's RECORDED leased pane by id instead — it mirrors the tui pane for
    // durable runtimes and the main pane for legacy ones, so it is topology-agnostic.
    // T-04928: the codex-app-server viewer FLAT shape records NO tmuxJson (the lease
    // lives in runtimeStateJson.broker), so a bare `runtime.tmuxJson?.paneId` read
    // here was undefined → "session missing" → killServer → SIGHUP killed the live
    // viewer broker mid-turn. The presentation-aware resolver falls back to the
    // broker pane for that shape.
    const leasedPaneId = getBrokerRuntimeTmuxLeasedPaneId(runtime)
    const inspected =
      typeof leasedPaneId === 'string' &&
      (await brokerTmux.inspectPaneLiveness(leasedPaneId)) !== null
        ? { paneId: leasedPaneId }
        : null
    if (inspected) {
      // Session existence is necessary but NOT sufficient: the hrc-owned lease
      // session can outlive the harness process inside the pane. If the harness
      // exited — or its `exec` launch never landed and the pane was left at a
      // bare shell — reusing this runtime would attach the user to a dead pane
      // with no relaunch. Probe the leased pane's foreground and only reuse when
      // the harness is genuinely live. (Legacy interactive runtimes gate reuse on
      // a tracked launch PID via hasLiveInteractiveLaunch; broker runtimes paste
      // into the pane and persist no child PID, so the pane foreground is the
      // available liveness signal.)
      let liveness = await brokerTmux.inspectPaneLiveness(inspected.paneId)
      if (!liveness?.alive) {
        for (const retryDelayMs of [100, 250, 500, 1000, 2000]) {
          await delay(retryDelayMs)
          liveness = await brokerTmux.inspectPaneLiveness(inspected.paneId)
          if (liveness?.alive) {
            return runtime
          }
        }
      }
      if (liveness?.alive) {
        return runtime
      }

      const session = requireSession(this.db, runtime.hostSessionId)
      const payload = {
        runtimeId: runtime.runtimeId,
        sessionName,
        socketPath,
        paneId: inspected.paneId,
        paneDead: liveness?.dead ?? null,
        paneCommand: liveness?.currentCommand ?? null,
        reason: 'broker_tmux_harness_not_live',
      }
      const userExitReason = findUserInitiatedContinuationClearReason(this.db, runtime)
      const event =
        userExitReason !== undefined
          ? markRuntimeTerminatedAfterUserExit(this.db, session, runtime, {
              ...payload,
              userExitReason,
            })
          : markRuntimeStale(this.db, session, runtime, payload)
      this.notifyEvent(event)
      await brokerTmux.killServer().catch((error) => {
        writeServerLog('WARN', 'failed to remove stale broker tmux lease server', {
          runtimeId: runtime.runtimeId,
          sessionName,
          socketPath,
          reason: 'broker_tmux_harness_not_live',
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return requireKnownRuntime(this.db, runtime.runtimeId)
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    const payload = {
      runtimeId: runtime.runtimeId,
      sessionName,
      socketPath,
      reason: 'broker_tmux_session_missing',
    }
    const userExitReason = findUserInitiatedContinuationClearReason(this.db, runtime)
    const event =
      userExitReason !== undefined
        ? markRuntimeTerminatedAfterUserExit(this.db, session, runtime, {
            ...payload,
            userExitReason,
          })
        : markRuntimeStale(this.db, session, runtime, payload)
    this.notifyEvent(event)
    await brokerTmux.killServer().catch((error) => {
      writeServerLog('WARN', 'failed to remove missing broker tmux lease server', {
        runtimeId: runtime.runtimeId,
        sessionName,
        socketPath,
        reason: 'broker_tmux_session_missing',
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return requireKnownRuntime(this.db, runtime.runtimeId)
  }

  if (runtime.transport !== 'tmux' || isRuntimeUnavailableStatus(runtime.status)) return runtime

  const tmuxSessionTarget = getObservedTmuxSessionName(runtime)
  if (!tmuxSessionTarget) {
    return runtime
  }

  const inspected = await this.tmux.inspectSession(tmuxSessionTarget)
  if (inspected) {
    return runtime
  }

  markRuntimeDead(this.db, requireSession(this.db, runtime.hostSessionId), runtime, 'tmux', {
    runtimeId: runtime.runtimeId,
    sessionTarget: tmuxSessionTarget,
    reason: 'tmux_session_missing',
  })

  return requireRuntime(this.db, runtime.runtimeId)
}

export async function startRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  restartStyle: RestartStyle,
  options: {
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    operatorAttachPending?: boolean | undefined
    /** This start is the attached-run door's operation. */
    attachedRunDoor?: boolean | undefined
    /** §1.4 "Joining a registered start": the newborn a joined start produced. */
    attachedRunJoinedRuntimeId?: string | undefined
    /** The settled start this door already joined; it can no longer change rows. */
    attachedRunJoinedOperation?: Promise<HrcRuntimeSnapshot> | undefined
    /** §1.4 "Initial input": delivered by identity before the operation deregisters. */
    attachedRunPrompt?: AttachedRunPrompt | undefined
  } = {}
): Promise<HrcRuntimeSnapshot> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  assertAppIdentityOwner(session)
  // An attached run is a generic door.  It cannot inspect the request to
  // predict a driver or a surface: ASP admits the execution first, and the
  // controller exposes the attach gate only when that execution allocated a
  // leased presentation surface.
  const attachedRunDoor = options.attachedRunDoor === true
  // Generic participant scopes are likewise permanent externally-owned
  // addresses. Establishment enters through the participant broker path, so an
  // ordinary cold-start here would create a competing HRC-owned writer.
  const participantRegistration = this.db.participantRegistrations.getRegistrationByScopeRef(
    session.scopeRef
  )
  if (participantRegistration !== null) {
    throw new HrcRuntimeUnavailableError('participant scope cannot be cold-born', {
      scopeRef: session.scopeRef,
      registrationId: participantRegistration.registrationId,
      reason: 'participant_address_reserved',
    })
  }
  const existingOperation = this.runtimeStartOperations.get(session.hostSessionId)
  if (
    existingOperation &&
    attachedRunDoor &&
    existingOperation !== options.attachedRunJoinedOperation
  ) {
    // T-08556 (§1.4): never return another start's result as this door's. A
    // foreign recorded birth refuses before its boot is awaited; otherwise the
    // start settles and the door re-enters to select inside its OWN registered
    // operation, carrying the newborn (a newborn is never admission-replaced).
    const birth = await startBirthOf(existingOperation)
    if (birth !== undefined) decideCrossingBirthRoute(intent, birth)
    const joined = await existingOperation.catch(() => undefined)
    return await this.startRuntimeForSession(session, intent, restartStyle, {
      ...options,
      attachedRunJoinedRuntimeId: joined?.runtimeId ?? options.attachedRunJoinedRuntimeId,
      attachedRunJoinedOperation: existingOperation,
    })
  }
  if (existingOperation && !attachedRunDoor) {
    const runtime = await existingOperation
    assertActuatorSplitRuntimeReuse(intent, runtime)
    // T-08553: joining a boot is reuse; a conflicting live presentation refuses.
    assertNoOperatorPresentationConflict(intent, [runtime])
    return runtime
  }

  // T-08555: a crossing redirect-off dispatch reads this start's chosen birth
  // (settled below once decided, or undefined on an early exit).
  const startBirth = createStartBirthDecision()
  const operation = (async () => {
    let existingRuntime = findLatestSessionRuntime(this.db, session.hostSessionId)
    if (existingRuntime) {
      existingRuntime = await this.reconcileTmuxRuntimeLiveness(existingRuntime)
      if (
        existingRuntime.controllerKind === 'harness-broker' &&
        !isRuntimeUnavailableStatus(existingRuntime.status)
      ) {
        // The producer's frozen selection is the only reuse identity. In
        // particular, a request that omits selection does not force a local
        // default back onto an established runtime.
        assertV2SelectionCompatibleForReuse(existingRuntime, intent)
      }
    }
    // T-08556 (§1.4): the attached-run door's selection. The selected runtime
    // is marked operator-attach-pending and receives the door's prompt by
    // identity before this registered operation settles.
    const attachedRunSelected = async (
      runtime: HrcRuntimeSnapshot
    ): Promise<HrcRuntimeSnapshot> => {
      await this.publishPresentation(runtime, { operatorAttachPending: true })
      if (options.attachedRunPrompt !== undefined) {
        await deliverAttachedRunPrompt(this, session, runtime, options.attachedRunPrompt)
      }
      return runtime
    }
    if (attachedRunDoor) {
      const joined =
        options.attachedRunJoinedRuntimeId !== undefined
          ? this.db.runtimes.getByRuntimeId(options.attachedRunJoinedRuntimeId)
          : null
      const liveJoined =
        joined !== null &&
        joined.controllerKind === 'harness-broker' &&
        joined.status !== 'failed' &&
        !isRuntimeUnavailableStatus(joined.status)
          ? joined
          : undefined
      // Rules 1–2: a live joined newborn is never replaced.
      if (liveJoined !== undefined) {
        // The attached door consumes an execution that has already been
        // admitted and allocated.  Legacy provider/harness birth classifiers
        // cannot participate in this decision.
        assertAttachedRunReusesHeadless(liveJoined, {
          transitional: isBrokerRuntimeTransitional(this.db, liveJoined),
        })
        startBirth.decide(undefined)
        return await attachedRunSelected(liveJoined)
      }
      // Rule 5: an established headless runtime of any harness or state is never
      // stale-marked, replaced or started beside, short of --force-restart.
      if (restartStyle !== 'fresh_pty') {
        const established = findEstablishedBrokerRuntime(
          this.db.runtimes.listByHostSessionId(session.hostSessionId)
        )
        if (established !== undefined && established.transport !== 'tmux') {
          assertAttachedRunReusesHeadless(established, {
            transitional: isBrokerRuntimeTransitional(this.db, established),
          })
          startBirth.decide(undefined)
          return await attachedRunSelected(established)
        }
      }
    }
    // An ordinary v2 start never selects a provider, harness, profile or
    // driver locally. ASP compiles the raw request and HRC hosts its frozen
    // execution. Only an explicit operator surface keeps the older interactive
    // attach choreography below.
    if (isProducerSelectedOrdinaryBirth(intent)) {
      startBirth.decide(undefined)
      const presentationOptions = {
        operatorAttachPending:
          options.attachBeforeInvocationStart !== undefined ||
          options.operatorAttachPending === true,
      }
      if (
        existingRuntime?.controllerKind === 'harness-broker' &&
        !isRuntimeUnavailableStatus(existingRuntime.status) &&
        restartStyle !== 'fresh_pty'
      ) {
        assertActuatorSplitRuntimeReuse(intent, existingRuntime)
        assertNoOperatorPresentationConflict(intent, [existingRuntime])
        if (attachedRunDoor) return await attachedRunSelected(existingRuntime)
        await this.publishPresentation(existingRuntime, presentationOptions)
        const initialPrompt = intent.initialPrompt ?? ''
        if (initialPrompt.length > 0) {
          const runId = `run-${randomUUID()}`
          if (existingRuntime.transport === 'tmux') {
            await this.executeInteractiveBrokerInputTurn(
              session,
              existingRuntime,
              initialPrompt,
              runId,
              { waitForCompletion: true }
            )
          } else {
            await this.executeHeadlessBrokerInputTurn(
              session,
              existingRuntime,
              initialPrompt,
              runId,
              { waitForCompletion: true }
            )
          }
        }
        return requireRuntime(this.db, existingRuntime.runtimeId)
      }

      const startRunId = `run-${randomUUID()}`
      issueAppBirthRunGrantForCompile(this.db, session, intent, startRunId)
      if (existingRuntime && !isRuntimeUnavailableStatus(existingRuntime.status)) {
        this.markRuntimeStaleForBrokerReprovision(session, existingRuntime, {
          reason: 'producer-selected-ordinary-start-reprovision',
          route: 'producer-selected-execution',
        })
      }
      const initialPrompt = intent.initialPrompt ?? ''
      const runtime = await this.startHeadlessBrokerRuntime(
        session,
        intent,
        initialPrompt,
        startRunId,
        {
          ...(hasInitialUserTurn(intent) ? {} : { allowCompilerInitialInputWithoutIdentity: true }),
          ...(options.attachBeforeInvocationStart !== undefined
            ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
            : {}),
        }
      )
      await this.publishPresentation(runtime, presentationOptions)
      if (attachedRunDoor) return await attachedRunSelected(runtime)
      if (initialPrompt.length > 0) {
        await this.waitForHeadlessBrokerRunCompletion(startRunId, runtime.runtimeId)
      }
      return requireRuntime(this.db, runtime.runtimeId)
    }
    const highRiskActuatorSplit =
      normalizeActuatorSplitPolicy(intent.execution?.actuatorSplit)?.mode === 'high-risk'
    const claudeRedirect =
      this.claudeCodeTmuxBrokerEnabled &&
      !highRiskActuatorSplit &&
      shouldRedirectClaudeToInteractiveBroker(intent)
    // T-08553: an explicit per-request no-viewer choice keeps the start headless,
    // and an omitted one is delivered into the scope's live headless runtime.
    // T-08555: with the redirect off, the scope's established broker runtime
    // selects the admission (§1.3 rules 3–5); nothing established runs headless
    // with the node presentation default.
    const codexRedirect = this.codexCliTmuxBrokerEnabled
      ? !highRiskActuatorSplit &&
        !requestsOperatorPresentation(intent) &&
        shouldRedirectCodexToInteractiveBroker(intent) &&
        !scopeHasLiveHeadlessBrokerRuntime(this.db, session.hostSessionId)
      : !claudeRedirect &&
        isOmittedChoiceCodexRequest(intent) &&
        decideRedirectOffCodexRoute(
          intent,
          this.db.runtimes.listByHostSessionId(session.hostSessionId)
        ) === 'interactive'
    const startIntent = claudeRedirect
      ? normalizeClaudeInteractiveBrokerIntent(intent)
      : codexRedirect
        ? normalizeCodexInteractiveBrokerIntent(intent)
        : intent
    startBirth.decide(
      startBirthOfIntent(shouldUseHeadlessTransport(startIntent) ? 'headless' : 'tmux', startIntent)
    )
    // T-08553: refuse an unhonorable or conflicting no-viewer choice before any
    // reuse, stale-marking or reprovision below.
    if (requestsOperatorPresentation(startIntent)) {
      assertOperatorPresentationRoutable(startIntent, {
        claudeRedirect,
        headlessTransport: shouldUseHeadlessTransport(startIntent),
        headlessRoute: shouldUseHeadlessTransport(startIntent)
          ? decideHeadlessExecutionRoute(startIntent, {
              brokerFlagEnabled: this.headlessCodexBrokerEnabled,
              museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
            })
          : undefined,
      })
      assertNoOperatorPresentationConflict(
        startIntent,
        this.db.runtimes.listByHostSessionId(session.hostSessionId)
      )
    }
    const normalizedIntent = normalizeRuntimeProvisionIntent(startIntent)
    const presentationOptions = {
      operatorAttachPending:
        options.attachBeforeInvocationStart !== undefined || options.operatorAttachPending === true,
    }
    if (shouldUseHeadlessTransport(startIntent)) {
      // T-01757 (Wave C, A2): codex headless START provisions THROUGH the
      // HarnessBrokerController (parent acceptance: "Codex headless sessions
      // start through HarnessBrokerController") — never exec.ts. SDK start
      // still hard-fails; legacy-exec still fails closed.
      const headlessRoute = decideHeadlessExecutionRoute(startIntent, {
        brokerFlagEnabled: this.headlessCodexBrokerEnabled,
        museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
      })
      assertActuatorSplitRouteAdmission(startIntent, headlessRoute)
      if (headlessRoute === 'broker') {
        const reusableBrokerRuntime = getReusableHeadlessRuntimeForSession(
          this.db,
          session.hostSessionId
        )
        // Idempotent reuse ONLY for a real broker headless runtime that has a
        // continuation. A legacy (non-broker) or continuation-less runtime is
        // staled + reprovisioned through the broker, never returned as-is.
        if (
          reusableBrokerRuntime &&
          reusableBrokerRuntime.controllerKind === 'harness-broker' &&
          !isRuntimeUnavailableStatus(reusableBrokerRuntime.status) &&
          automaticContinuationForRuntime(this.db, session, reusableBrokerRuntime)?.key
        ) {
          assertActuatorSplitRuntimeReuse(startIntent, reusableBrokerRuntime)
          await this.publishPresentation(reusableBrokerRuntime, presentationOptions)
          const initialPrompt = startIntent.initialPrompt ?? ''
          let resolvedRuntime = reusableBrokerRuntime
          if (initialPrompt.length > 0) {
            await this.executeHeadlessBrokerInputTurn(
              session,
              reusableBrokerRuntime,
              initialPrompt,
              `run-${randomUUID()}`,
              { waitForCompletion: true }
            )
            resolvedRuntime = requireRuntime(this.db, reusableBrokerRuntime.runtimeId)
          }
          this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, timestamp())
          return resolvedRuntime
        }
        const startRunId = `run-${randomUUID()}`
        // T-08576 D5: an app birth that compiles an initial turn reserves its run
        // id under the owner before any stale-mark, run, handle or launch effect.
        issueAppBirthRunGrantForCompile(this.db, session, startIntent, startRunId)
        if (reusableBrokerRuntime && !isRuntimeUnavailableStatus(reusableBrokerRuntime.status)) {
          this.markRuntimeStaleForBrokerReprovision(session, reusableBrokerRuntime, {
            reason: 'headless-broker-start-reprovision',
            route: 'headless-broker',
          })
        }

        // The broker controller owns runtime allocation — do NOT pre-create a
        // runtime record here. Pass the RAW intent (not normalizedIntent): the
        // broker headless plan needs interactive:false; normalizeRuntimeProvisionIntent
        // flips headless intents to interactive:true for tmux provisioning,
        // which would compile the broker plan in interactive mode.
        const initialPrompt = startIntent.initialPrompt ?? ''
        const brokerRuntime = await this.startHeadlessBrokerRuntime(
          session,
          startIntent,
          initialPrompt,
          startRunId,
          // A promptless headless start still permits ASPC's bundle/profile
          // priming input, just as broker session-open does. No HRC run/input
          // identity exists in this shape, so attachment-bearing starts remain
          // strict and do not opt in here.
          hasInitialUserTurn(startIntent)
            ? undefined
            : { allowCompilerInitialInputWithoutIdentity: true }
        )
        await this.publishPresentation(brokerRuntime, presentationOptions)
        // Explicit start WITH an initial prompt: wait for the startup turn to
        // complete (continuation established) via broker events, as the old
        // exec.ts start did. With NO initial user turn there is no run to wait
        // on — return once the controller yields the runtime.
        if (initialPrompt.length > 0) {
          await this.waitForHeadlessBrokerRunCompletion(startRunId, brokerRuntime.runtimeId)
        }
        return requireRuntime(this.db, brokerRuntime.runtimeId)
      }

      // SDK (anthropic) start hard-fails; legacy-exec start fails closed.
      const reusableRuntime = getReusableHeadlessRuntimeForSession(this.db, session.hostSessionId)
      if (
        reusableRuntime &&
        automaticContinuationForRuntime(this.db, session, reusableRuntime)?.key
      ) {
        assertActuatorSplitRuntimeReuse(startIntent, reusableRuntime)
        this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, timestamp())
        return reusableRuntime
      }

      // Retired SDK and legacy CLI starts fail before allocating a runtime row.
      // Continuation-backed reuse above remains valid and does not allocate
      // anything.
      if (headlessRoute === 'sdk') {
        this.failSdkHarnessPath(
          'startRuntimeForSession',
          session,
          normalizedIntent,
          `run-${randomUUID()}`
        )
      }

      if (headlessRoute === 'legacy-exec') {
        this.failCliStartPath(
          'startRuntimeForSession',
          session,
          normalizedIntent,
          `run-${randomUUID()}`
        )
      }
    }

    if (highRiskActuatorSplit) {
      assertActuatorSplitRouteAdmission(startIntent, 'interactive-broker')
    }
    const interactiveBrokerOptions = this.selectInteractiveTmuxBrokerOptions(normalizedIntent)
    if (interactiveBrokerOptions) {
      if (
        existingRuntime &&
        !isRuntimeUnavailableStatus(existingRuntime.status) &&
        restartStyle === 'reuse_pty' &&
        isMatchingInteractiveTmuxBrokerRuntime(
          existingRuntime,
          normalizedIntent,
          interactiveBrokerOptions.allowedBrokerDriver
        )
      ) {
        assertActuatorSplitRuntimeReuse(normalizedIntent, existingRuntime)
        if (attachedRunDoor) return await attachedRunSelected(existingRuntime)
        await this.publishPresentation(existingRuntime, presentationOptions)
        return existingRuntime
      }
      const startRunId = `run-${randomUUID()}`
      // T-08576 D5: reserve before any stale-mark, run, handle or launch effect.
      issueAppBirthRunGrantForCompile(this.db, session, normalizedIntent, startRunId)
      if (existingRuntime && !isRuntimeUnavailableStatus(existingRuntime.status)) {
        this.markRuntimeStaleForBrokerReprovision(session, existingRuntime, {
          reason: 'interactive-broker-start-reprovision',
          allowedBrokerDriver: interactiveBrokerOptions.allowedBrokerDriver,
        })
      }

      // T-01757 (Wave C): the route is hardcoded 'broker', so the legacyTmux
      // closure was dead. Dropped — only the broker executor is reachable.
      const runtime = await runInteractiveTmuxRoute('broker', {
        broker: async () =>
          this.startInteractiveTmuxBrokerRuntime(session, normalizedIntent, startRunId, {
            ...interactiveBrokerOptions,
            ...(options.attachBeforeInvocationStart
              ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
              : {}),
          }),
      })
      if (attachedRunDoor) return await attachedRunSelected(runtime)
      await this.publishPresentation(runtime, presentationOptions)
      if ((normalizedIntent.initialPrompt ?? '').length > 0) {
        await this.waitForInteractiveBrokerRunCompletion(startRunId, runtime.runtimeId)
      }
      return runtime
    }

    // T-01757 (Wave C) reachability note: the headless branch above always
    // returns; the interactive-broker block above always returns-or-throws.
    // By here the intent is therefore NOT headless, so this guard ALWAYS
    // throws RuntimeUnavailable for any non-headless, non-broker-admissible
    // interactive intent. The legacy interactive/headless START fall-through
    // that used to follow (ensureRuntimeForSession plus start-launch dispatch)
    // was provably unreachable and is removed.
    throw new HrcRuntimeUnavailableError('interactive runtime is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: normalizedIntent.harness.provider,
      harnessId: normalizedIntent.harness.id,
      route: 'interactive-broker',
    })
  })().finally(() => {
    startBirth.decide(undefined)
    this.runtimeStartOperations.delete(session.hostSessionId)
  })

  recordStartBirth(operation, startBirth.decided)
  this.runtimeStartOperations.set(session.hostSessionId, operation)
  return await operation
}

/** T-08556 (§1.4): the attached-run door's prompt and the sink for its turn response. */
export type AttachedRunPrompt = {
  prompt: string
  runId: string
  onDelivered: (response: Response) => void
}

/**
 * §1.4 "Initial input exactly once": the prompt goes to the selected runtime by
 * identity, through the turn admission gate and that transport's input-turn
 * executor. No session-level selection, admission or reprovision runs here.
 */
async function deliverAttachedRunPrompt(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  input: AttachedRunPrompt
): Promise<void> {
  const releaseAdmission = server.turnAdmissionGate.admit({ existingAcceptedRun: false })
  try {
    const current = requireRuntime(server.db, runtime.runtimeId)
    const response =
      current.transport === 'tmux'
        ? await server.executeInteractiveBrokerInputTurn(
            session,
            current,
            input.prompt,
            input.runId,
            {
              waitForCompletion: false,
            }
          )
        : await server.executeHeadlessBrokerInputTurn(session, current, input.prompt, input.runId, {
            waitForCompletion: false,
          })
    input.onDelivered(response)
  } finally {
    releaseAdmission()
  }
}

export function selectInteractiveTmuxBrokerOptions(
  this: HrcServerInstanceForHandlers,
  intent: HrcRuntimeIntent
): { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver } | undefined {
  if (!isExplicitInteractiveTmuxBrokerStartIntent(intent)) {
    return undefined
  }

  const route = decideInteractiveTmuxBrokerStartRoute(intent, {
    claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
    piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
    museCliTmuxBrokerEnabled: this.museCliTmuxBrokerEnabled,
  })

  if (route.route !== 'broker') {
    return undefined
  }

  return {
    flagEnvName: route.flagEnvName,
    allowedBrokerDriver: route.allowedBrokerDriver,
  }
}

function isExplicitInteractiveTmuxBrokerStartIntent(intent: HrcRuntimeIntent): boolean {
  return (
    (intent.harness.provider === 'anthropic' && intent.harness.id === 'claude-code') ||
    (intent.harness.provider === 'openai' &&
      (intent.harness.id === 'codex-cli' ||
        intent.harness.id === 'pi' ||
        intent.harness.id === 'pi-cli')) ||
    (intent.harness.provider === 'meta' && intent.harness.id === 'muse-cli')
  )
}

export function attachRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  options: { allowLegacyTmuxAttach?: boolean } = {}
): Response {
  if (
    runtime.controllerKind === 'harness-broker' &&
    (runtime.transport === 'tmux' || canOperatorAttach(runtime))
  ) {
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    if (!socketPath) {
      throw new HrcRuntimeUnavailableError(
        `broker runtime "${runtime.runtimeId}" is missing tmux socket state`,
        {
          runtimeId: runtime.runtimeId,
          transport: runtime.transport,
          controllerKind: runtime.controllerKind,
        }
      )
    }
    const brokerTmuxWindowId =
      typeof runtime.tmuxJson?.['windowId'] === 'string' ? runtime.tmuxJson['windowId'] : undefined
    const brokerTmuxPaneId =
      typeof runtime.tmuxJson?.['paneId'] === 'string' ? runtime.tmuxJson['paneId'] : undefined

    return json({
      transport: 'tmux',
      argv: this.tmux.getAttachDescriptor(getBrokerRuntimeTmuxAttachTarget(runtime), socketPath)
        .argv,
      bindingFence: {
        hostSessionId: runtime.hostSessionId,
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        ...(brokerTmuxWindowId ? { windowId: brokerTmuxWindowId } : {}),
        ...(brokerTmuxPaneId ? { paneId: brokerTmuxPaneId } : {}),
      },
    } satisfies AttachDescriptorResponse)
  }

  if (runtime.transport !== 'tmux') {
    throw new HrcRuntimeUnavailableError('attach is only available for interactive runtimes', {
      runtimeId: runtime.runtimeId,
      transport: runtime.transport,
    })
  }
  if (options.allowLegacyTmuxAttach !== true) {
    throw new HrcRuntimeUnavailableError('attach is only available for broker runtimes', {
      runtimeId: runtime.runtimeId,
      transport: runtime.transport,
      controllerKind: runtime.controllerKind,
    })
  }
  const tmux = requireTmuxPane(runtime)

  return json({
    transport: 'tmux',
    argv: this.tmux.getAttachDescriptor(tmux.sessionId).argv,
    bindingFence: {
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      windowId: tmux.windowId,
      paneId: tmux.paneId,
    },
  } satisfies AttachDescriptorResponse)
}

export async function attachRuntimeEffectfully(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  options: { strictRuntimeId?: boolean } = {}
): Promise<Response> {
  if (runtime.transport === 'sdk') {
    throw new HrcRuntimeUnavailableError('attach is only available for interactive runtimes', {
      runtimeId: runtime.runtimeId,
      transport: runtime.transport,
    })
  }

  const session = requireSession(this.db, runtime.hostSessionId)
  const startOperation = this.runtimeStartOperations.get(session.hostSessionId)
  if (startOperation) {
    await startOperation
  }

  const refreshedRuntime = requireKnownRuntime(this.db, runtime.runtimeId)
  const existingOperation = this.runtimeAttachOperations.get(refreshedRuntime.runtimeId)
  if (existingOperation) {
    return await existingOperation
  }

  const operation = (async () => {
    const latestRuntime = await this.reconcileTmuxRuntimeLiveness(
      requireKnownRuntime(this.db, refreshedRuntime.runtimeId)
    )

    // Attachment consumes the already-realized execution. It never reconstructs
    // an interactive intent or replaces the runtime from historical request
    // fields; a v1 retained tmux runtime remains attachable as evidence only.
    if (
      latestRuntime.controllerKind === 'harness-broker' &&
      !isRuntimeUnavailableStatus(latestRuntime.status) &&
      latestRuntime.status !== 'failed'
    ) {
      return this.attachRuntime(latestRuntime)
    }
    if (latestRuntime.transport === 'tmux' && !isRuntimeUnavailableStatus(latestRuntime.status)) {
      return this.attachRuntime(latestRuntime, { allowLegacyTmuxAttach: true })
    }
    throw new HrcRuntimeUnavailableError('runtime cannot be attached without replacing it', {
      runtimeId: latestRuntime.runtimeId,
      hostSessionId: latestRuntime.hostSessionId,
      controllerKind: latestRuntime.controllerKind,
      transport: latestRuntime.transport,
      replacementRequired: true,
      ...(options.strictRuntimeId === true ? { strictRuntimeId: true } : {}),
    })
  })().finally(() => {
    this.runtimeAttachOperations.delete(refreshedRuntime.runtimeId)
  })

  this.runtimeAttachOperations.set(refreshedRuntime.runtimeId, operation)
  return await operation
}

export const runtimeIoHandlersMethods = {
  captureRuntime,
  reconcileTmuxRuntimeLiveness,
  startRuntimeForSession,
  selectInteractiveTmuxBrokerOptions,
  attachRuntime,
  attachRuntimeEffectfully,
}

export type RuntimeIoHandlersMethods = typeof runtimeIoHandlersMethods
