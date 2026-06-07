import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HrcErrorCode } from 'hrc-core'
import type {
  HrcEventEnvelope,
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  KillBrokerTmuxLeasesResponse,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  decideLegacyRuntimeStartupDisposition,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import {
  type BrokerControllerAttachResult,
  type BrokerUnixClientFactory,
  HarnessBrokerController,
} from './broker/controller.js'
import {
  extractBrokerEndpoint,
  extractRuntimeControlState,
  withDirectTmuxDegradedControlState,
} from './broker/runtime-state.js'
import {
  type BrokerLeaseProbe,
  brokerLeaseIdentityMatches,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
} from './broker/runtime-hosting.js'
import type { GhostmuxManager as ServerGhostmuxManager } from './ghostmux.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { isRunActive, isTerminalBrokerInvocationState, requireSession } from './require-helpers.js'
import { isLiveProcess } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxPaneState,
  createTmuxManager,
} from './tmux.js'

const DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS = 5 * 60 * 1000
const HRC_REAPED_RUN_ERROR_MESSAGE = 'runtime lifecycle is incompatible with an active run'
const USER_INITIATED_CONTINUATION_CLEAR_REASONS = new Set(['prompt_input_exit', 'logout', 'clear'])

type BrokerTmuxLeaseSweepOptions = {
  graceMs: number
  removeDeadSocketFiles: boolean
  killLiveLeaseServers: boolean
}

type BrokerTmuxLeaseSweepResult = Omit<KillBrokerTmuxLeasesResponse, 'ok'>

/**
 * Application-level broker liveness, observed via a `broker.health` round-trip
 * (NOT a raw socket connect). `ok`/`degraded` are both IPC-live and attach-
 * eligible; `shutting_down` means the broker is draining (skip binding, but the
 * runtime is NOT dead); `unreachable` covers connect/timeout/RPC failure and is
 * treated as non-terminal for durable runtimes (the lease may still be valid).
 */
export type BrokerHealthState = 'ok' | 'degraded' | 'shutting_down' | 'unreachable'

export type BrokerReattachProbe = {
  brokerSocketLive: boolean
  brokerWindow: TmuxPaneState | null
  tuiWindow: TmuxPaneState | null
  userExited?: boolean | undefined
  /** Result of the `broker.health` round-trip; absent for legacy/raw probes. */
  brokerHealth?: BrokerHealthState | undefined
}

export type DurableBrokerReattachDeps = {
  controller: Pick<HarnessBrokerController, 'attachAndReplay'>
  brokerUnixClientFactory: BrokerUnixClientFactory
  resolveAttachToken(runtime: HrcRuntimeSnapshot): Promise<string | undefined>
  probeBrokerLease(runtime: HrcRuntimeSnapshot): Promise<BrokerReattachProbe>
  /**
   * When false, do classification/orphan work ONLY — probe + lease-identity
   * checks that may stale a genuinely-dead runtime — but do NOT attach+replay a
   * live one onto the controller (it returns `broker-attachable` and is left
   * intact for the serving controller's warmup). This keeps a single attach
   * authority: the pre-instance reconcile classifies; the post-construction
   * serving warm is the only path that binds onto the request-serving controller
   * (the one with a live `notifyEvent` loop). Defaults to true (attach).
   */
  attach?: boolean | undefined
}

export type BrokerReattachOutcome = {
  runtimeId: string
  state:
    | 'broker-attached'
    | 'broker-attachable'
    | 'broker-shutting-down'
    | 'direct-tmux-degraded'
    | 'terminated'
    | 'stale'
    | 'broker-ipc-unavailable'
  brokerAttached: boolean
  replayedThroughSeq?: number | undefined
  reason?: string | undefined
}

export type BrokerWindowObservation = {
  brokerWindow: TmuxPaneState | null
  tuiWindow: TmuxPaneState | null
}

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
    if (
      (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') ||
      runtime.status === 'terminated' ||
      runtime.status === 'dead'
    ) {
      continue
    }

    // Broker-tmux runtimes own a tmux server on a per-runtime LEASE socket, not
    // the default `tmux` server this generic block inspects. They are reconciled
    // by the dedicated broker pass below (lease-socket inspect + id-match
    // re-associate), so skip them here to avoid a false "session missing" death.
    if (runtime.controllerKind === 'harness-broker' && runtime.transport === 'tmux') {
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
      updatedAt: now,
      lastActivityAt: now,
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
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux' && hosting.presentation.kind === 'none') {
    return {
      runtimeId,
      state: 'broker-ipc-unavailable',
      brokerAttached: false,
      reason: 'broker_ipc_unavailable',
    }
  }

  return markBrokerReattachStale(db, runtime, 'broker_socket_and_tui_unavailable')
}

export async function reconcileDurableBrokerStartup(
  db: HrcDatabase,
  deps: DurableBrokerReattachDeps & { sweepOrphans(): Promise<void> }
): Promise<BrokerReattachOutcome[]> {
  const outcomes: BrokerReattachOutcome[] = []
  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      isRuntimeUnavailableStatus(runtime.status)
    ) {
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

/** Operator-visible warmup category, derived from a BrokerReattachOutcome. */
export type BrokerWarmupCategory =
  | 'attached'
  | 'skipped_shutting_down'
  | 'ipc_unreachable_nonterminal'
  | 'lease_identity_invalid_stale'
  | 'attach_replay_failed'
  | 'terminated'
  | 'other'

export type BrokerWarmupSummary = {
  total: number
  attached: number
  byCategory: Record<BrokerWarmupCategory, number>
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

async function resolvePersistedBrokerAttachToken(
  runtime: HrcRuntimeSnapshot
): Promise<string | undefined> {
  const broker = getRuntimeStateBrokerRecord(runtime)
  const endpoint = extractBrokerEndpoint(getRecord(broker?.['endpoint']))
  if (endpoint?.kind !== 'unix-jsonrpc-ndjson') {
    return undefined
  }
  return (await readFile(endpoint.attachTokenRef.path, 'utf8')).trim()
}

async function probePersistedBrokerLease(
  runtime: HrcRuntimeSnapshot
): Promise<BrokerReattachProbe> {
  const endpoint = getPersistedDurableBrokerEndpoint(runtime)
  // T-01884: derive the lease tmux socket/session from the hosting-state substrate
  // (durable headless AND interactive store it in runtime_state_json.broker, NOT the
  // legacy tmuxJson). A durable HEADLESS runtime has NO tmuxJson, so the legacy
  // getBrokerRuntimeTmuxSocketPath returned undefined → the broker window was never
  // inspected → brokerWindow=null → broker_lease_identity_mismatch, failing reattach
  // even though the leased broker is alive and accepting. Fall back to the legacy
  // tmuxJson helpers only for pre-durable rows. (Mirrors the sweeper claim source.)
  const hosting = parseBrokerRuntimeHostingState(runtime)
  const leasedSubstrate =
    hosting?.substrate.kind === 'leased-tmux' ? hosting.substrate : undefined
  const socketPath = leasedSubstrate?.tmuxSocketPath ?? getBrokerRuntimeTmuxSocketPath(runtime)
  const sessionName = leasedSubstrate?.sessionName ?? getBrokerRuntimeTmuxSessionName(runtime)
  let brokerWindow: TmuxPaneState | null = null
  let tuiWindow: TmuxPaneState | null = null
  if (socketPath) {
    const leaseTmux = createTmuxManager({ socketPath })
    brokerWindow = await leaseTmux.inspectWindow({ sessionName, windowName: 'broker' })
    tuiWindow = await leaseTmux.inspectWindow({ sessionName, windowName: 'tui' })
  }
  const brokerHealth: BrokerHealthState = endpoint
    ? await probeBrokerHealth(endpoint.socketPath)
    : 'unreachable'
  return {
    // `ok`/`degraded` are both attach-eligible; `shutting_down`/`unreachable` are
    // not "live" for binding purposes (callers special-case `shutting_down`).
    brokerSocketLive: brokerHealth === 'ok' || brokerHealth === 'degraded',
    brokerHealth,
    brokerWindow,
    tuiWindow,
  }
}

/**
 * Adapt a startup `BrokerReattachProbe` (TmuxPaneState windows) to the
 * hosting-state `BrokerLeaseProbe` (window-identity triples) consumed by
 * brokerLeaseIdentityMatches. The socket path + session name come from the
 * observed broker window. Returns undefined when no broker window was observed,
 * since identity cannot be fenced without it.
 */
function toBrokerLeaseProbe(probe: BrokerReattachProbe): BrokerLeaseProbe | undefined {
  const broker = probe.brokerWindow
  if (!broker) {
    return undefined
  }
  return {
    tmuxSocketPath: broker.socketPath,
    sessionName: broker.sessionName,
    brokerWindow: {
      sessionId: broker.sessionId,
      windowId: broker.windowId,
      paneId: broker.paneId,
    },
    ...(probe.tuiWindow
      ? {
          tuiWindow: {
            sessionId: probe.tuiWindow.sessionId,
            windowId: probe.tuiWindow.windowId,
            paneId: probe.tuiWindow.paneId,
          },
        }
      : {}),
  }
}

/**
 * Application-level broker liveness via a `broker.health` round-trip. Replaces
 * the legacy raw `createConnection` probe (250ms), which only proved the kernel
 * accepted a unix-socket connect — it could not tell whether the JSON-RPC loop
 * was alive, and its tight timeout lost races under post-restart load (the
 * source of the spurious `broker_runtime_not_active` failures). `connectUnix`
 * performs a `broker.hello` handshake (already a real liveness signal) and the
 * follow-up `health()` returns the broker's drain state, so a draining broker
 * can be skipped rather than mistaken for dead. A generous budget is acceptable
 * here: this runs at boot and on the rare cold-binding dispatch, not on the hot
 * path. Any connect/timeout/RPC failure maps to `unreachable` (non-terminal for
 * durable runtimes), never to a false "dead" classification.
 */
const BROKER_HEALTH_PROBE_BUDGET_MS = 2000

async function probeBrokerHealth(socketPath: string): Promise<BrokerHealthState> {
  let client: BrokerClient | undefined
  try {
    client = await BrokerClient.connectUnix({
      socketPath,
      timeoutMs: BROKER_HEALTH_PROBE_BUDGET_MS,
    })
    const response = await withTimeout(
      client.health(),
      BROKER_HEALTH_PROBE_BUDGET_MS,
      'broker_health_timeout'
    )
    switch (response.status) {
      case 'ok':
      case 'degraded':
      case 'shutting_down':
        return response.status
      default:
        return 'unreachable'
    }
  } catch {
    return 'unreachable'
  } finally {
    await client?.close().catch(() => undefined)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function appendMissingHeadlessTurnCompleted(
  db: HrcDatabase,
  input: {
    session: HrcSessionRecord
    runtime?: HrcRuntimeSnapshot | undefined
    runId: string
    launchId: string
    exitCode?: number | undefined
    ts: string
    replayed?: boolean | undefined
    notify?: ((event: HrcLifecycleEvent) => void) | undefined
  }
): void {
  if (input.runtime?.transport !== 'headless') {
    return
  }
  if (db.hrcEvents.listByRun(input.runId, { eventKind: 'turn.completed' }).length > 0) {
    return
  }

  const completedEvent = appendHrcEvent(db, 'turn.completed', {
    ts: input.ts,
    hostSessionId: input.session.hostSessionId,
    scopeRef: input.session.scopeRef,
    laneRef: input.session.laneRef,
    generation: input.session.generation,
    runtimeId: input.runtime.runtimeId,
    runId: input.runId,
    launchId: input.launchId,
    transport: 'headless',
    ...(input.replayed === true ? { replayed: true } : {}),
    ...(input.exitCode === 0 ? {} : { errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE }),
    payload: {
      success: input.exitCode === 0,
      transport: 'headless',
      source: 'launch_exit_synthesized',
    },
  })
  input.notify?.(completedEvent)
}

export function getObservedTmuxSessionName(runtime: HrcRuntimeSnapshot): string | null {
  const sessionId = runtime.tmuxJson?.['sessionId']
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return sessionId
  }

  const sessionName = runtime.tmuxJson?.['sessionName']
  if (typeof sessionName === 'string' && sessionName.length > 0) {
    return sessionName
  }

  return null
}

export function markRuntimeDead(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  source: HrcEventEnvelope['source'],
  eventJson: Record<string, unknown>
): void {
  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} is dead after startup reconciliation`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'dead',
    updatedAt: now,
    lastActivityAt: now,
  })
  db.events.append({
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    source,
    eventKind: 'runtime.dead',
    eventJson,
  })
}

export function markRuntimeStale(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  eventJson: Record<string, unknown>
): HrcLifecycleEvent {
  const now = timestamp()
  const invocationId = runtime.activeInvocationId
  if (runtime.controllerKind === 'harness-broker' && invocationId !== undefined) {
    const invocation = db.brokerInvocations.getByInvocationId(invocationId)
    if (invocation && !isTerminalBrokerInvocationState(invocation.invocationState)) {
      db.brokerInvocations.update(invocationId, {
        invocationState: 'disposed',
        updatedAt: now,
      })
    }
  }
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} is stale after startup reconciliation`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    updatedAt: now,
    lastActivityAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'stale',
      updatedAt: now,
      staleReason: eventJson['reason'],
      stalePayload: eventJson,
      ...(invocationId !== undefined
        ? {
            terminalInvocation: {
              invocationId,
              eventType: 'hrc.runtime.stale',
            },
          }
        : {}),
    },
  })
  return appendHrcEvent(db, 'runtime.stale', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: eventJson,
  })
}

export function findUserInitiatedContinuationClearReason(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): string | undefined {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    return undefined
  }

  const row = db.sqlite
    .query<{ reason: string | null }, [string]>(
      `SELECT json_extract(broker_event_json, '$.reason') AS reason
         FROM broker_invocation_events
        WHERE invocation_id = ? AND type = 'continuation.cleared'
        ORDER BY seq DESC
        LIMIT 1`
    )
    .get(invocationId)

  return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
    ? row.reason
    : undefined
}

/**
 * Read the lifecycle terminal reason already projected onto a broker runtime's
 * active invocation (WS-C persists this for terminal broker events such as
 * `harness.exited` / `invocation.exited { reason: 'idle-ttl' }`).
 *
 * When present, the broker has authoritatively classified this runtime's
 * termination; liveness/orphan reconciliation must DEFER to it rather than
 * synthesize a generic stale/dead reason from pane/session inspection.
 */
export function findPersistedLifecycleTerminalReason(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): string | undefined {
  if (runtime.controllerKind !== 'harness-broker') {
    return undefined
  }
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    return undefined
  }
  return db.brokerInvocations.getByInvocationId(invocationId)?.lifecycleTerminalReason
}

export function markRuntimeTerminatedAfterUserExit(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  eventJson: Record<string, unknown>
): HrcLifecycleEvent {
  const now = timestamp()
  const invocationId = runtime.activeInvocationId
  if (runtime.controllerKind === 'harness-broker' && invocationId !== undefined) {
    const invocation = db.brokerInvocations.getByInvocationId(invocationId)
    if (invocation && !isTerminalBrokerInvocationState(invocation.invocationState)) {
      db.brokerInvocations.update(invocationId, {
        invocationState: 'exited',
        updatedAt: now,
      })
    }
  }
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} was terminated by user exit`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'terminated',
    updatedAt: now,
    lastActivityAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'terminated',
      updatedAt: now,
      terminationReason: 'user_initiated_session_end',
      userExitReason: eventJson['userExitReason'],
      terminationPayload: eventJson,
      ...(invocationId !== undefined
        ? {
            terminalInvocation: {
              invocationId,
              eventType: 'hrc.runtime.terminated',
            },
          }
        : {}),
    },
  })
  return appendHrcEvent(db, 'runtime.terminated', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: {
      ...eventJson,
      reason: 'user_initiated_session_end',
    },
  })
}

export function logStartupIssue(
  message: string,
  detail: Record<string, unknown>,
  error: unknown
): void {
  writeServerLog('ERROR', 'startup.issue', {
    message,
    detail,
    error,
  })
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
 * Sweep leaked broker-tmux lease sockets under `<runtimeRoot>/btmux/`. A socket
 * is reclaimed only when no non-terminal broker-tmux runtime claims it and it is
 * past the grace threshold. Live orphan servers are killed; dead socket files
 * are removed when requested. Claimed sockets are always preserved.
 */
export async function sweepOrphanedBrokerTmuxLeases(
  db: HrcDatabase,
  runtimeRoot: string,
  options: BrokerTmuxLeaseSweepOptions
): Promise<BrokerTmuxLeaseSweepResult> {
  const result: BrokerTmuxLeaseSweepResult = {
    scanned: 0,
    killedLiveLeaseServers: 0,
    removedDeadSocketFiles: 0,
    skippedClaimed: 0,
    skippedWithinGrace: 0,
    errors: 0,
  }
  const dir = join(runtimeRoot, 'btmux')
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith('.sock'))
  } catch {
    // No btmux directory yet -> nothing to sweep.
    return result
  }
  if (entries.length === 0) {
    return result
  }

  // Lease sockets claimed by a still-live (non-terminal) harness-broker runtime.
  // T-01875: derive the claim from the hosting-state SUBSTRATE (leased-tmux), NOT
  // from runtime.transport — a durable HEADLESS runtime (transport='headless')
  // legitimately claims a leased tmux substrate and must not be swept. Fall back
  // to the legacy tmuxJson lease socket for pre-durable broker-tmux runtimes that
  // have no parseable broker hosting state.
  const claimedSockets = new Set<string>()
  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      runtime.status === 'terminated' ||
      runtime.status === 'dead' ||
      isRuntimeUnavailableStatus(runtime.status)
    ) {
      continue
    }
    const hosting = parseBrokerRuntimeHostingState(runtime)
    const socketPath =
      hosting?.substrate.kind === 'leased-tmux'
        ? hosting.substrate.tmuxSocketPath
        : getBrokerRuntimeTmuxSocketPath(runtime)
    if (socketPath) {
      claimedSockets.add(socketPath)
    }
  }

  const now = Date.now()

  for (const entry of entries) {
    const socketPath = join(dir, entry)
    result.scanned += 1
    if (claimedSockets.has(socketPath)) {
      result.skippedClaimed += 1
      continue
    }
    try {
      let ageMs: number
      try {
        const stats = await stat(socketPath)
        ageMs = now - stats.mtimeMs
      } catch {
        // Socket vanished between readdir and stat -> nothing to sweep.
        continue
      }
      if (ageMs < options.graceMs) {
        // Still within grace: a live other daemon may be allocating/draining it.
        result.skippedWithinGrace += 1
        continue
      }

      const leaseTmux = createTmuxManager({ socketPath })
      const sessions = await leaseTmux.listSessionNames()
      const orphanLeaseSessions = sessions.filter((name) => name.startsWith('hrc-'))
      if (orphanLeaseSessions.length === 0) {
        if (options.removeDeadSocketFiles) {
          await rm(socketPath, { force: true })
          result.removedDeadSocketFiles += 1
          writeServerLog('INFO', 'broker.dead_lease_socket_removed', {
            socketPath,
            ageMs,
            graceMs: options.graceMs,
          })
        }
        continue
      }

      if (!options.killLiveLeaseServers) {
        continue
      }
      await leaseTmux.killServer()
      result.killedLiveLeaseServers += 1
      writeServerLog('INFO', 'broker.orphan_lease_swept', {
        socketPath,
        sessions: orphanLeaseSessions,
        ageMs,
        graceMs: options.graceMs,
      })
    } catch (error) {
      result.errors += 1
      logStartupIssue('broker orphan lease sweep failed', { socketPath }, error)
    }
  }
  return result
}

export async function reassociateBrokerTmuxLease(runtime: HrcRuntimeSnapshot): Promise<boolean> {
  const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
  if (!socketPath) {
    return false
  }
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  const leaseTmux = createTmuxManager({ socketPath })
  const persistedWindows = getPersistedBrokerWindows(runtime)
  if (!persistedWindows?.brokerWindow && !persistedWindows?.tuiWindow) {
    const inspected = await leaseTmux.inspectSession(sessionName)
    if (!inspected) {
      return false
    }
    return brokerLeaseIdsMatch(runtime, inspected)
  }
  return reassociateBrokerTmuxWindows(runtime, async () => ({
    brokerWindow: await leaseTmux.inspectWindow({ sessionName, windowName: 'broker' }),
    tuiWindow: await leaseTmux.inspectWindow({ sessionName, windowName: 'tui' }),
  }))
}

export async function reassociateBrokerTmuxWindows(
  runtime: HrcRuntimeSnapshot,
  inspect: (runtime: HrcRuntimeSnapshot) => Promise<BrokerWindowObservation>
): Promise<boolean> {
  return brokerLeaseWindowsMatch(runtime, await inspect(runtime))
}

export function brokerLeaseWindowsMatch(
  runtime: HrcRuntimeSnapshot,
  observed: BrokerWindowObservation
): boolean {
  const persisted = getPersistedBrokerWindows(runtime)
  if (!persisted?.brokerWindow || !persisted.tuiWindow) {
    return false
  }
  return (
    tmuxPaneIdentityMatches(persisted.brokerWindow, observed.brokerWindow) &&
    tmuxPaneIdentityMatches(persisted.tuiWindow, observed.tuiWindow)
  )
}

function emitBrokerTmuxReassociated(db: HrcDatabase, runtime: HrcRuntimeSnapshot): void {
  const session = requireSession(db, runtime.hostSessionId)
  appendHrcEvent(db, 'runtime.reassociated', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: {
      runtimeId: runtime.runtimeId,
      reason: 'broker_tmux_lease_reassociated_on_restart',
      generation: runtime.generation,
    },
  })
}

export function brokerLeaseIdsMatch(runtime: HrcRuntimeSnapshot, observed: TmuxPaneState): boolean {
  const tmuxJson = runtime.tmuxJson
  if (!tmuxJson) {
    return false
  }
  for (const [key, value] of [
    ['sessionId', observed.sessionId],
    ['windowId', observed.windowId],
    ['paneId', observed.paneId],
  ] as const) {
    const persisted = tmuxJson[key]
    if (typeof persisted === 'string' && persisted !== value) {
      return false
    }
  }
  return true
}

function brokerTuiWindowMatches(
  runtime: HrcRuntimeSnapshot,
  observed: TmuxPaneState | null
): boolean {
  const persisted = getPersistedBrokerWindows(runtime)
  return tmuxPaneIdentityMatches(persisted?.tuiWindow, observed)
}

function getPersistedDurableBrokerEndpoint(
  runtime: HrcRuntimeSnapshot
): { socketPath: string } | undefined {
  const broker = getRuntimeStateBrokerRecord(runtime)
  const endpoint = extractBrokerEndpoint(getRecord(broker?.['endpoint']))
  return endpoint?.kind === 'unix-jsonrpc-ndjson' ? { socketPath: endpoint.socketPath } : undefined
}

function getPersistedBrokerWindows(
  runtime: HrcRuntimeSnapshot
): { brokerWindow?: TmuxPaneState | undefined; tuiWindow?: TmuxPaneState | undefined } | undefined {
  const broker = getRuntimeStateBrokerRecord(runtime)
  if (!broker) {
    return undefined
  }
  return {
    brokerWindow: toTmuxPaneState(broker['brokerWindow']),
    tuiWindow: toTmuxPaneState(broker['tuiWindow']),
  }
}

function getRuntimeStateBrokerRecord(
  runtime: HrcRuntimeSnapshot
): Record<string, unknown> | undefined {
  return getRecord(runtime.runtimeStateJson?.['broker'])
}

function toTmuxPaneState(value: unknown): TmuxPaneState | undefined {
  const record = getRecord(value)
  if (!record) {
    return undefined
  }
  const socketPath = record['socketPath']
  const sessionName = record['sessionName']
  const windowName = record['windowName']
  const sessionId = record['sessionId']
  const windowId = record['windowId']
  const paneId = record['paneId']
  if (
    typeof socketPath !== 'string' ||
    typeof sessionName !== 'string' ||
    typeof windowName !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof windowId !== 'string' ||
    typeof paneId !== 'string'
  ) {
    return undefined
  }
  return { socketPath, sessionName, windowName, sessionId, windowId, paneId }
}

function tmuxPaneIdentityMatches(
  persisted: TmuxPaneState | undefined,
  observed: TmuxPaneState | null
): boolean {
  if (!persisted || !observed) {
    return false
  }
  return (
    persisted.socketPath === observed.socketPath &&
    persisted.sessionName === observed.sessionName &&
    persisted.windowName === observed.windowName &&
    persisted.sessionId === observed.sessionId &&
    persisted.windowId === observed.windowId &&
    persisted.paneId === observed.paneId
  )
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function markBrokerReattachStale(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  reason: string,
  error?: unknown
): BrokerReattachOutcome {
  const session = requireSession(db, runtime.hostSessionId)
  markRuntimeStale(db, session, runtime, {
    runtimeId: runtime.runtimeId,
    reason,
    generation: runtime.generation,
    ...(error instanceof Error ? { error: error.message } : {}),
  })
  const now = timestamp()
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId)
  db.runtimes.update(runtime.runtimeId, {
    runtimeStateJson: {
      ...(latest?.runtimeStateJson ?? runtime.runtimeStateJson ?? {}),
      control: {
        mode: 'broker-ipc',
        brokerAttached: false,
        lastAttachError: {
          code: reason,
          message: error instanceof Error ? error.message : reason,
        },
      },
      updatedAt: now,
    },
    updatedAt: now,
    lastActivityAt: now,
  })
  return {
    runtimeId: runtime.runtimeId,
    state: 'stale',
    brokerAttached: false,
    reason,
  }
}

function gcBrokerRuntimeOnRestart(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  reason: string
): void {
  const session = requireSession(db, runtime.hostSessionId)
  const now = timestamp()
  const invocationId = runtime.activeInvocationId
  if (invocationId !== undefined) {
    const invocation = db.brokerInvocations.getByInvocationId(invocationId)
    if (
      invocation &&
      invocation.invocationState !== 'disposed' &&
      invocation.invocationState !== 'exited' &&
      invocation.invocationState !== 'failed'
    ) {
      db.brokerInvocations.update(invocationId, {
        invocationState: 'disposed',
        updatedAt: now,
      })
    }
  }
  markRuntimeStale(db, session, runtime, {
    runtimeId: runtime.runtimeId,
    reason,
    generation: runtime.generation,
    ...(invocationId !== undefined ? { invocationId } : {}),
  })
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
    updatedAt: now,
    lastActivityAt: now,
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
