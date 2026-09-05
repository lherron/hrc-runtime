/**
 * "This envelope was presented and nothing here disposed it" — the two places
 * that question can be answered without a sender asking it (T-07964 §3/§4).
 *
 * Both readers start from the LOCAL receipt and only then consult the ledger,
 * in that order and never the reverse. A presentation receipt with no reminder
 * and no failure notice is cheap to find and is almost always empty; the ledger
 * read that decides whether the obligation is genuinely outstanding is
 * therefore paid for only when something already looks wrong.
 *
 * Neither reader disposes anything. Reporting is this task's whole scope;
 * T-07963 owns what to DO about what these lines name.
 */
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcMailDrivePresentedAttempt } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { LAPSE_SWEEP_LOOKBACK_MS, STALLED_DELIVERY_THRESHOLD_MS, errorText } from '../internal.js'
import { newestPresentationReceipt } from '../ledger/types.js'

/** Attempt states that still own their envelopes; anything else has let go. */
const LIVE_ATTEMPT_STATES = new Set(['held', 'claimed', 'started'])

/** How many ledger reads one report may spend before it stops asking. */
const STRANDED_LEDGER_READ_CAP = 25
/** How many candidate receipts the boot report pulls from the store. */
const BOOT_RECONCILE_CANDIDATE_LIMIT = 200
/** Below this age an `accepted` run with no dispatched input is simply young. */
const UNDISPATCHED_RUN_MIN_AGE_MS = 5 * 60_000

export type StrandedPresentation = {
  envelope: string
  driveAttemptId: string
  targetSessionRef: string
  attemptState: string
  runId: string
  runtimeId?: string | undefined
  presentedAt: string
  completedAt?: string | undefined
}

/**
 * Ask the ledger which of these receipts still name an outstanding obligation.
 *
 * "Outstanding" is two facts, not one: the envelope is still `presented`, AND
 * the receipt this attempt holds is still the NEWEST one. A later attempt that
 * re-presented the same envelope owns it now, and reporting it against the
 * older attempt would name the wrong drive in the verdict.
 */
export async function confirmStranded(
  server: MailKickerContext,
  candidates: readonly HrcMailDrivePresentedAttempt[],
  // T-07963's reconcile ACTS on this set rather than reporting it, so it reads
  // the whole candidate list; the diagnostic readers keep their cap, because a
  // report costing 200 ledger reads on every turn terminal is not a report.
  cap: number = STRANDED_LEDGER_READ_CAP
): Promise<{ stranded: StrandedPresentation[]; ledgerErrors: number }> {
  const stranded: StrandedPresentation[] = []
  let ledgerErrors = 0
  for (const candidate of candidates.slice(0, cap)) {
    try {
      const row = await server.ledger.envelopeShow({ envelope: candidate.envelopeId })
      if (row.state !== 'presented') continue
      const newest = newestPresentationReceipt(row)
      if (newest?.driveAttemptId !== candidate.attempt.driveAttemptId) continue
      stranded.push({
        envelope: candidate.envelopeId,
        driveAttemptId: candidate.attempt.driveAttemptId,
        targetSessionRef: candidate.attempt.targetSessionRef,
        attemptState: candidate.attempt.state,
        runId: candidate.attempt.runId,
        ...(candidate.attempt.runtimeId === undefined
          ? {}
          : { runtimeId: candidate.attempt.runtimeId }),
        presentedAt: candidate.presentedAt,
        ...(candidate.attempt.completedAt === undefined
          ? {}
          : { completedAt: candidate.attempt.completedAt }),
      })
    } catch {
      ledgerErrors += 1
    }
  }
  return { stranded, ledgerErrors }
}

export type StalledDelivery = StrandedPresentation & {
  /** How long this attempt has held the obligation without its turn starting. */
  liveAgeMs: number
}

/**
 * Deliveries that are not awaited but WEDGED (T-07964, mable's ruling for the
 * T-07971 interim net).
 *
 * The gap this closes: every other reader here keys on a TERMINAL attempt,
 * because a live attempt owns its own disposal. That is true right up until the
 * attempt stops being live in any meaningful sense — and then the obligation is
 * stranded exactly as EN-03687 was, while `hrc mail inspect` says
 * `awaiting_turn`, which is indistinguishable from a healthy in-flight delivery
 * at any age.
 *
 * Three filters, in order of cost:
 *
 *  1. SQL: live state, `started_at IS NULL`, claimed before the threshold. The
 *     second is structural — an attempt that observed its `turn.started` cannot
 *     appear, so "started, at any age" is silent by construction, not by a case.
 *  2. A HELD batch is excluded while its runtime still has an active run. Held
 *     batches wait for a turn boundary BY DESIGN, and turns legitimately run for
 *     an hour — EN-03687's own ran 54 minutes. Reporting those would fire on
 *     every long turn on the node, which is the failure mode that makes a signal
 *     worthless. A held batch behind a runtime with nothing running is waiting
 *     for a boundary that has already passed, and that IS wedged.
 *  3. The ledger: still `presented`, and this attempt still owns the newest
 *     receipt. Same authority as everywhere else here.
 *
 * It REPORTS. Nothing is disposed, no attempt is transitioned; the whole point
 * is to make the operator ack possible until T-07971 lands the real fix.
 */
export async function findStalledDeliveries(
  server: MailKickerContext
): Promise<{ stalled: StalledDelivery[]; ledgerErrors: number }> {
  const now = Date.now()
  const candidates = server.db.mailDrives
    .listStalledLivePresentations({
      claimedBefore: new Date(now - STALLED_DELIVERY_THRESHOLD_MS).toISOString(),
      limit: STRANDED_LEDGER_READ_CAP,
    })
    .filter((candidate) => {
      if (candidate.attempt.state !== 'held') return true
      const runtimeId = candidate.attempt.runtimeId
      if (runtimeId === undefined) return true
      const runtime = server.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
      return runtime?.activeRunId === undefined
    })
  if (candidates.length === 0) return { stalled: [], ledgerErrors: 0 }

  const { stranded, ledgerErrors } = await confirmStranded(server, candidates)
  const claimedAtById = new Map(
    candidates.map((candidate) => [candidate.attempt.driveAttemptId, candidate.attempt.claimedAt])
  )
  return {
    stalled: stranded.map((item) => {
      const claimedAt = Date.parse(claimedAtById.get(item.driveAttemptId) ?? '')
      return {
        ...item,
        liveAgeMs: Number.isNaN(claimedAt) ? 0 : Math.max(now - claimedAt, 0),
      }
    }),
    ledgerErrors,
  }
}

/**
 * One line per wedged delivery, at most once per attempt per process.
 *
 * Bounded because the periodic sweep re-reads the same rows forever and a
 * wedge does not clear on its own; unbounded it would be the loudest thing in
 * the log. Bounded per PROCESS rather than permanently because a restart is
 * exactly when someone is reading, and `boot_reconcile` names the population
 * again there anyway.
 */
export async function reportStalledDeliveries(server: MailKickerContext): Promise<void> {
  const { stalled, ledgerErrors } = await findStalledDeliveries(server)
  for (const delivery of stalled) {
    if (server.mailKickerStalledDeliveryAnnounced.has(delivery.driveAttemptId)) continue
    server.mailKickerStalledDeliveryAnnounced.add(delivery.driveAttemptId)
    server.log('WARN', 'wrkq.kicker.stalled_delivery', {
      targetSessionRef: delivery.targetSessionRef,
      driveAttemptId: delivery.driveAttemptId,
      runId: delivery.runId,
      ...(delivery.runtimeId === undefined ? {} : { runtimeId: delivery.runtimeId }),
      envelope: delivery.envelope,
      attemptState: delivery.attemptState,
      liveAgeMs: delivery.liveAgeMs,
      thresholdMs: STALLED_DELIVERY_THRESHOLD_MS,
      reason: 'presented but no turn.started observed for this attempt',
      recovery: 'reporting only; disposition is T-07971. Clear by operator ack.',
      ...(ledgerErrors > 0 ? { ledgerErrors } : {}),
    })
  }
}

/**
 * A turn ended on a runtime that is still holding someone's obligation, and no
 * live drive attempt owns the turn (§3).
 *
 * This is the exact shape EN-03687 died in: the drive's attempt had already
 * been failed by the shutdown, so `completeStartedAttempt` refused the later
 * `turn.completed`, and the whole event passed without one line naming the
 * envelope. Naming it is the whole job — T-08093 removed the response text this
 * used to print alongside, because "what a reply would have said" is no longer
 * a thing HRC has any business asserting: nothing here was ever going to answer
 * for the seat, and printing a turn's narration next to a stranded obligation
 * invites reading it as one.
 */
export async function reportUnownedTurn(
  server: MailKickerContext,
  event: HrcLifecycleEvent,
  targetSessionRef: string
): Promise<void> {
  const runtimeId = event.runtimeId
  if (runtimeId === undefined) return
  const owner =
    event.runId === undefined ? undefined : server.db.mailDrives.getAttemptByRunId(event.runId)
  // A live attempt owns this turn: its own terminal path will dispose what it
  // carries, and nothing here has anything to say.
  if (owner !== undefined && LIVE_ATTEMPT_STATES.has(owner.state)) return

  // Bounded in SQL, not in JS: this runs on EVERY turn terminal on the node, so
  // the common answer — nothing — must cost one indexed query and no more.
  const candidates = server.db.mailDrives.listUndisposedTerminalPresentations({
    since: new Date(Date.now() - LAPSE_SWEEP_LOOKBACK_MS).toISOString(),
    limit: STRANDED_LEDGER_READ_CAP,
    runtimeId,
  })
  if (candidates.length === 0) return
  const { stranded, ledgerErrors } = await confirmStranded(server, candidates)
  if (stranded.length === 0) return

  server.log('WARN', 'wrkq.kicker.unowned_turn', {
    targetSessionRef,
    runtimeId,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    turnEventKind: event.eventKind,
    ...(owner === undefined
      ? { owningAttempt: 'none' }
      : { terminalAttemptId: owner.driveAttemptId, terminalAttemptState: owner.state }),
    envelopeIds: stranded.map((item) => item.envelope),
    stranded,
    ...(ledgerErrors > 0 ? { ledgerErrors } : {}),
  })
}

/**
 * One summary line at boot for everything that outlived the last daemon (§4).
 *
 * Two populations, both of which the 2026-09-03 incident produced and neither
 * of which the restarted daemon said anything about:
 *
 *  (a) terminal attempts still holding a `presented` envelope — the stranded
 *      obligation itself;
 *  (b) drive-bound runs still `accepted` with no dispatched input — a caller
 *      prompt that never entered the broker, which for EN-03687 stayed that way
 *      for 51 minutes while the seat looked busy.
 *
 * It REPORTS. Acting on either population is T-07963's.
 */
export async function reportBootReconcile(server: MailKickerContext): Promise<void> {
  const now = Date.now()
  const candidates = server.db.mailDrives.listUndisposedTerminalPresentations({
    since: new Date(now - LAPSE_SWEEP_LOOKBACK_MS).toISOString(),
    limit: BOOT_RECONCILE_CANDIDATE_LIMIT,
  })
  const { stranded, ledgerErrors } = await confirmStranded(server, candidates)
  const undispatched = server.db.mailDrives.listUndispatchedAcceptedDriveRuns(
    new Date(now - UNDISPATCHED_RUN_MIN_AGE_MS).toISOString()
  )
  // The third population (mable's T-07971 interim net): live attempts holding an
  // obligation whose turn never started. The other two key on a TERMINAL
  // attempt, so without this a wedged live delivery is silent between boots and
  // reads as `awaiting_turn` in the inspect command.
  const { stalled, ledgerErrors: stalledLedgerErrors } = await findStalledDeliveries(server)
  const errors = ledgerErrors + stalledLedgerErrors

  server.log(
    stranded.length > 0 || undispatched.length > 0 || stalled.length > 0 ? 'WARN' : 'INFO',
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
      preMigrationUnknown: server.db.mailDrives.countPreMigrationUnknownPresentations(),
      undispatchedCount: undispatched.length,
      undispatched,
      stalledCount: stalled.length,
      stalled,
      stalledThresholdMs: STALLED_DELIVERY_THRESHOLD_MS,
      ...(errors > 0 ? { ledgerErrors: errors } : {}),
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
