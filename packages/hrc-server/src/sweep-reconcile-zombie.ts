import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRunRecord,
  SweepZombieRunResult,
  SweepZombieRunsResponse,
  SweepZombieRunsSummary,
} from 'hrc-core'

import { runtimeHasOpenAskBracket } from './ask-bracket.js'
import { isCompilerPrimingActive } from './compiler-priming.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { HRC_SERVER_RUN_COLUMNS } from './server-constants.js'
import type { ServerContext } from './server-context.js'
import type {
  HrcServerRunRow,
  LatestRunEventRow,
  ObservedRunActivity,
  ZombieRunCandidate,
} from './server-types.js'
import { timestamp } from './server-util.js'
import { mapServerRunRow } from './sweep-helpers.js'

const HRC_ZOMBIE_ACTIVE_RUN_STATUSES = ['accepted', 'started', 'running'] as const
const HRC_ZOMBIE_ERROR_MESSAGE = 'run had no events for more than 30 minutes'

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

/**
 * T-07944: a cold-birth accepted run whose caller prompt is still owed.
 *
 * A promptless cold boot accepts the run, boots the invocation with the
 * compiler-owned priming input (no run identity, by design), and only submits
 * the caller's prompt once that priming turn goes terminal. Between those two
 * points the run emits NOTHING after `turn.accepted` — while the seat is in
 * fact working. Reading the run's own clock therefore counted priming time as
 * silence and buried live seats as zombies (8 of 12 observed zombies had
 * priming turns of 32-97 min still running at sweep time).
 *
 * The runtime's clock is the honest one for that window. It is not an
 * exemption: a runtime that goes genuinely silent still ages out at the same
 * threshold, and the result carries `observedSource: 'runtime_event'` so the
 * zombied payload says which clock made it a candidate.
 */
function coldBirthPrimingObservedActivity(
  ctx: ServerContext,
  run: HrcRunRecord
): ObservedRunActivity | undefined {
  if (run.status !== 'accepted' || run.dispatchedInputId !== undefined) return undefined
  const runtimeId = run.runtimeId
  if (runtimeId === undefined) return undefined
  const runtime = ctx.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null || !isCompilerPrimingActive(ctx.db, runtime)) return undefined

  const latestRuntimeEvent = ctx.db.sqlite
    .query<LatestRunEventRow, [string]>(
      `
          SELECT ts FROM hrc_events
          WHERE runtime_id = ?
          ORDER BY ts DESC, hrc_seq DESC
          LIMIT 1
        `
    )
    .get(runtimeId)
  const latestBrokerEvent = ctx.db.sqlite
    .query<{ ts: string }, [string]>(
      `
          SELECT time AS ts FROM broker_invocation_events
          WHERE runtime_id = ?
          ORDER BY time DESC, id DESC
          LIMIT 1
        `
    )
    .get(runtimeId)
  const observedAt = [
    latestRuntimeEvent?.ts,
    latestBrokerEvent?.ts,
    runtime.lastActivityAt,
    run.acceptedAt,
    run.updatedAt,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .reduce((newest, value) => (value > newest ? value : newest), '')
  if (observedAt.length === 0) return undefined
  return {
    observedAt,
    observedSource: 'runtime_event',
    ...(latestRuntimeEvent ? { latestEventAt: latestRuntimeEvent.ts } : {}),
  }
}

export function latestObservedRunActivity(
  ctx: ServerContext,
  run: HrcRunRecord
): ObservedRunActivity {
  const coldBirthPriming = coldBirthPrimingObservedActivity(ctx, run)
  if (coldBirthPriming) return coldBirthPriming

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
