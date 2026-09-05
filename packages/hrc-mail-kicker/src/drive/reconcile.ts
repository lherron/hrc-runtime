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
 * Four verdicts, and the last one is the accepted risk:
 *
 *  - LANDED — write the receipt with the intent's own presentation id, which
 *    wrkq's unique index dedupes, so this is idempotent with the live path.
 *  - REFUSED — clear, re-wake, deliver again under the same policy next pass.
 *  - RUNTIME GONE — clear, re-wake. The envelope stays `pending`: it was never
 *    presented, so nothing about it is failed.
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
import { clearRefusedIntent, commitLanding, landLaunchIfStarted } from './landing.js'

const LANDED_EVENT_TYPES = new Set(['submission.absorbed', 'submission.executed'])

export type IntentReconcileVerdict = 'landed' | 'refused' | 'runtime_gone' | 'expired' | 'open'

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
  const runtimeId = intent.runtimeId
  if (runtimeId !== undefined) {
    const submissionId =
      intent.submissionId ??
      server.db.brokerInvocationEvents.findSubmissionIdForEnvelope(runtimeId, intent.envelopeId)
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
        await commitLanding(server, current, {
          runtimeId,
          eventType: disposition.type,
          landingHrcSeq: server.db.hrcEvents.maxHrcSeq(),
        })
        return 'landed'
      }
      if (disposition !== undefined) {
        clearRefusedIntent(server, intent, disposition.reason ?? disposition.type)
        return 'refused'
      }
    } else if (intent.door === 'launch') {
      // The launch-carried body has no submission by construction. Its landing
      // fact is the first turn the runtime that launch produced started.
      if (await landLaunchIfStarted(server, intent)) return 'landed'
    }

    const runtime = server.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
    if (runtime === undefined || isRuntimeTerminal(runtime.status)) {
      clearRefusedIntent(server, intent, 'runtime_terminated_before_landing')
      return 'runtime_gone'
    }
  }

  const age = now - Date.parse(intent.submittedAt)
  if (Number.isFinite(age) && age >= KICKER_SUBMISSION_TTL_MS) {
    clearRefusedIntent(server, intent, 'ttl_without_landing')
    return 'expired'
  }
  return 'open'
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
    refused: 0,
    runtime_gone: 0,
    expired: 0,
    open: 0,
  }
  const intents = server.db.mailDelivery
    .listOpenIntents()
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
  if (counts.landed + counts.refused + counts.runtime_gone + counts.expired > 0) {
    server.log('INFO', 'wrkq.kicker.intent_reconciled', {
      nodeId: server.nodeId,
      reason: options.reason,
      examined: intents.length,
      ...counts,
    })
  }
  return counts
}
