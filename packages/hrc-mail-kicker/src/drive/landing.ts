/**
 * Presentation is a LANDING FACT, never an admission (spec T-08092 rev 4, §2).
 *
 * A door returns "the broker took this"; it does not say the reader saw it. The
 * two facts that do are both on the committed broker stream HRC already mirrors
 * under `harness-broker-committed-observation-control`:
 *
 *  - `submission.absorbed` (the body joined a live turn) or `submission.executed`
 *    (it originated one) for a submission;
 *  - the first `turn.started` of the runtime a launch produced, for a body that
 *    rode `spec.launch.initialPrompt` and therefore has no submission at all.
 *
 * Anything else a submission can end as — rejected, lost, expired, cancelled,
 * withdrawn — CLEARS the intent and re-wakes the target. No envelope is ever
 * failed for a refused or lost submission: the next pass re-delivers it under
 * the same policy, so a refused steer becomes an enqueue while the seat is busy
 * and a drive when it is idle.
 *
 * The receipt is written with the intent's own presentation id, minted before
 * the door was called. wrkq's unique index on that id is the dedupe, so a
 * landing observed twice — live, and again by reconcile after a restart —
 * yields exactly one receipt.
 */
import type { HrcBrokerInvocationEventRecord } from 'hrc-core'
import type { HrcMailDeliveryIntent } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { errorText, isRecord } from '../internal.js'

const LANDED_TYPES = new Set(['submission.absorbed', 'submission.executed'])
const REFUSED_TYPES = new Set([
  'submission.rejected',
  'submission.lost',
  'submission.expired',
  'submission.cancelled',
  'submission.withdrawn',
])

function parsePayload(
  record: Pick<HrcBrokerInvocationEventRecord, 'brokerEventJson'>
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(record.brokerEventJson)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The receipt's `delivery_outcome` for one landing.
 *
 * The vocabulary is closed (§2) and each member says how the body reached the
 * reader, which is the part a log line cannot carry: a log rotates and is
 * grepped from one node, while the receipt travels with the envelope.
 */
function deliveryOutcomeFor(intent: HrcMailDeliveryIntent, eventType: string): string {
  if (intent.deliveryOutcome !== undefined) return intent.deliveryOutcome
  if (intent.door === 'preempt') return 'preempted_live_harness'
  if (intent.door === 'launch') return 'launch_carried'
  return eventType === 'submission.absorbed' ? 'steered' : 'executed'
}

/**
 * Commit one landing: local record first, then the ledger.
 *
 * The ordering is the T-07615 one and survives a kill in between — the local
 * row says a receipt is owed, and the reconcile replays it against the same
 * presentation id, which wrkq dedupes.
 */
export async function commitLanding(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  input: { runtimeId: string; eventType: string; landingHrcSeq: number }
): Promise<boolean> {
  const outcome = deliveryOutcomeFor(intent, input.eventType)
  // A reminder lands ON the record it is reminding about — unless the seat
  // rotated between arming and firing, in which case the body reached a runtime
  // this envelope has no record for. That is a NEW presentation, not a reminder
  // landing: recording it as one would leave the obligation bound to a runtime
  // D3 has nothing to dispose it from.
  const isReminder =
    intent.form === 'reminder' &&
    server.db.mailDelivery.getPresentation(intent.envelopeId, input.runtimeId) !== undefined
  if (isReminder) {
    server.db.mailDelivery.recordReminderLanding(
      intent.envelopeId,
      input.runtimeId,
      input.landingHrcSeq
    )
  } else {
    server.db.mailDelivery.recordPresentation({
      envelopeId: intent.envelopeId,
      runtimeId: input.runtimeId,
      targetSessionRef: intent.targetSessionRef,
      ...(intent.generation === undefined ? {} : { generation: intent.generation }),
      presentationId: intent.presentationId,
      ...(intent.submissionId === undefined ? {} : { inputId: intent.submissionId }),
      deliveryOutcome: outcome,
      landingHrcSeq: input.landingHrcSeq,
    })
  }

  try {
    await server.ledger.present({
      envelope: intent.envelopeId,
      node: server.nodeId,
      ...(intent.hostSessionId === undefined ? {} : { hostSessionId: intent.hostSessionId }),
      ...(intent.generation === undefined ? {} : { generation: String(intent.generation) }),
      runtimeId: input.runtimeId,
      // The opaque HRC presentation id. No run id is written: a run is a
      // runtime concern and no longer participates in the envelope lifecycle.
      driveAttemptId: intent.presentationId,
      ...(intent.submissionId === undefined ? {} : { inputId: intent.submissionId }),
      deliveryOutcome: outcome,
    })
  } catch (error) {
    // The local record stands and the intent stays open, so reconcile replays
    // this against the same presentation id rather than delivering again.
    server.log('WARN', 'wrkq.kicker.presentation_commit_failed', {
      targetSessionRef: intent.targetSessionRef,
      envelope: intent.envelopeId,
      runtimeId: input.runtimeId,
      presentationId: intent.presentationId,
      error: errorText(error),
    })
    return false
  }

  server.db.mailDelivery.clearIntent(intent.envelopeId)
  server.log('INFO', 'wrkq.kicker.presented', {
    targetSessionRef: intent.targetSessionRef,
    envelope: intent.envelopeId,
    runtimeId: input.runtimeId,
    presentationId: intent.presentationId,
    ...(intent.submissionId === undefined ? {} : { inputId: intent.submissionId }),
    door: intent.door,
    form: intent.form,
    deliveryOutcome: outcome,
    landingHrcSeq: input.landingHrcSeq,
    landedOn: input.eventType,
  })
  return true
}

/**
 * Land a LAUNCH-CARRIED body if the runtime it produced has started its turn.
 *
 * Read off HRC's own committed lifecycle ledger rather than the broker stream,
 * for the same reason D3's terminals are: the landing sequence and the terminal
 * sequences must be comparable, and they are only comparable inside one ledger.
 *
 * Called both when the birth returns — the first turn commonly starts DURING
 * the launch, before the intent knows which runtime it produced — and from the
 * reconcile, which is what covers a daemon that died in between.
 */
export async function landLaunchIfStarted(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent
): Promise<boolean> {
  const runtimeId = intent.runtimeId
  if (runtimeId === undefined || intent.door !== 'launch') return false
  const started = server.db.hrcEvents.listByKind('turn.started', { runtimeId, limit: 1 })[0]
  if (started === undefined) return false
  return await commitLanding(server, intent, {
    runtimeId,
    eventType: 'turn.started',
    landingHrcSeq: started.hrcSeq,
  })
}

/** A refused or lost submission: clear, say so, and let the next pass decide. */
export function clearRefusedIntent(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  reason: string
): void {
  server.db.mailDelivery.clearIntent(intent.envelopeId)
  server.log('INFO', 'wrkq.kicker.landing_refused', {
    targetSessionRef: intent.targetSessionRef,
    envelope: intent.envelopeId,
    door: intent.door,
    ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
    ...(intent.runtimeId === undefined ? {} : { runtimeId: intent.runtimeId }),
    reason,
  })
  server.wake(intent.targetSessionRef, 'insert')
}

/**
 * Observe one committed broker event for a delivery this node is waiting on.
 *
 * The launch-carried branch reads `turn.started` for the runtime a launch
 * produced — the same launch-to-runtime correlation the first-turn watch uses —
 * and is the only landing fact that names no submission.
 */
export async function observeBrokerLanding(
  server: MailKickerContext,
  record: HrcBrokerInvocationEventRecord
): Promise<void> {
  if (record.type === 'turn.started') {
    const intents = server.db.mailDelivery.listLaunchIntentsForRuntime(record.runtimeId)
    for (const intent of intents) {
      await commitLanding(server, intent, {
        runtimeId: record.runtimeId,
        eventType: record.type,
        landingHrcSeq: server.db.hrcEvents.maxHrcSeq(),
      })
    }
    return
  }
  if (!LANDED_TYPES.has(record.type) && !REFUSED_TYPES.has(record.type)) return
  const payload = parsePayload(record)
  const submissionId = payload?.['submissionId']
  if (typeof submissionId !== 'string') return
  const intent = server.db.mailDelivery.getIntentBySubmissionId(submissionId)
  if (intent === undefined) return

  if (LANDED_TYPES.has(record.type)) {
    await commitLanding(server, intent, {
      runtimeId: intent.runtimeId ?? record.runtimeId,
      eventType: record.type,
      landingHrcSeq: server.db.hrcEvents.maxHrcSeq(),
    })
    return
  }
  const reason = typeof payload?.['reason'] === 'string' ? payload['reason'] : record.type
  // D2: a refused steer becomes an enqueue while the seat is busy. The next
  // pass reads the same advertised capability, so the refusal has to be
  // remembered or the pair takes the same door again and spins.
  if (intent.door === 'steer' && intent.runtimeId !== undefined) {
    server.mailKickerSteerRefused.add(intent.runtimeId)
  }
  clearRefusedIntent(server, intent, reason)
}
