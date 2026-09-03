import { HrcErrorCode } from 'hrc-core'
import type { HrcRunRecord } from 'hrc-core'

import {
  failColdBootInputContinuation,
  parseDurableColdBootTurnInput,
  waitForCompilerPrimingTerminal,
} from './broker-headless-handlers.js'
import { requireSession } from './require-helpers.js'
import { HRC_SERVER_RUN_COLUMNS } from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { HrcServerRunRow } from './server-types.js'
import { isRuntimeUnavailableStatus } from './server-util.js'
import { mapServerRunRow } from './sweep-helpers.js'

/**
 * Startup recovery for cold-birth accepted runs whose prompt is still owed
 * (T-07944 change 2).
 *
 * `executeHeadlessBrokerStartTurn` accepts the run, boots the invocation with
 * the compiler priming input, and then — in a detached, process-local chain —
 * waits for the priming turn to go terminal before submitting the caller's
 * prompt through the invoke door. A daemon restart inside that window used to
 * drop the chain silently: the run stayed `accepted` with no
 * `dispatched_input_id`, nothing in the ledger said the prompt had been lost,
 * and 30 minutes later the zombie sweep buried it as "no events" — after which
 * the sender resent a message the agent had, in truth, already acted on.
 *
 * The prompt is now durable in `runs.correlation_json` from the moment of
 * acceptance, so exactly one of two honest outcomes is possible here:
 *
 *  - the invocation survived the restart -> re-arm wait-priming -> submit, and
 *    the run reaches `started`/`completed` as it always should have;
 *  - it did not -> fail the run NOW with a positive reason code
 *    (`cold_input_continuation_lost`) and a `turn.failed`, so the waiting mail
 *    drive fails truthfully and immediately instead of on a 30-minute silence.
 *
 * Must run AFTER the broker warmup: warmup is the sole attach+replay authority,
 * and a probe before it would read a live seat as absent.
 */
export async function recoverColdBootInputContinuations(
  server: HrcServerInstanceForHandlers
): Promise<void> {
  const runs = listColdBootAcceptedRuns(server)
  if (runs.length === 0) return
  writeServerLog('INFO', 'broker.cold_boot_input.recovery_started', { candidates: runs.length })
  await Promise.all(runs.map((run) => recoverOne(server, run)))
}

function listColdBootAcceptedRuns(server: HrcServerInstanceForHandlers): HrcRunRecord[] {
  return server.db.sqlite
    .query<HrcServerRunRow, []>(
      `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status = 'accepted'
            AND transport = 'headless'
            AND dispatched_input_id IS NULL
            AND completed_at IS NULL
          ORDER BY accepted_at ASC, run_id ASC`
    )
    .all()
    .map(mapServerRunRow)
}

async function recoverOne(server: HrcServerInstanceForHandlers, run: HrcRunRecord): Promise<void> {
  const runId = run.runId
  const lost = (detail: Record<string, unknown>): void => {
    failColdBootInputContinuation(server, runId, {
      errorCode: HrcErrorCode.COLD_INPUT_CONTINUATION_LOST,
      phase: 'cold-boot-input-recovery',
      detail,
    })
  }

  const delivery = parseDurableColdBootTurnInput(server.db.runs.getCorrelationJson(runId))
  if (delivery === undefined) {
    // Accepted before the prompt was made durable (or the correlation belongs to
    // another shape). There is nothing to resubmit, so say that rather than
    // leaving the run to age into a zombie.
    lost({ reason: 'prompt_not_durable' })
    return
  }

  const runtimeId = run.runtimeId
  const runtime = runtimeId === undefined ? null : server.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null) {
    lost({ reason: 'runtime_missing', ...(runtimeId !== undefined ? { runtimeId } : {}) })
    return
  }
  if (isRuntimeUnavailableStatus(runtime.status)) {
    lost({ reason: 'runtime_unavailable', runtimeId: runtime.runtimeId, status: runtime.status })
    return
  }
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    lost({ reason: 'invocation_absent', runtimeId: runtime.runtimeId })
    return
  }

  // Liveness is proved against the real broker binding, never inferred from the
  // runtime row: a probe that cannot reach the seat is exactly the case where
  // the prompt can never be delivered, and it must fail now rather than block
  // the priming wait forever.
  const probe = await server.getHarnessBrokerController().seatProbe(runtime.runtimeId)
  if (!probe.ok) {
    lost({
      reason: 'seat_probe_failed',
      runtimeId: runtime.runtimeId,
      invocationId,
      probeError: probe.error.code,
    })
    return
  }

  try {
    const session = requireSession(server.db, run.hostSessionId)
    await waitForCompilerPrimingTerminal(server, runtime, server.runtimeStartPresentationSignal)
    writeServerLog('INFO', 'broker.cold_boot_input.rearmed', {
      runId,
      runtimeId: runtime.runtimeId,
      invocationId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
    })
    await server.executeHeadlessBrokerInputTurn(session, runtime, delivery.prompt, runId, {
      ...delivery.dispatch,
      ...(delivery.responseFormat !== undefined ? { responseFormat: delivery.responseFormat } : {}),
      waitForCompletion: false,
    })
  } catch (error) {
    failColdBootInputContinuation(server, runId, {
      errorCode: HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED,
      phase: 'cold-boot-input-recovery',
      error,
      detail: { runtimeId: runtime.runtimeId, invocationId },
    })
  }
}
