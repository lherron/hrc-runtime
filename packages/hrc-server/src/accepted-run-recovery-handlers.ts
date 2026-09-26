import { HrcErrorCode } from 'hrc-core'
import type { HrcRunRecord, RecoverUnstartedRunResponse } from 'hrc-core'

import {
  ACCEPTED_RUN_NEVER_STARTED_REASON,
  terminalizeWithdrawnAcceptedRun,
} from './accepted-run-recovery.js'
import { runtimeHasAnyOpenAskBracket } from './ask-bracket.js'
import type { HarnessBrokerController } from './broker/controller.js'
import { isCompilerPrimingActive } from './compiler-priming.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody, parseRecoverUnstartedRunRequest } from './server-parsers.js'
import { json, timestamp } from './server-util.js'

// This is only a quiet-period gate before the live probe. It never establishes
// recovery eligibility by itself: a current idle, zero-held broker seat does.
const RECOVERY_QUIET_PERIOD_MS = 5 * 60_000

type Candidate = {
  run: HrcRunRecord
  runtimeId: string
  invocationId: string
  operationId: string
  submissionId: string
}

type CandidateRejection = { reason: string; runtimeId?: string | undefined }

function skipped(runId: string, reason: string, runtimeId?: string): RecoverUnstartedRunResponse {
  return {
    ok: true,
    runId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    status: 'skipped',
    reason,
  }
}

function isQuietEnough(values: Array<string | undefined>): boolean {
  const observed = values
    .map((value) => (value === undefined ? Number.NaN : Date.parse(value)))
    .filter((value) => Number.isFinite(value))
  if (observed.length === 0) return false
  return Date.now() - Math.max(...observed) >= RECOVERY_QUIET_PERIOD_MS
}

function exactCandidate(
  server: HrcServerInstanceForHandlers,
  run: HrcRunRecord
): Candidate | CandidateRejection {
  if (run.status !== 'accepted' || run.startedAt !== undefined || run.completedAt !== undefined) {
    return { reason: 'run_not_accepted_without_start', runtimeId: run.runtimeId }
  }
  if (
    run.runtimeId === undefined ||
    run.invocationId === undefined ||
    run.operationId === undefined ||
    run.dispatchedInputId === undefined ||
    run.brokerSubmissionId === undefined ||
    run.dispatchedInputId !== run.brokerSubmissionId
  ) {
    return { reason: 'exact_submission_identity_absent', runtimeId: run.runtimeId }
  }
  const runtime = server.db.runtimes.getByRuntimeId(run.runtimeId)
  if (
    runtime === null ||
    runtime.controllerKind !== 'harness-broker' ||
    runtime.status !== 'busy' ||
    runtime.activeRunId !== run.runId ||
    runtime.activeInvocationId !== run.invocationId ||
    runtime.activeOperationId !== run.operationId ||
    runtime.wrapperPid !== undefined ||
    runtime.childPid !== undefined ||
    isExternalLifecycleOwner(runtime)
  ) {
    return { reason: 'runtime_not_exact_stale_owner', runtimeId: run.runtimeId }
  }
  const invocation = server.db.brokerInvocations.getByInvocationId(run.invocationId)
  if (
    invocation === null ||
    invocation.runtimeId !== runtime.runtimeId ||
    invocation.operationId !== run.operationId ||
    invocation.invocationState !== 'ready'
  ) {
    return { reason: 'invocation_not_ready', runtimeId: run.runtimeId }
  }
  if (runtimeHasAnyOpenAskBracket(server.db, runtime)) {
    return { reason: 'open_ask_bracket', runtimeId: run.runtimeId }
  }
  if (isCompilerPrimingActive(server.db, runtime)) {
    return { reason: 'compiler_priming_active', runtimeId: run.runtimeId }
  }
  if (!isQuietEnough([runtime.lastActivityAt, invocation.updatedAt, run.updatedAt])) {
    return { reason: 'broker_activity_within_quiet_period', runtimeId: run.runtimeId }
  }
  return {
    run,
    runtimeId: runtime.runtimeId,
    invocationId: run.invocationId,
    operationId: run.operationId,
    submissionId: run.dispatchedInputId,
  }
}

/**
 * A process can die after the withdrawal terminal projection but before the
 * separate ready normalization. The retry does no new withdrawal; it accepts
 * only the retained exact broker evidence and performs one fresh seat probe.
 */
function retryCandidate(
  server: HrcServerInstanceForHandlers,
  run: HrcRunRecord
): Candidate | CandidateRejection {
  if (
    run.status !== 'failed' ||
    run.completedAt === undefined ||
    run.errorCode !== HrcErrorCode.RUN_ACCEPTED_NEVER_STARTED ||
    run.runtimeId === undefined ||
    run.invocationId === undefined ||
    run.operationId === undefined ||
    run.dispatchedInputId === undefined ||
    run.brokerSubmissionId !== run.dispatchedInputId
  ) {
    return { reason: 'recovery_projection_not_pending', runtimeId: run.runtimeId }
  }
  const runtime = server.db.runtimes.getByRuntimeId(run.runtimeId)
  const invocation = server.db.brokerInvocations.getByInvocationId(run.invocationId)
  if (
    runtime === null ||
    invocation === null ||
    runtime.controllerKind !== 'harness-broker' ||
    runtime.status !== 'busy' ||
    runtime.activeRunId !== undefined ||
    runtime.activeOperationId !== run.operationId ||
    runtime.activeInvocationId !== run.invocationId ||
    runtime.wrapperPid !== undefined ||
    runtime.childPid !== undefined ||
    invocation.runtimeId !== runtime.runtimeId ||
    invocation.operationId !== run.operationId ||
    invocation.invocationState !== 'ready' ||
    isExternalLifecycleOwner(runtime) ||
    runtimeHasAnyOpenAskBracket(server.db, runtime) ||
    isCompilerPrimingActive(server.db, runtime) ||
    !hasExactWithdrawalEvidence(server, run.invocationId, run.dispatchedInputId)
  ) {
    return { reason: 'recovery_retry_not_proven', runtimeId: run.runtimeId }
  }
  return {
    run,
    runtimeId: runtime.runtimeId,
    invocationId: run.invocationId,
    operationId: run.operationId,
    submissionId: run.dispatchedInputId,
  }
}

function matchesIdleProbe(
  result: Awaited<ReturnType<HarnessBrokerController['seatProbe']>>,
  invocationId: string
): boolean {
  return (
    result.ok &&
    result.response.invocationId === invocationId &&
    result.response.seat.state === 'idle' &&
    result.response.brokerHeldDepth === 0
  )
}

function hasExactWithdrawalEvidence(
  server: HrcServerInstanceForHandlers,
  invocationId: string,
  submissionId: string
): boolean {
  return server.db.brokerInvocationEvents.listByInvocationId(invocationId).some((event) => {
    if (event.type !== 'submission.withdrawn') return false
    try {
      const payload = JSON.parse(event.brokerEventJson) as Record<string, unknown>
      return (
        payload['submissionId'] === submissionId &&
        payload['reason'] === ACCEPTED_RUN_NEVER_STARTED_REASON
      )
    } catch {
      return false
    }
  })
}

async function normalizeReadyAfterRecovery(
  server: HrcServerInstanceForHandlers,
  candidate: Pick<Candidate, 'run' | 'runtimeId' | 'invocationId' | 'operationId'>
): Promise<boolean> {
  const runtime = server.db.runtimes.getByRuntimeId(candidate.runtimeId)
  const invocation = server.db.brokerInvocations.getByInvocationId(candidate.invocationId)
  const run = server.db.runs.getByRunId(candidate.run.runId)
  if (
    runtime === null ||
    invocation === null ||
    run === null ||
    runtime.status !== 'busy' ||
    runtime.activeRunId !== undefined ||
    runtime.activeInvocationId !== candidate.invocationId ||
    runtime.activeOperationId !== candidate.operationId ||
    runtime.wrapperPid !== undefined ||
    runtime.childPid !== undefined ||
    runtime.controllerKind !== 'harness-broker' ||
    invocation.runtimeId !== candidate.runtimeId ||
    invocation.operationId !== candidate.operationId ||
    invocation.invocationState !== 'ready' ||
    run.errorCode !== HrcErrorCode.RUN_ACCEPTED_NEVER_STARTED ||
    run.completedAt === undefined ||
    isExternalLifecycleOwner(runtime) ||
    runtimeHasAnyOpenAskBracket(server.db, runtime) ||
    isCompilerPrimingActive(server.db, runtime)
  ) {
    return false
  }
  const probe = await server.getHarnessBrokerController().seatProbe(candidate.runtimeId)
  if (!matchesIdleProbe(probe, candidate.invocationId)) return false

  const now = timestamp()
  const updated = server.db.sqlite
    .query(
      `UPDATE runtimes
          SET status = 'ready', status_changed_at = ?, updated_at = ?
        WHERE runtime_id = ?
          AND status = 'busy'
          AND active_run_id IS NULL
          AND active_invocation_id = ?
          AND active_operation_id = ?
          AND controller_kind = 'harness-broker'
          AND wrapper_pid IS NULL
          AND child_pid IS NULL
          AND EXISTS (
            SELECT 1 FROM broker_invocations
             WHERE invocation_id = ?
               AND runtime_id = ?
               AND operation_id = ?
               AND invocation_state = 'ready'
          )`
    )
    .run(
      now,
      now,
      candidate.runtimeId,
      candidate.invocationId,
      candidate.operationId,
      candidate.invocationId,
      candidate.runtimeId,
      candidate.operationId
    ) as { changes?: number }
  return (updated.changes ?? 0) === 1
}

/**
 * T-08385's explicit recovery door. It is intentionally single-run and has no
 * selector or timer form: an operator reviews this exact candidate first.
 */
export async function handleRecoverUnstartedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseRecoverUnstartedRunRequest(await parseJsonBody(request))
  const run = this.db.runs.getByRunId(body.runId)
  if (run === null) {
    return json(skipped(body.runId, 'unknown_run'))
  }

  const retrying =
    run.status === 'failed' &&
    run.completedAt !== undefined &&
    run.errorCode === HrcErrorCode.RUN_ACCEPTED_NEVER_STARTED
  const candidate = retrying ? retryCandidate(this, run) : exactCandidate(this, run)
  if ('reason' in candidate) return json(skipped(run.runId, candidate.reason, candidate.runtimeId))

  const dryRun = body.dryRun === true || body.yes !== true
  if (retrying) {
    if (dryRun) {
      return json({
        ok: true,
        runId: candidate.run.runId,
        runtimeId: candidate.runtimeId,
        status: 'matched',
      } satisfies RecoverUnstartedRunResponse)
    }
    const normalized = await normalizeReadyAfterRecovery(this, candidate)
    return json({
      ok: true,
      runId: candidate.run.runId,
      runtimeId: candidate.runtimeId,
      status: normalized ? 'recovered' : 'projection_pending',
    } satisfies RecoverUnstartedRunResponse)
  }

  const initialProbe = await this.getHarnessBrokerController().seatProbe(candidate.runtimeId)
  if (!matchesIdleProbe(initialProbe, candidate.invocationId)) {
    return json(skipped(run.runId, 'live_seat_not_idle', candidate.runtimeId))
  }
  if (dryRun) {
    return json({
      ok: true,
      runId: candidate.run.runId,
      runtimeId: candidate.runtimeId,
      status: 'matched',
    } satisfies RecoverUnstartedRunResponse)
  }

  const withdrawal = await this.getHarnessBrokerController().withdraw({
    runtimeId: candidate.runtimeId,
    submissionId: candidate.submissionId,
    reason: ACCEPTED_RUN_NEVER_STARTED_REASON,
  })
  if (!withdrawal.ok) {
    return json(skipped(run.runId, 'broker_withdraw_unavailable', candidate.runtimeId))
  }
  if (withdrawal.response.outcome !== 'withdrawn') {
    // `not_held` becomes recoverable only after the retained exact broker event
    // exists. This request has no authority to guess that terminal evidence.
    return json({
      ok: true,
      runId: candidate.run.runId,
      runtimeId: candidate.runtimeId,
      status: hasExactWithdrawalEvidence(this, candidate.invocationId, candidate.submissionId)
        ? 'projection_pending'
        : 'skipped',
      reason: 'withdrawal_not_durable',
    } satisfies RecoverUnstartedRunResponse)
  }

  const event = this.db.sqlite.transaction(() =>
    terminalizeWithdrawnAcceptedRun(this.db, {
      runId: candidate.run.runId,
      runtimeId: candidate.runtimeId,
      invocationId: candidate.invocationId,
      submissionId: candidate.submissionId,
      reason: ACCEPTED_RUN_NEVER_STARTED_REASON,
      now: timestamp(),
    })
  )()
  if (event !== undefined) this.notifyEvent(event)

  const normalized = await normalizeReadyAfterRecovery(this, candidate)
  return json({
    ok: true,
    runId: candidate.run.runId,
    runtimeId: candidate.runtimeId,
    status: normalized ? 'recovered' : 'projection_pending',
  } satisfies RecoverUnstartedRunResponse)
}

export const acceptedRunRecoveryHandlersMethods = { handleRecoverUnstartedRun }

export type AcceptedRunRecoveryHandlersMethods = typeof acceptedRunRecoveryHandlersMethods
