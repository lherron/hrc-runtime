/**
 * T-10829: a terminal runtime owns no run.
 *
 * `active_run_id` is the projection's "mid-turn whatever the status says"
 * signal (session-recency.ts). A runtime moved to terminated/crashed/dead that
 * keeps the pointer is therefore listed in every unscoped session read forever,
 * and the active-run reconciler and zombie sweep, which only look at live
 * runtimes, never clear it. Every write that moves a runtime to a terminal
 * status calls this in the same transaction, the way
 * `settleParticipantBrokerLoss` already failed the runtime's open runs.
 *
 * `detached` is not settled here: an EPR detachment is the linger state whose
 * exits are reattach (which resumes the turn) or finalize (which terminates and
 * settles through this helper).
 */

import { HrcErrorCode } from 'hrc-core'
import type { HrcRunRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { isActiveBrokerRun } from './broker/controller/internal.js'
import { writeServerLog } from './server-log.js'

export const RUN_HOLDING_TERMINAL_RUNTIME_STATUSES = ['terminated', 'crashed', 'dead'] as const

function isOpenRun(run: HrcRunRecord): boolean {
  return run.completedAt === undefined && (isActiveBrokerRun(run) || run.status === 'queued')
}

/**
 * Fail every open run of `runtimeId` with RUNTIME_UNAVAILABLE and clear the
 * runtime's `active_run_id`. Returns the run ids it failed. Callers that already
 * failed their own runs with a more specific message call this afterwards; it
 * skips runs that are no longer open.
 */
export function settleTerminalRuntimeRuns(
  db: HrcDatabase,
  runtimeId: string,
  input: { now: string; errorMessage: string }
): string[] {
  const failedRunIds: string[] = []
  for (const run of db.runs.listByRuntimeId(runtimeId)) {
    if (!isOpenRun(run)) continue
    db.runs.markCompleted(run.runId, {
      status: 'failed',
      completedAt: input.now,
      updatedAt: input.now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: input.errorMessage,
    })
    failedRunIds.push(run.runId)
  }
  if (db.runtimes.getByRuntimeId(runtimeId)?.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtimeId, undefined, input.now)
  }
  return failedRunIds
}

/**
 * One-time repair at daemon start for rows written before every terminal
 * transition settled its runs: a terminal runtime that still names an active
 * run. One log line per repaired row.
 */
export function reconcileTerminalRuntimeActiveRuns(db: HrcDatabase, now: string): number {
  const placeholders = RUN_HOLDING_TERMINAL_RUNTIME_STATUSES.map(() => '?').join(', ')
  const rows = db.sqlite
    .query(
      `SELECT runtime_id, status, active_run_id
         FROM runtimes
        WHERE active_run_id IS NOT NULL
          AND status IN (${placeholders})`
    )
    .all(...RUN_HOLDING_TERMINAL_RUNTIME_STATUSES) as Array<{
    runtime_id: string
    status: string
    active_run_id: string
  }>
  for (const row of rows) {
    db.sqlite.transaction(() => {
      const runStatusBefore = db.runs.getByRunId(row.active_run_id)?.status ?? null
      const failedRunIds = settleTerminalRuntimeRuns(db, row.runtime_id, {
        now,
        errorMessage: `runtime ${row.runtime_id} is ${row.status}; open run settled by startup reconcile`,
      })
      writeServerLog('WARN', 'runtime.terminal_active_run.reconciled', {
        runtimeId: row.runtime_id,
        priorStatus: row.status,
        activeRunId: row.active_run_id,
        runStatusBefore,
        runStatusAfter: db.runs.getByRunId(row.active_run_id)?.status ?? null,
        failedRunIds,
      })
    })()
  }
  return rows.length
}
