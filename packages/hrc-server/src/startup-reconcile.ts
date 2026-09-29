import { HrcErrorCode } from 'hrc-core'
import type {
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  decideLegacyRuntimeStartupDisposition,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import { BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT } from './broker/adoption-root.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory, HarnessBrokerController } from './broker/controller.js'
import {
  assertNoRetainedProjection,
  awaitRetainedRecoveryOwner,
  retainedRecoveryInFlight,
} from './broker/runtime-exclusive-owner'
import {
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
} from './broker/runtime-hosting.js'
import { extractRuntimeControlState } from './broker/runtime-state.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { isRunActive, requireSession } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import { isLiveProcess } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import {
  probePersistedBrokerLease,
  resolvePersistedBrokerAttachToken,
} from './startup-reconcile/broker-probe.js'
import { reconcileDurableBrokerRuntimeReattach } from './startup-reconcile/durable-broker-reattach.js'
import {
  emitBrokerTmuxReassociated,
  gcBrokerRuntimeOnRestart,
  getPersistedDurableBrokerEndpoint,
  reassociateBrokerTmuxLease,
  sweepOrphanedBrokerTmuxLeases,
  sweepOrphanedRendererControlSockets,
} from './startup-reconcile/lease-identity.js'
import {
  getObservedTmuxSessionName,
  logStartupIssue,
  markRuntimeDead,
  markRuntimeStale,
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

export { reconcileDurableBrokerRuntimeReattach }
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
  sweepOrphanedRendererControlSockets,
  reassociateBrokerTmuxLease,
  reassociateBrokerTmuxWindows,
  brokerLeaseWindowsMatch,
  brokerLeaseIdsMatch,
} from './startup-reconcile/lease-identity.js'

export async function reconcileStartupState(
  db: HrcDatabase,
  tmux: ServerTmuxManager,
  options: { runtimeRoot: string }
): Promise<void> {
  // T-07155: an urgent-delivery contribution still `attempting` means the daemon
  // died mid-RPC. It cannot be retried — the harness may or may not have applied
  // it — so seal it `ambiguous`. A later retry with the same idempotency key then
  // returns the truth instead of injecting the order a second time.
  const sealedOrphanedSteers = db.steerContributions.sealOrphanedAsAmbiguous(timestamp())
  if (sealedOrphanedSteers > 0) {
    writeServerLog('WARN', 'steer_contribution.orphaned_sealed_ambiguous', {
      count: sealedOrphanedSteers,
    })
  }

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
      if (runtime?.transport === 'headless' && !isExternalLifecycleOwner(runtime) && activeRunId) {
        reapStartupHeadlessOrphan(db, session, runtime, launch, activeRunId, now)
      }
    } catch (error) {
      logStartupIssue('launch reconciliation failed', { launchId: launch.launchId }, error)
    }
  }

  for (const runtime of db.runtimes.listAll()) {
    if (isExternalLifecycleOwner(runtime)) {
      continue
    }
    const brokerTmuxLeaseRuntime =
      runtime.controllerKind === 'harness-broker' && hasLeasedBrokerSubstrate(runtime)
    if (
      (runtime.transport !== 'tmux' && !brokerTmuxLeaseRuntime) ||
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
    } catch (error) {
      logStartupIssue('runtime reconciliation failed', { runtimeId: runtime.runtimeId }, error)
    }
  }

  await reconcileDurableBrokerStartup(db, {
    runtimeRoot: options.runtimeRoot,
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
      connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>,
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
    if (isExternalLifecycleOwner(runtime)) {
      continue
    }
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
        if (await reassociateBrokerTmuxLease(runtime, options.runtimeRoot)) {
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
  await sweepOrphanedRendererControlSockets(options.runtimeRoot, {
    graceMs: resolveBrokerOrphanSweepGraceMs(),
    holderEnumerationTimeoutMs: resolveHolderEnumerationTimeoutMs(),
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
      if (isExternalLifecycleOwner(runtime)) {
        continue
      }
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

    // EPR owns a durable Unix endpoint but its process substrate and attach
    // protocol are external. Registration convergence / epr.reattach own these
    // rows; the harness-broker startup classifier must never stale or attach
    // them with broker.attach.
    //
    if (isExternalLifecycleOwner(runtime)) {
      continue
    }

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
 * on the SAME broker (continuity, no re-alloc). Returns a discriminated result so
 * callers cannot confuse an off-root authority rejection with ordinary broker
 * unavailability and destructively clean up the persisted source lease.
 */
export type SharedBrokerAttachDeps = {
  runtimeRoot: string
  controller: Pick<HarnessBrokerController, 'attachAndReplay' | 'activeClientInvocationId'>
  brokerUnixClientFactory: BrokerUnixClientFactory
  // Default to the persisted-state probe/token resolvers (production). Tests
  // script these to avoid touching a live socket / on-disk attach token.
  resolveAttachToken?: (runtime: HrcRuntimeSnapshot) => Promise<string | undefined>
  probeBrokerLease?: (runtime: HrcRuntimeSnapshot) => Promise<BrokerReattachProbe>
  /**
   * Request-serving ownership for durable reattach. EVERY caller that may attach
   * a durable runtime onto the serving controller shares this per-server map, so
   * only one attach runs per runtime and crossing callers await the same result.
   */
  inFlightOperations: Map<string, Promise<BrokerReattachOutcome>>
}

/**
 * Is this runtime ALREADY attached on the serving controller?
 *
 * The recheck that makes the single-flight an ownership fence rather than a
 * coincidence. Joining an in-flight attach is not enough on its own: a caller
 * that arrives just after one completed finds an empty map, and would start a
 * SECOND attach on a runtime that is already attached. `attachAndReplay`
 * publishes the new client with `setActive` and then subscribes a live consumer
 * on it; nothing closes the previous client or cancels its consumer, so a second
 * attach leaves two sockets and two consumers projecting the same stream. The
 * store stays correct — projection is idempotent — but the process leaks a
 * connection and an event loop per race, and "the map has one entry" was never
 * evidence of one connection.
 */
function alreadyAttachedOnServingController(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  deps: Pick<SharedBrokerAttachDeps, 'controller'>
): boolean {
  const current = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  const invocationId = current.activeInvocationId
  if (invocationId === undefined) return false
  return deps.controller.activeClientInvocationId(current.runtimeId) === invocationId
}

/**
 * Attach one durable runtime onto the serving controller, at most once at a time.
 *
 * The SINGLE shared owner. Startup warmup enters here, so concurrent warmup
 * callers cannot each open a client for the same runtime, and the
 * rich outcome is preserved for the warmup's category diagnostics.
 *
 * Concurrency contract, in full:
 *  - a caller that finds a flight JOINS it and receives that flight's outcome,
 *    success or failure, and never starts one of its own;
 *  - a caller that finds none checks whether the runtime is already attached on
 *    the serving controller before acquiring ownership, because a flight that
 *    completed a moment ago has already cleared the map;
 *  - a rejected flight propagates to everyone who joined it, and the map entry is
 *    cleared, so the next call can acquire ownership and recover.
 */
export async function attachDurableBrokerShared(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  deps: SharedBrokerAttachDeps
): Promise<BrokerReattachOutcome> {
  // A JOINER SHARES THE OUTCOME, including a failure.
  //
  // The first cut returned early only when the joined flight had actually
  // attached, and fell through otherwise. That looked like a harmless retry and
  // was not: on a non-throwing failure every joiner falls past both checks,
  // constructs its own operation and OVERWRITES the map, so two joiners become
  // two competing retries — and if those succeed, the double-client race this
  // helper exists to prevent is back. It also silently converted "one shared
  // failure" into "one automatic retry per joiner".
  //
  // Sharing the outcome is the whole contract. A genuinely LATER call — one that
  // finds no flight at entry — still acquires ownership normally and retries,
  // which is where a retry belongs.
  // T-08566: an in-flight retained recovery owns this runtime. Wait for it, then
  // decide inside our own ownership: the guard below is evaluated synchronously
  // with acquiring the flight, never on a value read before recovery finished.
  // Only yield when a recovery actually owns the runtime, so an ordinary attach
  // still acquires its flight synchronously (callers rely on that ordering).
  if (retainedRecoveryInFlight(deps.inFlightOperations, runtime.runtimeId)) {
    await awaitRetainedRecoveryOwner(deps.inFlightOperations, runtime.runtimeId)
  }
  const joined = deps.inFlightOperations.get(runtime.runtimeId)
  if (joined) return await joined

  assertNoRetainedProjection(db, runtime.runtimeId, 'dispatch')

  if (alreadyAttachedOnServingController(db, runtime, deps)) {
    return { runtimeId: runtime.runtimeId, state: 'broker-attached', brokerAttached: true }
  }

  let resolveOperation!: (result: BrokerReattachOutcome) => void
  let rejectOperation!: (error: unknown) => void
  const operation = new Promise<BrokerReattachOutcome>((resolve, reject) => {
    resolveOperation = resolve
    rejectOperation = reject
  })
  deps.inFlightOperations.set(runtime.runtimeId, operation)
  void reconcileDurableBrokerRuntimeReattach(db, runtime, {
    runtimeRoot: deps.runtimeRoot,
    controller: deps.controller,
    brokerUnixClientFactory: deps.brokerUnixClientFactory,
    resolveAttachToken: deps.resolveAttachToken ?? resolvePersistedBrokerAttachToken,
    probeBrokerLease: deps.probeBrokerLease ?? probePersistedBrokerLease,
    attach: true,
  })
    .then(resolveOperation, rejectOperation)
    .finally(() => {
      if (deps.inFlightOperations.get(runtime.runtimeId) === operation) {
        deps.inFlightOperations.delete(runtime.runtimeId)
      }
    })
  return await operation
}

export async function reattachDurableBrokerForDispatch(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  deps: SharedBrokerAttachDeps
): Promise<DurableBrokerDispatchReattachResult> {
  if (!getPersistedDurableBrokerEndpoint(runtime)) {
    return { state: 'unavailable' }
  }
  const outcome = await attachDurableBrokerShared(db, runtime, deps)
  if (outcome.state === 'broker-attached') {
    return { state: 'reattached' }
  }
  if (outcome.reason === BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT) {
    return {
      state: 'rejected-outside-runtime-root',
      reason: BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
    }
  }
  return { state: 'unavailable' }
}

export type DurableBrokerDispatchReattachResult =
  | { state: 'reattached' }
  | { state: 'unavailable' }
  | {
      state: 'rejected-outside-runtime-root'
      reason: typeof BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT
    }

export function brokerWarmupCategoryForOutcome(
  outcome: BrokerReattachOutcome
): BrokerWarmupCategory {
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
      if (outcome.reason === BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT) {
        return 'adoption_path_rejected'
      }
      if (outcome.reason?.startsWith('broker_control_probe_')) {
        return 'control_probe_failed'
      }
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
/**
 * Externally-owned rows (EPR and participant-served participants) are never
 * reattached by startup warmup: their process substrate and attach protocol are
 * external, and registration convergence owns them.
 */
export async function warmDurableBrokerBindings(
  db: HrcDatabase,
  deps: {
    runtimeRoot: string
    controller: Pick<HarnessBrokerController, 'attachAndReplay' | 'activeClientInvocationId'>
    brokerUnixClientFactory?: BrokerUnixClientFactory | undefined
    /** The server's shared per-runtime attach owner; see {@link attachDurableBrokerShared}. */
    inFlightOperations: Map<string, Promise<BrokerReattachOutcome>>
  }
): Promise<BrokerWarmupSummary> {
  const brokerUnixClientFactory: BrokerUnixClientFactory =
    deps.brokerUnixClientFactory ??
    ((options) => connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>)

  const summary: BrokerWarmupSummary = {
    total: 0,
    attached: 0,
    byCategory: {
      attached: 0,
      adoption_path_rejected: 0,
      skipped_shutting_down: 0,
      ipc_unreachable_nonterminal: 0,
      substrate_gone_stale: 0,
      lease_identity_invalid_stale: 0,
      attach_replay_failed: 0,
      control_probe_failed: 0,
      terminated: 0,
      other: 0,
    },
  }

  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      isRuntimeUnavailableStatus(runtime.status) ||
      isExternalLifecycleOwner(runtime) ||
      !getPersistedDurableBrokerEndpoint(runtime)
    ) {
      continue
    }
    summary.total += 1
    let outcome: BrokerReattachOutcome
    try {
      // Through the SHARED per-runtime owner, not a private call. Two
      // concurrent attachers used to be able to attach the same runtime —
      // `setActive` replaces the map entry but neither closes the losing client
      // nor cancels its live consumer, so the loser kept projecting from a second
      // socket forever.
      outcome = await attachDurableBrokerShared(db, runtime, {
        runtimeRoot: deps.runtimeRoot,
        controller: deps.controller,
        brokerUnixClientFactory,
        resolveAttachToken: resolvePersistedBrokerAttachToken,
        probeBrokerLease: probePersistedBrokerLease,
        inFlightOperations: deps.inFlightOperations,
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
    const category = brokerWarmupCategoryForOutcome(outcome)
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

/**
 * Abort budget for holder discovery, overridable so a test can bound this
 * WITHOUT depending on the runner's per-test timeout being larger.
 *
 * That coupling is a real trap: at bun's default 5000ms a test and the default
 * budget are exactly equal, so a stalled `lsof` kills the test before the
 * preserve path it is meant to exercise ever runs — an opaque timeout instead
 * of a result. Tests that care set this small and stop caring. (T-07740)
 */
function resolveHolderEnumerationTimeoutMs(): number | undefined {
  const raw = process.env['HRC_HOLDER_ENUMERATION_TIMEOUT_MS']
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
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
    statusChangedAt: now,
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
