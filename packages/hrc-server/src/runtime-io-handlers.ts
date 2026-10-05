import { setTimeout as delay } from 'node:timers/promises'

import { HrcBadRequestError, HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type { CaptureResponse, HrcRuntimeSnapshot } from 'hrc-core'
import {
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxLeasedPaneId,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import {
  canOperatorAttach,
  getBrokerPresentationPane,
  hasLeasedBrokerSubstrate,
} from './broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import {
  requireKnownRuntime,
  requireRuntime,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { AttachDescriptorResponse } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import {
  findPersistedLifecycleTerminalReason,
  findUserInitiatedContinuationClearReason,
  getObservedTmuxSessionName,
  markRuntimeDead,
  markRuntimeStale,
  markRuntimeTerminatedAfterUserExit,
} from './startup-reconcile.js'
import { type TmuxManager, createTmuxManager } from './tmux.js'

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
      markBrokerRuntimeNotLive(this, runtime, {
        runtimeId: runtime.runtimeId,
        reason: 'broker_tmux_socket_missing',
      })
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

      markBrokerRuntimeNotLive(this, runtime, {
        runtimeId: runtime.runtimeId,
        sessionName,
        socketPath,
        paneId: inspected.paneId,
        paneDead: liveness?.dead ?? null,
        paneCommand: liveness?.currentCommand ?? null,
        reason: 'broker_tmux_harness_not_live',
      })
      await killBrokerLeaseServer(brokerTmux, 'failed to remove stale broker tmux lease server', {
        runtimeId: runtime.runtimeId,
        sessionName,
        socketPath,
        reason: 'broker_tmux_harness_not_live',
      })
      return requireKnownRuntime(this.db, runtime.runtimeId)
    }

    const payload = {
      runtimeId: runtime.runtimeId,
      sessionName,
      socketPath,
      reason: 'broker_tmux_session_missing',
    }
    markBrokerRuntimeNotLive(this, runtime, payload)
    await killBrokerLeaseServer(
      brokerTmux,
      'failed to remove missing broker tmux lease server',
      payload
    )
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

/**
 * A broker runtime whose lease is gone or whose harness is not live: terminated
 * when the user ended it (continuation cleared), otherwise stale.
 */
function markBrokerRuntimeNotLive(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  payload: Record<string, unknown>
): void {
  const session = requireSession(server.db, runtime.hostSessionId)
  const userExitReason = findUserInitiatedContinuationClearReason(server.db, runtime)
  const event =
    userExitReason !== undefined
      ? markRuntimeTerminatedAfterUserExit(server.db, session, runtime, {
          ...payload,
          userExitReason,
        })
      : markRuntimeStale(server.db, session, runtime, payload)
  server.notifyEvent(event)
}

async function killBrokerLeaseServer(
  brokerTmux: TmuxManager,
  failureMessage: string,
  logFields: Record<string, unknown>
): Promise<void> {
  await brokerTmux.killServer().catch((error) => {
    writeServerLog('WARN', failureMessage, {
      ...logFields,
      error: error instanceof Error ? error.message : String(error),
    })
  })
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
  attachRuntime,
  attachRuntimeEffectfully,
}

export type RuntimeIoHandlersMethods = typeof runtimeIoHandlersMethods
