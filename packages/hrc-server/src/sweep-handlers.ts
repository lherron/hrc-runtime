import { HrcConflictError, HrcDomainError, HrcErrorCode } from 'hrc-core'
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
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { runFirstTurnEvaluationOnce } from './first-turn-eval.js'
import { resolveFirstTurnEvalIntervalSeconds } from './first-turn-watch.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { resolveSessionIdleArchiveDays } from './option-resolvers.js'
import { requireSession } from './require-helpers.js'
import {
  HRC_ACTIVE_RUN_RECONCILE_ENABLED,
  HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV,
  HRC_SESSION_RETENTION_SWEEP_INTERVAL_MS,
  HRC_TMUX_AGING_INTERVAL_SECONDS,
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
import {
  markRuntimeStale,
  sweepOrphanedBrokerTmuxLeases,
  sweepOrphanedRendererControlSockets,
} from './startup-reconcile.js'
import { DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS } from './startup-reconcile/types.js'
import {
  evaluatePruneDisposition,
  evaluateRuntimeAgingDisposition,
  parseSweepDurationMs,
  runtimeMatchesSweepRequest,
} from './sweep-helpers.js'
import type { RuntimeAgingDisposition, RuntimeAgingEvidence } from './sweep-helpers.js'
import { reconcileActiveRunsOnce, sweepZombieRunsOnce } from './sweep-reconcile.js'
import { archiveIdleSessions } from './target-message-handlers.js'
import { createTmuxManager } from './tmux.js'

const MNEME_LEDGER_PRUNE_SCOPE_ALLOWLIST = new Set([
  'agent:mneme:project:signal-pipeline:task:signal-cluster',
  'agent:mneme:project:signal-pipeline:task:signal-summarize',
  'agent:mneme:project:signal-pipeline:task:signal-score',
])

export async function handleSweepRuntimes(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSweepRuntimesRequest(await parseJsonBody(request))
  const statuses = body.status ?? ['ready', 'busy']
  const nowMs = Date.now()
  const cutoffMs =
    nowMs -
    (body.olderThan === undefined
      ? this.staleGenerationThresholdSec * 1000
      : parseSweepDurationMs(body.olderThan))
  const result = await runRuntimeAging.call(this, {
    statuses,
    nowMs,
    cutoffMs,
    scope: body.scope,
    transport: body.transport,
    dryRun: body.dryRun === true,
    dropContinuation: body.dropContinuation,
    emitSummaryEvent: body.dryRun !== true,
    reason: 'runtime_sweep',
  })
  return json(result)
}

async function runRuntimeAging(
  this: HrcServerInstanceForHandlers,
  input: {
    statuses: string[]
    nowMs: number
    cutoffMs: number
    scope?: string | undefined
    transport?: SweepRuntimeTransport | undefined
    dryRun: boolean
    dropContinuation?: boolean | undefined
    emitSummaryEvent: boolean
    reason: 'runtime_sweep' | 'runtime_tmux_aging'
  }
): Promise<SweepRuntimesResponse> {
  const matched = this.db.runtimes.listAll().filter((runtime) =>
    runtimeMatchesSweepRequest(runtime, {
      cutoffMs: input.cutoffMs,
      includeRecentUnavailable: false,
      nowMs: input.nowMs,
      scope: input.scope,
      statuses: input.statuses,
      transport: input.transport,
    })
  )

  const results: SweepRuntimeResult[] = []
  const transitioned: HrcRuntimeSnapshot[] = []
  for (const runtime of matched) {
    const droppedContinuation =
      input.dropContinuation ?? (runtime.transport !== 'tmux' && runtime.activeRunId != null)
    const base = {
      type: 'runtime' as const,
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport: runtime.transport as SweepRuntimeTransport,
    }
    let disposition: RuntimeAgingDisposition
    try {
      disposition = await evaluateRuntimeAgingDisposition(runtime, {
        db: this.db,
        tmuxManagerFactory: this.brokerTmuxManagerFactory ?? createTmuxManager,
      })
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        droppedContinuation: false,
        errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (!disposition.eligible) {
      results.push({
        ...base,
        status: 'skipped',
        droppedContinuation: false,
        reason: disposition.reason,
      })
      continue
    }

    if (input.dryRun) {
      results.push({ ...base, status: 'stale', droppedContinuation: false })
      continue
    }

    try {
      const event = this.transitionRuntimeForAging(
        runtime,
        disposition.evidence,
        droppedContinuation,
        input.reason
      )
      if (event === null) {
        results.push({
          ...base,
          status: 'skipped',
          droppedContinuation: false,
          reason: 'runtime_changed',
        })
        continue
      }
      transitioned.push(runtime)
      this.notifyEvent(event)
      results.push({ ...base, status: 'stale', droppedContinuation })
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        droppedContinuation: false,
        errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const summary: SweepRuntimesSummary = {
    type: 'summary',
    matched: matched.length,
    stale: results.filter((result) => result.status === 'stale').length,
    terminated: 0,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
  }

  if (input.emitSummaryEvent) {
    this.appendSweepCompletedEvent(summary, transitioned)
  }

  return {
    ok: true,
    results,
    summary,
  } satisfies SweepRuntimesResponse
}

/**
 * Final no-live-runtime-staled gate. The liveness probes above are advisory
 * until this compare-and-set wins: dispatch/activity/ownership changes after
 * the probe make the transition lose without touching the row.
 */
export function transitionRuntimeForAging(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  evidence: RuntimeAgingEvidence,
  droppedContinuation: boolean,
  reason: 'runtime_sweep' | 'runtime_tmux_aging'
): ReturnType<typeof markRuntimeStale> | null {
  if (isExternalLifecycleOwner(runtime)) return null
  const transition = this.db.sqlite.transaction(() => {
    const now = timestamp()
    const result = this.db.sqlite
      .query(
        `UPDATE runtimes
            SET status = ?, status_changed_at = ?, updated_at = ?
          WHERE runtime_id = ?
            AND status = ?
            AND active_run_id IS ?
            AND active_operation_id IS ?
            AND active_invocation_id IS ?
            AND wrapper_pid IS ?
            AND child_pid IS ?
            AND last_activity_at IS ?
            AND runtime_state_json IS ?
            AND (
              ? IS NULL OR EXISTS (
                SELECT 1
                  FROM broker_invocations
                 WHERE invocation_id = ?
                   AND broker_pid IS ?
                   AND child_pid IS ?
              )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM runs
               WHERE runtime_id = runtimes.runtime_id
                 AND status NOT IN ('completed', 'failed', 'cancelled', 'zombie')
            )`
      )
      .run(
        'stale',
        now,
        now,
        runtime.runtimeId,
        runtime.status,
        runtime.activeRunId ?? null,
        runtime.activeOperationId ?? null,
        runtime.activeInvocationId ?? null,
        runtime.wrapperPid ?? null,
        runtime.childPid ?? null,
        runtime.lastActivityAt ?? null,
        runtime.runtimeStateJson === undefined ? null : JSON.stringify(runtime.runtimeStateJson),
        evidence.invocationId,
        evidence.invocationId,
        evidence.invocationBrokerPid,
        evidence.invocationChildPid
      ) as { changes?: number }
    if ((result.changes ?? 0) === 0) {
      return null
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    if (droppedContinuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, undefined, now)
    }
    return markRuntimeStale(this.db, session, runtime, {
      runtimeId: runtime.runtimeId,
      reason,
      priorStatus: runtime.status,
      transport: runtime.transport,
      droppedContinuation,
    })
  })
  return transition()
}

export async function runTmuxAgingOnce(
  this: HrcServerInstanceForHandlers
): Promise<SweepRuntimesResponse> {
  const nowMs = Date.now()
  const result = await runRuntimeAging.call(this, {
    statuses: ['ready', 'busy'],
    nowMs,
    cutoffMs: nowMs - this.staleGenerationThresholdSec * 1000,
    transport: 'tmux',
    dryRun: false,
    emitSummaryEvent: false,
    reason: 'runtime_tmux_aging',
  })
  writeServerLog('INFO', 'runtime.tmux_aging_complete', result.summary)
  return result
}

export function startTmuxAging(this: HrcServerInstanceForHandlers): void {
  if (!this.tmuxAgingEnabled || this.staleGenerationThresholdSec <= 0) return

  void this.runRecurringTmuxAging()
  this.tmuxAgingTimer = setInterval(() => {
    void this.runRecurringTmuxAging()
  }, HRC_TMUX_AGING_INTERVAL_SECONDS * 1000)
}

export async function runRecurringTmuxAging(this: HrcServerInstanceForHandlers): Promise<void> {
  if (this.tmuxAgingInFlight) return
  const aging = this.runTmuxAgingOnce()
  this.tmuxAgingInFlight = aging
  try {
    await aging
  } catch (error) {
    writeServerLog('WARN', 'runtime.tmux_aging_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (this.tmuxAgingInFlight === aging) {
      this.tmuxAgingInFlight = undefined
    }
  }
}

/**
 * Record-level GC for orphaned runtime store rows (T-05441). Distinct from
 * `handleSweepRuntimes`, which only ages abandoned runtimes stale — prune DELETES
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
  if (body.runtimeIds && body.includeLedgers === true) {
    return handleLedgerManifestPrune.call(this, body.runtimeIds, {
      dryRun: body.dryRun === true,
      yes: body.yes === true,
    })
  }

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

async function handleLedgerManifestPrune(
  this: HrcServerInstanceForHandlers,
  runtimeIds: string[],
  options: { dryRun: boolean; yes: boolean }
): Promise<Response> {
  const mutate = !options.dryRun && options.yes
  const byRuntimeId = new Map(
    this.db.runtimes.listAll().map((runtime) => [runtime.runtimeId, runtime] as const)
  )
  const matched: HrcRuntimeSnapshot[] = []
  const gateFailures: Array<{
    runtimeId: string
    scopeRef?: string | undefined
    reasons: string[]
  }> = []

  // This complete preflight is the all-or-nothing boundary. No repository
  // mutation occurs until every manifest row passes both gates.
  for (const runtimeId of runtimeIds) {
    const runtime = byRuntimeId.get(runtimeId)
    if (!runtime) {
      gateFailures.push({ runtimeId, reasons: ['unknown_runtime'] })
      continue
    }

    const reasons: string[] = []
    if (!MNEME_LEDGER_PRUNE_SCOPE_ALLOWLIST.has(runtime.scopeRef)) {
      reasons.push('scope_not_allowlisted')
    }
    try {
      const disposition = await evaluatePruneDisposition(runtime, this.tmux)
      if (!disposition.prunable) reasons.push(disposition.reason ?? 'not_prunable')
    } catch (error) {
      reasons.push(`safety_gate_error:${error instanceof Error ? error.message : String(error)}`)
    }

    if (reasons.length > 0) {
      gateFailures.push({ runtimeId, scopeRef: runtime.scopeRef, reasons })
    } else {
      matched.push(runtime)
    }
  }

  if (gateFailures.length > 0) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      `ledger-inclusive runtime prune refused: ${gateFailures.length} of ${runtimeIds.length} manifest runtimes failed the all-or-nothing safety gate`,
      {
        manifestCount: runtimeIds.length,
        failureCount: gateFailures.length,
        failures: gateFailures,
      }
    )
  }

  const deleteCounts = this.db.runtimes.countPruneRows(runtimeIds, { includeLedgers: true })
  if (mutate) {
    const pruneAll = this.db.sqlite.transaction(() => {
      for (const runtime of matched) {
        const removed = this.db.runtimes.pruneRuntime(runtime.runtimeId, {
          includeLedgers: true,
        })
        if (!removed) {
          throw new HrcConflictError(
            HrcErrorCode.STALE_CONTEXT,
            `ledger-inclusive runtime prune lost runtime during apply: ${runtime.runtimeId}`,
            { runtimeId: runtime.runtimeId }
          )
        }
      }
    })
    pruneAll()
  }

  const results: PruneRuntimeResult[] = matched.map((runtime) => ({
    type: 'runtime',
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    transport: runtime.transport as SweepRuntimeTransport,
    status: 'pruned',
    ...(mutate ? {} : { reason: 'dry_run' }),
  }))
  const summary: PruneRuntimesSummary = {
    type: 'summary',
    matched: matched.length,
    pruned: matched.length,
    skipped: 0,
    errors: 0,
  }

  return json({
    ok: true,
    results,
    summary,
    deleteCounts,
  } satisfies PruneRuntimesResponse)
}

export async function handleKillBrokerTmuxLeases(
  this: HrcServerInstanceForHandlers
): Promise<Response> {
  await sweepOrphanedRendererControlSockets(this.options.runtimeRoot, { graceMs: 0 })
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

export function startBrokerLeaseGc(this: HrcServerInstanceForHandlers): void {
  if (process.env['HRC_BROKER_LEASE_GC_ENABLED'] === '0') return
  // Startup reconciliation already ran the same classifier. Schedule the first
  // recurring pass one cadence later so embedded CLI startup does not emit an
  // empty asynchronous summary after its command has begun.
  this.brokerLeaseGcTimer = setInterval(() => {
    void this.runRecurringBrokerLeaseGc()
  }, HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS * 1000)
}

export async function runRecurringBrokerLeaseGc(this: HrcServerInstanceForHandlers): Promise<void> {
  if (this.brokerLeaseGcInFlight) return
  const sweep = (async () => {
    const renderer = await sweepOrphanedRendererControlSockets(this.options.runtimeRoot, {
      graceMs: DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS,
      emitSummary: false,
    })
    const broker = await sweepOrphanedBrokerTmuxLeases(this.db, this.options.runtimeRoot, {
      graceMs: DEFAULT_BROKER_ORPHAN_SWEEP_GRACE_MS,
      removeDeadSocketFiles: true,
      killLiveLeaseServers: true,
    })
    const changed =
      renderer.removed +
        renderer.errors +
        broker.killedLiveLeaseServers +
        broker.removedDeadSocketFiles +
        broker.reapedClaimedOrphans +
        broker.staledClaimedRuntimes +
        broker.removedBrokerIpcDirs +
        broker.errors >
      0
    // Log every tick, not just the ones that changed something: gating on
    // `changed` made a healthy idle timer and a dead timer look identical from
    // the log, which is exactly what you need to tell apart during an incident.
    // Matches the `runtime.tmux_aging_complete` sibling. `changed` stays in the
    // payload so no-op ticks remain trivially filterable (T-06974, from T-05337).
    writeServerLog('INFO', 'broker.lease_gc_sweep_complete', { changed, renderer, broker })
  })()
  this.brokerLeaseGcInFlight = sweep
  try {
    await sweep
  } catch (error) {
    writeServerLog('WARN', 'broker.lease_gc_sweep_failed', { error })
  } finally {
    if (this.brokerLeaseGcInFlight === sweep) {
      this.brokerLeaseGcInFlight = undefined
    }
  }
}

/**
 * T-07235 — the provision-liveness watchdog gets its OWN timer. It deliberately
 * does NOT ride `HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS` (300s), whose cadence
 * cannot honor the 120s default deadline.
 */
export function startFirstTurnWatchdog(this: HrcServerInstanceForHandlers): void {
  const intervalSeconds = resolveFirstTurnEvalIntervalSeconds()
  void this.runRecurringFirstTurnEval()
  this.firstTurnEvalTimer = setInterval(() => {
    void this.runRecurringFirstTurnEval()
  }, intervalSeconds * 1000)
}

export async function runRecurringFirstTurnEval(this: HrcServerInstanceForHandlers): Promise<void> {
  if (this.firstTurnEvalInFlight) return
  const pass = runFirstTurnEvaluationOnce(this)
  this.firstTurnEvalInFlight = pass
  try {
    const summary = await pass
    if (summary.scanned > 0) {
      writeServerLog('INFO', 'runtime.first_turn_eval_complete', summary)
    }
  } catch (error) {
    writeServerLog('WARN', 'runtime.first_turn_eval_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (this.firstTurnEvalInFlight === pass) {
      this.firstTurnEvalInFlight = undefined
    }
  }
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

/**
 * T-07575 — the session retention sweep.
 *
 * Before this the session store had no retirement mechanism at all: the
 * archiver existed (`POST /v1/sessions/archive-abandoned`) but had no caller,
 * so on a four-month-old host 5,807 rows still claimed `status: 'active'` while
 * only 28 held a live runtime.
 *
 * Its own timer, at a daily cadence: idle archival is a days-scale question and
 * has no business riding the 300s runtime sweep, whose cadence is chosen for
 * liveness. Set `HRC_SESSION_RETENTION_SWEEP_ENABLED=0` to disable.
 */
export function startSessionRetentionSweep(this: HrcServerInstanceForHandlers): void {
  if (process.env[HRC_SESSION_RETENTION_SWEEP_ENABLED_ENV] === '0') return
  void this.runRecurringSessionRetention()
  this.sessionRetentionTimer = setInterval(() => {
    void this.runRecurringSessionRetention()
  }, HRC_SESSION_RETENTION_SWEEP_INTERVAL_MS)
}

export async function runRecurringSessionRetention(
  this: HrcServerInstanceForHandlers
): Promise<void> {
  if (this.sessionRetentionInFlight) return
  const idleThresholdDays = resolveSessionIdleArchiveDays()
  const sweep = (async () => {
    const result = archiveIdleSessions(this, idleThresholdDays)
    // Log every tick, not just the ones that changed something: a healthy idle
    // timer and a dead timer must not look identical from the log. Matches the
    // broker lease GC and tmux aging siblings.
    writeServerLog('INFO', 'session.retention_sweep_complete', { idleThresholdDays, ...result })
  })()
  this.sessionRetentionInFlight = sweep
  try {
    await sweep
  } catch (error) {
    writeServerLog('WARN', 'session.retention_sweep_failed', { idleThresholdDays, error })
  } finally {
    if (this.sessionRetentionInFlight === sweep) {
      this.sessionRetentionInFlight = undefined
    }
  }
}

export const sweepHandlersMethods = {
  handleSweepRuntimes,
  handlePruneRuntimes,
  transitionRuntimeForAging,
  runTmuxAgingOnce,
  startTmuxAging,
  runRecurringTmuxAging,
  handleKillBrokerTmuxLeases,
  handleSweepZombieRuns,
  startZombieRunSweeper,
  runRecurringZombieSweep,
  handleReconcileActiveRuns,
  startActiveRunReconciler,
  runRecurringActiveRunReconcile,
  startBrokerLeaseGc,
  runRecurringBrokerLeaseGc,
  startFirstTurnWatchdog,
  runRecurringFirstTurnEval,
  startSessionRetentionSweep,
  runRecurringSessionRetention,
  appendSweepCompletedEvent,
  resolveSweepSummarySession,
}

export type SweepHandlersMethods = typeof sweepHandlersMethods
