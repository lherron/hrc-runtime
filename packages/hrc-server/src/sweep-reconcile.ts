import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRunRecord,
  ReconcileActiveRunResult,
  ReconcileActiveRunsResponse,
  ReconcileActiveRunsSummary,
  SweepZombieRunResult,
  SweepZombieRunsResponse,
  SweepZombieRunsSummary,
} from 'hrc-core'
import { setTimeout as delay } from 'node:timers/promises'

import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { resolveClaudeGhosttyIdleCleanupMinutes } from './option-resolvers.js'
import { requireGhosttySurface, requireSession } from './require-helpers.js'
import type { ServerContext } from './server-context.js'
import { HRC_SERVER_RUN_COLUMNS } from './server-constants.js'
import { writeServerLog } from './server-log.js'
import { finalizeRuntimeTermination } from './server-misc.js'
import type {
  ActiveRunReconcileCandidate,
  ActiveRunReconcilePlan,
  HrcServerRunRow,
  LatestRunEventRow,
  ObservedRunActivity,
  ZombieRunCandidate,
} from './server-types.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import { getObservedTmuxSessionName } from './startup-reconcile.js'
import { createTmuxManager } from './tmux.js'
import { mapServerRunRow, reconcileResultTransport } from './sweep-helpers.js'

const HRC_ZOMBIE_ACTIVE_RUN_STATUSES = ['accepted', 'started', 'running'] as const
const HRC_ZOMBIE_ERROR_MESSAGE = 'run had no events for more than 30 minutes'
const HRC_REAPED_RUN_ERROR_MESSAGE = 'runtime lifecycle is incompatible with an active run'

export async function sweepZombieRunsOnce(
  ctx: ServerContext,
  input: {
    olderThanMs: number
    dryRun: boolean
    thresholdSeconds: number
  }
): Promise<SweepZombieRunsResponse> {
  const nowMs = Date.now()
  const cutoffMs = nowMs - input.olderThanMs
  const candidates = listZombieRunCandidates(ctx, cutoffMs)
  const results: SweepZombieRunResult[] = []

  for (const candidate of candidates) {
    if (input.dryRun) {
      results.push({
        type: 'run',
        runId: candidate.run.runId,
        hostSessionId: candidate.run.hostSessionId,
        ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
        status: 'matched',
        observedAt: candidate.observedAt,
        observedSource: candidate.observedSource,
        runtimeOwnershipCleared: false,
      })
      continue
    }

    try {
      const result = await zombieRun(ctx, candidate, input.thresholdSeconds)
      results.push(result)
    } catch (error) {
      results.push({
        type: 'run',
        runId: candidate.run.runId,
        hostSessionId: candidate.run.hostSessionId,
        ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
        status: 'error',
        observedAt: candidate.observedAt,
        observedSource: candidate.observedSource,
        runtimeOwnershipCleared: false,
        errorCode: error instanceof HrcDomainError ? error.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const summary: SweepZombieRunsSummary = {
    type: 'summary',
    matched: candidates.length,
    zombied: results.filter((result) => result.status === 'zombied').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
  }

  return {
    ok: true,
    results,
    summary,
  } satisfies SweepZombieRunsResponse
}

function listZombieRunCandidates(ctx: ServerContext, cutoffMs: number): ZombieRunCandidate[] {
  const placeholders = HRC_ZOMBIE_ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
  const rows = ctx.db.sqlite
    .query<HrcServerRunRow, string[]>(
      `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status IN (${placeholders})
            AND transport = 'headless'
            AND completed_at IS NULL
          ORDER BY updated_at ASC, run_id ASC`
    )
    .all(...HRC_ZOMBIE_ACTIVE_RUN_STATUSES)

  const candidates: ZombieRunCandidate[] = []
  for (const row of rows) {
    const run = mapServerRunRow(row)
    const observed = latestObservedRunActivity(ctx, run)
    const observedMs = Date.parse(observed.observedAt)
    if (!Number.isFinite(observedMs) || observedMs > cutoffMs) {
      continue
    }
    candidates.push({
      run,
      ...observed,
    })
  }
  return candidates
}

function latestObservedRunActivity(ctx: ServerContext, run: HrcRunRecord): ObservedRunActivity {
  const latestEvent = ctx.db.sqlite
    .query<LatestRunEventRow, [string]>(
      `
          SELECT ts FROM hrc_events
          WHERE run_id = ?
          ORDER BY ts DESC, hrc_seq DESC
          LIMIT 1
        `
    )
    .get(run.runId)
  if (latestEvent) {
    return {
      observedAt: latestEvent.ts,
      observedSource: 'event',
      latestEventAt: latestEvent.ts,
    }
  }

  if (run.startedAt) {
    return { observedAt: run.startedAt, observedSource: 'started_at' }
  }
  if (run.acceptedAt) {
    return { observedAt: run.acceptedAt, observedSource: 'accepted_at' }
  }
  return { observedAt: run.updatedAt, observedSource: 'updated_at' }
}

async function zombieRun(
  ctx: ServerContext,
  candidate: ZombieRunCandidate,
  thresholdSeconds: number
): Promise<SweepZombieRunResult> {
  const now = timestamp()
  const claim = ctx.db.sqlite
    .query(
      `
          UPDATE runs
          SET
            status = ?,
            completed_at = ?,
            updated_at = ?,
            error_code = ?,
            error_message = ?
          WHERE run_id = ?
            AND status IN ('accepted', 'started', 'running')
            AND transport = 'headless'
            AND completed_at IS NULL
        `
    )
    .run(
      'zombie',
      now,
      now,
      HrcErrorCode.RUN_ZOMBIE_TIMEOUT,
      HRC_ZOMBIE_ERROR_MESSAGE,
      candidate.run.runId
    ) as { changes?: number }

  if ((claim.changes ?? 0) === 0) {
    return {
      type: 'run',
      runId: candidate.run.runId,
      hostSessionId: candidate.run.hostSessionId,
      ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
      status: 'skipped',
      observedAt: candidate.observedAt,
      observedSource: candidate.observedSource,
      runtimeOwnershipCleared: false,
    }
  }

  const runtime = candidate.run.runtimeId
    ? ctx.db.runtimes.getByRuntimeId(candidate.run.runtimeId)
    : null
  let runtimeOwnershipCleared = false
  let runtimeStatus: string | undefined
  if (runtime?.activeRunId === candidate.run.runId) {
    runtimeStatus = 'stale'
    const runtimeUpdate = ctx.db.sqlite
      .query(
        `
            UPDATE runtimes
            SET active_run_id = NULL,
                status = ?,
                updated_at = ?,
                last_activity_at = ?
            WHERE runtime_id = ?
              AND active_run_id = ?
          `
      )
      .run(runtimeStatus, now, now, runtime.runtimeId, candidate.run.runId) as {
      changes?: number
    }
    runtimeOwnershipCleared = (runtimeUpdate.changes ?? 0) > 0
  }

  const event = appendHrcEvent(ctx.db, 'turn.zombied', {
    ts: now,
    hostSessionId: candidate.run.hostSessionId,
    scopeRef: candidate.run.scopeRef,
    laneRef: candidate.run.laneRef,
    generation: candidate.run.generation,
    runId: candidate.run.runId,
    ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
    ...(candidate.run.transport === 'sdk' ||
    candidate.run.transport === 'tmux' ||
    candidate.run.transport === 'headless' ||
    candidate.run.transport === 'ghostty'
      ? { transport: candidate.run.transport }
      : {}),
    errorCode: HrcErrorCode.RUN_ZOMBIE_TIMEOUT,
    payload: {
      runId: candidate.run.runId,
      ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
      thresholdSeconds,
      lastObservedAt: candidate.observedAt,
      observedSource: candidate.observedSource,
      ...(candidate.latestEventAt ? { latestEventAt: candidate.latestEventAt } : {}),
      fallbackTimestampSource:
        candidate.observedSource === 'event' ? undefined : candidate.observedSource,
      runtimeOwnershipCleared,
      ...(runtimeStatus ? { runtimeStatus } : {}),
    },
  })
  ctx.notifyEvent(event)

  return {
    type: 'run',
    runId: candidate.run.runId,
    hostSessionId: candidate.run.hostSessionId,
    ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
    status: 'zombied',
    observedAt: candidate.observedAt,
    observedSource: candidate.observedSource,
    runtimeOwnershipCleared,
    ...(runtimeStatus ? { runtimeStatus } : {}),
  }
}

export async function cleanupIdleClaudeGhosttyRuntimes(ctx: ServerContext): Promise<void> {
  const cleanupMinutes = resolveClaudeGhosttyIdleCleanupMinutes()
  if (cleanupMinutes === 0) return

  const nowMs = Date.now()
  const cutoffMs = nowMs - cleanupMinutes * 60_000
  for (const runtime of ctx.db.runtimes.listAll()) {
    if (
      runtime.transport !== 'ghostty' ||
      runtime.harness !== 'claude-code' ||
      runtime.activeRunId !== undefined ||
      runtime.status === 'busy' ||
      runtime.status === 'starting' ||
      isRuntimeUnavailableStatus(runtime.status)
    ) {
      continue
    }

    const activityMs = Date.parse(runtime.lastActivityAt ?? runtime.updatedAt)
    if (!Number.isFinite(activityMs) || activityMs > cutoffMs) continue

    const latest = ctx.db.runtimes.getByRuntimeId(runtime.runtimeId)
    if (
      !latest ||
      latest.activeRunId !== undefined ||
      latest.status === 'busy' ||
      latest.status === 'starting' ||
      latest.generation !== runtime.generation
    ) {
      continue
    }

    const surface = requireGhosttySurface(latest)
    const session = requireSession(ctx.db, latest.hostSessionId)
    const startedAt = timestamp()
    const startedEvent = appendHrcEvent(ctx.db, 'runtime.idle_cleanup_started', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: latest.runtimeId,
      transport: 'ghostty',
      payload: {
        transport: 'ghostty',
        surfaceId: surface.surfaceId,
        reason: 'claude-ghostty-idle',
        idleMinutes: cleanupMinutes,
      },
    })
    ctx.notifyEvent(startedEvent)

    try {
      await ctx.ghostmux.sendKeys(surface.surfaceId, '/quit')
      await delay(1_000)
      await ctx.ghostmux.terminate(surface.surfaceId)
    } catch (error) {
      const inspected = await ctx.ghostmux.inspectSurface(surface.surfaceId).catch(() => null)
      if (inspected) throw error
    }

    const completedAt = timestamp()
    finalizeRuntimeTermination(ctx.db, latest, completedAt)
    const terminatedEvent = appendHrcEvent(ctx.db, 'runtime.terminated', {
      ts: completedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: latest.runtimeId,
      transport: 'ghostty',
      payload: {
        transport: 'ghostty',
        surfaceId: surface.surfaceId,
        reason: 'claude-ghostty-idle',
        droppedContinuation: false,
      },
    })
    ctx.notifyEvent(terminatedEvent)
  }
}

export async function reconcileActiveRunsOnce(
  ctx: ServerContext,
  input: {
    olderThanMs: number
    dryRun: boolean
    thresholdSeconds: number
  }
): Promise<ReconcileActiveRunsResponse> {
  const nowMs = Date.now()
  const cutoffMs = nowMs - input.olderThanMs
  const candidates = listActiveRunReconcileCandidates(ctx, cutoffMs)
  const results: ReconcileActiveRunResult[] = []

  for (const candidate of candidates) {
    try {
      const plan = await planActiveRunReconcile(ctx, candidate)
      if (plan.action === 'suspect') {
        results.push(activeRunReconcileResult(candidate, plan, 'suspect', false))
        continue
      }
      if (input.dryRun) {
        results.push(activeRunReconcileResult(candidate, plan, 'matched', false))
        continue
      }

      results.push(reapActiveRun(ctx, candidate, plan, input.thresholdSeconds))
    } catch (error) {
      results.push({
        type: 'run',
        runId: candidate.run.runId,
        hostSessionId: candidate.run.hostSessionId,
        runtimeId: candidate.runtime.runtimeId,
        transport: reconcileResultTransport(candidate.run),
        status: 'error',
        reason: 'runtime_unavailable_with_active_run',
        observedAt: candidate.observedAt,
        observedSource: candidate.observedSource,
        runtimeStatus: candidate.runtime.status,
        runtimeOwnershipCleared: false,
        errorCode: error instanceof HrcDomainError ? error.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const summary: ReconcileActiveRunsSummary = {
    type: 'summary',
    matched: results.filter((result) => result.status === 'matched').length,
    reaped: results.filter((result) => result.status === 'reaped').length,
    suspect: results.filter((result) => result.status === 'suspect').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
  }

  return {
    ok: true,
    results,
    summary,
  } satisfies ReconcileActiveRunsResponse
}

function listActiveRunReconcileCandidates(
  ctx: ServerContext,
  cutoffMs: number
): ActiveRunReconcileCandidate[] {
  const rows = ctx.db.sqlite
    .query<HrcServerRunRow, []>(
      `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status IN ('accepted', 'started', 'running')
            AND transport IN ('sdk', 'tmux', 'headless', 'ghostty')
            AND runtime_id IS NOT NULL
            AND completed_at IS NULL
          ORDER BY updated_at ASC, run_id ASC`
    )
    .all()

  const candidates: ActiveRunReconcileCandidate[] = []
  for (const row of rows) {
    const run = mapServerRunRow(row)
    if (!run.runtimeId) continue

    const runtime = ctx.db.runtimes.getByRuntimeId(run.runtimeId)
    if (!runtime || runtime.activeRunId !== run.runId) continue

    const launch = runtime.launchId ? ctx.db.launches.getByLaunchId(runtime.launchId) : null
    if (run.transport === 'headless' && launch?.status !== 'orphaned') continue

    const observed = latestObservedRunActivity(ctx, run)
    const observedMs = Date.parse(observed.observedAt)
    if (!Number.isFinite(observedMs) || observedMs > cutoffMs) {
      continue
    }

    candidates.push({
      run,
      runtime,
      ...(launch ? { launch } : {}),
      ...observed,
    })
  }
  return candidates
}

async function planActiveRunReconcile(
  ctx: ServerContext,
  candidate: ActiveRunReconcileCandidate
): Promise<ActiveRunReconcilePlan> {
  const { runtime, launch } = candidate

  if (runtime.transport === 'headless' && launch?.status === 'orphaned') {
    return {
      action: 'reap',
      reason: 'orphaned-headless',
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
      nextRuntimeStatus: 'stale',
    }
  }

  if (runtime.status === 'terminated') {
    return {
      action: 'reap',
      reason: 'runtime_terminated_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_TERMINATED_WITH_ACTIVE_RUN,
    }
  }

  if (runtime.status === 'dead') {
    return {
      action: 'reap',
      reason: 'runtime_dead_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_DEAD_WITH_ACTIVE_RUN,
    }
  }

  if (runtime.status === 'stale') {
    return {
      action: 'reap',
      reason: 'runtime_unavailable_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
    }
  }

  if (runtime.status === 'ready') {
    return {
      action: 'reap',
      reason: 'runtime_ready_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_READY_WITH_ACTIVE_RUN,
    }
  }

  if (launch && (launch.status === 'exited' || launch.status === 'failed')) {
    return {
      action: 'reap',
      reason: 'runtime_process_exited_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_PROCESS_EXITED_WITH_ACTIVE_RUN,
    }
  }

  if (launch?.status === 'orphaned') {
    return {
      action: 'reap',
      reason: 'runtime_unavailable_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
      nextRuntimeStatus: 'stale',
    }
  }

  // T-01941: a durable harness-broker runtime is hosted in its OWN per-runtime
  // leased tmux server (btmux/…sock), NOT the default hrc socket. The generic
  // tmux branch below probes `ctx.tmux.inspectSession` on the default socket
  // (and `<session>:main`), so for a durable broker it always reports "missing"
  // and condemns a LIVE broker to `dead` while its pid + tmux + attached viewer
  // keep running — an orphan dispatch can never recover (reconcileTmuxRuntimeLiveness
  // skips unavailable-status rows, and selectDispatchInteractiveRuntime then forks
  // a parallel headless broker). Probe the runtime's own socket + recorded leased
  // pane instead, mirroring reconcileTmuxRuntimeLiveness (runtime-io-handlers.ts).
  // Scoped via controllerKind + hasLeasedBrokerSubstrate (the hosting predicate),
  // which is false for a ghostty broker, so this preserves the tmux-only reconcile.
  if (runtime.controllerKind === 'harness-broker' && hasLeasedBrokerSubstrate(runtime)) {
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    const leasedPaneId = runtime.tmuxJson?.['paneId']
    if (socketPath && typeof leasedPaneId === 'string' && leasedPaneId.length > 0) {
      const brokerTmux = createTmuxManager({ socketPath })
      const liveness = await brokerTmux.inspectPaneLiveness(leasedPaneId)
      if (liveness?.alive) {
        // Substrate liveness and run ownership are SEPARATE authorities (daedalus,
        // T-01941): a live leased pane proves the broker surface is up, NOT that the
        // active turn is complete. 30m of HRC-event silence + a live pane is missing
        // observability, not proof the run is detachable — clearing active_run_id or
        // marking the runtime ready here would detach a real long-running turn and
        // break queued-run ownership. Leave the run visibly `suspect` and mutate
        // nothing; an authoritative broker-side terminal/heartbeat signal (separate
        // follow-ups: lost turn.completed projection + long-tool heartbeat) is
        // required before this run can be safely reaped.
        return {
          action: 'suspect',
          reason: 'runtime_may_still_be_live',
        }
      }

      // Pane is dead/missing on the runtime's OWN socket: the broker is genuinely
      // gone. Reap the run and mark the runtime dead per current policy, and tear
      // down the now-defunct leased tmux server so we don't trade one orphan class
      // (false-dead-but-alive) for another (dead-row-but-live-server).
      await brokerTmux.killServer().catch((error) => {
        writeServerLog('WARN', 'failed to remove dead broker tmux lease server', {
          runtimeId: runtime.runtimeId,
          sessionName: getBrokerRuntimeTmuxSessionName(runtime),
          socketPath,
          reason: 'active_run_reconcile_broker_pane_not_live',
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return {
        action: 'reap',
        reason: 'runtime_unavailable_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
        nextRuntimeStatus: 'dead',
      }
    }

    // No per-runtime socket / leased pane recorded — we cannot prove liveness on
    // the correct surface, so fall back to today's unavailable-with-active-run reap.
    return {
      action: 'reap',
      reason: 'runtime_unavailable_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
      nextRuntimeStatus: 'dead',
    }
  }

  if (runtime.transport === 'tmux') {
    const tmuxSessionName = getObservedTmuxSessionName(runtime)
    if (!tmuxSessionName) {
      return {
        action: 'reap',
        reason: 'runtime_unavailable_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
        nextRuntimeStatus: 'dead',
      }
    }

    const inspected = await ctx.tmux.inspectSession(tmuxSessionName)
    if (!inspected) {
      return {
        action: 'reap',
        reason: 'runtime_unavailable_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
        nextRuntimeStatus: 'dead',
      }
    }
  }

  if (runtime.status === 'busy') {
    return {
      action: 'reap',
      reason: 'runtime_busy_timeout_with_active_run',
      errorCode: HrcErrorCode.RUNTIME_BUSY_TIMEOUT_WITH_ACTIVE_RUN,
      nextRuntimeStatus: 'stale',
    }
  }

  return {
    action: 'suspect',
    reason: 'runtime_may_still_be_live',
  }
}

function activeRunReconcileResult(
  candidate: ActiveRunReconcileCandidate,
  plan: ActiveRunReconcilePlan,
  status: ReconcileActiveRunResult['status'],
  runtimeOwnershipCleared: boolean
): ReconcileActiveRunResult {
  return {
    type: 'run',
    runId: candidate.run.runId,
    hostSessionId: candidate.run.hostSessionId,
    runtimeId: candidate.runtime.runtimeId,
    transport: reconcileResultTransport(candidate.run),
    status,
    reason: plan.reason,
    observedAt: candidate.observedAt,
    observedSource: candidate.observedSource,
    runtimeStatus: candidate.runtime.status,
    ...(plan.nextRuntimeStatus ? { nextRuntimeStatus: plan.nextRuntimeStatus } : {}),
    runtimeOwnershipCleared,
    ...(candidate.launch ? { launchId: candidate.launch.launchId } : {}),
    ...(candidate.launch ? { launchStatus: candidate.launch.status } : {}),
    ...(plan.errorCode ? { errorCode: plan.errorCode } : {}),
  }
}

function reapActiveRun(
  ctx: ServerContext,
  candidate: ActiveRunReconcileCandidate,
  plan: ActiveRunReconcilePlan,
  thresholdSeconds: number
): ReconcileActiveRunResult {
  const now = timestamp()
  const errorCode = plan.errorCode ?? HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN
  const errorMessage = `${HRC_REAPED_RUN_ERROR_MESSAGE}: ${plan.reason}`
  const claim = ctx.db.sqlite
    .query(
      `
          UPDATE runs
          SET
            status = ?,
            completed_at = ?,
            updated_at = ?,
            error_code = ?,
            error_message = ?
          WHERE run_id = ?
            AND runtime_id = ?
            AND status IN ('accepted', 'started', 'running')
            AND transport IN ('sdk', 'tmux', 'headless', 'ghostty')
            AND completed_at IS NULL
            AND EXISTS (
              SELECT 1 FROM runtimes
              WHERE runtime_id = ?
                AND active_run_id = ?
            )
        `
    )
    .run(
      'failed',
      now,
      now,
      errorCode,
      errorMessage,
      candidate.run.runId,
      candidate.runtime.runtimeId,
      candidate.runtime.runtimeId,
      candidate.run.runId
    ) as { changes?: number }

  if ((claim.changes ?? 0) === 0) {
    return activeRunReconcileResult(candidate, plan, 'skipped', false)
  }

  let runtimeOwnershipCleared = false
  const runtimeUpdate = ctx.db.sqlite
    .query(
      `
          UPDATE runtimes
          SET active_run_id = NULL,
              status = ?,
              updated_at = ?,
              last_activity_at = ?
          WHERE runtime_id = ?
            AND active_run_id = ?
        `
    )
    .run(
      plan.nextRuntimeStatus ?? candidate.runtime.status,
      now,
      now,
      candidate.runtime.runtimeId,
      candidate.run.runId
    ) as { changes?: number }
  runtimeOwnershipCleared = (runtimeUpdate.changes ?? 0) > 0

  const event = appendHrcEvent(ctx.db, 'turn.reaped', {
    ts: now,
    hostSessionId: candidate.run.hostSessionId,
    scopeRef: candidate.run.scopeRef,
    laneRef: candidate.run.laneRef,
    generation: candidate.run.generation,
    runId: candidate.run.runId,
    runtimeId: candidate.runtime.runtimeId,
    ...(candidate.run.transport === 'sdk' ||
    candidate.run.transport === 'tmux' ||
    candidate.run.transport === 'headless' ||
    candidate.run.transport === 'ghostty'
      ? { transport: candidate.run.transport }
      : {}),
    errorCode,
    payload: {
      runId: candidate.run.runId,
      runtimeId: candidate.runtime.runtimeId,
      reason: plan.reason,
      thresholdSeconds,
      lastObservedAt: candidate.observedAt,
      observedSource: candidate.observedSource,
      ...(candidate.latestEventAt ? { latestEventAt: candidate.latestEventAt } : {}),
      fallbackTimestampSource:
        candidate.observedSource === 'event' ? undefined : candidate.observedSource,
      priorRunStatus: candidate.run.status,
      priorRuntimeStatus: candidate.runtime.status,
      ...(plan.nextRuntimeStatus ? { nextRuntimeStatus: plan.nextRuntimeStatus } : {}),
      ...(candidate.launch
        ? {
            launchId: candidate.launch.launchId,
            launchStatus: candidate.launch.status,
            wrapperPid: candidate.launch.wrapperPid,
            childPid: candidate.launch.childPid,
            exitCode: candidate.launch.exitCode,
            signal: candidate.launch.signal,
          }
        : {}),
      runtimeOwnershipCleared,
    },
  })
  ctx.notifyEvent(event)

  return activeRunReconcileResult(candidate, plan, 'reaped', runtimeOwnershipCleared)
}
