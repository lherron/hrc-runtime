/**
 * "This envelope was presented and nothing here disposed it" — answered without
 * a sender having to ask (T-07964 §4, re-pointed for T-08094).
 *
 * Both readers start from the LOCAL record and only then consult the ledger, in
 * that order and never the reverse. An undisposed presentation is cheap to find
 * and is almost always empty; the ledger read that decides whether the
 * obligation is genuinely outstanding is therefore paid for only when something
 * already looks wrong.
 *
 * The populations changed shape with the drive attempt (T-08094) and mean the
 * same things:
 *
 *  (a) UNDISPOSED PRESENTATIONS — a landed body whose runtime has ended no turn
 *      since, or whose disposal was cut off. D3 acts on these at the next turn
 *      terminal; this names the ones that have been sitting.
 *  (b) OPEN DELIVERY INTENTS past the stall threshold — a submission admitted
 *      and never landed. Under the drive era this was a live attempt whose turn
 *      never started, and it is the same wedge: the reader has not been shown
 *      the body and nothing says so. The periodic reconcile clears these at TTL;
 *      this is what makes the interval visible before then.
 *
 * Neither reader disposes anything.
 */
import type { HrcMailPresentation } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { STALLED_DELIVERY_THRESHOLD_MS, errorText } from '../internal.js'
import { newestPresentationReceipt } from '../ledger/types.js'

/** How many ledger reads one report may spend before it stops asking. */
const STRANDED_LEDGER_READ_CAP = 25
/** How many candidate records the boot report pulls from the store. */
const BOOT_RECONCILE_CANDIDATE_LIMIT = 200

export type StrandedPresentation = {
  envelope: string
  presentationId: string
  targetSessionRef: string
  runtimeId: string
  runtimeStatus: string
  deliveryOutcome: string
  landedAt: string
  reminderArmedAt?: string | undefined
}

/**
 * Ask the ledger which of these records still name an outstanding obligation.
 *
 * "Outstanding" is two facts, not one: the envelope is still `presented`, AND
 * the receipt this record holds is still the NEWEST one. A later delivery that
 * re-presented the same envelope owns it now, and reporting it against the
 * older record would name the wrong runtime in the verdict.
 */
export async function confirmStranded(
  server: MailKickerContext,
  candidates: readonly HrcMailPresentation[],
  cap: number = STRANDED_LEDGER_READ_CAP
): Promise<{ stranded: StrandedPresentation[]; ledgerErrors: number }> {
  const stranded: StrandedPresentation[] = []
  let ledgerErrors = 0
  for (const candidate of candidates.slice(0, cap)) {
    try {
      const row = await server.ledger.envelopeShow({ envelope: candidate.envelopeId })
      if (row.state !== 'presented') continue
      const newest = newestPresentationReceipt(row)
      if (newest?.runtimeId !== candidate.runtimeId) continue
      stranded.push({
        envelope: candidate.envelopeId,
        presentationId: candidate.presentationId,
        targetSessionRef: candidate.targetSessionRef,
        runtimeId: candidate.runtimeId,
        runtimeStatus: server.db.runtimes.getByRuntimeId(candidate.runtimeId)?.status ?? 'absent',
        deliveryOutcome: candidate.deliveryOutcome,
        landedAt: candidate.landedAt,
        ...(candidate.reminderArmedAt === undefined
          ? {}
          : { reminderArmedAt: candidate.reminderArmedAt }),
      })
    } catch {
      ledgerErrors += 1
    }
  }
  return { stranded, ledgerErrors }
}

export type StalledDelivery = {
  envelope: string
  targetSessionRef: string
  door: string
  presentationId: string
  runtimeId?: string | undefined
  submissionId?: string | undefined
  submittedAt: string
  ageMs: number
}

/**
 * Submissions admitted and never landed (the T-08094 shape of a wedged delivery).
 *
 * The threshold is not a timeout — the reconcile's TTL is — it is the point at
 * which "in flight" stops being a plausible reading. A cold birth reaches its
 * seat in about thirteen seconds and `turn.started` arrives at the HEAD of a
 * turn, so five minutes without a landing is not a slow turn: it is a delivery
 * whose evidence never arrived.
 */
export function findStalledDeliveries(server: MailKickerContext): StalledDelivery[] {
  const now = Date.now()
  const threshold = new Date(now - STALLED_DELIVERY_THRESHOLD_MS).toISOString()
  return server.db.mailDelivery.listExpiredIntents(threshold).map((intent) => {
    const submittedMs = Date.parse(intent.submittedAt)
    return {
      envelope: intent.envelopeId,
      targetSessionRef: intent.targetSessionRef,
      door: intent.door,
      presentationId: intent.presentationId,
      ...(intent.runtimeId === undefined ? {} : { runtimeId: intent.runtimeId }),
      ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
      submittedAt: intent.submittedAt,
      ageMs: Number.isNaN(submittedMs) ? 0 : Math.max(now - submittedMs, 0),
    }
  })
}

/**
 * One line per wedged delivery, at most once per envelope per process.
 *
 * Bounded because the periodic sweep re-reads the same rows and a wedge does
 * not clear on its own; unbounded it would be the loudest thing in the log.
 * Bounded per PROCESS rather than permanently because a restart is exactly when
 * someone is reading, and `boot_reconcile` names the population again there.
 */
export function reportStalledDeliveries(server: MailKickerContext): Promise<void> {
  for (const delivery of findStalledDeliveries(server)) {
    if (server.mailKickerStalledDeliveryAnnounced.has(delivery.envelope)) continue
    server.mailKickerStalledDeliveryAnnounced.add(delivery.envelope)
    server.log('WARN', 'wrkq.kicker.stalled_delivery', {
      targetSessionRef: delivery.targetSessionRef,
      envelope: delivery.envelope,
      door: delivery.door,
      presentationId: delivery.presentationId,
      ...(delivery.runtimeId === undefined ? {} : { runtimeId: delivery.runtimeId }),
      ...(delivery.submissionId === undefined ? {} : { submissionId: delivery.submissionId }),
      ageMs: delivery.ageMs,
      thresholdMs: STALLED_DELIVERY_THRESHOLD_MS,
      reason: 'submission admitted but no landing fact observed',
      recovery: 'the periodic reconcile clears this at TTL and redelivers once',
    })
  }
  return Promise.resolve()
}

/**
 * One summary line at boot for everything that outlived the last daemon (§4).
 *
 * It REPORTS. Acting on either population belongs to D3 and to the intent
 * reconcile, both of which run on the same sweep and ahead of this line, so
 * what it names is the set an operator actually has to do something about.
 */
export async function reportBootReconcile(server: MailKickerContext): Promise<void> {
  const candidates = server.db.mailDelivery.listUndisposedPresentations(
    BOOT_RECONCILE_CANDIDATE_LIMIT
  )
  const { stranded, ledgerErrors } = await confirmStranded(server, candidates)
  const stalled = findStalledDeliveries(server)
  const openIntents = server.db.mailDelivery.listOpenIntents().length

  server.log(
    stranded.length > 0 || stalled.length > 0 ? 'WARN' : 'INFO',
    'wrkq.kicker.boot_reconcile',
    {
      nodeId: server.nodeId,
      candidatesExamined: Math.min(candidates.length, STRANDED_LEDGER_READ_CAP),
      candidatesFound: candidates.length,
      strandedCount: stranded.length,
      stranded,
      // T-07963: its own labelled count, never inside `stranded`. These rows
      // predate local disposition tracking, are excluded from the actionable
      // set, and can never empty — inside the stranded array they would be a
      // permanent false alarm that teaches the reader to skip the line.
      preMigrationUnknown: server.db.mailDelivery.countPreMigrationUnknownPresentations(),
      openIntents,
      stalledCount: stalled.length,
      stalled,
      stalledThresholdMs: STALLED_DELIVERY_THRESHOLD_MS,
      ...(ledgerErrors > 0 ? { ledgerErrors } : {}),
    }
  )
}

/** `reportBootReconcile`, run at most once per process and never throwing. */
export function reportBootReconcileOnce(server: MailKickerContext): Promise<void> {
  if (!server.mailKickerBootReconcilePending) return Promise.resolve()
  server.mailKickerBootReconcilePending = false
  return reportBootReconcile(server).catch((error: unknown) => {
    server.log('WARN', 'wrkq.kicker.boot_reconcile_failed', { error: errorText(error) })
  })
}
