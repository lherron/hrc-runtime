import { HrcErrorCode } from 'hrc-core'
import type {
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  decideLegacyRuntimeStartupDisposition,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import type {
  BrokerControllerAttachResult,
  BrokerUnixClientFactory,
  HarnessBrokerController,
} from './broker/controller.js'
import {
  brokerLeaseIdentityMatches,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
} from './broker/runtime-hosting.js'
import {
  extractRuntimeControlState,
  withDirectTmuxDegradedControlState,
} from './broker/runtime-state.js'
import type { GhostmuxManager as ServerGhostmuxManager } from './ghostmux.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { isRunActive, requireSession } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import { isLiveProcess } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import {
  probePersistedBrokerLease,
  resolvePersistedBrokerAttachToken,
  toBrokerLeaseProbe,
} from './startup-reconcile/broker-probe.js'
import {
  brokerTuiWindowMatches,
  emitBrokerTmuxReassociated,
  gcBrokerRuntimeOnRestart,
  getPersistedDurableBrokerEndpoint,
  markBrokerReattachStale,
  reassociateBrokerTmuxLease,
  sweepOrphanedBrokerTmuxLeases,
} from './startup-reconcile/lease-identity.js'
import {
  getObservedTmuxSessionName,
  logStartupIssue,
  markRuntimeDead,
  markRuntimeStale,
  markRuntimeTerminatedAfterUserExit,
} from './startup-reconcile/runtime-mutations.js'
import {
  DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS,
  HRC_REAPED_RUN_ERROR_MESSAGE,
} from './startup-reconcile/types.js'
import type {
  BrokerReattachOutcome,
  BrokerReattachProbe,
  BrokerWarmupCategory,
  BrokerWarmupSummary,
  DurableBrokerReattachDeps,
} from './startup-reconcile/types.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'

export type {
  BrokerHealthState,
  BrokerReattachProbe,
  DurableBrokerReattachDeps,
  BrokerReattachOutcome,
  BrokerWindowObservation,
  BrokerWarmupCategory,
  BrokerWarmupSummary,
} from './startup-reconcile/types.js'
export {
  appendMissingHeadlessTurnCompleted,
  getObservedTmuxSessionName,
  markRuntimeDead,
  markRuntimeStale,
  findUserInitiatedContinuationClearReason,
  findPersistedLifecycleTerminalReason,
  markRuntimeTerminatedAfterUserExit,
  logStartupIssue,
} from './startup-reconcile/runtime-mutations.js'
export {
  sweepOrphanedBrokerTmuxLeases,
  reassociateBrokerTmuxLease,
  reassociateBrokerTmuxWindows,
  brokerLeaseWindowsMatch,
  brokerLeaseIdsMatch,
} from './startup-reconcile/lease-identity.js'

export async function reconcileStartupState(
  db: HrcDatabase,
  tmux: ServerTmuxManager,
  ghostmux: ServerGhostmuxManager,
  options: { reconcileGhostty: boolean; runtimeRoot: string }
): Promise<void> {
  for (const launch of db.launches.listAll()) {
    if (!isOrphanableLaunchStatus(launch.status)) {
      continue
    }

    try {
      const trackedPid = getTrackedLaunchPid(launch)
      if (trackedPid === undefined || isLiveProcess(trackedPid)) {
        continue
      }

      const session = requireSession(db, launch.hostSessionId)
      const now = timestamp()
      const runtime = launch.runtimeId ? db.runtimes.getByRuntimeId(launch.runtimeId) : null
      const activeRunId = runtime?.activeRunId
      db.launches.update(launch.launchId, {
        status: 'orphaned',
        updatedAt: now,
      })
      appendHrcEvent(db, 'launch.orphaned', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: launch.runtimeId,
        runId: activeRunId,
        launchId: launch.launchId,
        payload: {
          pid: trackedPid,
          priorStatus: launch.status,
        },
      })
      if (runtime?.transport === 'headless' && activeRunId) {
        reapStartupHeadlessOrphan(db, session, runtime, launch, activeRunId, now)
      }
    } catch (error) {
      logStartupIssue('launch reconciliation failed', { launchId: launch.launchId }, error)
    }
  }

  for (const runtime of db.runtimes.listAll()) {
    const brokerTmuxLeaseRuntime =
      runtime.controllerKind === 'harness-broker' && hasLeasedBrokerSubstrate(runtime)
    if (
      (runtime.transport !== 'tmux' &&
        runtime.transport !== 'ghostty' &&
        !brokerTmuxLeaseRuntime) ||
      runtime.status === 'terminated' ||
      runtime.status === 'dead'
    ) {
      continue
    }

    // Broker-tmux runtimes own a tmux server on a per-runtime LEASE socket, not
    // the default `tmux` server this generic block inspects. They are reconciled
    // by the dedicated broker pass below (lease-socket inspect + id-match
    // re-associate), so skip them here to avoid a false "session missing" death.
    if (
      runtime.controllerKind === 'harness-broker' &&
      (runtime.transport === 'tmux' || brokerTmuxLeaseRuntime)
    ) {
      continue
    }

    try {
      const runtimeLaunches = db.launches.listByRuntimeId(runtime.runtimeId)
      const currentRuntimeLaunches = runtimeLaunches.filter(
        (launch) =>
          launch.hostSessionId === runtime.hostSessionId && launch.generation === runtime.generation
      )
      const launchBecameOrphaned =
        currentRuntimeLaunches.length > 0 &&
        currentRuntimeLaunches.every((launch) => launch.status === 'orphaned') &&
        (runtime.launchId === undefined ||
          currentRuntimeLaunches.some((launch) => launch.launchId === runtime.launchId))
      if (launchBecameOrphaned) {
        markRuntimeStale(db, requireSession(db, runtime.hostSessionId), runtime, {
          runtimeId: runtime.runtimeId,
          reason: 'launch_orphaned',
          priorStatus: runtime.status,
          ...(runtime.launchId ? { launchId: runtime.launchId } : {}),
        })
        continue
      }

      if (runtime.transport === 'ghostty') {
        if (!options.reconcileGhostty) {
          continue
        }
        const surfaceId = runtime.surfaceJson?.['surfaceId']
        if (typeof surfaceId !== 'string') {
          continue
        }

        const inspected = await ghostmux.inspectSurface(surfaceId)
        if (inspected) {
          continue
        }

        markRuntimeDead(db, requireSession(db, runtime.hostSessionId), runtime, 'ghostty', {
          runtimeId: runtime.runtimeId,
          surfaceId,
          reason: 'ghostty_surface_missing',
        })
      } else {
        const tmuxSessionName = getObservedTmuxSessionName(runtime)
        if (!tmuxSessionName) {
          continue
        }

        const inspected = await tmux.inspectSession(tmuxSessionName)
        if (inspected) {
          continue
        }

        markRuntimeDead(db, requireSession(db, runtime.hostSessionId), runtime, 'tmux', {
          runtimeId: runtime.runtimeId,
          sessionName: tmuxSessionName,
          reason: 'tmux_session_missing',
        })
      }
    } catch (error) {
      logStartupIssue('runtime reconciliation failed', { runtimeId: runtime.runtimeId }, error)
    }
  }

  await reconcileDurableBrokerStartup(db, {
    // ───────────────────────────────────────────────────────────────────────
    // INVARIANT (T-01996) — SINGLE ATTACH AUTHORITY. DO NOT REINTRODUCE A
    // THROWAWAY-CONTROLLER ATTACH HERE.
    //
    // This pre-instance pass runs BEFORE the HrcServerInstance (and its
    // request-serving controller) exists — index.ts constructs the instance
    // AFTER reconcileStartupState returns, and the serving controller cannot be
    // built earlier because its event mapper closes over `this.notifyEvent`.
    // Therefore this pass must do CLASSIFICATION/orphan work ONLY (attach:false):
    // it stales genuinely-dead/legacy runtimes and leaves live durable ones
    // intact (`broker-attachable`) for the serving controller's post-construction
    // warmup (warmDurableBrokerBindings) to bind. That warmup is the ONLY
    // attach+replay authority.
    //
    // History: this pass used to attach+replay onto a `new HarnessBrokerController`
    // throwaway whose in-memory binding was discarded and whose event projection
    // had no notifyEvent loop — producing fencing churn AND the cold-serving-
    // controller race that surfaced as spurious `broker_runtime_not_active` (the
    // "retry fixes it" failure). If you ever pass a real controller + attach:true
    // here, you will resurrect both bugs. The stub controller below makes the
    // invariant enforceable: it throws if anything attempts attach under
    // attach:false.
    // ───────────────────────────────────────────────────────────────────────
    attach: false,
    controller: {
      attachAndReplay: () => {
        throw new Error('attachAndReplay called during attach:false classification pass')
      },
    } as Pick<HarnessBrokerController, 'attachAndReplay'>,
    brokerUnixClientFactory: (options) =>
      BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>,
    resolveAttachToken: resolvePersistedBrokerAttachToken,
    probeBrokerLease: probePersistedBrokerLease,
    sweepOrphans: async () => undefined,
  })

  // T-01875 G3: the durable endpoint/substrate-driven pass above
  // (reconcileDurableBrokerStartup) is the SINGLE CLASSIFICATION authority for
  // every harness-broker runtime that carries a parseable broker hosting state —
  // it classify-once-stales the legacy/v0.1 ones with a precise reason and (as of
  // T-01996) leaves the LIVE durable ones intact (`broker-attachable`) WITHOUT
  // attaching. Attach+replay onto the request-serving controller is now owned
  // solely by the post-construction serving warmup (HrcServerInstance), so this
  // pass no longer binds onto a throwaway controller. The blanket
  // `broker_orphaned_on_restart` GC loop (and its headless fallthrough) is GONE:
  // a durable runtime classified above must NEVER fall through to an orphan
  // path, so this loop SKIPS durable runtimes outright.
  //
  // What remains here is the PRE-DURABLE broker-tmux lease path: legacy
  // harness-broker runtimes whose lease lives in the old `tmuxJson` shape (no
  // `runtime_state_json.broker` hosting state at all). Those tmux servers outlive
  // the daemon, so on restart re-scan the LEASE socket and id-match RE-ASSOCIATE
  // (leave usable + invocation intact) or GC on mismatch. (T-01711 / T-01730)
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker' || isRuntimeUnavailableStatus(runtime.status)) {
      continue
    }
    // Durable runtimes are reconciled by reconcileDurableBrokerStartup above.
    // Skipping them here closes the G3 trap (a reattached durable runtime must
    // not then hit a transport-driven orphan/stale path).
    if (hasDurableBrokerEndpoint(runtime) && hasLeasedBrokerSubstrate(runtime)) {
      continue
    }
    try {
      // Legacy broker-tmux lease persisted in the pre-durable tmuxJson shape
      // (no parseable broker hosting state). Runtimes WITH a parseable hosting
      // state but no durable endpoint (v0.1 stdio / daemon-child) were already
      // classified+staled above, so they are isRuntimeUnavailableStatus here and
      // never reach this branch.
      if (runtime.transport === 'tmux' && parseBrokerRuntimeHostingState(runtime) === undefined) {
        const control = extractRuntimeControlState(runtime.runtimeStateJson)
        if (control?.mode === 'direct-tmux-degraded') {
          continue
        }
        if (await reassociateBrokerTmuxLease(runtime)) {
          emitBrokerTmuxReassociated(db, runtime)
          continue
        }
        gcBrokerRuntimeOnRestart(db, runtime, 'broker_tmux_lease_stale_on_restart')
      }
    } catch (error) {
      logStartupIssue(
        'broker runtime reconciliation failed',
        { runtimeId: runtime.runtimeId },
        error
      )
    }
  }

  // After re-associating persisted leases, sweep orphaned broker-tmux lease
  // servers — a crash BETWEEN tmux allocate and the runtime-persist write leaks
  // a lease server on a per-runtime socket under `<runtimeRoot>/btmux/` whose
  // `hrc-<driver>-<runtimeId>` session no DB runtime references. The re-associate
  // pass only walks persisted runtimes, so it can never reclaim such a leak.
  // (C-02889 / T-01730 GAP 1)
  await sweepOrphanedBrokerTmuxLeases(db, options.runtimeRoot, {
    graceMs: resolveBrokerOrphanSweepGraceMs(),
    removeDeadSocketFiles: true,
    killLiveLeaseServers: true,
  })

  // T-01760 (Wave C): legacy runtime sweep. The broker passes above
  // reassociate/GC harness-broker runtimes; this final pass stales any still
  // reusable LEGACY runtime (controllerKind unset OR != 'harness-broker') so it
  // can never be reused for a harness turn. The pure decision NEVER stales a
  // harness-broker runtime (preserved regardless of socket path VALUE) and
  // no-ops anything already unavailable, so broker tmux leases + attach
  // descriptors survive. (C-03008 landmine.)
  for (const runtime of db.runtimes.listAll()) {
    try {
      const decision = decideLegacyRuntimeStartupDisposition({
        controllerKind: runtime.controllerKind,
        transport: runtime.transport,
        status: runtime.status,
        brokerTmuxSocketPath: getBrokerRuntimeTmuxSocketPath(runtime),
        hasAttachDescriptor: runtime.surfaceJson !== undefined || runtime.tmuxJson !== undefined,
      })
      if (decision.disposition !== 'stale') {
        continue
      }
      markRuntimeStale(db, requireSession(db, runtime.hostSessionId), runtime, {
        runtimeId: runtime.runtimeId,
        reason: decision.reason,
        priorStatus: runtime.status,
        sweep: 'legacy_startup_reconciliation',
        ...(runtime.launchId ? { launchId: runtime.launchId } : {}),
      })
    } catch (error) {
      logStartupIssue('legacy runtime sweep failed', { runtimeId: runtime.runtimeId }, error)
    }
  }
}

export async function reconcileDurableBrokerRuntimeReattach(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  deps: DurableBrokerReattachDeps
): Promise<BrokerReattachOutcome> {
  const probe = await deps.probeBrokerLease(runtime)
  const runtimeId = runtime.runtimeId

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

    // Single attach authority: the pre-instance reconcile pass runs with
    // attach:false and stops here once it has confirmed the runtime is live and
    // its lease identity valid — it leaves the runtime intact (`broker-attachable`)
    // for the request-serving controller's warmup to bind. Only the serving warm
    // (attach:true) performs attach+replay.
    if (deps.attach === false) {
      return { runtimeId, state: 'broker-attachable', brokerAttached: false }
    }

    const attachToken = await deps.resolveAttachToken(runtime)
    if (!attachToken) {
      return markBrokerReattachStale(db, runtime, 'broker_attach_token_missing')
    }

    let result: BrokerControllerAttachResult
    try {
      const client = await deps.brokerUnixClientFactory({ socketPath: endpoint.socketPath })
      result = await deps.controller.attachAndReplay({
        runtimeId,
        client,
        attachToken,
      })
    } catch (error) {
      return markBrokerReattachStale(db, runtime, 'broker_attach_replay_failed', error)
    }

    if (!result.ok) {
      // G6: a retention gap is terminal for the in-flight run. Surface the spec
      // reason (broker_event_retention_gap) and explicitly fail the active run so
      // a subsequent zombie sweep cannot race it (attachAndReplay's failReplayStale
      // stales the runtime but leaves the run untouched).
      if (result.error.code === 'broker_replay_retention_gap') {
        return markBrokerReattachStale(db, runtime, 'broker_event_retention_gap')
      }
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
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux' && hosting.presentation.kind === 'none') {
    if (probe.brokerWindow) {
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

export async function reconcileDurableBrokerStartup(
  db: HrcDatabase,
  deps: DurableBrokerReattachDeps & { sweepOrphans(): Promise<void> }
): Promise<BrokerReattachOutcome[]> {
  const outcomes: BrokerReattachOutcome[] = []
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker' || isRuntimeUnavailableStatus(runtime.status)) {
      continue
    }
    const hosting = parseBrokerRuntimeHostingState(runtime)

    // Durable runtime: unix endpoint + leased-tmux substrate → reattach over IPC.
    // Keyed off the parsed hosting state, NOT runtime.transport — headless and
    // interactive durable runtimes both flow through here (G3).
    if (
      hosting?.endpoint.kind === 'unix-jsonrpc-ndjson' &&
      hosting.substrate.kind === 'leased-tmux'
    ) {
      outcomes.push(await reconcileDurableBrokerRuntimeReattach(db, runtime, deps))
      continue
    }

    // Pre-durable broker-tmux lease (no parseable broker hosting state, but a
    // legacy tmuxJson lease socket): leave it to the lease id-match re-associate
    // pass in reconcileStartupState. Do NOT classify-stale it here.
    if (!hosting && runtime.transport === 'tmux' && getBrokerRuntimeTmuxSocketPath(runtime)) {
      continue
    }

    // Classify-once with Q5 precedence: a v0.1 (stdio) endpoint is unsupported on
    // startup; anything else lacking a durable endpoint is a legacy daemon-child.
    const reason =
      hosting?.endpoint.kind === 'stdio-jsonrpc-ndjson'
        ? 'broker_protocol_legacy_unsupported_on_startup'
        : 'broker_legacy_no_durable_endpoint_on_restart'
    gcBrokerRuntimeOnRestart(db, runtime, reason)
    outcomes.push({
      runtimeId: runtime.runtimeId,
      state: 'stale',
      brokerAttached: false,
      reason,
    })
  }
  await deps.sweepOrphans()
  return outcomes
}

/**
 * T-01801: LAZY IPC re-attach for the DISPATCH path. A durable broker that
 * survived a daemon restart has live broker state and a re-associated tmux lease,
 * but the request-serving `HarnessBrokerController` is rebuilt fresh on boot and
 * holds NO in-memory active client — startup reconciliation does its attach on a
 * SEPARATE controller instance (it runs before the server instance, hence the
 * request-serving controller, exists). The first input therefore fails
 * `broker_runtime_not_active`. Re-attach the persisted durable endpoint onto the
 * REQUEST-SERVING controller passed in here, so the caller can retry the dispatch
 * on the SAME broker (continuity, no re-alloc). Returns true iff the controller
 * is now broker-attached. No-ops to false for a runtime with no persisted durable
 * IPC endpoint, so the caller falls back to legacy pane-lease reassociation.
 */
export async function reattachDurableBrokerForDispatch(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  deps: {
    controller: Pick<HarnessBrokerController, 'attachAndReplay'>
    brokerUnixClientFactory: BrokerUnixClientFactory
    // Default to the persisted-state probe/token resolvers (production). Tests
    // script these to avoid touching a live socket / on-disk attach token.
    resolveAttachToken?: (runtime: HrcRuntimeSnapshot) => Promise<string | undefined>
    probeBrokerLease?: (runtime: HrcRuntimeSnapshot) => Promise<BrokerReattachProbe>
  }
): Promise<boolean> {
  if (!getPersistedDurableBrokerEndpoint(runtime)) {
    return false
  }
  const outcome = await reconcileDurableBrokerRuntimeReattach(db, runtime, {
    controller: deps.controller,
    brokerUnixClientFactory: deps.brokerUnixClientFactory,
    resolveAttachToken: deps.resolveAttachToken ?? resolvePersistedBrokerAttachToken,
    probeBrokerLease: deps.probeBrokerLease ?? probePersistedBrokerLease,
  })
  return outcome.state === 'broker-attached'
}

function warmupCategory(outcome: BrokerReattachOutcome): BrokerWarmupCategory {
  switch (outcome.state) {
    case 'broker-attached':
      return 'attached'
    case 'broker-shutting-down':
      return 'skipped_shutting_down'
    case 'broker-ipc-unavailable':
    case 'direct-tmux-degraded':
      return 'ipc_unreachable_nonterminal'
    case 'terminated':
      return 'terminated'
    case 'stale':
      if (outcome.reason === 'broker_lease_substrate_gone') {
        // T-04297: reboot-reaped durable headless runtimes (lease tmux gone) get
        // their own bucket so `broker.warmup.complete` separates them from
        // lease-identity stales.
        return 'substrate_gone_stale'
      }
      return outcome.reason === 'broker_attach_replay_failed' ||
        outcome.reason === 'broker_replay_retention_gap' ||
        outcome.reason === 'broker_event_retention_gap'
        ? 'attach_replay_failed'
        : 'lease_identity_invalid_stale'
    default:
      return 'other'
  }
}

/**
 * T-01996: warm the REQUEST-SERVING controller after the HrcServerInstance is
 * constructed. This is the SINGLE attach+replay authority — the pre-instance
 * reconcile pass only classifies (attach:false). Binding here, on the controller
 * that owns the live `notifyEvent` loop, means the first dispatch after a restart
 * finds its broker already bound instead of racing a cold controller.
 *
 * Bounded and single-flight by construction (called once from the constructor).
 * Never dispatches. Per-runtime outcomes are logged with a stable category so an
 * operator can see the control loop if the intermittent failure reappears.
 */
export async function warmDurableBrokerBindings(
  db: HrcDatabase,
  deps: {
    controller: Pick<HarnessBrokerController, 'attachAndReplay'>
    brokerUnixClientFactory?: BrokerUnixClientFactory | undefined
  }
): Promise<BrokerWarmupSummary> {
  const brokerUnixClientFactory: BrokerUnixClientFactory =
    deps.brokerUnixClientFactory ??
    ((options) => BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>)

  const summary: BrokerWarmupSummary = {
    total: 0,
    attached: 0,
    byCategory: {
      attached: 0,
      skipped_shutting_down: 0,
      ipc_unreachable_nonterminal: 0,
      substrate_gone_stale: 0,
      lease_identity_invalid_stale: 0,
      attach_replay_failed: 0,
      terminated: 0,
      other: 0,
    },
  }

  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      isRuntimeUnavailableStatus(runtime.status) ||
      !getPersistedDurableBrokerEndpoint(runtime)
    ) {
      continue
    }
    summary.total += 1
    let outcome: BrokerReattachOutcome
    try {
      outcome = await reconcileDurableBrokerRuntimeReattach(db, runtime, {
        controller: deps.controller,
        brokerUnixClientFactory,
        resolveAttachToken: resolvePersistedBrokerAttachToken,
        probeBrokerLease: probePersistedBrokerLease,
        attach: true,
      })
    } catch (error) {
      // A warmup miss is never fatal: the lazy dispatch-path reattach remains the
      // backstop. Log and move on rather than aborting the whole warmup.
      summary.byCategory.other += 1
      writeServerLog('WARN', 'broker.warmup.runtime_error', {
        runtimeId: runtime.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const category = warmupCategory(outcome)
    summary.byCategory[category] += 1
    if (category === 'attached') {
      summary.attached += 1
    }
    writeServerLog('INFO', 'broker.warmup.runtime', {
      runtimeId: runtime.runtimeId,
      category,
      state: outcome.state,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
  }

  writeServerLog('INFO', 'broker.warmup.complete', {
    total: summary.total,
    attached: summary.attached,
    byCategory: summary.byCategory,
  })
  return summary
}

function resolveBrokerOrphanSweepGraceMs(): number {
  const raw = process.env['HRC_BROKER_ORPHAN_SWEEP_GRACE_MS']
  if (raw === undefined) {
    return DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS
}

function isOrphanableLaunchStatus(status: string): boolean {
  return status === 'started' || status === 'wrapper_started' || status === 'child_started'
}

function getTrackedLaunchPid(launch: HrcLaunchRecord): number | undefined {
  if (launch.status === 'started') {
    return launch.wrapperPid
  }

  if (launch.status === 'child_started') {
    return launch.childPid ?? launch.wrapperPid
  }

  if (launch.status === 'wrapper_started') {
    return launch.wrapperPid
  }

  return undefined
}

function reapStartupHeadlessOrphan(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  launch: HrcLaunchRecord,
  runId: string,
  now: string
): HrcLifecycleEvent | null {
  const run = db.runs.getByRunId(runId)
  if (!run || !isRunActive(run) || run.transport !== 'headless') {
    return null
  }

  db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: now,
    updatedAt: now,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
    errorMessage: `${HRC_REAPED_RUN_ERROR_MESSAGE}: orphaned-headless`,
  })
  db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    ...runtimeActivityPatch(db, runtime.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })

  return appendHrcEvent(db, 'turn.reaped', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    runId,
    transport: 'headless',
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
    payload: {
      runId,
      runtimeId: runtime.runtimeId,
      reason: 'orphaned-headless',
      lastObservedAt: now,
      observedSource: 'updated_at',
      priorRunStatus: run.status,
      priorRuntimeStatus: runtime.status,
      nextRuntimeStatus: 'stale',
      launchId: launch.launchId,
      launchStatus: 'orphaned',
      wrapperPid: launch.wrapperPid,
      childPid: launch.childPid,
      runtimeOwnershipCleared: true,
    },
  })
}
