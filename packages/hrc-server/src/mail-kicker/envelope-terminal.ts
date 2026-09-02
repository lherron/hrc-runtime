import { randomUUID } from 'node:crypto'

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

const serverInstanceIds = new WeakMap<object, string>()

/**
 * Process-local identity for a terminal RPC attempt.
 *
 * Several HRC servers can exist on one host (the canonical daemon, hrc-dev,
 * isolated dev environments, and test-created instances). A pid identifies
 * the process, argv/role explains how it was entered, and the stable UUID
 * distinguishes two HrcServer instances constructed inside the same process.
 */
function terminalActorIdentity(server: HrcServerInstanceForHandlers): {
  processId: number
  processArgv0: string
  processRole: string
  serverInstanceId: string
} {
  let serverInstanceId = serverInstanceIds.get(server)
  if (serverInstanceId === undefined) {
    serverInstanceId = randomUUID()
    serverInstanceIds.set(server, serverInstanceId)
  }
  const entry = process.argv[1]?.split('/').at(-1) ?? 'unknown-entry'
  const command = process.argv.slice(2, 4).join(' ')
  return {
    processId: process.pid,
    processArgv0: process.argv0,
    processRole: command === '' ? entry : `${entry}:${command}`,
    serverInstanceId,
  }
}

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
  const actor = terminalActorIdentity(server)
  if (input.reason === 'undeliverable') {
    const live = liveRuntimeForTarget(server, input.targetSessionRef)
    if (live !== undefined) {
      writeServerLog('WARN', 'wrkq.kicker.envelope_terminal_suppressed', {
        ...actor,
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
    ...actor,
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
    ...actor,
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
