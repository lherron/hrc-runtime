import { HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
  rejectedBrokerAdoptionPaths,
} from '../broker/adoption-root.js'
import type { BrokerControllerAttachResult } from '../broker/controller.js'
import { hasRetainedProjection } from '../broker/runtime-exclusive-owner'
import {
  brokerLeaseIdentityMatches,
  parseBrokerRuntimeHostingState,
} from '../broker/runtime-hosting.js'
import { withDirectTmuxDegradedControlState } from '../broker/runtime-state.js'
import { isRunActive, requireSession } from '../require-helpers.js'
import { runtimeActivityPatch } from '../runtime-activity.js'
import { writeServerLog } from '../server-log.js'
import { timestamp } from '../server-util.js'
import { toBrokerLeaseProbe } from './broker-probe.js'
import {
  brokerTuiWindowMatches,
  clearBrokerRecovery,
  getPersistedDurableBrokerEndpoint,
  isBrokerRecoveryExhausted,
  markBrokerReattachStale,
  recordBrokerRecoveryFailure,
} from './lease-identity.js'
import { markRuntimeTerminatedAfterUserExit } from './runtime-mutations.js'
import type { BrokerReattachOutcome, DurableBrokerReattachDeps } from './types.js'

export async function reconcileDurableBrokerRuntimeReattach(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  deps: DurableBrokerReattachDeps
): Promise<BrokerReattachOutcome> {
  const runtimeId = runtime.runtimeId
  // T-08566: a runtime with committed retained projection is never probed,
  // classified, reattached or ACKed again, and this refusal writes nothing.
  if (hasRetainedProjection(db, runtimeId)) {
    return {
      runtimeId,
      state: 'stale',
      brokerAttached: false,
      reason: HrcErrorCode.RUNTIME_RETAINED_EVIDENCE_PROJECTED,
    }
  }
  const hosting = parseBrokerRuntimeHostingState(runtime)
  const brokerState = runtime.runtimeStateJson?.['broker']
  const brokerRecord =
    typeof brokerState === 'object' && brokerState !== null
      ? (brokerState as Record<string, unknown>)
      : undefined
  const reattachStartedAt = performance.now()
  let previousPhaseAt = reattachStartedAt
  const phase = (name: string, fields: Record<string, unknown> = {}): void => {
    const now = performance.now()
    writeServerLog('INFO', 'broker.reattach.phase', {
      phase: name,
      runtimeId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      invocationId: runtime.activeInvocationId,
      ...(hosting?.endpoint.kind === 'unix-jsonrpc-ndjson'
        ? { endpointSocketPath: hosting.endpoint.socketPath }
        : {}),
      ...(hosting?.substrate.kind === 'leased-tmux'
        ? {
            leaseTmuxSocketPath: hosting.substrate.tmuxSocketPath,
            leaseSessionName: hosting.substrate.sessionName,
            leaseSessionId: hosting.substrate.brokerWindow.sessionId,
            leaseBrokerWindowId: hosting.substrate.brokerWindow.windowId,
            leaseBrokerPaneId: hosting.substrate.brokerWindow.paneId,
          }
        : {}),
      ...(typeof brokerRecord?.['brokerPid'] === 'number'
        ? { persistedBrokerPid: brokerRecord['brokerPid'] }
        : {}),
      phaseElapsedMs: Number((now - previousPhaseAt).toFixed(1)),
      totalElapsedMs: Number((now - reattachStartedAt).toFixed(1)),
      ...fields,
    })
    previousPhaseAt = now
  }

  const rejectedPaths = rejectedBrokerAdoptionPaths(runtime, deps.runtimeRoot)
  if (rejectedPaths.length > 0) {
    phase('adoption-path-rejected', {
      finalCategory: BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
      runtimeRoot: deps.runtimeRoot,
      rejectedPaths,
    })
    writeServerLog('WARN', 'broker.adoption.path_rejected', {
      runtimeId,
      runtimeRoot: deps.runtimeRoot,
      rejectedPaths,
      reason: BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
    })
    return markBrokerReattachStale(db, runtime, BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT)
  }

  phase('lease-probe.begin')
  const probe = await deps.probeBrokerLease(runtime)
  phase('lease-probe.complete', {
    brokerSocketLive: probe.brokerSocketLive,
    brokerHealth: probe.brokerHealth,
    observedBrokerSessionId: probe.brokerWindow?.sessionId,
    observedBrokerWindowId: probe.brokerWindow?.windowId,
    observedBrokerPaneId: probe.brokerWindow?.paneId,
    observedTuiSessionId: probe.tuiWindow?.sessionId,
    observedTuiWindowId: probe.tuiWindow?.windowId,
    observedTuiPaneId: probe.tuiWindow?.paneId,
    observedObserverSessionId: probe.observerWindow?.sessionId,
    observedObserverWindowId: probe.observerWindow?.windowId,
    observedObserverPaneId: probe.observerWindow?.paneId,
  })

  // A draining broker is NOT dead — observe and decline to bind (the shutdown-
  // intent / graceful-exit path owns lease reap; the probe must never initiate
  // cleanup). Skip before any stale classification so a normal shutdown does not
  // look like a lease fault.
  if (probe.brokerHealth === 'shutting_down') {
    return {
      runtimeId,
      state: 'broker-shutting-down',
      brokerAttached: false,
      reason: 'broker_shutting_down',
    }
  }

  if (probe.brokerSocketLive) {
    const endpoint = getPersistedDurableBrokerEndpoint(runtime)
    if (!endpoint) {
      return markBrokerReattachStale(db, runtime, 'missing_durable_broker_endpoint')
    }
    // G4: verify the live lease identity via the hosting-state model — brokerWindow
    // for EVERY leased substrate, tuiWindow ONLY when presentation=tmux-tui. Handles
    // both the flat and normalized persisted shapes through the choke-point parser.
    const leaseProbe = toBrokerLeaseProbe(probe)
    if (!leaseProbe || !brokerLeaseIdentityMatches(runtime, leaseProbe)) {
      return markBrokerReattachStale(db, runtime, 'broker_lease_identity_mismatch')
    }
    clearBrokerRecovery(db, runtime)

    // Single attach authority: the pre-instance reconcile pass runs with
    // attach:false and stops here once it has confirmed the runtime is live and
    // its lease identity valid — it leaves the runtime intact (`broker-attachable`)
    // for the request-serving controller's warmup to bind. Only the serving warm
    // (attach:true) performs attach+replay.
    if (deps.attach === false) {
      phase('classified-attachable', { finalCategory: 'broker-attachable' })
      return { runtimeId, state: 'broker-attachable', brokerAttached: false }
    }

    phase('attach-token.begin')
    const attachToken = await deps.resolveAttachToken(runtime)
    if (!attachToken) {
      phase('attach-token.failed', { finalCategory: 'broker_attach_token_missing' })
      return markBrokerReattachStale(db, runtime, 'broker_attach_token_missing')
    }
    phase('attach-token.complete', { tokenResolved: true })

    let result: BrokerControllerAttachResult
    try {
      phase('unix-connect.begin', { endpointSocketPath: endpoint.socketPath })
      const client = await deps.brokerUnixClientFactory({ socketPath: endpoint.socketPath })
      phase('unix-connect.complete', { endpointSocketPath: endpoint.socketPath })
      phase('attach-replay-control.begin')
      result = await deps.controller.attachAndReplay({
        runtimeId,
        client,
        attachToken,
      })
      phase('attach-replay-control.complete', {
        ok: result.ok,
        ...(result.ok
          ? {
              replayedThroughSeq: result.replayedThroughSeq,
              ackedThroughSeq: result.ackedThroughSeq,
            }
          : { errorCode: result.error.code }),
      })
    } catch (error) {
      phase('attach-replay-control.failed', {
        finalCategory: 'broker_attach_replay_failed',
        error: error instanceof Error ? error.message : String(error),
      })
      const failed = recordBrokerRecoveryFailure(db, runtime, 'broker_attach_replay_failed')
      if (isBrokerRecoveryExhausted(failed)) {
        return markBrokerReattachStale(db, failed, 'broker_attach_replay_failed', error)
      }
      return {
        runtimeId,
        state: 'broker-ipc-unavailable',
        brokerAttached: false,
        reason: 'broker_attach_replay_failed_recoverable',
      }
    }

    if (!result.ok) {
      // G6: a retention gap is terminal for the in-flight run. Surface the spec
      // reason (broker_event_retention_gap) and explicitly fail the active run so
      // a subsequent zombie sweep cannot race it (attachAndReplay's failReplayStale
      // stales the runtime but leaves the run untouched).
      if (result.error.code === 'broker_replay_retention_gap') {
        phase('failed', { finalCategory: 'broker_event_retention_gap' })
        return markBrokerReattachStale(db, runtime, 'broker_event_retention_gap')
      }
      phase('failed', { finalCategory: result.error.code })
      return {
        runtimeId,
        state: 'stale',
        brokerAttached: false,
        reason: result.error.code,
      }
    }

    // G6: a successful attach + replay proves the in-flight run is live. Refresh
    // its activity timestamp so the zombie sweep leaves the recovered run alone.
    if (runtime.activeRunId !== undefined) {
      const activeRun = db.runs.getByRunId(runtime.activeRunId)
      if (activeRun && isRunActive(activeRun)) {
        db.runs.update(runtime.activeRunId, { updatedAt: timestamp() })
      }
    }

    phase('attached', {
      finalCategory: 'broker-attached',
      replayedThroughSeq: result.replayedThroughSeq,
    })
    clearBrokerRecovery(db, runtime)
    return {
      runtimeId,
      state: 'broker-attached',
      brokerAttached: true,
      replayedThroughSeq: result.replayedThroughSeq,
    }
  }

  if (probe.userExited === true && !probe.brokerWindow && !probe.tuiWindow) {
    const session = requireSession(db, runtime.hostSessionId)
    markRuntimeTerminatedAfterUserExit(db, session, runtime, {
      runtimeId,
      reason: 'broker_runtime_user_exited_while_down',
      userExitReason: 'reconcile_probe_user_exited',
    })
    return { runtimeId, state: 'terminated', brokerAttached: false, reason: 'user_exited' }
  }

  if (brokerTuiWindowMatches(runtime, probe.tuiWindow)) {
    const now = timestamp()
    db.runtimes.update(runtimeId, {
      runtimeStateJson: {
        ...withDirectTmuxDegradedControlState(runtime.runtimeStateJson),
        status: runtime.status,
        updatedAt: now,
      },
      ...runtimeActivityPatch(db, runtimeId, { source: 'housekeeping', updatedAt: now }),
    })
    return {
      runtimeId,
      state: 'direct-tmux-degraded',
      brokerAttached: false,
      reason: 'broker_socket_unavailable_tui_live',
    }
  }

  // T-01875 G5: a durable HEADLESS runtime (leased substrate, presentation=none)
  // has no operator TUI degraded fallback. Do NOT tear it down just because its
  // broker IPC socket was unreachable in this startup probe — the leased tmux
  // substrate may still host a live broker, and the next dispatch lazily reattaches
  // (reattachDurableBrokerForDispatch). Leave the runtime intact so it keeps
  // CLAIMING its lease (the orphan sweeper still reaps genuinely dead/leaked
  // leases that no non-terminal runtime references).
  //
  // T-04297: that nonterminal bet is only sound while the leased substrate is
  // OBSERVABLY alive — i.e. the probe saw the lease's 'broker' window. When the
  // lease tmux server/window is gone (probe.brokerWindow === null, e.g. a host
  // reboot killed every tmux server), no broker can be hosted there and reattach
  // can NEVER succeed (even a live socket without a window fails
  // broker_lease_identity_mismatch). Leaving such a runtime `ready` produced the
  // perpetual "headless broker connection was not live" zombie loop. Stale it so
  // the next dispatch reprovisions a fresh broker on the SAME session via the
  // reattach-failed branch in handleHeadlessBrokerDispatchTurn.
  if (hosting?.substrate.kind === 'leased-tmux' && hosting.presentation.kind === 'none') {
    if (probe.brokerWindow) {
      const leaseProbe = toBrokerLeaseProbe(probe)
      if (!leaseProbe || !brokerLeaseIdentityMatches(runtime, leaseProbe)) {
        return markBrokerReattachStale(db, runtime, 'broker_lease_identity_mismatch')
      }
      const failed = recordBrokerRecoveryFailure(db, runtime, 'broker_ipc_unavailable')
      if (isBrokerRecoveryExhausted(failed)) {
        return markBrokerReattachStale(db, failed, 'broker_recovery_budget_exhausted')
      }
      return {
        runtimeId,
        state: 'broker-ipc-unavailable',
        brokerAttached: false,
        reason: 'broker_ipc_unavailable',
      }
    }
    return markBrokerReattachStale(db, runtime, 'broker_lease_substrate_gone')
  }

  return markBrokerReattachStale(db, runtime, 'broker_socket_and_tui_unavailable')
}
