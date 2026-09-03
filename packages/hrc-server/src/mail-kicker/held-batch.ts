import type { HrcSessionRecord } from 'hrc-core'
import type {
  HrcMailDriveAttempt,
  HrcMailDriveWakeReason,
  HrcMailEnvelopeReminder,
} from 'hrc-store-sqlite'

import { presentationKeyFor } from '../auto-reply-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { parseSessionRef } from '../server-parsers.js'
import {
  type EnvelopePresentationForm,
  envelopeReplyAddressee,
} from '../wrkq/envelope-presentation.js'
import { buildKickRuntimeIntent } from '../wrkq/kick-intent.js'
import type { WrkqEnvelope } from '../wrkq/ledger-types.js'

/** One boundary input carries at most one room-sized page of obligations. */
export const MAX_PRESENTED_PER_ATTEMPT = 20

/** One envelope selected by the kicker, including its presentation form. */
export type HeldBatchActionableEnvelope = {
  envelope: WrkqEnvelope
  form: EnvelopePresentationForm
  reminder?: HrcMailEnvelopeReminder | undefined
}

export type ActiveBrokerSeat = {
  state: 'turn-active'
  runtimeId: string
  turnId: string
}

/**
 * Append ordinary queue mail to the one HRC-held batch behind an active turn.
 *
 * This seam is intentionally broker-free: no submission and no wrkq receipt
 * exists until a later boundary freezes and activates the batch.
 */
export function holdQueueForBusyTarget(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  session: HrcSessionRecord,
  seat: ActiveBrokerSeat,
  actionable: readonly HeldBatchActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason
): boolean {
  const queue = actionable.filter((item) => item.envelope.delivery === 'queue')
  if (queue.length === 0) return false
  const update = server.db.mailDrives.holdQueuedAttempt(
    {
      targetSessionRef,
      wakeReason,
      envelopeIds: queue.map((item) => item.envelope.id),
      counterpartyRefs: Object.fromEntries(
        queue.flatMap((item) => {
          const counterpartyRef = envelopeReplyAddressee(item.envelope)
          return counterpartyRef === undefined ? [] : [[item.envelope.id, counterpartyRef]]
        })
      ),
      heldBehindTurnId: seat.turnId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: seat.runtimeId,
      materializationIntent:
        session.lastAppliedIntentJson ??
        buildKickRuntimeIntent(parseSessionRef(targetSessionRef).scopeRef, undefined),
    },
    MAX_PRESENTED_PER_ATTEMPT
  )
  const persistedIds = server.db.mailDrives.presentationEnvelopeIds(update.attempt.driveAttemptId)
  const byId = new Map(queue.map((item) => [item.envelope.id, item.envelope]))
  const oldest = byId.get(persistedIds[0] ?? '')
  const presentationKey = oldest === undefined ? undefined : presentationKeyFor(oldest)
  const selectedCount =
    presentationKey === undefined
      ? Math.min(persistedIds.length, 1)
      : persistedIds.filter((envelopeId) => {
          const envelope = byId.get(envelopeId)
          return envelope !== undefined && presentationKeyFor(envelope) === presentationKey
        }).length
  writeServerLog('INFO', 'wrkq.kicker.queue_batch_held', {
    targetSessionRef,
    wakeReason,
    driveAttemptId: update.attempt.driveAttemptId,
    runId: update.attempt.runId,
    runtimeId: seat.runtimeId,
    heldBehindTurnId: update.attempt.heldBehindTurnId,
    observedTurnId: seat.turnId,
    addedEnvelopeIds: update.addedEnvelopeIds,
    envelopeIds: persistedIds,
    presentationKey,
    leftHeldCount: persistedIds.length - selectedCount,
  })
  return true
}

/**
 * Re-read every locally held member at freeze time and drop terminal rows.
 *
 * Ack, withdrawal, and expiry can win while HRC owns no broker input. A
 * terminal member is removed locally and is never composed or presented.
 */
export async function revalidateHeldBatch(
  server: HrcServerInstanceForHandlers,
  attempt: HrcMailDriveAttempt
): Promise<HeldBatchActionableEnvelope[]> {
  const surviving: HeldBatchActionableEnvelope[] = []
  for (const envelopeId of server.db.mailDrives.presentationEnvelopeIds(attempt.driveAttemptId)) {
    const envelope = await server.wrkqLedger.envelopeShow({ envelope: envelopeId })
    if (!envelope.terminal && envelope.state === 'pending') {
      surviving.push({
        envelope,
        form: envelope.presentedTo.length === 0 ? 'full' : 'defer-retry',
      })
      continue
    }
    const reason = envelope.terminal
      ? `terminal_while_held:${envelope.state}`
      : `no_longer_actionable:${envelope.state}`
    const dropped = server.db.mailDrives.dropHeldEnvelope(envelopeId, reason)
    if (dropped === undefined) continue
    writeServerLog('INFO', 'wrkq.kicker.held_member_dropped', {
      targetSessionRef: attempt.targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      envelopeId,
      envelopeState: envelope.state,
      reason,
      remainingEnvelopeIds: dropped.remainingEnvelopeIds,
      brokerWithdrawCalled: false,
    })
  }
  return surviving
}

/**
 * Remove an acked member from a batch HRC has never submitted to the broker.
 *
 * A true result is a complete disposition for the withdraw-on-ack path: the
 * caller must return without invoking `submission.withdraw`.
 */
export function dropAckedHeldMember(
  server: HrcServerInstanceForHandlers,
  envelopeId: string,
  reason: string
): boolean {
  const heldDrop = server.db.mailDrives.dropHeldEnvelope(envelopeId, reason)
  if (heldDrop === undefined) return false
  writeServerLog('INFO', 'wrkq.kicker.held_member_acked', {
    envelopeId,
    driveAttemptId: heldDrop.attempt.driveAttemptId,
    reason,
    remainingEnvelopeIds: heldDrop.remainingEnvelopeIds,
    brokerWithdrawCalled: false,
  })
  return true
}
