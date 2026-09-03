import type { HrcSessionRecord } from 'hrc-core'
import type { HrcMailDriveAttempt, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import { presentationKeyFor } from '../auto-reply-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import {
  type HeldBatchActionableEnvelope,
  MAX_PRESENTED_PER_ATTEMPT,
  revalidateHeldBatch,
} from './held-batch.js'

export type ObservedBrokerSeat =
  | { state: 'absent' }
  | { state: 'unavailable'; runtimeId: string }
  | { state: 'idle'; runtimeId: string }
  | { state: 'turn-active'; runtimeId: string; turnId: string }
  | { state: 'starting' | 'stopping' | 'terminal'; runtimeId: string }

export function seatCanDispatch(seat: ObservedBrokerSeat): boolean {
  return seat.state === 'idle' || seat.state === 'absent'
}

/**
 * Recover a crash during the per-envelope receipt commit for one batch input.
 *
 * The broker input already exists and is identified by the stable run row;
 * this fills only missing wrkq receipts with the same driveAttemptId/inputId.
 */
export async function replayHeldBatchReceipts(
  server: HrcServerInstanceForHandlers,
  attempt: HrcMailDriveAttempt
): Promise<void> {
  if (attempt.heldBehindTurnId === undefined || attempt.state === 'held') return
  const run = server.db.runs.getByRunId(attempt.runId)
  const inputId = run?.dispatchedInputId
  if (
    run === null ||
    inputId === undefined ||
    attempt.hostSessionId === undefined ||
    attempt.generation === undefined ||
    attempt.runtimeId === undefined
  ) {
    return
  }

  const replayed: string[] = []
  for (const envelopeId of server.db.mailDrives.presentationEnvelopeIds(attempt.driveAttemptId)) {
    const envelope = await server.wrkqLedger.envelopeShow({ envelope: envelopeId })
    if (
      envelope.terminal ||
      envelope.presentedTo.some((receipt) => receipt.driveAttemptId === attempt.driveAttemptId)
    ) {
      continue
    }
    await server.wrkqLedger.present({
      envelope: envelopeId,
      node: server.federationNodeId,
      hostSessionId: attempt.hostSessionId,
      generation: String(attempt.generation),
      runId: attempt.runId,
      runtimeId: attempt.runtimeId,
      inputId,
      driveAttemptId: attempt.driveAttemptId,
    })
    replayed.push(envelopeId)
  }
  if (replayed.length > 0) {
    writeServerLog('INFO', 'wrkq.kicker.queue_batch_receipts_replayed', {
      targetSessionRef: attempt.targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      inputId,
      envelopeIds: replayed,
    })
  }
}

/**
 * Freeze and activate the oldest HRC-held batch at an observed boundary.
 *
 * The injected second seat probe is authoritative. If another turn wins the
 * boundary interval, the batch remains held for the next terminal event.
 */
export async function prepareHeldBatchForBoundary(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  session: HrcSessionRecord,
  held: HrcMailDriveAttempt,
  actionable: readonly HeldBatchActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason,
  observeSeat: (session: HrcSessionRecord) => Promise<ObservedBrokerSeat>
): Promise<
  { attempt: HrcMailDriveAttempt; actionable: HeldBatchActionableEnvelope[] } | undefined
> {
  if (held.runtimeId === undefined) {
    server.db.mailDrives.failWithoutStart(
      held.driveAttemptId,
      'HRC-held queue batch has no broker runtime identity'
    )
    writeServerLog('WARN', 'wrkq.kicker.queue_batch_invalid', {
      targetSessionRef,
      driveAttemptId: held.driveAttemptId,
      reason: 'missing_runtime_id',
    })
    return undefined
  }

  const appended = server.db.mailDrives.holdQueuedAttempt(
    {
      targetSessionRef,
      wakeReason,
      envelopeIds: actionable
        .filter((item) => item.envelope.delivery === 'queue')
        .map((item) => item.envelope.id),
      heldBehindTurnId: held.heldBehindTurnId ?? 'unknown',
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: held.runtimeId,
      materializationIntent: held.materializationIntent,
    },
    MAX_PRESENTED_PER_ATTEMPT
  )
  const surviving = await revalidateHeldBatch(server, appended.attempt)
  if (surviving.length === 0) return undefined

  const oldest = surviving[0]
  if (oldest === undefined) return undefined
  const presentationKey = presentationKeyFor(oldest.envelope)
  const selected =
    presentationKey === undefined
      ? surviving.slice(0, 1)
      : surviving
          .filter((item) => presentationKeyFor(item.envelope) === presentationKey)
          .slice(0, MAX_PRESENTED_PER_ATTEMPT)

  const boundarySeat = await observeSeat(session)
  if (!seatCanDispatch(boundarySeat)) {
    writeServerLog('INFO', 'wrkq.kicker.queue_batch_foreign_turn_won', {
      targetSessionRef,
      driveAttemptId: held.driveAttemptId,
      wakeReason,
      observedSeatState: boundarySeat.state,
      ...(boundarySeat.state === 'turn-active' ? { observedTurnId: boundarySeat.turnId } : {}),
      envelopeIds: surviving.map((item) => item.envelope.id),
    })
    return undefined
  }

  const activated = server.db.mailDrives.activateHeldAttempt(
    held.driveAttemptId,
    selected.map((item) => item.envelope.id),
    {
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      // `absent` is also dispatchable: clear the dead held runtime now and let
      // the accepted dispatch install the newly materialized runtime below.
      runtimeId: boundarySeat.state === 'idle' ? boundarySeat.runtimeId : undefined,
    }
  )
  if (activated.outcome !== 'acquired') {
    writeServerLog('INFO', 'wrkq.kicker.queue_batch_slot_busy', {
      targetSessionRef,
      driveAttemptId: held.driveAttemptId,
      wakeReason,
      activeDriveAttemptId:
        activated.outcome === 'active' ? activated.attempt.driveAttemptId : undefined,
    })
    return undefined
  }
  const leftHeldCount = server.db.mailDrives.getHeldAttempt(targetSessionRef)?.presentedCount ?? 0
  writeServerLog('INFO', 'wrkq.kicker.queue_batch_flush_selected', {
    targetSessionRef,
    driveAttemptId: activated.attempt.driveAttemptId,
    wakeReason,
    presentationKey,
    selectedEnvelopeIds: selected.map((item) => item.envelope.id),
    leftHeldCount,
  })
  return { attempt: activated.attempt, actionable: selected }
}
