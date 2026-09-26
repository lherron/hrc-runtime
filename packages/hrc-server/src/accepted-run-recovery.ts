import { HrcErrorCode } from 'hrc-core'
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from './hrc-event-helper.js'

/** Exact broker reason that authorizes this bounded recovery. */
export const ACCEPTED_RUN_NEVER_STARTED_REASON = 'accepted_run_never_started'

type TerminalizeWithdrawnAcceptedRunInput = {
  runId?: string | undefined
  runtimeId: string
  invocationId: string
  submissionId: string | undefined
  reason: string | undefined
  now: string
}

/**
 * Apply the one durable effect authorized by an exact broker withdrawal.
 *
 * This helper never changes runtime status. A caller may clear only the exact
 * stale `activeRunId`; a live recovery door separately proves readiness.
 * Call it inside the caller's SQLite transaction when it shares a broker event
 * projection. It is idempotent at the terminal run write.
 */
export function terminalizeWithdrawnAcceptedRun(
  db: HrcDatabase,
  input: TerminalizeWithdrawnAcceptedRunInput
): HrcLifecycleEvent | undefined {
  if (
    input.reason !== ACCEPTED_RUN_NEVER_STARTED_REASON ||
    input.submissionId === undefined ||
    input.submissionId.length === 0
  ) {
    return undefined
  }

  const run =
    (input.runId === undefined ? null : db.runs.getByRunId(input.runId)) ??
    db.runs.getByBrokerSubmissionId(input.submissionId)
  if (
    run === null ||
    run.runtimeId !== input.runtimeId ||
    run.invocationId !== input.invocationId ||
    run.status !== 'accepted' ||
    run.startedAt !== undefined ||
    run.completedAt !== undefined ||
    run.dispatchedInputId !== input.submissionId ||
    run.brokerSubmissionId !== input.submissionId
  ) {
    return undefined
  }

  const claimed = db.sqlite
    .query(
      `UPDATE runs
          SET status = 'failed', completed_at = ?, updated_at = ?,
              error_code = ?, error_message = ?
        WHERE run_id = ?
          AND runtime_id = ?
          AND invocation_id = ?
          AND status = 'accepted'
          AND started_at IS NULL
          AND completed_at IS NULL
          AND dispatched_input_id = ?
          AND broker_submission_id = ?`
    )
    .run(
      input.now,
      input.now,
      HrcErrorCode.RUN_ACCEPTED_NEVER_STARTED,
      'accepted broker submission was withdrawn before a turn started',
      run.runId,
      input.runtimeId,
      input.invocationId,
      input.submissionId,
      input.submissionId
    ) as { changes?: number }
  if ((claimed.changes ?? 0) !== 1) return undefined

  // The pointer may already be gone or reassigned. Clear it only when it still
  // names this exact terminalized run, and never infer a ready state here.
  db.sqlite
    .query(
      `UPDATE runtimes
          SET active_run_id = NULL, updated_at = ?
        WHERE runtime_id = ? AND active_run_id = ?`
    )
    .run(input.now, input.runtimeId, run.runId)

  return appendHrcEvent(db, 'turn.reaped', {
    ts: input.now,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: run.generation,
    runId: run.runId,
    runtimeId: input.runtimeId,
    ...(run.transport === 'sdk' || run.transport === 'tmux' || run.transport === 'headless'
      ? { transport: run.transport }
      : {}),
    errorCode: HrcErrorCode.RUN_ACCEPTED_NEVER_STARTED,
    payload: {
      runId: run.runId,
      runtimeId: input.runtimeId,
      invocationId: input.invocationId,
      submissionId: input.submissionId,
      reason: ACCEPTED_RUN_NEVER_STARTED_REASON,
      finalizedRunStatus: 'failed',
      source: 'accepted-run-recovery',
    },
  })
}
