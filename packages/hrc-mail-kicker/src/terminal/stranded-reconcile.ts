/**
 * Startup reconcile for stranded obligations (T-07963 criterion 2).
 *
 * A drive attempt that went terminal without disposing what it presented leaves
 * the envelope `presented` with no reminder, no failure and no reply. On
 * 2026-09-03 the daemon stopped 28 ms after such an attempt ended and EN-03687
 * sat that way for an hour while its sender was told nothing.
 *
 * `stop()` now drains in-flight disposals and every decision is written to its
 * presentation row as it is MADE, so this pass replays what a stop, a crash or
 * the drain deadline cut off. It is the durable half of criterion 3 and the
 * whole of criterion 2's disposition.
 *
 * DISPOSITION SPLITS ON TRUTH, NEVER ON CONVENIENCE — the three branches are
 * ruled, and the third is the one that matters:
 *
 *  - the receipt's runtime is terminal -> fail `runtime_terminated`, which is
 *    true there and is what the sender's notice will say;
 *  - the runtime is alive AND a turn provably carried the body -> the ordinary
 *    D4/D5 lifecycle: arm the one reminder, or strike out `ignored` if this
 *    attempt WAS the reminder;
 *  - the runtime is alive and NO turn ever carried the body -> REPORT ONLY.
 *    Nothing is disposed. Every failure reason available would assert
 *    something false (`runtime_terminated` renders "runtime X ended";
 *    `ignored` renders "reminded, 2 turns ended undisposed"; `undeliverable`
 *    renders "could not be seated" and is suppressed for live targets), and a
 *    reminder's pointer form says "your turn ended without a reply" to a reader
 *    who never saw the body. Redelivery is T-07971's, pending a shape review.
 *    Until then an operator clears it with `wrkc ack`, and it is visible in
 *    T-07964's `boot_reconcile` line and `hrc mail inspect`.
 *
 * The never-carried branch performs NO ledger write and NO state change, so it
 * cannot loop: repeated boots re-report it and never act.
 *
 * NEVER branches on `attempt.state`. `finishUnstarted`/`failDriveAfterThrow`
 * can move an attempt from `started` to `failed`, so state cannot distinguish
 * "carried the body" from "never did". `startHrcSeq` is the positive evidence:
 * stamped only by `recordStart` from an observed `turn.started`, and it
 * survives every later transition.
 */
import type { MailKickerContext } from '../context.js'
import { confirmStranded } from '../diagnostics/stranded.js'
import { isRuntimeTerminal } from '../drive/attempt-lifecycle.js'
import { REMINDER_HOLD_MS, errorText } from '../internal.js'
import { failEnvelopeWithAudit } from './envelope-terminal.js'

/** Whole-history candidate read: no time horizon, so nothing can age out. */
const RECONCILE_CANDIDATE_LIMIT = 500

type Disposition = 'failed:runtime_terminated' | 'failed:ignored' | 'reminder_armed' | 'reported'

export async function reconcileStrandedObligations(server: MailKickerContext): Promise<void> {
  const candidates = server.db.mailDrives.listUndisposedTerminalPresentations({
    // Epoch, deliberately: a lookback window puts a recovery TTL on
    // keep-forever collaboration state. The set is bounded structurally
    // instead — a row leaves it permanently once dispositioned.
    since: new Date(0).toISOString(),
    limit: RECONCILE_CANDIDATE_LIMIT,
  })
  if (candidates.length === 0) return
  const { stranded, ledgerErrors } = await confirmStranded(
    server,
    candidates,
    RECONCILE_CANDIDATE_LIMIT
  )
  if (stranded.length === 0) {
    if (ledgerErrors > 0) {
      server.log('WARN', 'wrkq.kicker.stranded_reconcile_incomplete', { ledgerErrors })
    }
    return
  }

  const counts: Record<Disposition, number> = {
    'failed:runtime_terminated': 0,
    'failed:ignored': 0,
    reminder_armed: 0,
    reported: 0,
  }

  for (const item of stranded) {
    try {
      const attempt = server.db.mailDrives.getAttempt(item.driveAttemptId)
      if (attempt === undefined) continue
      const runtimeId = item.runtimeId ?? attempt.runtimeId
      if (runtimeId === undefined) continue
      const runtime = server.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
      const disposition = await disposeOne(server, item, attempt, runtime, runtimeId)
      counts[disposition] += 1
      // The never-carried branch records NOTHING: an undecided obligation must
      // stay a candidate so the operator surface keeps naming it, and so
      // T-07971's eventual redelivery has something to act on.
      if (disposition !== 'reported') {
        server.db.mailDrives.recordPresentationDisposition(
          item.driveAttemptId,
          item.envelope,
          disposition
        )
      }
      server.log('INFO', 'wrkq.kicker.stranded_reconciled', {
        targetSessionRef: item.targetSessionRef,
        driveAttemptId: item.driveAttemptId,
        envelope: item.envelope,
        runtimeId,
        runtimeStatus: runtime?.status ?? 'absent',
        carriedATurn: attempt.startHrcSeq !== undefined,
        disposition,
      })
    } catch (error) {
      // Not disposing leaves the obligation alive, which is the safe direction:
      // it stays a candidate and the next boot tries again.
      server.log('WARN', 'wrkq.kicker.stranded_reconcile_failed', {
        targetSessionRef: item.targetSessionRef,
        driveAttemptId: item.driveAttemptId,
        envelope: item.envelope,
        error: errorText(error),
      })
    }
  }

  server.log('INFO', 'wrkq.kicker.stranded_reconcile_complete', {
    nodeId: server.nodeId,
    examined: stranded.length,
    ...counts,
    ...(ledgerErrors > 0 ? { ledgerErrors } : {}),
  })
}

async function disposeOne(
  server: MailKickerContext,
  item: { envelope: string; driveAttemptId: string; targetSessionRef: string },
  attempt: { startHrcSeq?: number | undefined; completedAt?: string | undefined },
  runtime: { status: string } | undefined,
  runtimeId: string
): Promise<Disposition> {
  // (1) The runtime that held it is gone. `runtime_terminated` is true here and
  // is exactly what the sender's notice renders.
  if (runtime === undefined || isRuntimeTerminal(runtime.status)) {
    await failEnvelopeWithAudit(server, {
      envelope: item.envelope,
      reason: 'runtime_terminated',
      runtime: runtimeId,
      targetSessionRef: item.targetSessionRef,
      driveAttemptId: item.driveAttemptId,
      callSite: 'lapsed_obligations',
    })
    return 'failed:runtime_terminated'
  }

  // (2) A turn provably carried the body: the ordinary D4/D5 lifecycle.
  if (attempt.startHrcSeq !== undefined) {
    const reminded = server.db.mailDrives
      .remindersForAttempt(item.driveAttemptId)
      .some((reminder) => reminder.envelopeId === item.envelope)
    if (reminded) {
      await failEnvelopeWithAudit(server, {
        envelope: item.envelope,
        reason: 'ignored',
        runtime: runtimeId,
        targetSessionRef: item.targetSessionRef,
        driveAttemptId: item.driveAttemptId,
        callSite: 'dispose_attempt_obligations',
      })
      return 'failed:ignored'
    }
    server.db.mailDrives.armReminder({
      envelopeId: item.envelope,
      runtimeId,
      targetSessionRef: item.targetSessionRef,
      turnEndedAt: attempt.completedAt ?? new Date().toISOString(),
      remindAt: new Date(Date.now() + REMINDER_HOLD_MS).toISOString(),
    })
    return 'reminder_armed'
  }

  // (3) Alive, and no turn ever carried the body. Reported, never disposed.
  return 'reported'
}
