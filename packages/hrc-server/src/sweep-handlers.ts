import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  KillBrokerTmuxLeasesResponse,
  PruneRuntimeResult,
  PruneRuntimesResponse,
  PruneRuntimesSummary,
  SweepRuntimeResult,
  SweepRuntimeTransport,
  SweepRuntimesResponse,
  SweepRuntimesSummary,
} from 'hrc-core'
import { isClaudeGhosttyEnabled } from './broker-decisions.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { resolveClaudeGhosttyIdleCleanupMinutes } from './option-resolvers.js'
import { requireSession } from './require-helpers.js'
import {
  HRC_ACTIVE_RUN_RECONCILE_ENABLED,
  HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_INTERVAL_MS,
  HRC_ZOMBIE_RUN_TIMEOUT_SECONDS,
  HRC_ZOMBIE_SWEEP_ENABLED,
  HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  parseJsonBody,
  parsePruneRuntimesRequest,
  parseReconcileActiveRunsRequest,
  parseSweepRuntimesRequest,
  parseSweepZombieRunsRequest,
} from './server-parsers.js'
import { json, timestamp } from './server-util.js'
import { markRuntimeStale, sweepOrphanedBrokerTmuxLeases } from './startup-reconcile.js'
import {
  evaluatePruneDisposition,
  parseSweepDurationMs,
  runtimeMatchesSweepRequest,
} from './sweep-helpers.js'
import {
  cleanupIdleClaudeGhosttyRuntimes,
  reconcileActiveRunsOnce,
  sweepZombieRunsOnce,
} from './sweep-reconcile.js'

export async function handleSweepRuntimes(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSweepRuntimesRequest(await parseJsonBody(request))
  const statuses = body.status ?? ['ready', 'busy']
  const nowMs = Date.now()
  const cutoffMs = nowMs - parseSweepDurationMs(body.olderThan ?? '24h')
  const matched = this.db.runtimes.listAll().filter((runtime) =>
    runtimeMatchesSweepRequest(runtime, {
      cutoffMs,
      includeRecentUnavailable: body.status === undefined,
      nowMs,
      scope: body.scope,
      statuses,
      transport: body.transport,
    })
  )

  const results: SweepRuntimeResult[] = []
  const claimed: HrcRuntimeSnapshot[] = []
  if (body.dryRun !== true) {
    for (const runtime of matched) {
      const droppedContinuation =
        body.dropContinuation ?? (runtime.transport !== 'tmux' && runtime.activeRunId != null)
      if (!this.claimRuntimeForSweep(runtime.runtimeId, statuses, timestamp())) {
        continue
      }
      claimed.push(runtime)

      try {
        const session = requireSession(this.db, runtime.hostSessionId)
        if (droppedContinuation) {
          this.db.sessions.updateContinuation(session.hostSessionId, undefined, timestamp())
        }
        const event = markRuntimeStale(this.db, session, runtime, {
          runtimeId: runtime.runtimeId,
          reason: 'runtime_sweep',
          priorStatus: runtime.status,
          transport: runtime.transport,
          droppedContinuation,
        })
        this.notifyEvent(event)
        results.push({
          type: 'runtime',
          runtimeId: runtime.runtimeId,
          hostSessionId: runtime.hostSessionId,
          transport: runtime.transport as SweepRuntimeTransport,
          status: 'stale',
          droppedContinuation,
        })
      } catch (err) {
        results.push({
          type: 'runtime',
          runtimeId: runtime.runtimeId,
          hostSessionId: runtime.hostSessionId,
          transport: runtime.transport as SweepRuntimeTransport,
          status: 'error',
          droppedContinuation: false,
          errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } else {
    for (const runtime of matched) {
      results.push({
        type: 'runtime',
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        transport: runtime.transport as SweepRuntimeTransport,
        status: 'stale',
        droppedContinuation: false,
      })
    }
  }

  const summary: SweepRuntimesSummary = {
    type: 'summary',
    matched: body.dryRun === true ? matched.length : claimed.length,
    stale: results.filter((result) => result.status === 'stale').length,
    terminated: 0,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
  }

  if (body.dryRun !== true) {
    this.appendSweepCompletedEvent(summary, claimed)
  }

  return json({
    ok: true,
    results,
    summary,
  } satisfies SweepRuntimesResponse)
}

/**
 * Record-level GC for orphaned runtime store rows (T-05441). Distinct from
 * `handleSweepRuntimes`, which only marks live runtimes stale — prune DELETES
 * the row (and its runtime-scoped satellites) for records that are genuinely
 * orphaned. It is dry-run unless the caller passes both a non-dry-run request
 * AND `yes:true`; every matched record is put through `evaluatePruneDisposition`
 * so a live/ready/busy/claimed/active-run record is always spared even when the
 * status filter would otherwise select it.
 */
export async function handlePruneRuntimes(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parsePruneRuntimesRequest(await parseJsonBody(request))
  const statuses = body.status ?? ['stale']
  const nowMs = Date.now()
  const cutoffMs = nowMs - parseSweepDurationMs(body.olderThan ?? '24h')
  const mutate = body.dryRun !== true && body.yes === true

  const matched = this.db.runtimes.listAll().filter((runtime) =>
    runtimeMatchesSweepRequest(runtime, {
      cutoffMs,
      includeRecentUnavailable: false,
      nowMs,
      scope: body.scope,
      statuses,
      transport: body.transport,
    })
  )

  const results: PruneRuntimeResult[] = []
  for (const runtime of matched) {
    const transport = runtime.transport as SweepRuntimeTransport
    const base = {
      type: 'runtime' as const,
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport,
    }

    let disposition: { prunable: boolean; reason?: string }
    try {
      disposition = await evaluatePruneDisposition(runtime, this.tmux)
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (!disposition.prunable) {
      results.push({
        ...base,
        status: 'skipped',
        ...(disposition.reason ? { reason: disposition.reason } : {}),
      })
      continue
    }

    if (!mutate) {
      results.push({ ...base, status: 'pruned', reason: 'dry_run' })
      continue
    }

    try {
      const removed = this.db.runtimes.pruneRuntime(runtime.runtimeId)
      results.push({
        ...base,
        status: removed ? 'pruned' : 'skipped',
        ...(removed ? {} : { reason: 'already_absent' }),
      })
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const summary: PruneRuntimesSummary = {
    type: 'summary',
    matched: matched.length,
    pruned: results.filter((result) => result.status === 'pruned').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
  }

  return json({
    ok: true,
    results,
    summary,
  } satisfies PruneRuntimesResponse)
}

export async function handleKillBrokerTmuxLeases(
  this: HrcServerInstanceForHandlers
): Promise<Response> {
  const result = await sweepOrphanedBrokerTmuxLeases(this.db, this.options.runtimeRoot, {
    graceMs: 0,
    removeDeadSocketFiles: true,
    killLiveLeaseServers: true,
  })
  return json({
    ok: true,
    ...result,
  } satisfies KillBrokerTmuxLeasesResponse)
}

export async function handleSweepZombieRuns(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSweepZombieRunsRequest(await parseJsonBody(request))
  const olderThanMs = parseSweepDurationMs(body.olderThan ?? '30m')
  const result = await sweepZombieRunsOnce(this.ctx, {
    olderThanMs,
    dryRun: body.dryRun === true,
    thresholdSeconds: Math.floor(olderThanMs / 1000),
  })
  return json(result)
}

export function startZombieRunSweeper(this: HrcServerInstanceForHandlers): void {
  if (!HRC_ZOMBIE_SWEEP_ENABLED) return

  void this.runRecurringZombieSweep()
  this.zombieSweepTimer = setInterval(() => {
    void this.runRecurringZombieSweep()
  }, HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS * 1000)
}

export async function runRecurringZombieSweep(this: HrcServerInstanceForHandlers): Promise<void> {
  if (this.zombieSweepInFlight) {
    return
  }

  const sweep = sweepZombieRunsOnce(this.ctx, {
    olderThanMs: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS * 1000,
    dryRun: false,
    thresholdSeconds: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS,
  })
  this.zombieSweepInFlight = sweep
  try {
    await sweep
  } catch (error) {
    writeServerLog('WARN', 'run.zombie_sweep_failed', { error })
  } finally {
    if (this.zombieSweepInFlight === sweep) {
      this.zombieSweepInFlight = undefined
    }
  }
}

export async function handleReconcileActiveRuns(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseReconcileActiveRunsRequest(await parseJsonBody(request))
  const olderThanMs = parseSweepDurationMs(body.olderThan ?? '30m')
  const result = await reconcileActiveRunsOnce(this.ctx, {
    olderThanMs,
    dryRun: body.dryRun === true,
    thresholdSeconds: Math.floor(olderThanMs / 1000),
  })
  return json(result)
}

export function startActiveRunReconciler(this: HrcServerInstanceForHandlers): void {
  if (!HRC_ACTIVE_RUN_RECONCILE_ENABLED) return

  void this.runRecurringActiveRunReconcile()
  this.activeRunReconcileTimer = setInterval(() => {
    void this.runRecurringActiveRunReconcile()
  }, HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS * 1000)
}

export async function runRecurringActiveRunReconcile(
  this: HrcServerInstanceForHandlers
): Promise<void> {
  if (this.activeRunReconcileInFlight) {
    return
  }

  const reconcile = reconcileActiveRunsOnce(this.ctx, {
    olderThanMs: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS * 1000,
    dryRun: false,
    thresholdSeconds: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS,
  })
  this.activeRunReconcileInFlight = reconcile
  try {
    await reconcile
  } catch (error) {
    writeServerLog('WARN', 'run.active_reconcile_failed', { error })
  } finally {
    if (this.activeRunReconcileInFlight === reconcile) {
      this.activeRunReconcileInFlight = undefined
    }
  }
}

export function startClaudeGhosttyIdleCleanup(this: HrcServerInstanceForHandlers): void {
  if (!isClaudeGhosttyEnabled()) return
  if (resolveClaudeGhosttyIdleCleanupMinutes() === 0) return

  void this.runClaudeGhosttyIdleCleanup()
  this.idleCleanupTimer = setInterval(() => {
    void this.runClaudeGhosttyIdleCleanup()
  }, HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_INTERVAL_MS)
}

export async function runClaudeGhosttyIdleCleanup(
  this: HrcServerInstanceForHandlers
): Promise<void> {
  if (this.idleCleanupInFlight) return
  const cleanup = cleanupIdleClaudeGhosttyRuntimes(this.ctx)
  this.idleCleanupInFlight = cleanup
  try {
    await cleanup
  } catch (error) {
    writeServerLog('WARN', 'runtime.idle_cleanup_failed', { error })
  } finally {
    if (this.idleCleanupInFlight === cleanup) {
      this.idleCleanupInFlight = undefined
    }
  }
}

export function claimRuntimeForSweep(
  this: HrcServerInstanceForHandlers,
  runtimeId: string,
  statuses: string[],
  now: string
): boolean {
  const placeholders = statuses.map(() => '?').join(', ')
  const statement = this.db.sqlite.query(
    `UPDATE runtimes SET status = ?, updated_at = ? WHERE runtime_id = ? AND status IN (${placeholders})`
  )
  const result = statement.run('terminating', now, runtimeId, ...statuses) as { changes?: number }
  return (result.changes ?? 0) > 0
}

export function appendSweepCompletedEvent(
  this: HrcServerInstanceForHandlers,
  summary: SweepRuntimesSummary,
  matched: HrcRuntimeSnapshot[]
): void {
  const session = this.resolveSweepSummarySession(matched)
  const event = appendHrcEvent(this.db, 'runtime.sweep_completed', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    payload: summary,
  })
  this.notifyEvent(event)
}

export function resolveSweepSummarySession(
  this: HrcServerInstanceForHandlers,
  matched: HrcRuntimeSnapshot[]
): HrcSessionRecord {
  const firstRuntimeSession = matched
    .map((runtime) => this.db.sessions.getByHostSessionId(runtime.hostSessionId))
    .find((session): session is HrcSessionRecord => session !== null)
  if (firstRuntimeSession) {
    return firstRuntimeSession
  }

  const hostSessionId = 'hrc-sweep-summary'
  const existing = this.db.sessions.getByHostSessionId(hostSessionId)
  if (existing) {
    return existing
  }

  const now = timestamp()
  return this.db.sessions.insert({
    hostSessionId,
    scopeRef: 'system:hrc/sweep',
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

export const sweepHandlersMethods = {
  handleSweepRuntimes,
  handlePruneRuntimes,
  handleKillBrokerTmuxLeases,
  handleSweepZombieRuns,
  startZombieRunSweeper,
  runRecurringZombieSweep,
  handleReconcileActiveRuns,
  startActiveRunReconciler,
  runRecurringActiveRunReconcile,
  startClaudeGhosttyIdleCleanup,
  runClaudeGhosttyIdleCleanup,
  claimRuntimeForSweep,
  appendSweepCompletedEvent,
  resolveSweepSummarySession,
}

export type SweepHandlersMethods = typeof sweepHandlersMethods
