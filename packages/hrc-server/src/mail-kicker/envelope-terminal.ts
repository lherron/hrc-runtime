import { RUNTIME_STATUS_LEVEL_BY_STATUS } from 'hrc-core'

import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { parseSessionRef } from '../server-parsers.js'
import type { WrkqEnvelope, WrkqEnvelopeFailureReason } from '../wrkq/ledger-types.js'

export type EnvelopeFailCallSite =
  | 'birth_refusals_exhausted'
  | 'dispose_attempt_obligations'
  | 'lapsed_obligations'
  | 'queued_injection_expiry'

type EnvelopeFailInput = {
  envelope: string
  reason: Exclude<WrkqEnvelopeFailureReason, 'legacy'>
  runtime?: string | undefined
  targetSessionRef: string
  driveAttemptId?: string | undefined
  callSite: EnvelopeFailCallSite
}

export type EnvelopeFailOutcome =
  | { outcome: 'failed'; envelope: WrkqEnvelope }
  | { outcome: 'suppressed_live_target'; runtimeId: string; runtimeStatus: string }

/** A local runtime row is live until monitor truth classifies it runtime-dead. */
function liveRuntimeForTarget(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string
): { runtimeId: string; status: string } | undefined {
  let target: ReturnType<typeof parseSessionRef>
  try {
    target = parseSessionRef(targetSessionRef)
  } catch {
    return undefined
  }
  return server.db.runtimes
    .listAll()
    .filter((runtime) => runtime.scopeRef === target.scopeRef && runtime.laneRef === target.laneRef)
    .find(
      (runtime) =>
        (RUNTIME_STATUS_LEVEL_BY_STATUS as Record<string, string | null | undefined>)[
          runtime.status
        ] !== 'runtime-dead'
    )
}

/**
 * The one HRC boundary for an unsuccessful envelope terminal transition.
 *
 * The audit line is deliberately BEFORE the RPC: a process exit, a rejected
 * response, or a logging failure after the write must never erase who tried to
 * terminal the row. `undeliverable` gets one last local-liveness read at this
 * boundary. Candidate discovery and the RPC are asynchronous; a scope can be
 * born between them, and D7 has no authority to fail mail once that happens.
 */
export async function failEnvelopeWithAudit(
  server: HrcServerInstanceForHandlers,
  input: EnvelopeFailInput
): Promise<EnvelopeFailOutcome> {
  if (input.reason === 'undeliverable') {
    const live = liveRuntimeForTarget(server, input.targetSessionRef)
    if (live !== undefined) {
      writeServerLog('WARN', 'wrkq.kicker.envelope_terminal_suppressed', {
        operation: 'fail',
        callSite: input.callSite,
        targetSessionRef: input.targetSessionRef,
        envelope: input.envelope,
        reason: input.reason,
        runtimeId: live.runtimeId,
        runtimeStatus: live.status,
        suppression: 'live_target',
      })
      return {
        outcome: 'suppressed_live_target',
        runtimeId: live.runtimeId,
        runtimeStatus: live.status,
      }
    }
  }

  writeServerLog('INFO', 'wrkq.kicker.envelope_terminal_call', {
    operation: 'fail',
    callSite: input.callSite,
    targetSessionRef: input.targetSessionRef,
    ...(input.driveAttemptId === undefined ? {} : { driveAttemptId: input.driveAttemptId }),
    envelope: input.envelope,
    reason: input.reason,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    phase: 'before_rpc',
  })
  const failed = await server.wrkqLedger.fail({
    envelope: input.envelope,
    reason: input.reason,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  })
  writeServerLog('INFO', 'wrkq.kicker.envelope_failed', {
    callSite: input.callSite,
    targetSessionRef: input.targetSessionRef,
    ...(input.driveAttemptId === undefined ? {} : { driveAttemptId: input.driveAttemptId }),
    envelope: input.envelope,
    reason: input.reason,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    state: failed.state,
  })
  return { outcome: 'failed', envelope: failed }
}
