function isDurablyActiveRun(run: HrcRunRecord): boolean {
  if (run.completedAt !== undefined) return false
  return run.status === 'queued' || isRunActive(run)
}

export function activeRunIdFor(
  server: MailKickerContext,
  session: HrcSessionRecord
): string | undefined {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (runtime.activeRunId !== undefined) return runtime.activeRunId
  }
  return undefined
}

/** A mid-turn attempt (rev 4): owned by the queued input's run, holding no slot. */
export function isQueuedAttempt(attempt: HrcMailDriveAttempt): boolean {
  return attempt.driveAttemptId.startsWith('queued-')
}

function terminalRunEvent(events: HrcLifecycleEvent[]): HrcLifecycleEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return event
  }
  return undefined
}

/**
 * Read the seat's own observed turn state, never an HRC run-row inference.
 *
 * Human-typed pane turns mint no HRC run row (the failed first cut of T-07890),
 * while the broker observes both those turns and HRC-driven turns. The broker
 * seat probe is therefore the one busy/idle authority. Hook-observed terminal
 * turn events wake the boundary flush; the periodic sweep is its backstop.
 */
export async function observeBrokerSeat(
  server: MailKickerContext,
  session: HrcSessionRecord
): Promise<ObservedBrokerSeat> {
  const runtime = server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (candidate) =>
        candidate.generation === session.generation &&
        candidate.controllerKind === 'harness-broker' &&
        candidate.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(candidate.status)
    )
    .at(-1)
  if (runtime === undefined) return { state: 'absent' }
  const probe = await server.broker.seatProbe(runtime.runtimeId)
  if (!probe.ok) return { state: 'unavailable', runtimeId: runtime.runtimeId }
  const seat = probe.response.seat
  return seat.state === 'turn-active'
    ? { state: 'turn-active', runtimeId: runtime.runtimeId, turnId: String(seat.turnId) }
    : { state: seat.state, runtimeId: runtime.runtimeId }
}

/**
 * What a finished attempt's own turn did to the obligations it carried
 * (rev 5.1 D4/D5).
 *
 * The trigger is the attempt's OWN turn having provably started and ended:
 * `completeStartedAttempt` returns envelope ids only in that case, so an input
 * the harness merged into another turn reaches here with nothing and neither
 * arms a reminder nor strikes an obligation out. That is the rev 4 ownership
 * rule, retained for exactly this one job.
 *
 * Two outcomes, decided by whether THIS attempt was the reminder:
 *
 *  - an ordinary delivery attempt ARMS the one reminder for (envelope,
 *    runtime), held `REMINDER_HOLD_MS`;
 *  - the reminder attempt STRIKES OUT — the reader has now ended two turns
 *    holding the obligation, one of them after being pointed straight at it.
 *
 * Both are conditional on the envelope still being `presented` AND on this
 * attempt still owning its newest receipt. A reply, a defer, or a delivery that
 * has since been superseded all mean this attempt has nothing left to decide.
 * Failures are logged and dropped: not failing an obligation makes it live
 * longer, which is the safe direction, and D3 bounds it regardless.
 */
function disposeAttemptObligations(
  server: MailKickerContext,
  attempt: HrcMailDriveAttempt,
  envelopeIds: readonly string[]
): void {
  // T-07671 §5: a line about a target that does not name the target is not part
  // of that target's timeline, and `grep <scope>` silently misses it.
  const { targetSessionRef, driveAttemptId } = attempt
  if (envelopeIds.length === 0) return
  const reminded = new Map(
    server.db.mailDrives
      .remindersForAttempt(driveAttemptId)
      .map((reminder) => [reminder.envelopeId, reminder] as const)
  )
  // A disposition is durable the moment it is DECIDED, not when the loop ends:
  // the reconcile's candidate set is "presentation not yet dispositioned", so a
  // per-envelope write is what makes a partially-completed loop resumable.
  const dispose = (envelope: string, disposition: string): void => {
    server.db.mailDrives.recordPresentationDisposition(driveAttemptId, envelope, disposition)
  }
  const turnEndedAt = attempt.completedAt ?? new Date().toISOString()
  const remindAt = new Date(Date.now() + REMINDER_HOLD_MS).toISOString()
  // T-07964 §2: every branch below used to be a bare `continue`, so a disposal
  // that ran and decided nothing looked exactly like one that never ran at all.
  const disposeLog = beginDisposeLog(server, attempt, envelopeIds)
  // T-07963: this was `void (async () => {…})()`, so a daemon stop between an
  // attempt going terminal and its obligations being disposed took the whole
  // loop with it — the 28 ms that stranded EN-03687. The promise is registered
  // so `MailKicker.stop()` can drain it, and every decision below is ALSO
  // written durably, so a stop that still beats the loop leaves the boot
  // reconcile a candidate rather than silence. Two mechanisms because the drain
  // alone cannot cover a kill -9.
  const disposal = (async () => {
    try {
      for (const envelope of envelopeIds) {
        try {
          const row = await server.ledger.envelopeShow({ envelope })
          if (row.state !== 'presented') {
            disposeLog.outcome(envelope, 'skipped:not_presented', { envelopeState: row.state })
            dispose(envelope, `skipped:not_presented:${row.state}`)
            continue
          }
          const newest = newestPresentationReceipt(row)
          // Superseded: another attempt has presented this since, so the
          // obligation is bound to that delivery and not to this one.
          if (newest?.driveAttemptId !== driveAttemptId) {
            disposeLog.outcome(envelope, 'skipped:superseded', {
              ...(newest?.driveAttemptId === undefined
                ? {}
                : { newestDriveAttemptId: newest.driveAttemptId }),
            })
            dispose(envelope, 'skipped:superseded')
            continue
          }
          const runtime = newest.runtimeId ?? attempt.runtimeId
          if (runtime === undefined) {
            disposeLog.outcome(envelope, 'skipped:no_runtime')
            dispose(envelope, 'skipped:no_runtime')
            continue
          }
          if (reminded.has(envelope)) {
            await failEnvelope(server, {
              envelope,
              reason: 'ignored',
              runtime,
              targetSessionRef,
              driveAttemptId,
              callSite: 'dispose_attempt_obligations',
            })
            disposeLog.outcome(envelope, 'failed:ignored', { runtimeId: runtime })
            dispose(envelope, 'failed:ignored')
            continue
          }
          const armed = server.db.mailDrives.armReminder({
            envelopeId: envelope,
            runtimeId: runtime,
            targetSessionRef,
            turnEndedAt,
            remindAt,
          })
          if (!armed) {
            disposeLog.outcome(envelope, 'skipped:reminder_exists', { runtimeId: runtime })
            dispose(envelope, 'skipped:reminder_exists')
            continue
          }
          server.log('INFO', 'wrkq.kicker.reminder_armed', {
            targetSessionRef,
            driveAttemptId,
            envelope,
            runtimeId: runtime,
            remindAt,
          })
          disposeLog.outcome(envelope, 'reminded', { runtimeId: runtime, remindAt })
          dispose(envelope, 'reminder_armed')
        } catch (error) {
          server.log('WARN', 'wrkq.kicker.dispose_obligation_failed', {
            targetSessionRef,
            driveAttemptId,
            envelope,
            error: errorText(error),
          })
          disposeLog.outcome(envelope, 'failed:error', { error: errorText(error) })
        }
      }
    } finally {
      disposeLog.finish()
    }
  })()
  server.mailKickerDisposalsPending.add(disposal)
  void disposal.finally(() => server.mailKickerDisposalsPending.delete(disposal))
}

/**
 * End one obligation unsuccessfully, and say so in one greppable line.
 *
 * The call is IDEMPOTENT per (envelope, runtime) on the wrkq side, and a
 * runtime that no longer owns the newest receipt is REFUSED there rather than
 * allowed to fail a delivery that has moved on. Both matter here: this is
 * reached from a wake, from a sweep, and from a completed attempt, and all
 * three can observe the same lapse.
 */
async function failEnvelope(
  server: MailKickerContext,
  input: {
    envelope: string
    reason: Exclude<WrkqEnvelopeFailureReason, 'legacy'>
    runtime?: string | undefined
    targetSessionRef: string
    driveAttemptId?: string | undefined
    callSite: 'birth_refusals_exhausted' | 'dispose_attempt_obligations' | 'lapsed_obligations'
  }
): Promise<void> {
  await failEnvelopeWithAudit(server, input)
}

/** Is this runtime, by its own status column, no longer live? */
export function isRuntimeTerminal(status: string): boolean {
  const level = (RUNTIME_STATUS_LEVEL_BY_STATUS as Record<string, string | null>)[status]
  return level === 'runtime-dead'
}

export function observeAttempt(
  server: MailKickerContext,
  attempt: HrcMailDriveAttempt
): AttemptObservation {
  const events = server.db.hrcEvents.listByRun(attempt.runId)
  const started = events.find((event) => event.eventKind === 'turn.started')
  let current = attempt
  if (started !== undefined) {
    current =
      server.db.mailDrives.recordStart({
        runId: attempt.runId,
        startHrcSeq: started.hrcSeq,
        startedAt: started.ts,
        hostSessionId: started.hostSessionId,
        generation: started.generation,
        runtimeId: started.runtimeId,
      }) ?? current
  }

  const terminal = terminalRunEvent(events)
  if (terminal !== undefined) {
    const completed = server.db.mailDrives.completeStartedAttempt(current.runId, terminal.eventKind)
    if (completed !== undefined) {
      logAttemptTerminal(server, completed.attempt, {
        reason: terminal.eventKind,
        presentedEnvelopeIds: completed.presentedEnvelopeIds,
        runStatus: server.db.runs.getByRunId(current.runId)?.status,
      })
      disposeAttemptObligations(server, completed.attempt, completed.presentedEnvelopeIds)
    }
    return 'finished'
  }

  const run = server.db.runs.getByRunId(current.runId)
  const runtime =
    current.runtimeId === undefined
      ? undefined
      : (server.db.runtimes.getByRuntimeId(current.runtimeId) ?? undefined)
  // T-07908: the runtime row is independent terminal evidence. A broker crash
  // can sever both runtime.activeRunId and invocation.runId before the drive's
  // run receives a terminal event or row update. In that shape the accepted run
  // is not durable liveness: the runtime that owned it is already dead. Finish
  // the attempt before consulting the run row so the scope slot cannot remain
  // wedged behind the dead dispatch.
  if (runtime !== undefined && isRuntimeTerminal(runtime.status)) {
    const completed = server.db.mailDrives.completeStartedAttempt(
      current.runId,
      `runtime.${runtime.status}`
    )
    if (completed !== undefined) {
      logAttemptTerminal(server, completed.attempt, {
        reason: `runtime.${runtime.status}`,
        presentedEnvelopeIds: completed.presentedEnvelopeIds,
        runStatus: run?.status,
      })
      disposeAttemptObligations(server, completed.attempt, completed.presentedEnvelopeIds)
    }
    server.log('INFO', 'wrkq.kicker.terminal_runtime_attempt_reaped', {
      targetSessionRef: current.targetSessionRef,
      driveAttemptId: current.driveAttemptId,
      runId: current.runId,
      runtimeId: runtime.runtimeId,
      runtimeStatus: runtime.status,
    })
    return 'finished'
  }
  // T-07612 rev 4: a mid-turn (`queued-`) attempt holds no slot and is never
  // replayed. If its run is gone, or its runtime died before the input ever
  // started a turn, nothing will complete it: close it WITHOUT rounds — the
  // envelope was not shown at a boundary — and let the floor re-drive.
  if (started === undefined && isQueuedAttempt(current)) {
    const reason = run === null ? 'queued input has no run row' : undefined
    if (reason !== undefined) {
      const failed = server.db.mailDrives.failWithoutStart(current.driveAttemptId, reason)
      logAttemptTerminal(server, failed, {
        reason,
        // An unstarted attempt never owned a turn, so it disposes nothing. The
        // empty list is the point: it says the receipt is going nowhere.
        presentedEnvelopeIds: server.db.mailDrives.presentationEnvelopeIds(failed.driveAttemptId),
      })
      server.log('INFO', 'wrkq.kicker.queued_attempt_reaped', {
        targetSessionRef: current.targetSessionRef,
        driveAttemptId: current.driveAttemptId,
        runId: current.runId,
        queuedBehindRunId: current.queuedBehindRunId,
        reason,
      })
      return 'finished'
    }
  }
  if (run === null) return 'dispatch'
  if (isDurablyActiveRun(run)) return 'waiting'

  if (run.completedAt !== undefined || run.status === 'completed' || run.status === 'failed') {
    const completed = server.db.mailDrives.completeStartedAttempt(
      current.runId,
      `run.${run.status}`
    )
    if (completed !== undefined) {
      logAttemptTerminal(server, completed.attempt, {
        reason: `run.${run.status}`,
        presentedEnvelopeIds: completed.presentedEnvelopeIds,
        runStatus: run.status,
      })
      disposeAttemptObligations(server, completed.attempt, completed.presentedEnvelopeIds)
    }
    return 'finished'
  }
  return 'waiting'
}

import { RUNTIME_STATUS_LEVEL_BY_STATUS } from 'hrc-core'
import type { HrcLifecycleEvent, HrcRunRecord, HrcSessionRecord } from 'hrc-core'
import type { HrcMailDriveAttempt } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { beginDisposeLog, logAttemptTerminal } from '../diagnostics/attempt-log.js'
import {
  MAIL_DRIVE_TERMINAL_EVENTS,
  REMINDER_HOLD_MS,
  errorText,
  isRunActive,
  isRuntimeUnavailableStatus,
} from '../internal.js'
import { newestPresentationReceipt } from '../ledger/types.js'
import type { WrkqEnvelopeFailureReason } from '../ledger/types.js'
import { failEnvelopeWithAudit } from '../terminal/envelope-terminal.js'
import type { ObservedBrokerSeat } from './held-batch-flush.js'

export type AttemptObservation = 'dispatch' | 'waiting' | 'finished'
