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
import { LAPSE_SWEEP_LOOKBACK_MS, errorText } from '../internal.js'
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
async function confirmStranded(
  server: MailKickerContext,
  candidates: readonly HrcMailDrivePresentedAttempt[]
): Promise<{ stranded: StrandedPresentation[]; ledgerErrors: number }> {
  const stranded: StrandedPresentation[] = []
  let ledgerErrors = 0
  for (const candidate of candidates.slice(0, STRANDED_LEDGER_READ_CAP)) {
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

/**
 * A turn ended on a runtime that is still holding someone's obligation, and no
 * live drive attempt owns the turn (§3).
 *
 * This is the exact shape EN-03687 died in: the drive's attempt had already
 * been failed by the shutdown, so `completeStartedAttempt` refused the later
 * `turn.completed`, no auto-reply intent was ever minted, and the whole event
 * passed without one line naming the envelope. The turn's canonical response
 * was sitting right there.
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

  // Only now — AFTER the guard — do we pay for the response read. This function
  // runs on EVERY mail-drive turn terminal on the node and is cheap because the
  // healthy answer costs one indexed query and stops; a projection read above
  // this line would move that cost onto every healthy turn. The text is the one
  // server-owned projection (T-07969), so what the log names is exactly what an
  // auto-reply would have minted — "the turn's canonical response was sitting
  // right there" becomes a line an operator can read instead of an inference.
  const response = event.runId === undefined ? undefined : server.projectTurnResponse(event.runId)

  server.log('WARN', 'wrkq.auto_reply.unowned_turn', {
    targetSessionRef,
    runtimeId,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    turnEventKind: event.eventKind,
    ...(response === undefined || response.body.length === 0
      ? {}
      : { canonicalResponse: response.body, canonicalResponseTruncated: response.truncated }),
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

  server.log(
    stranded.length > 0 || undispatched.length > 0 ? 'WARN' : 'INFO',
    'wrkq.kicker.boot_reconcile',
    {
      nodeId: server.nodeId,
      candidatesExamined: Math.min(candidates.length, STRANDED_LEDGER_READ_CAP),
      candidatesFound: candidates.length,
      strandedCount: stranded.length,
      stranded,
      undispatchedCount: undispatched.length,
      undispatched,
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
