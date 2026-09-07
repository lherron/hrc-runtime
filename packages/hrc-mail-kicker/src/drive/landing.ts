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
 * withdrawn — CLEARS the intent and re-wakes the target: the next pass
 * re-delivers it under the same policy, so a refused steer becomes an enqueue
 * while the seat is busy and a drive when it is idle.
 *
 * That redelivery is BOUNDED, because unbounded it is a loop that costs the
 * reader a turn per cycle forever (T-08094 finding 5, live). The bound counts
 * NON-LANDING OUTCOMES per (envelope, runtime) and a TTL expiry is only one
 * kind of them; see `refuseIntent` for the post-write / pre-write split that
 * decides when a refusal is one.
 *
 * The receipt is written with the intent's own presentation id, minted before
 * the door was called. wrkq's unique index on that id is the dedupe, so a
 * landing observed twice — live, and again by reconcile after a restart —
 * yields exactly one receipt.
 */
import type { HrcBrokerInvocationEventRecord } from 'hrc-core'
import type { HrcMailDeliveryIntent } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import {
  KICKER_MAX_NON_LANDING_STRIKES,
  KICKER_SUBMISSION_TTL_MS,
  STEER_RETRY_BASE_MS,
  STEER_RETRY_MAX_MS,
  errorText,
  isRecord,
} from '../internal.js'
import { failEnvelopeWithAudit } from '../terminal/envelope-terminal.js'

const LANDED_TYPES = new Set(['submission.absorbed', 'submission.executed'])
const REFUSED_TYPES = new Set([
  'input.rejected',
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
 * What a landing commit did, so callers can COUNT it honestly.
 *
 * `disposed` is not `committed` and it is not a failure: the body landed and
 * the obligation was already discharged. Reporting it as landed made the
 * reconcile's own summary line say `landed:3` about three envelopes that got no
 * receipt (chief, finding 4) — a counter that lies is worse than no counter.
 */
export type LandingCommit = 'committed' | 'disposed' | 'failed' | 'held'

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
): Promise<LandingCommit> {
  // Terminal envelopes are audit-only.  This guard is deliberately here (not
  // only in reconcile) because live broker observation and launch turn-start
  // delivery call commitLanding directly.
  if (intent.terminalEnvelopeAt !== undefined) return 'held'
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
    // `wrong_state` is wrkq refusing a receipt on a TERMINAL envelope: the
    // reader replied (or the sender withdrew) between the body landing and this
    // commit. The delivery HAPPENED and the obligation is already discharged —
    // there is nothing left to record and nothing to retry. Retrying is what
    // this branch used to do, once per sweep per envelope until the TTL, and it
    // left the intent open the whole time (chief, finding 4).
    //
    // The receipt is lost, and that loss is accepted: wrkq will not take a
    // presentation onto a discharged row, and forging one would be a worse
    // record than none.
    if (isDisposedBeforeLanding(error)) {
      // The body landed after the envelope became terminal.  Preserve the
      // intent as an inspectable terminal fence: deleting it would allow a
      // sweep to inject a second body while the receipt is impossible.
      server.db.mailDelivery.markTerminalEnvelope(intent.envelopeId, 'receipt_wrong_state')
      server.db.mailDelivery.recordDisposition(
        intent.envelopeId,
        input.runtimeId,
        'terminal_before_receipt'
      )
      server.log('INFO', 'wrkq.kicker.disposed_before_landing', {
        targetSessionRef: intent.targetSessionRef,
        envelope: intent.envelopeId,
        runtimeId: input.runtimeId,
        presentationId: intent.presentationId,
        door: intent.door,
        note: 'body landed after the envelope was discharged; no receipt is possible',
      })
      return 'disposed'
    }
    // Anything else is a transport or ledger fault: the local record stands and
    // the intent stays open, so reconcile replays this against the same
    // presentation id rather than delivering again.
    server.log('WARN', 'wrkq.kicker.presentation_commit_failed', {
      targetSessionRef: intent.targetSessionRef,
      envelope: intent.envelopeId,
      runtimeId: input.runtimeId,
      presentationId: intent.presentationId,
      error: errorText(error),
    })
    return 'failed'
  }

  server.db.mailDelivery.markReceiptCommitted(intent.envelopeId, input.runtimeId)
  server.db.mailDelivery.clearIntent(intent.envelopeId)
  server.mailKickerDeliveryBackoff.delete(input.runtimeId)
  // The seat took a body, so it is not the seat that cannot land: the TTL bound
  // starts over rather than carrying a stale near-miss into the next delivery.
  server.db.mailDelivery.clearNonLandingStrikes(intent.envelopeId)
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
  return 'committed'
}

/**
 * Did wrkq refuse this receipt because the envelope is already disposed?
 *
 * The ledger answers `wrong_state` for a presentation onto a terminal row. That
 * is not a fault to retry: it is the at-least-once world working as designed,
 * where the reader answered faster than the landing was committed.
 */
function isDisposedBeforeLanding(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('wrong_state')
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
): Promise<LandingCommit | undefined> {
  const runtimeId = intent.runtimeId
  if (runtimeId === undefined || intent.door !== 'launch') return undefined
  const started = server.db.hrcEvents.listByKind('turn.started', { runtimeId, limit: 1 })[0]
  if (started === undefined) return undefined
  return await commitLanding(server, intent, {
    runtimeId,
    eventType: 'turn.started',
    landingHrcSeq: started.hrcSeq,
  })
}

/**
 * Was this steer refused because the seat CANNOT steer, or because it could not
 * right then?
 *
 * The broker emits `admission.rejected` alongside `submission.rejected` for
 * anything refused at admission, and it carries the LAYER. `capability` is a
 * fact about the driver and is permanent for this invocation; `state`, `policy`
 * and `authority` are facts about the instant. A submission that was ADMITTED
 * and then failed in execution — `pane_not_quiescent`, a transport error —
 * emits no `admission.rejected` at all, so the reason string is read directly,
 * and anything that is not a named capability refusal is transient.
 *
 * The default matters and is deliberately TRANSIENT. Getting this wrong in the
 * permanent direction costs the seat steer-first for the life of the daemon;
 * getting it wrong in the transient direction costs one bounded retry.
 */
const CAPABILITY_REFUSALS = new Set(['steer_not_supported', 'unsupported:steer'])

export function steerRefusalIsPermanent(
  server: MailKickerContext,
  runtimeId: string,
  submissionId: string | undefined,
  reason: string
): boolean {
  if (CAPABILITY_REFUSALS.has(reason)) return true
  if (submissionId === undefined) return false
  const rejection = server.db.brokerInvocationEvents.findAdmissionRejection(runtimeId, submissionId)
  return rejection?.layer === 'capability'
}

/**
 * The next wait for a refusal about the MOMENT on this runtime, doubling to the
 * ceiling. Shared by the transient-steer path and the door-threw path, so no
 * refusal path is unpaced (chief, 2026-09-06).
 */
export function nextDeliveryBackoffMs(server: MailKickerContext, runtimeId: string): number {
  const previous = server.mailKickerDeliveryBackoff.get(runtimeId)
  const next =
    previous === undefined ? STEER_RETRY_BASE_MS : Math.min(previous * 2, STEER_RETRY_MAX_MS)
  server.mailKickerDeliveryBackoff.set(runtimeId, next)
  return next
}

/** A refused or lost submission: clear, say so, and let the next pass decide. */
export function clearRefusedIntent(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  reason: string,
  options: { retryInMs?: number | undefined; refusalClass?: string | undefined } = {}
): void {
  server.db.mailDelivery.clearIntent(intent.envelopeId)
  server.log('INFO', 'wrkq.kicker.landing_refused', {
    targetSessionRef: intent.targetSessionRef,
    envelope: intent.envelopeId,
    door: intent.door,
    ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
    ...(intent.runtimeId === undefined ? {} : { runtimeId: intent.runtimeId }),
    reason,
    ...(options.refusalClass === undefined ? {} : { refusalClass: options.refusalClass }),
    ...(options.retryInMs === undefined ? {} : { retryInMs: options.retryInMs }),
  })
  if (options.retryInMs === undefined) {
    server.wake(intent.targetSessionRef, 'insert')
    return
  }
  // Deferred, not dropped. The sweep would find this target within a tick
  // regardless; the wait exists so the retry lands after the pane has gone
  // quiet rather than into the same instant that refused it.
  const timer = setTimeout(() => {
    if (!server.stopping) server.wake(intent.targetSessionRef, 'insert')
  }, options.retryInMs)
  timer.unref?.()
}

/**
 * Did the body reach the pane BEFORE this refusal?
 *
 * This is chief's discriminator and the whole weight of the bound rests on it.
 * The broker emits `input.accepted` when it has written a submission to the
 * harness; a refusal that arrives after one means the reader HAS READ THE BODY,
 * whatever the broker later decided about attributing it. `merged-into-foreign-turn`
 * is the specimen: the body landed in the pane, drove a turn, and was then
 * settled as belonging to somebody else.
 *
 * A refusal with no `input.accepted` — `pane_not_quiescent`, a busy seat, an
 * admission refused on state or policy — wrote nothing, so redelivering it
 * costs the reader nothing and must not be charged as if it had.
 */
function refusalFollowedAWrite(
  server: MailKickerContext,
  runtimeId: string,
  submissionId: string | undefined
): boolean {
  if (submissionId === undefined) return false
  return server.db.brokerInvocationEvents.hasInputAccepted(runtimeId, submissionId)
}

/**
 * Charge ONE non-landing outcome against this (envelope, runtime), and fail the
 * envelope when the bound is spent.
 *
 * One counter, one rule. A TTL expiry and a post-write refusal are both "this
 * delivery did not land", and counting them separately would let a seat that
 * alternates between the two evade both bounds forever. Three strikes on one
 * runtime is not a slow seat — it is a seat that cannot land — and the sender
 * learns `undeliverable` instead of watching a `pending` row for eternity.
 *
 * A rotation resets it structurally: a different runtime is a different row.
 */
export async function chargeNonLandingOutcome(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  runtimeId: string,
  cause: string
): Promise<'struck' | 'exhausted'> {
  const strikes = server.db.mailDelivery.recordNonLandingStrike(intent.envelopeId, runtimeId)
  // The window belongs to the RUN of refusals a strike ends, so the next
  // continuous run is measured from scratch rather than from the first refusal
  // this envelope ever had on this seat.
  server.db.mailDelivery.closeRefusalWindow(intent.envelopeId, runtimeId)
  if (strikes < KICKER_MAX_NON_LANDING_STRIKES) return 'struck'

  server.db.mailDelivery.clearIntent(intent.envelopeId)
  server.log('WARN', 'wrkq.kicker.non_landing_strikes_exhausted', {
    targetSessionRef: intent.targetSessionRef,
    envelope: intent.envelopeId,
    runtimeId,
    door: intent.door,
    strikes,
    cause,
    ttlMs: KICKER_SUBMISSION_TTL_MS,
  })
  try {
    await failEnvelopeWithAudit(server, {
      envelope: intent.envelopeId,
      reason: 'undeliverable',
      targetSessionRef: intent.targetSessionRef,
      presentationId: intent.presentationId,
      callSite: 'non_landing_strikes_exhausted',
    })
  } catch (error) {
    // Not failing it leaves the obligation alive, which is the safe direction;
    // the count stands and the next non-landing outcome tries again.
    server.log('WARN', 'wrkq.kicker.non_landing_fail_failed', {
      targetSessionRef: intent.targetSessionRef,
      envelope: intent.envelopeId,
      error: errorText(error),
    })
  }
  return 'exhausted'
}

/**
 * Refuse ONE intent: charge it if the reader already read it, pace it if not.
 *
 * POST-WRITE refusal → a full strike. The body reached the pane; redelivering
 * it shows the reader the same message twice, so the third one is where HRC
 * stops rather than where it tries harder.
 *
 * PRE-WRITE refusal → no strike per event, and the classification below still
 * decides the door. A PERMANENT steer refusal memoizes the runtime so the next
 * pass enqueues — the spec's "a refused steer becomes an enqueue". A TRANSIENT
 * one memoizes nothing and re-wakes on a bounded backoff, so the next pass
 * steers again: the door that will work in a moment is the right door.
 *
 * But a seat that refuses BEFORE writing, every time, would back off forever
 * and strike never — so a run of pre-write refusals spanning one TTL window
 * earns exactly one strike. Both kinds of seat converge in three windows.
 */
export async function refuseIntent(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  reason: string,
  _now = Date.now()
): Promise<'refused' | 'undeliverable'> {
  const runtimeId = intent.runtimeId
  if (runtimeId === undefined) {
    // No runtime is no (envelope, runtime) pair to charge. Nothing to bound.
    clearRefusedIntent(server, intent, reason)
    return 'refused'
  }

  if (refusalFollowedAWrite(server, runtimeId, intent.submissionId)) {
    server.db.mailDelivery.markUncertain(intent.envelopeId, reason, 'post_write_refusal')
    return 'refused'
  }

  if (
    intent.door === 'steer' &&
    steerRefusalIsPermanent(server, runtimeId, intent.submissionId, reason)
  ) {
    server.mailKickerSteerRefused.add(runtimeId)
    server.mailKickerDeliveryBackoff.delete(runtimeId)
    clearRefusedIntent(server, intent, reason, { refusalClass: 'permanent' })
    return 'refused'
  }
  clearRefusedIntent(server, intent, reason, {
    refusalClass: 'not_written',
    retryInMs: nextDeliveryBackoffMs(server, runtimeId),
  })
  return 'refused'
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
  const submissionId = payload?.['submissionId'] ?? payload?.['inputId']
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
  // A refusal alone is not proof that the body was never written.  Producer
  // rev2 emits this explicit correlation on `input.rejected`; older/partial
  // streams remain safely uncertain rather than reopening the envelope.
  if (payload?.['deliveryEvidence'] !== 'not_written') {
    server.db.mailDelivery.markUncertain(
      intent.envelopeId,
      reason,
      'refusal_without_no_write_proof'
    )
    return
  }
  await refuseIntent(server, intent, reason)
}
