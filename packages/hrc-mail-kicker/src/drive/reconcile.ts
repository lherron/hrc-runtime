/**
 * Resolve every OPEN delivery intent against committed broker evidence
 * (spec T-08092 rev 4, D2 step 5).
 *
 * The live observer in `landing.ts` closes an intent within milliseconds when
 * the daemon is up and watching. This is what closes one when it was not: a
 * crash between the door call and the landing, a restart, a dropped observer, a
 * broker that went away mid-submission. It runs at daemon start, at runtime
 * termination, and on the periodic sweep, and it asks the MIRRORED STREAM what
 * happened rather than HRC's memory, which by construction is gone.
 *
 * The verdicts, and the one that is the accepted risk:
 *
 *  - LANDED — write the receipt with the intent's own presentation id, which
 *    wrkq's unique index dedupes, so this is idempotent with the live path.
 *  - DISPOSED — the reader discharged the envelope before the landing committed.
 *    Nothing to record, nothing to retry; not a landing and not a fault.
 *  - REFUSED — clear, re-wake, deliver again under the same policy next pass.
 *  - RUNTIME GONE — uncertain, then cleared and re-woken once the TTL is spent.
 *    A runtime that died mid-submission is NOT proof the body never reached the
 *    pane, so this waits out the same bound as every other uncertain outcome
 *    rather than redelivering on the spot. The envelope stays `pending`
 *    throughout: it was never presented, so nothing about it is failed.
 *  - UNDELIVERABLE — the bound is spent. Three non-landing outcomes for one
 *    envelope on ONE runtime, of any mix of kinds, and the sender is told rather
 *    than left watching a `pending` row while the reader is shown the same body
 *    once a turn forever.
 *  - NOTHING FOUND AFTER TTL — clear and re-wake. This is the one window where
 *    HRC redelivers a body the reader may already have seen: the broker applies
 *    a body BEFORE it emits the landing fact, so a broker failure inside that
 *    interval leaves a delivered body with no evidence. That is the bounded
 *    window of the accepted risk `wrkq.collaboration-ledger.at-least-once-presentation`,
 *    and it is why the guarantee is at-least-once rather than exactly-once.
 */
import type { HrcMailDeliveryIntent } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { KICKER_SUBMISSION_TTL_MS, errorText } from '../internal.js'
import { isRuntimeTerminal } from '../terminal/runtime-status.js'
import {
  chargeNonLandingOutcome,
  commitLanding,
  landLaunchIfStarted,
  refuseIntent,
} from './landing.js'

const LANDED_EVENT_TYPES = new Set(['submission.absorbed', 'submission.executed'])

export type IntentReconcileVerdict =
  | 'landed'
  | 'disposed'
  | 'refused'
  | 'runtime_gone'
  | 'expired'
  | 'undeliverable'
  | 'open'

/**
 * One intent, resolved or left alone.
 *
 * Left alone is a real outcome and the common one: a submission admitted three
 * seconds ago with no disposition yet is a delivery in flight, not a stranded
 * one, and clearing it would be the redelivery this whole mechanism exists to
 * make impossible.
 */
export async function reconcileIntent(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  now = Date.now()
): Promise<IntentReconcileVerdict> {
  // A terminal envelope remains an audit fence.  Late broker evidence may be
  // inspected, but cannot create a receipt or re-open delivery.
  if (intent.terminalEnvelopeAt !== undefined) return 'open'
  const runtimeId = intent.runtimeId
  if (runtimeId !== undefined) {
    const submissionId =
      intent.submissionId ??
      (intent.invocationId !== undefined && intent.brokerAfterSeq !== undefined
        ? server.db.brokerInvocationEvents.findUniqueSubmissionForEnvelopeAfter({
            runtimeId,
            invocationId: intent.invocationId,
            envelopeId: intent.envelopeId,
            afterSeq: intent.brokerAfterSeq,
          })
        : undefined)
    if (submissionId !== undefined) {
      if (intent.submissionId === undefined) {
        server.db.mailDelivery.attachAdmission(intent.envelopeId, { submissionId })
      }
      const disposition = server.db.brokerInvocationEvents.findSubmissionDisposition(
        runtimeId,
        submissionId
      )
      if (disposition !== undefined && LANDED_EVENT_TYPES.has(disposition.type)) {
        const current = server.db.mailDelivery.getIntent(intent.envelopeId) ?? intent
        const commit = await commitLanding(server, current, {
          runtimeId,
          eventType: disposition.type,
          landingHrcSeq: server.db.hrcEvents.maxHrcSeq(),
        })
        // A commit that hit an already-discharged envelope is NOT a landing.
        return commit === 'committed' ? 'landed' : commit === 'disposed' ? 'disposed' : 'open'
      }
      if (disposition !== undefined) {
        const evidence = server.db.brokerInvocationEvents.findInputRejectionDeliveryEvidence(
          runtimeId,
          submissionId
        )
        if (evidence !== 'not_written') {
          const cause = disposition.reason ?? disposition.type
          server.db.mailDelivery.markUncertain(
            intent.envelopeId,
            cause,
            evidence === 'possibly_written' ? 'possibly_written' : 'refusal_without_no_write_proof'
          )
          return await expireIfSpent(server, intent, runtimeId, cause, now)
        }
        return await refuseIntent(server, intent, disposition.reason ?? disposition.type)
      }
      const evidence = server.db.brokerInvocationEvents.findInputRejectionDeliveryEvidence(
        runtimeId,
        submissionId
      )
      if (evidence === 'not_written') return await refuseIntent(server, intent, 'input.rejected')
      if (evidence === 'possibly_written') {
        server.db.mailDelivery.markUncertain(
          intent.envelopeId,
          'input.rejected',
          'possibly_written'
        )
        return await expireIfSpent(server, intent, runtimeId, 'input.rejected', now)
      }
    } else if (intent.door === 'launch') {
      // The launch-carried body has no submission by construction. Its landing
      // fact is the first turn the runtime that launch produced started.
      const commit = await landLaunchIfStarted(server, intent)
      if (commit === 'committed') return 'landed'
      if (commit === 'disposed') return 'disposed'
    }

    const runtime = server.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
    if (runtime === undefined || isRuntimeTerminal(runtime.status)) {
      server.db.mailDelivery.markUncertain(
        intent.envelopeId,
        'runtime_terminated_before_landing',
        'runtime_terminal'
      )
      return await expireIfSpent(
        server,
        intent,
        runtimeId,
        'runtime_terminated_before_landing',
        now
      )
    }
  }

  return await expireIfSpent(server, intent, runtimeId, 'ttl_without_landing', now)
}

/**
 * End an intent whose TTL has run out, or leave it alone while it could land.
 *
 * Every uncertain branch above ends here rather than returning `open` on its
 * own. Uncertain is not resolved, and staying open is only correct while the
 * delivery could still land: past the TTL the submission is gone, and an open
 * intent keeps its envelope out of `readActionableEnvelopes` FOREVER. That is
 * how 33 envelopes reached four days old still `pending`, never presented, with
 * no failure notice to their senders (T-08394) — the verdicts this module's
 * header promises for RUNTIME GONE and NOTHING FOUND AFTER TTL were written
 * down but never returned.
 *
 * Expiry IS the bounded redelivery window the spec calls at-least-once: clear
 * the intent, charge the seat one non-landing strike, and re-wake the target.
 * The strike is what keeps the window bounded — three on one runtime still
 * tells the sender `undeliverable` rather than showing the reader one body
 * forever — and an intent with no runtime has no seat to charge, so it clears
 * on the TTL alone.
 */
async function expireIfSpent(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  runtimeId: string | undefined,
  cause: string,
  now: number
): Promise<IntentReconcileVerdict> {
  const age = now - Date.parse(intent.submittedAt)
  if (!Number.isFinite(age) || age < KICKER_SUBMISSION_TTL_MS) return 'open'
  server.db.mailDelivery.markUncertain(intent.envelopeId, cause, 'ttl')

  if (runtimeId !== undefined) {
    // `exhausted` has already cleared the intent and failed the envelope to the
    // sender, so there is nothing left here to clear or re-wake for.
    const charged = await chargeNonLandingOutcome(server, intent, runtimeId, cause)
    if (charged === 'exhausted') return 'undeliverable'
  }

  server.db.mailDelivery.clearIntent(intent.envelopeId)
  server.log('INFO', 'wrkq.kicker.delivery_expired', {
    targetSessionRef: intent.targetSessionRef,
    envelope: intent.envelopeId,
    door: intent.door,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
    cause,
    ageMs: age,
    ttlMs: KICKER_SUBMISSION_TTL_MS,
  })
  server.wake(intent.targetSessionRef, 'insert')
  return 'expired'
}

/**
 * Reconcile every open intent, or only those bound to named runtimes.
 *
 * Returns the verdict counts so the caller can say what it did in ONE line: a
 * reconcile that ran and decided nothing must not read like one that never ran.
 */
export async function reconcileOpenIntents(
  server: MailKickerContext,
  options: { runtimeIds?: ReadonlySet<string> | undefined; reason: string } = {
    reason: 'periodic',
  }
): Promise<Record<IntentReconcileVerdict, number>> {
  const counts: Record<IntentReconcileVerdict, number> = {
    landed: 0,
    disposed: 0,
    refused: 0,
    runtime_gone: 0,
    expired: 0,
    undeliverable: 0,
    open: 0,
  }
  const intents = server.db.mailDelivery
    .listActiveOpenIntents()
    .filter(
      (intent) =>
        options.runtimeIds === undefined ||
        (intent.runtimeId !== undefined && options.runtimeIds.has(intent.runtimeId))
    )
  if (intents.length === 0) return counts
  for (const intent of intents) {
    try {
      counts[await reconcileIntent(server, intent)] += 1
    } catch (error) {
      // Leaving the intent open keeps the envelope unactionable, which is the
      // safe direction: it is examined again on the next sweep rather than
      // delivered twice on a read that failed.
      counts.open += 1
      server.log('WARN', 'wrkq.kicker.intent_reconcile_failed', {
        targetSessionRef: intent.targetSessionRef,
        envelope: intent.envelopeId,
        error: errorText(error),
      })
    }
  }
  const resolved =
    counts.landed +
    counts.disposed +
    counts.refused +
    counts.runtime_gone +
    counts.expired +
    counts.undeliverable
  if (resolved > 0) {
    server.log('INFO', 'wrkq.kicker.intent_reconciled', {
      nodeId: server.nodeId,
      reason: options.reason,
      examined: intents.length,
      ...counts,
    })
  }
  return counts
}
