import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunResult,
  ReconcileActiveRunsResponse,
  ReconcileActiveRunsSummary,
  SweepZombieRunResult,
  SweepZombieRunsResponse,
  SweepZombieRunsSummary,
} from 'hrc-core'

import {
  isCorruptAwaitingRuntime,
  latestBrokerSeq,
  listOpenAskBrackets,
  runtimeHasOpenAskBracket,
} from './ask-bracket.js'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import { hasLeasedBrokerSubstrate } from './broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { HRC_SERVER_RUN_COLUMNS } from './server-constants.js'
import type { ServerContext } from './server-context.js'
import { writeServerLog } from './server-log.js'
import type {
  ActiveRunReconcileCandidate,
  ActiveRunReconcilePlan,
  HrcServerRunRow,
  LatestRunEventRow,
  ObservedRunActivity,
  ZombieRunCandidate,
} from './server-types.js'
import { timestamp } from './server-util.js'
import { getObservedTmuxSessionName } from './startup-reconcile.js'
import { mapServerRunRow, reconcileResultTransport } from './sweep-helpers.js'
import { createTmuxManager } from './tmux.js'

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
    // T-01946: a run parked on a user prompt has no events while it waits, so the
    // event-silence clock would mark it zombie. The durable ask bracket overrides
    // event-silence — skip it entirely (non-reapable) across the headless sweep.
    if (run.runtimeId) {
      const runtime = ctx.db.runtimes.getByRuntimeId(run.runtimeId)
      if (runtime && isExternalLifecycleOwner(runtime)) {
        continue
      }
      if (runtime && runtimeHasOpenAskBracket(ctx.db, runtime, run.runId)) {
        continue
      }
    }
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
    candidate.run.transport === 'headless'
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

      if (plan.action === 'finalize') {
        results.push(finalizeActiveRun(ctx, candidate, plan))
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

  // T-07653: runs their runtime already let go of. Also not reconcile
  // candidates — the candidate query requires the runtime to still OWN the run —
  // so they are scanned separately, on the same cutoff.
  results.push(...reconcileRunsAbandonedByTheirRuntime(ctx, cutoffMs, input.dryRun))

  // T-01946 gate 6: surface (never normalize) corrupt `awaiting_input` runtimes —
  // the status set with no active run. These are not reconcile candidates (the
  // candidate query requires an active run), so they are scanned separately and
  // reported `suspect` with enough identity to act on them.
  results.push(...reconcileCorruptAwaitingRuntimes(ctx))

  const summary: ReconcileActiveRunsSummary = {
    type: 'summary',
    matched: results.filter((result) => result.status === 'matched').length,
    reaped: results.filter((result) => result.status === 'reaped').length,
    repaired: results.filter((result) => result.status === 'repaired').length,
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

/**
 * Is this runtime demonstrably NOT executing `runId`?
 *
 * Three answers, and only the first is a plain "no run at all":
 *
 *  - it claims nothing            -> not running anything, including this run.
 *  - it claims a FINISHED run     -> a stale pointer. The runtime let go and
 *                                    only the row kept the name. Still not
 *                                    running anything.
 *  - it claims THIS run           -> `listActiveRunReconcileCandidates` and the
 *                                    branches above own that case; this pass
 *                                    must not race them for it.
 *  - it claims a live run, or one
 *    with no row to check         -> not evidence. The live case is a genuinely
 *                                    busy runtime and the queued-behind window;
 *                                    the dangling case is unverifiable, and an
 *                                    unverifiable claim is never a licence to
 *                                    finalize somebody's turn.
 *
 * `completed_at` is the terminal marker throughout, the same one the scan query
 * and the finalize guard use, so all three agree on what "finished" means.
 */
function runtimeIsNotRunning(
  ctx: ServerContext,
  runtime: HrcRuntimeSnapshot,
  runId: string
): boolean {
  if (runtime.activeRunId === undefined) return true
  if (runtime.activeRunId === runId) return false
  const claimed = ctx.db.runs.getByRunId(runtime.activeRunId)
  return claimed !== null && claimed.completedAt !== undefined
}

/**
 * Terminalize non-terminal runs whose runtime is running NOTHING.
 *
 * Every branch above reaches its run through `listActiveRunReconcileCandidates`,
 * which gates on `runtime.activeRunId === run.runId`. A run the runtime has
 * ALREADY let go of is therefore invisible to all of them: the row sits
 * `running` with no `completed_at` for the rest of the daemon's uptime. Startup
 * reconcile clears these at boot — that is why a restart "fixes" it — and
 * nothing did so on the interval, so a run that lost its runtime mid-uptime was
 * fossil until the next restart.
 *
 * It is not cosmetic. The mail kicker READS these rows to decide whether a
 * scope's drive slot is still in flight: one of them held
 * `agent:clod:project:hrc-runtime:task:T-07615/lane:main` undrivable for
 * thirteen hours and left `EN-00209` pending with an empty `presentedTo`
 * (T-07653). The kicker is a READER of the run row; terminalizing it belongs to
 * the reconciler that owns it.
 *
 * The evidence is the runtime, not the clock: a runtime that is not RUNNING
 * this run is evidence the run has already ended and only the row failed to
 * learn. "Not running it" is two shapes, and the first cut of this pass only
 * caught one of them. A runtime with no `activeRunId` owns nothing — but a
 * runtime still pointing at a run that is ITSELF terminal owns nothing either,
 * and reading that stale pointer as "busy" left eight rows on max3 unreaped on
 * runtimes that were `terminated` or `crashed`, the oldest since 2026-06-02,
 * every one of them claiming a run that had been `failed` for weeks. A claim
 * this daemon cannot verify (no such run row) is NOT evidence and is left
 * alone. The reconciler's ordinary quiescence cutoff
 * still applies to BOTH the run and the runtime — not as the reason, but as a
 * race guard. A run row is inserted moments BEFORE `active_run_id` is stamped
 * on the runtime, and a queued prompt is admitted behind another run and only
 * takes ownership when that one clears; a run inside either window must never
 * be mistaken for an abandoned one, and requiring the RUNTIME to have been idle
 * since before the cutoff closes both. `last_activity_at` is the right clock
 * for that: housekeeping never advances it (`runtime-activity.ts`), so a merely
 * swept runtime still reads as quiescent.
 */
function reconcileRunsAbandonedByTheirRuntime(
  ctx: ServerContext,
  cutoffMs: number,
  dryRun: boolean
): ReconcileActiveRunResult[] {
  const results: ReconcileActiveRunResult[] = []
  const rows = ctx.db.sqlite
    .query<HrcServerRunRow, []>(
      `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status IN ('accepted', 'started', 'running')
            AND runtime_id IS NOT NULL
            AND completed_at IS NULL
          ORDER BY updated_at ASC, run_id ASC`
    )
    .all()

  for (const row of rows) {
    const run = mapServerRunRow(row)
    if (!run.runtimeId) continue

    const runtime = ctx.db.runtimes.getByRuntimeId(run.runtimeId)
    // No runtime row at all is a different defect and a different owner.
    if (!runtime) continue
    if (isExternalLifecycleOwner(runtime)) continue
    if (!runtimeIsNotRunning(ctx, runtime, run.runId)) continue

    const observed = latestObservedRunActivity(ctx, run)
    const observedMs = Date.parse(observed.observedAt)
    if (!Number.isFinite(observedMs) || observedMs > cutoffMs) continue

    const runtimeQuiescentSince = Date.parse(runtime.lastActivityAt ?? runtime.updatedAt)
    if (!Number.isFinite(runtimeQuiescentSince) || runtimeQuiescentSince > cutoffMs) continue

    results.push(
      dryRun
        ? abandonedRunResult(run, runtime, observed, 'matched')
        : finalizeAbandonedRun(ctx, run, runtime, observed)
    )
  }
  return results
}

/** Mark an abandoned run `failed` and say so in the lifecycle ledger. */
function finalizeAbandonedRun(
  ctx: ServerContext,
  run: HrcRunRecord,
  runtime: HrcRuntimeSnapshot,
  observed: ObservedRunActivity
): ReconcileActiveRunResult {
  const now = timestamp()
  const errorMessage = `runtime ${runtime.runtimeId} is not running ${run.runId}; it ended without a terminal event`
  // Re-assert the whole predicate in the WHERE clause. Between the scan and
  // here a real dispatch may have claimed this very run, and a reconcile that
  // finalizes a turn now in flight is worse than the leak it is closing.
  const claim = ctx.db.sqlite
    .query(
      `
          UPDATE runs
          SET status = 'failed', completed_at = ?, updated_at = ?,
              error_code = ?, error_message = ?
          WHERE run_id = ?
            AND status IN ('accepted', 'started', 'running')
            AND completed_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM runtimes rt
              WHERE rt.runtime_id = ?
                AND rt.active_run_id IS NOT NULL
                AND (
                  rt.active_run_id = ?
                  OR NOT EXISTS (
                    SELECT 1 FROM runs claimed
                    WHERE claimed.run_id = rt.active_run_id
                      AND claimed.completed_at IS NOT NULL
                  )
                )
            )
        `
    )
    .run(
      now,
      now,
      HrcErrorCode.RUN_ABANDONED_BY_RUNTIME,
      errorMessage,
      run.runId,
      runtime.runtimeId,
      run.runId
    ) as { changes?: number }

  if ((claim.changes ?? 0) === 0) {
    return abandonedRunResult(run, runtime, observed, 'skipped')
  }

  // `turn.reaped` is the reconciler's own terminal kind — the one the kicker's
  // terminal set and the notification handlers already recognise. A run this
  // daemon ends on evidence is reaped, not failed by its harness.
  const event = appendHrcEvent(ctx.db, 'turn.reaped', {
    ts: now,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: run.generation,
    runId: run.runId,
    runtimeId: runtime.runtimeId,
    ...(run.transport === 'sdk' || run.transport === 'tmux' || run.transport === 'headless'
      ? { transport: run.transport }
      : {}),
    errorCode: HrcErrorCode.RUN_ABANDONED_BY_RUNTIME,
    payload: {
      success: false,
      source: 'active-run-reconcile',
      reason: 'run_abandoned_by_runtime',
      finalizedRunStatus: 'failed',
      runId: run.runId,
      runtimeId: runtime.runtimeId,
      runtimeStatus: runtime.status,
      lastObservedAt: observed.observedAt,
      observedSource: observed.observedSource,
    },
  })
  ctx.notifyEvent(event)

  writeServerLog('INFO', 'active_run_reconcile.abandoned_by_runtime', {
    runId: run.runId,
    runtimeId: runtime.runtimeId,
    runtimeStatus: runtime.status,
    lastObservedAt: observed.observedAt,
    observedSource: observed.observedSource,
  })

  return abandonedRunResult(run, runtime, observed, 'repaired')
}

function abandonedRunResult(
  run: HrcRunRecord,
  runtime: HrcRuntimeSnapshot,
  observed: ObservedRunActivity,
  status: ReconcileActiveRunResult['status']
): ReconcileActiveRunResult {
  return {
    type: 'run',
    runId: run.runId,
    hostSessionId: run.hostSessionId,
    runtimeId: runtime.runtimeId,
    transport: reconcileResultTransport(run),
    status,
    reason: 'run_abandoned_by_runtime',
    observedAt: observed.observedAt,
    observedSource: observed.observedSource,
    runtimeStatus: runtime.status,
    // Nothing to clear: the runtime already owns no run. That IS the evidence.
    runtimeOwnershipCleared: false,
    ...(status === 'repaired' ? { finalizedRunStatus: 'failed' as const } : {}),
    ...(status === 'repaired' ? { errorCode: HrcErrorCode.RUN_ABANDONED_BY_RUNTIME } : {}),
  }
}

/**
 * Scan for corrupt `awaiting_input` runtimes (status set with no `activeRunId`).
 * This combination is impossible by construction; per T-01946 gate 6 it is
 * surfaced as `suspect` with actionable identity (runtimeId, invocationId, any
 * open bracket ids, latest broker seq), never silently healed to ready/busy.
 */
function reconcileCorruptAwaitingRuntimes(ctx: ServerContext): ReconcileActiveRunResult[] {
  const results: ReconcileActiveRunResult[] = []
  const now = timestamp()
  for (const runtime of ctx.db.runtimes.listAll()) {
    if (!isCorruptAwaitingRuntime(runtime)) continue
    const invocationId = runtime.activeInvocationId
    const brackets = listOpenAskBrackets(ctx.db, runtime)
    // Surface each open bracket with its FULL authority identity
    // (invocationId, runId, harnessGeneration, turnAttempt, toolCallId) so the
    // operator-facing undo path matches the bracket the reaper/predicate uses
    // (T-01946 gate 6, daedalus). bare toolCallId/runId lists are not enough.
    const identity = {
      invocationId: invocationId ?? null,
      openBrackets: brackets.map((bracket) => ({
        runId: bracket.runId,
        toolCallId: bracket.toolCallId,
        harnessGeneration: bracket.harnessGeneration,
        turnAttempt: bracket.turnAttempt,
        seq: bracket.seq,
      })),
      latestBrokerSeq:
        invocationId !== undefined ? (latestBrokerSeq(ctx.db, invocationId) ?? null) : null,
    }
    const firstBracketRunId = brackets.find((bracket) => !!bracket.runId)?.runId ?? ''
    results.push({
      type: 'run',
      // No active run to key on; prefer an open bracket's run, else the empty id.
      runId: firstBracketRunId,
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      transport: reconcileRuntimeTransport(runtime.transport),
      status: 'suspect',
      reason: 'runtime_awaiting_without_active_run',
      observedAt: now,
      observedSource: 'updated_at',
      runtimeStatus: runtime.status,
      runtimeOwnershipCleared: false,
      errorMessage: JSON.stringify(identity),
    })
  }
  return results
}

function reconcileRuntimeTransport(transport: string): ReconcileActiveRunResult['transport'] {
  if (transport === 'sdk' || transport === 'tmux' || transport === 'headless') {
    return transport
  }
  return 'headless'
}

function listActiveRunReconcileCandidates(
  ctx: ServerContext,
  cutoffMs: number
): ActiveRunReconcileCandidate[] {
  const rows = ctx.db.sqlite
    .query<HrcServerRunRow, []>(
      `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status IN ('accepted', 'started', 'running')
            AND transport IN ('sdk', 'tmux', 'headless')
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
    if (isExternalLifecycleOwner(runtime)) continue

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

  // T-01946: a turn parked on a user prompt (open ask bracket) is NEVER reapable,
  // across every runtime status. The bracket — judged from the durable broker
  // event ledger in broker seq order — is the authority; it MUST be consulted
  // before the status-based reap branches (ready/dead/stale/busy) below, which
  // would otherwise short-circuit and kill a perfectly live, parked TUI. Suspend
  // the activity clock by returning `suspect`, mutating nothing.
  if (runtimeHasOpenAskBracket(ctx.db, runtime, candidate.run.runId)) {
    return {
      action: 'suspect',
      reason: 'runtime_awaiting_user_input',
    }
  }

  // T-04240 (daedalus DM #8234, option C): a fossilized runtime-owned run whose
  // turn actually FINISHED leaves an ORPHAN terminal in the broker ledger (the
  // run_id-less turn.completed/failed/interrupted that escaped attribution). The
  // candidate is already runtime-owned (listActiveRunReconcileCandidates gates
  // on runtime.activeRunId === run.runId). Finalize from terminal evidence
  // INSTEAD of reaping as a failure — but ONLY when no competing active run
  // could own that terminal. Body/tool/assistant evidence alone is never a
  // terminal, so it falls through to the status-based reap branches below.
  const finalizePlan = planFinalizeFromOrphanTerminal(ctx, candidate, runtime)
  if (finalizePlan) return finalizePlan

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
  // which is false for a broker without a managed tmux session, preserving tmux-only reconcile.
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

// ── T-04240: evidence-ranked finalize from an orphan broker terminal ─────────
const ORPHAN_TERMINAL_RUN_STATUS: Record<string, 'completed' | 'failed' | 'cancelled'> = {
  'turn.completed': 'completed',
  'turn.failed': 'failed',
  'turn.interrupted': 'cancelled',
}

/**
 * Plan a `finalize` repair when the broker ledger proves the candidate's turn
 * actually reached a terminal but the run was never finalized (the orphan
 * terminal carries no run_id). Returns undefined when there is no terminal
 * evidence (body-only is never a terminal — daedalus) or when a competing
 * active nonterminal run could own that terminal (ambiguous — never infer).
 */
function planFinalizeFromOrphanTerminal(
  ctx: ServerContext,
  candidate: ActiveRunReconcileCandidate,
  runtime: HrcRuntimeSnapshot
): ActiveRunReconcilePlan | undefined {
  const invocationId = runtime.activeInvocationId
  // candidate.run is projected via HRC_SERVER_RUN_COLUMNS, which omits
  // dispatched_input_id — read the full run record for the input linkage.
  const inputId = ctx.db.runs.getByRunId(candidate.run.runId)?.dispatchedInputId
  if (invocationId === undefined || inputId === undefined) return undefined

  // No other active nonterminal run may exist for this runtime — otherwise the
  // orphan terminal could belong to a different turn (T-04238 ambiguity).
  const competing = ctx.db.runs
    .listByRuntimeId(runtime.runtimeId)
    .some(
      (run) =>
        run.runId !== candidate.run.runId &&
        (run.status === 'accepted' || run.status === 'started' || run.status === 'running')
    )
  if (competing) return undefined

  // Locate the candidate's input.accepted seq, then the FIRST orphan terminal
  // (run_id NULL) after it on the same invocation.
  const acceptedRow = ctx.db.sqlite
    .query<{ seq: number }, [string, string]>(
      `SELECT seq FROM broker_invocation_events
        WHERE invocation_id = ? AND type = 'input.accepted'
          AND json_extract(broker_event_json, '$.inputId') = ?
        ORDER BY seq DESC LIMIT 1`
    )
    .get(invocationId, inputId)
  if (!acceptedRow) return undefined

  const terminalRow = ctx.db.sqlite
    .query<{ type: string }, [string, number]>(
      `SELECT type FROM broker_invocation_events
        WHERE invocation_id = ?
          AND type IN ('turn.completed', 'turn.failed', 'turn.interrupted')
          AND (run_id IS NULL OR run_id = '')
          AND seq > ?
        ORDER BY seq ASC LIMIT 1`
    )
    .get(invocationId, acceptedRow.seq)
  if (!terminalRow) return undefined

  const finalizeStatus = ORPHAN_TERMINAL_RUN_STATUS[terminalRow.type]
  if (!finalizeStatus) return undefined

  return {
    action: 'finalize',
    reason: 'runtime_active_run_reconciled_from_terminal',
    finalizeStatus,
    nextRuntimeStatus: 'ready',
  }
}

/**
 * Execute a `finalize` repair: mark the run with the evidence-derived terminal
 * status, clear runtime ownership, and emit the matching lifecycle terminal
 * event (source `active-run-reconcile`) — NOT a `turn.reaped` failure.
 */
function finalizeActiveRun(
  ctx: ServerContext,
  candidate: ActiveRunReconcileCandidate,
  plan: ActiveRunReconcilePlan
): ReconcileActiveRunResult {
  const now = timestamp()
  const finalizeStatus = plan.finalizeStatus ?? 'completed'
  const claim = ctx.db.sqlite
    .query(
      `
          UPDATE runs
          SET status = ?, completed_at = ?, updated_at = ?
          WHERE run_id = ?
            AND runtime_id = ?
            AND status IN ('accepted', 'started', 'running')
            AND completed_at IS NULL
            AND EXISTS (
              SELECT 1 FROM runtimes
              WHERE runtime_id = ? AND active_run_id = ?
            )
        `
    )
    .run(
      finalizeStatus,
      now,
      now,
      candidate.run.runId,
      candidate.runtime.runtimeId,
      candidate.runtime.runtimeId,
      candidate.run.runId
    ) as { changes?: number }

  if ((claim.changes ?? 0) === 0) {
    return activeRunReconcileResult(candidate, plan, 'skipped', false)
  }

  const runtimeUpdate = ctx.db.sqlite
    .query(
      `
          UPDATE runtimes
          SET active_run_id = NULL, status = ?, updated_at = ?, last_activity_at = ?
          WHERE runtime_id = ? AND active_run_id = ?
        `
    )
    .run(
      plan.nextRuntimeStatus ?? 'ready',
      now,
      now,
      candidate.runtime.runtimeId,
      candidate.run.runId
    ) as { changes?: number }
  const runtimeOwnershipCleared = (runtimeUpdate.changes ?? 0) > 0

  const eventKind =
    finalizeStatus === 'completed'
      ? 'turn.completed'
      : finalizeStatus === 'failed'
        ? 'turn.failed'
        : 'turn.interrupted'
  const event = appendHrcEvent(ctx.db, eventKind, {
    ts: now,
    hostSessionId: candidate.run.hostSessionId,
    scopeRef: candidate.run.scopeRef,
    laneRef: candidate.run.laneRef,
    generation: candidate.run.generation,
    runId: candidate.run.runId,
    runtimeId: candidate.runtime.runtimeId,
    ...(candidate.run.transport === 'sdk' ||
    candidate.run.transport === 'tmux' ||
    candidate.run.transport === 'headless'
      ? { transport: candidate.run.transport }
      : {}),
    payload: {
      success: finalizeStatus === 'completed',
      source: 'active-run-reconcile',
      reason: plan.reason,
      finalizedRunStatus: finalizeStatus,
      runId: candidate.run.runId,
      runtimeId: candidate.runtime.runtimeId,
    },
  })
  ctx.notifyEvent(event)

  writeServerLog('INFO', 'active_run_reconcile.repaired_from_terminal', {
    runId: candidate.run.runId,
    runtimeId: candidate.runtime.runtimeId,
    finalizedRunStatus: finalizeStatus,
    runtimeOwnershipCleared,
  })

  return {
    ...activeRunReconcileResult(candidate, plan, 'repaired', runtimeOwnershipCleared),
    finalizedRunStatus: finalizeStatus,
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
            AND transport IN ('sdk', 'tmux', 'headless')
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
    candidate.run.transport === 'headless'
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
