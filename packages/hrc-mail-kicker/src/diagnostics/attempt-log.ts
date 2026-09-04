/**
 * The lifecycle lines a stranded obligation needs someone to have written
 * (T-07964 §1/§2).
 *
 * Diagnosing EN-03687 on 2026-09-03 took joining four sources by hand because
 * two transitions that decide an obligation's fate said nothing at all: an
 * attempt going terminal, and the asynchronous disposal of what it carried.
 * The attempt changed to `failed` in silence, its disposal died with the
 * process 28 ms later, and the log's last word on the envelope was a
 * `drive_in_flight` heartbeat from fifteen minutes earlier.
 *
 * Everything here is a LOG. Nothing in this file transitions an attempt, an
 * envelope or a run — the disposition rules stay exactly where they were, and
 * these functions are called from their existing sites.
 */
import type { HrcMailDriveAttempt } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'

/**
 * What one envelope's disposal did, in a closed vocabulary.
 *
 * The `skipped:` arm is the one that did not exist before: every branch below
 * was a bare `continue`, and "the disposal ran and decided to do nothing" was
 * indistinguishable from "the disposal never ran" for as long as that held.
 */
export type DisposeOutcome =
  | 'reminded'
  | 'skipped:not_presented'
  | 'skipped:superseded'
  | 'skipped:no_runtime'
  | 'skipped:reminder_exists'
  | `failed:${string}`

/** One asynchronous disposal, live for as long as it has envelopes left. */
export type DisposalInFlight = {
  targetSessionRef: string
  driveAttemptId: string
  runId: string
  envelopeIds: readonly string[]
  pending: Set<string>
  startedAt: string
}

/** The writer handed to `disposeAttemptObligations` for the length of its loop. */
export type DisposeLog = {
  outcome(envelope: string, outcome: DisposeOutcome, detail?: Record<string, unknown>): void
  finish(): void
}

/**
 * One line per attempt transition to a terminal state (§1).
 *
 * It names the target, the attempt, the run, the runtime, the reason the
 * transition was made and — the part that was missing — WHICH envelopes the
 * attempt was holding when it ended. Without that last field the line cannot be
 * joined to the sender's question, which is always about an envelope id.
 */
export function logAttemptTerminal(
  server: MailKickerContext,
  attempt: HrcMailDriveAttempt,
  input: {
    reason: string
    presentedEnvelopeIds: readonly string[]
    runStatus?: string | undefined
  }
): void {
  server.log('INFO', 'wrkq.kicker.attempt_terminal', {
    targetSessionRef: attempt.targetSessionRef,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    ...(attempt.runtimeId === undefined ? {} : { runtimeId: attempt.runtimeId }),
    state: attempt.state,
    reason: input.reason,
    ...(input.runStatus === undefined ? {} : { runStatus: input.runStatus }),
    ...(attempt.terminalEventKind === undefined
      ? {}
      : { terminalEventKind: attempt.terminalEventKind }),
    ...(attempt.lastError === undefined ? {} : { lastError: attempt.lastError }),
    ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
    presentedEnvelopeIds: [...input.presentedEnvelopeIds],
  })
}

/**
 * Open the disposal's log and put it on the in-flight register.
 *
 * The register is what makes `dispose_interrupted` possible: a disposal that is
 * still holding envelopes when the daemon stops is exactly the shape that lost
 * EN-03687, and it leaves no other trace anywhere.
 */
export function beginDisposeLog(
  server: MailKickerContext,
  attempt: HrcMailDriveAttempt,
  envelopeIds: readonly string[]
): DisposeLog {
  const record: DisposalInFlight = {
    targetSessionRef: attempt.targetSessionRef,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    envelopeIds: [...envelopeIds],
    pending: new Set(envelopeIds),
    startedAt: new Date().toISOString(),
  }
  server.mailKickerDisposalsInFlight.set(attempt.driveAttemptId, record)
  server.log('INFO', 'wrkq.kicker.dispose_begin', {
    targetSessionRef: attempt.targetSessionRef,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    ...(attempt.runtimeId === undefined ? {} : { runtimeId: attempt.runtimeId }),
    attemptState: attempt.state,
    envelopeIds: record.envelopeIds,
  })
  return {
    outcome(envelope, outcome, detail = {}) {
      record.pending.delete(envelope)
      server.log('INFO', 'wrkq.kicker.dispose_outcome', {
        targetSessionRef: attempt.targetSessionRef,
        driveAttemptId: attempt.driveAttemptId,
        runId: attempt.runId,
        ...(attempt.runtimeId === undefined ? {} : { runtimeId: attempt.runtimeId }),
        envelope,
        outcome,
        ...detail,
      })
    },
    finish() {
      server.mailKickerDisposalsInFlight.delete(attempt.driveAttemptId)
    },
  }
}

/**
 * What was still being disposed when the daemon was told to stop (§2).
 *
 * Disposal is fire-and-forget by construction, so a SIGTERM that lands mid-loop
 * takes the remaining envelopes with it. This line does not save them — that is
 * T-07963's job — but it names them, which is the difference between "the
 * obligation was lost at 23:47:33 by this stop" and a store that simply has no
 * row for it.
 */
export function logDisposeInterrupted(server: MailKickerContext): void {
  const live = [...server.mailKickerDisposalsInFlight.values()].filter(
    (record) => record.pending.size > 0
  )
  if (live.length === 0) return
  server.log('WARN', 'wrkq.kicker.dispose_interrupted', {
    disposals: live.length,
    pendingEnvelopes: live.reduce((total, record) => total + record.pending.size, 0),
    interrupted: live.map((record) => ({
      targetSessionRef: record.targetSessionRef,
      driveAttemptId: record.driveAttemptId,
      runId: record.runId,
      startedAt: record.startedAt,
      envelopeIds: [...record.pending],
    })),
  })
}
