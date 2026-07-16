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
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  decideInteractiveTmuxBrokerStartRoute,
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxLeasedPaneId,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  isMatchingInteractiveTmuxBrokerRuntime,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
  toLatestRuntimeAdmissionView,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
import {
  canOperatorAttach,
  canUseDirectPaneFallback,
  hasLeasedBrokerSubstrate,
} from './broker/runtime-hosting.js'
import {
  requireGhosttySurface,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import { findLatestSessionRuntime, getReusableHeadlessRuntimeForSession } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { AttachBeforeInvocationStartOption, AttachDescriptorResponse } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
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
  const directPaneCapture = canUseDirectPaneFallback(runtime)
  if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty' && !directPaneCapture) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'cannot capture a non-interactive runtime; use the runtime event stream instead',
      {
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
      }
    )
  }

  let text: string
  if (runtime.transport === 'ghostty') {
    text = await this.ghostmux.capture(requireGhosttySurface(runtime).surfaceId)
  } else {
    const pane = requireTmuxPane(runtime)
    text = await this.tmuxForPane(pane).capture(pane.paneId)
  }

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

  return json({
    text,
  } satisfies CaptureResponse)
}

export async function reconcileTmuxRuntimeLiveness(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<HrcRuntimeSnapshot> {
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

  if (runtime.transport !== 'tmux' || isRuntimeUnavailableStatus(runtime.status)) {
    if (runtime.transport !== 'ghostty' || isRuntimeUnavailableStatus(runtime.status)) {
      return runtime
    }
    const surfaceId = runtime.surfaceJson?.['surfaceId']
    if (typeof surfaceId !== 'string') {
      return runtime
    }
    const inspected = await this.ghostmux.inspectSurface(surfaceId)
    if (inspected) {
      return runtime
    }

    markRuntimeDead(this.db, requireSession(this.db, runtime.hostSessionId), runtime, 'ghostty', {
      runtimeId: runtime.runtimeId,
      surfaceId,
      reason: 'ghostty_surface_missing',
    })

    return requireRuntime(this.db, runtime.runtimeId)
  }

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
    suppressHeadlessViewer?: boolean | undefined
  } = {}
): Promise<HrcRuntimeSnapshot> {
  const existingOperation = this.runtimeStartOperations.get(session.hostSessionId)
  if (existingOperation) {
    return await existingOperation
  }

  const operation = (async () => {
    let existingRuntime = findLatestSessionRuntime(this.db, session.hostSessionId)
    if (existingRuntime) {
      existingRuntime = await this.reconcileTmuxRuntimeLiveness(existingRuntime)
    }
    const startIntent =
      this.claudeCodeTmuxBrokerEnabled && shouldRedirectClaudeToInteractiveBroker(intent)
        ? normalizeClaudeInteractiveBrokerIntent(intent)
        : intent
    const normalizedIntent = normalizeRuntimeProvisionIntent(startIntent)
    const viewerSpawnOptions = {
      operatorAttachPending:
        options.attachBeforeInvocationStart !== undefined ||
        options.suppressHeadlessViewer === true,
    }
    if (shouldUseHeadlessTransport(startIntent)) {
      const now = timestamp()
      this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, now)

      // T-01757 (Wave C, A2): codex headless START provisions THROUGH the
      // HarnessBrokerController (parent acceptance: "Codex headless sessions
      // start through HarnessBrokerController") — never exec.ts. SDK start
      // still hard-fails; legacy-exec still fails closed.
      const headlessRoute = decideHeadlessExecutionRoute(startIntent, {
        brokerFlagEnabled: this.headlessCodexBrokerEnabled,
      })
      if (headlessRoute === 'broker') {
        const reusableBrokerRuntime = getReusableHeadlessRuntimeForSession(
          this.db,
          session.hostSessionId,
          startIntent.harness.provider,
          startIntent.harness.id
        )
        // Idempotent reuse ONLY for a real broker headless runtime that has a
        // continuation. A legacy (non-broker) or continuation-less runtime is
        // staled + reprovisioned through the broker, never returned as-is.
        if (
          reusableBrokerRuntime &&
          reusableBrokerRuntime.controllerKind === 'harness-broker' &&
          !isRuntimeUnavailableStatus(reusableBrokerRuntime.status) &&
          (reusableBrokerRuntime.continuation?.key ?? session.continuation?.key)
        ) {
          await this.spawnBrokerHeadlessViewer(reusableBrokerRuntime, viewerSpawnOptions)
          const initialPrompt = startIntent.initialPrompt ?? ''
          if (initialPrompt.length > 0) {
            await this.executeHeadlessBrokerInputTurn(
              session,
              reusableBrokerRuntime,
              initialPrompt,
              `run-${randomUUID()}`,
              { waitForCompletion: true }
            )
            return requireRuntime(this.db, reusableBrokerRuntime.runtimeId)
          }
          return reusableBrokerRuntime
        }
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
        const startRunId = `run-${randomUUID()}`
        const initialPrompt = startIntent.initialPrompt ?? ''
        const brokerRuntime = await this.startHeadlessBrokerRuntime(
          session,
          startIntent,
          initialPrompt,
          startRunId
        )
        await this.spawnBrokerHeadlessViewer(brokerRuntime, viewerSpawnOptions)
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
      const reusableRuntime = getReusableHeadlessRuntimeForSession(
        this.db,
        session.hostSessionId,
        startIntent.harness.provider,
        startIntent.harness.id
      )
      if (reusableRuntime && (reusableRuntime.continuation?.key ?? session.continuation?.key)) {
        return reusableRuntime
      }

      // Retired SDK and legacy CLI starts fail before allocating a runtime row.
      // Continuation-backed reuse above remains valid and does not allocate
      // anything.
      if (headlessRoute === 'sdk') {
        this.failSdkHarnessPath(
          'runHeadlessSdkStartLaunch',
          session,
          normalizedIntent,
          `run-${randomUUID()}`
        )
      }

      if (headlessRoute === 'legacy-exec') {
        this.failCliStartPath(
          'runHeadlessStartLaunch',
          session,
          normalizedIntent,
          `run-${randomUUID()}`
        )
      }

      const runtime =
        reusableRuntime ?? this.createHeadlessRuntimeForSession(session, normalizedIntent)
      if (runtime.continuation?.key ?? session.continuation?.key) {
        return requireRuntime(this.db, runtime.runtimeId)
      }

      return await this.runHeadlessStartLaunch(session, runtime, normalizedIntent)
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
        await this.spawnBrokerHeadlessViewer(existingRuntime, viewerSpawnOptions)
        return existingRuntime
      }
      if (existingRuntime && !isRuntimeUnavailableStatus(existingRuntime.status)) {
        this.markRuntimeStaleForBrokerReprovision(session, existingRuntime, {
          reason: 'interactive-broker-start-reprovision',
          allowedBrokerDriver: interactiveBrokerOptions.allowedBrokerDriver,
        })
      }

      // T-01757 (Wave C): the route is hardcoded 'broker', so the legacyTmux
      // closure was dead. Dropped — only the broker executor is reachable.
      const startRunId = `run-${randomUUID()}`
      const runtime = await runInteractiveTmuxRoute('broker', {
        broker: async () =>
          this.startInteractiveTmuxBrokerRuntime(session, normalizedIntent, startRunId, {
            ...interactiveBrokerOptions,
            ...(options.attachBeforeInvocationStart
              ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
              : {}),
          }),
      })
      await this.spawnBrokerHeadlessViewer(runtime, viewerSpawnOptions)
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
    // that used to follow (ensureRuntimeForSession + enqueueInteractiveStartLaunch
    // + a second runHeadlessStartLaunch) was provably unreachable and is removed.
    throw new HrcRuntimeUnavailableError('interactive runtime is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: normalizedIntent.harness.provider,
      harnessId: normalizedIntent.harness.id,
      route: 'interactive-broker',
    })
  })().finally(() => {
    this.runtimeStartOperations.delete(session.hostSessionId)
  })

  this.runtimeStartOperations.set(session.hostSessionId, operation)
  return await operation
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
    codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
    piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
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
        intent.harness.id === 'pi-cli'))
  )
}

export function attachRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  options: { allowLegacyOperatorAttach?: boolean } = {}
): Response {
  if (runtime.transport === 'ghostty' && options.allowLegacyOperatorAttach === true) {
    const surface = requireGhosttySurface(runtime)
    return json({
      transport: 'ghostty',
      argv: this.ghostmux.getAttachDescriptor(surface.surfaceId).argv,
      bindingFence: {
        hostSessionId: runtime.hostSessionId,
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        surfaceId: surface.surfaceId,
      },
    } satisfies AttachDescriptorResponse)
  }

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
      argv: [
        'tmux',
        '-S',
        socketPath,
        'attach-session',
        '-t',
        getBrokerRuntimeTmuxAttachTarget(runtime),
      ],
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
  if (options.allowLegacyOperatorAttach !== true) {
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

    const latestIntent =
      session.lastAppliedIntentJson ??
      ({
        placement: {
          agentRoot: process.cwd(),
          projectRoot: process.cwd(),
          cwd: process.cwd(),
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: latestRuntime.provider,
          interactive: true,
        },
        execution: {
          preferredMode: 'interactive',
        },
      } satisfies HrcRuntimeIntent)
    const interactiveIntent = {
      ...latestIntent,
      harness: {
        ...latestIntent.harness,
        interactive: true,
      },
      execution: {
        ...latestIntent.execution,
        preferredMode: 'interactive',
      },
    } satisfies HrcRuntimeIntent

    const admission = decideInteractiveBrokerAdmission(
      interactiveIntent,
      toLatestRuntimeAdmissionView(latestRuntime),
      {
        claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
        codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
        piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
      }
    )
    if (admission.decision === 'runtime-unavailable') {
      throw new HrcRuntimeUnavailableError(admission.reason, {
        runtimeId: latestRuntime.runtimeId,
        hostSessionId: latestRuntime.hostSessionId,
        route: 'interactive-broker-attach',
      })
    }
    if (admission.decision === 'broker-reuse') {
      return this.attachRuntime(latestRuntime)
    }
    if (options.strictRuntimeId === true) {
      throw new HrcRuntimeUnavailableError(
        'explicit runtime attach cannot reprovision to a different runtime',
        {
          runtimeId: latestRuntime.runtimeId,
          hostSessionId: latestRuntime.hostSessionId,
          admissionDecision: admission.decision,
          route: 'interactive-broker-attach-by-id',
        }
      )
    }
    if (admission.decision === 'stale-and-reprovision') {
      this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
        reason: 'attach-broker-reprovision',
        allowedBrokerDriver: admission.allowedBrokerDriver,
      })
    }

    const brokerRuntime = await this.startRuntimeForSession(
      session,
      interactiveIntent,
      'reuse_pty',
      {
        suppressHeadlessViewer: true,
      }
    )
    return this.attachRuntime(requireKnownRuntime(this.db, brokerRuntime.runtimeId))
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
