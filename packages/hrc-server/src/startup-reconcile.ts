import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
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

export type BrokerReattachProbe = {
  brokerSocketLive: boolean
  brokerWindow: TmuxPaneState | null
  tuiWindow: TmuxPaneState | null
  userExited?: boolean | undefined
}

export type DurableBrokerReattachDeps = {
  controller: Pick<HarnessBrokerController, 'attachAndReplay'>
  brokerUnixClientFactory: BrokerUnixClientFactory
  resolveAttachToken(runtime: HrcRuntimeSnapshot): Promise<string | undefined>
  probeBrokerLease(runtime: HrcRuntimeSnapshot): Promise<BrokerReattachProbe>
}

export type BrokerReattachOutcome = {
  runtimeId: string
  state: 'broker-attached' | 'direct-tmux-degraded' | 'terminated' | 'stale'
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
    controller: new HarnessBrokerController({ db }),
    brokerUnixClientFactory: (options) =>
      BrokerClient.connectUnix(options) as ReturnType<BrokerUnixClientFactory>,
    resolveAttachToken: resolvePersistedBrokerAttachToken,
    probeBrokerLease: probePersistedBrokerLease,
    sweepOrphans: async () => undefined,
  })

  // Harness-broker runtimes cannot survive a daemon restart: the broker child
  // process was parented by the prior daemon and is gone, but its invocation may
  // persist as `ready`. Feeding such an invocation `invocation.input` on the next
  // turn surfaces as `runtime_unavailable: headless broker input failed`. Mark
  // these runtimes stale (reaping any active run) and dispose the orphaned
  // invocation so the next turn starts a FRESH invocation — continuation persists
  // on the session, so the conversation still resumes. (T-01711)
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker' || isRuntimeUnavailableStatus(runtime.status)) {
      continue
    }
    try {
      // Broker-TMUX runtimes lease a tmux server that outlives the daemon. On
      // restart re-scan the LEASE socket (NOT `tmux attach-session`): if the
      // leased pane is alive AND its ids match the persisted lease,
      // RE-ASSOCIATE (leave the runtime usable + invocation intact); otherwise
      // GC the runtime and dispose its orphaned invocation. Other broker
      // runtimes (headless) cannot survive — their child was parented by the
      // prior daemon — so fall through to the blanket orphan sweep.
      if (runtime.transport === 'tmux') {
        const control = extractRuntimeControlState(runtime.runtimeStateJson)
        if (control?.mode === 'direct-tmux-degraded') {
          continue
        }
        if (await reassociateBrokerTmuxLease(runtime)) {
          emitBrokerTmuxReassociated(db, runtime)
          continue
        }
        gcBrokerRuntimeOnRestart(db, runtime, 'broker_tmux_lease_stale_on_restart')
        continue
      }
      gcBrokerRuntimeOnRestart(db, runtime, 'broker_orphaned_on_restart')
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

  if (probe.brokerSocketLive) {
    const endpoint = getPersistedDurableBrokerEndpoint(runtime)
    if (!endpoint) {
      return markBrokerReattachStale(db, runtime, 'missing_durable_broker_endpoint')
    }
    if (!brokerLeaseWindowsMatch(runtime, probe)) {
      return markBrokerReattachStale(db, runtime, 'broker_window_identity_mismatch')
    }
    const attachToken = await deps.resolveAttachToken(runtime)
    if (!attachToken) {
      return markBrokerReattachStale(db, runtime, 'missing_attach_token')
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
      return {
        runtimeId,
        state: 'stale',
        brokerAttached: false,
        reason: result.error.code,
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
      runtime.transport !== 'tmux' ||
      isRuntimeUnavailableStatus(runtime.status) ||
      !getPersistedDurableBrokerEndpoint(runtime)
    ) {
      continue
    }
    outcomes.push(await reconcileDurableBrokerRuntimeReattach(db, runtime, deps))
  }
  await deps.sweepOrphans()
  return outcomes
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
  const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  let brokerWindow: TmuxPaneState | null = null
  let tuiWindow: TmuxPaneState | null = null
  if (socketPath) {
    const leaseTmux = createTmuxManager({ socketPath })
    brokerWindow = await leaseTmux.inspectWindow({ sessionName, windowName: 'broker' })
    tuiWindow = await leaseTmux.inspectWindow({ sessionName, windowName: 'tui' })
  }
  return {
    brokerSocketLive: endpoint ? await probeUnixSocketLive(endpoint.socketPath) : false,
    brokerWindow,
    tuiWindow,
  }
}

function probeUnixSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let settled = false
    const finish = (live: boolean) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(live)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
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

  // Lease sockets claimed by a still-live (non-terminal) broker-tmux runtime.
  const claimedSockets = new Set<string>()
  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      runtime.transport !== 'tmux' ||
      runtime.status === 'terminated' ||
      runtime.status === 'dead' ||
      isRuntimeUnavailableStatus(runtime.status)
    ) {
      continue
    }
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
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
