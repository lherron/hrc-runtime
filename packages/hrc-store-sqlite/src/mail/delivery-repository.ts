import type { Database } from 'bun:sqlite'

/**
 * HRC's DELIVERY state for the wrkq collaboration ledger (spec T-08092 rev 4,
 * D2/D3).
 *
 * wrkq owns the envelopes, their obligations and their dispositions. This
 * repository owns only the two things HRC must remember to deliver them
 * truthfully, and neither of them references a run or a turn:
 *
 *  - the WRITE-AHEAD INTENT, committed before any broker door is called. One
 *    open row per envelope — the primary key is that guarantee — so a landing
 *    can never precede the record, an HRC-side crash leaves durable intent
 *    rather than nothing, and an envelope with an open intent is never
 *    actionable. Rows are deleted when the delivery lands or is refused: this
 *    is the live set, and the durable receipt is wrkq's.
 *  - the PRESENTATION RECORD, written when a landing fact is observed on the
 *    committed broker stream. It is keyed by (envelope, runtime), which is the
 *    binding rev 5.1 means, and carries the landing sequence and the reminder
 *    state D3 decides disposal on.
 *
 * The drive ATTEMPT this replaces is gone (migration 0058). It existed so a
 * finished run could be joined to the envelope it carried; the auto-mint that
 * needed that join was retired in T-08093, and human-typed turns — which mint
 * no run — were invisible to every path keyed on one.
 */

/** Why the kicker woke for a target. Unchanged from the drive era. */
export type HrcMailDriveWakeReason = 'insert' | 'turn_completion' | 'periodic' | 'recovery'

/** Which broker door a delivery went through. `launch` carries no submission. */
export type HrcMailDeliveryDoor = 'steer' | 'enqueue' | 'preempt' | 'invoke' | 'launch'

/** The presentation form the body took; `reminder` lands on an existing record. */
export type HrcMailDeliveryForm = 'full' | 'defer-retry' | 'reminder'

export type HrcMailDeliveryIntent = {
  envelopeId: string
  targetSessionRef: string
  door: HrcMailDeliveryDoor
  form: HrcMailDeliveryForm
  /**
   * The opaque presentation id this delivery will carry onto the wrkq receipt
   * (`present-<uuid>`), minted with the intent and NOT at landing.
   *
   * Minting it here is what makes the receipt write idempotent across a crash:
   * wrkq's unique index on the id dedupes a replayed `present`, so a landing
   * observed twice — live and again by reconcile — yields exactly one receipt.
   */
  presentationId: string
  runtimeId?: string | undefined
  submissionId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  /** An outcome the door already decided, e.g. a hold whose authority was refused. */
  deliveryOutcome?: string | undefined
  invocationId?: string | undefined
  brokerAfterSeq?: number | undefined
  uncertainCause?: string | undefined
  uncertainAt?: string | undefined
  lastEvidenceKind?: string | undefined
  lastEvidenceAt?: string | undefined
  terminalEnvelopeCause?: string | undefined
  terminalEnvelopeAt?: string | undefined
  cleanupOutcome?: string | undefined
  cleanupAt?: string | undefined
  submittedHrcSeq: number
  submittedAt: string
  updatedAt: string
}

export type HrcMailPresentation = {
  envelopeId: string
  runtimeId: string
  targetSessionRef: string
  generation?: number | undefined
  presentationId: string
  inputId?: string | undefined
  deliveryOutcome: string
  landingHrcSeq: number
  landedAt: string
  /** Set only after wrkq has accepted the receipt for this presentation. */
  receiptCommittedAt?: string | undefined
  /** When the turn that carried the body ended; the reminder header quotes it. */
  turnEndedAt?: string | undefined
  reminderArmedAt?: string | undefined
  reminderDueAt?: string | undefined
  reminderLandingHrcSeq?: number | undefined
  reminderLandedAt?: string | undefined
  disposedAt?: string | undefined
  disposition?: string | undefined
}

export type HrcMailBirthRefusal = {
  targetSessionRef: string
  scopeRef: string
  refusals: number
  lastReason?: string | undefined
  resolvedAt?: string | undefined
  createdAt: string
  updatedAt: string
}

/** One §5 sender-side failure notice awaiting a live generation to land in. */
export type HrcMailFailureNotice = {
  envelopeId: string
  targetSessionRef: string
  notice: string
  createdAt: string
  deliveredAt?: string | undefined
}

/**
 * The mail hint's decision (`POST /v1/internal/mail/hint-decision`).
 *
 * The count is the seat's OUTSTANDING ENQUEUE SUBMISSIONS: mail that has been
 * handed to the harness-local queue and will not be readable until the turn
 * ends. On a steer-capable seat that count is zero by construction, because a
 * steer lands inside the turn and needs no hint.
 */
export type HrcMailHintDecision =
  | { outcome: 'suppressed'; reason: 'no_outstanding_mail' | 'runtime_mismatch' | 'cadence' }
  | { outcome: 'issued'; reason: 'first' | 'count_changed' | 'periodic'; outstandingCount: number }

const HINT_CADENCE_MS = 120_000

type IntentRow = {
  envelope_id: string
  target_session_ref: string
  door: string
  form: string
  presentation_id: string
  runtime_id: string | null
  submission_id: string | null
  host_session_id: string | null
  generation: number | null
  delivery_outcome: string | null
  invocation_id: string | null
  broker_after_seq: number | null
  uncertain_cause: string | null
  uncertain_at: string | null
  last_evidence_kind: string | null
  last_evidence_at: string | null
  terminal_envelope_cause: string | null
  terminal_envelope_at: string | null
  cleanup_outcome: string | null
  cleanup_at: string | null
  submitted_hrc_seq: number
  submitted_at: string
  updated_at: string
}

type PresentationRow = {
  envelope_id: string
  runtime_id: string
  target_session_ref: string
  generation: number | null
  presentation_id: string
  input_id: string | null
  delivery_outcome: string
  landing_hrc_seq: number
  landed_at: string
  receipt_committed_at: string | null
  turn_ended_at: string | null
  reminder_armed_at: string | null
  reminder_due_at: string | null
  reminder_landing_hrc_seq: number | null
  reminder_landed_at: string | null
  disposed_at: string | null
  disposition: string | null
}

type BirthRefusalRow = {
  target_session_ref: string
  scope_ref: string
  refusals: number
  last_reason: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

type FailureNoticeRow = {
  envelope_id: string
  target_session_ref: string
  notice: string
  created_at: string
  delivered_at: string | null
}

const INTENT_COLUMNS = `
  envelope_id, target_session_ref, door, form, presentation_id, runtime_id,
  submission_id, host_session_id, generation, delivery_outcome,
  submitted_hrc_seq, submitted_at, updated_at, invocation_id, broker_after_seq,
  uncertain_cause, uncertain_at, last_evidence_kind, last_evidence_at,
  terminal_envelope_cause, terminal_envelope_at, cleanup_outcome, cleanup_at
`

const PRESENTATION_COLUMNS = `
  envelope_id, runtime_id, target_session_ref, generation, presentation_id,
  input_id, delivery_outcome, landing_hrc_seq, landed_at, receipt_committed_at, turn_ended_at,
  reminder_armed_at, reminder_due_at, reminder_landing_hrc_seq,
  reminder_landed_at, disposed_at, disposition
`

function mapIntent(row: IntentRow): HrcMailDeliveryIntent {
  return {
    envelopeId: row.envelope_id,
    targetSessionRef: row.target_session_ref,
    door: row.door as HrcMailDeliveryDoor,
    form: row.form as HrcMailDeliveryForm,
    presentationId: row.presentation_id,
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id }),
    ...(row.submission_id === null ? {} : { submissionId: row.submission_id }),
    ...(row.host_session_id === null ? {} : { hostSessionId: row.host_session_id }),
    ...(row.generation === null ? {} : { generation: row.generation }),
    ...(row.delivery_outcome === null ? {} : { deliveryOutcome: row.delivery_outcome }),
    ...(row.invocation_id === null ? {} : { invocationId: row.invocation_id }),
    ...(row.broker_after_seq === null ? {} : { brokerAfterSeq: row.broker_after_seq }),
    ...(row.uncertain_cause === null ? {} : { uncertainCause: row.uncertain_cause }),
    ...(row.uncertain_at === null ? {} : { uncertainAt: row.uncertain_at }),
    ...(row.last_evidence_kind === null ? {} : { lastEvidenceKind: row.last_evidence_kind }),
    ...(row.last_evidence_at === null ? {} : { lastEvidenceAt: row.last_evidence_at }),
    ...(row.terminal_envelope_cause === null
      ? {}
      : { terminalEnvelopeCause: row.terminal_envelope_cause }),
    ...(row.terminal_envelope_at === null ? {} : { terminalEnvelopeAt: row.terminal_envelope_at }),
    ...(row.cleanup_outcome === null ? {} : { cleanupOutcome: row.cleanup_outcome }),
    ...(row.cleanup_at === null ? {} : { cleanupAt: row.cleanup_at }),
    submittedHrcSeq: row.submitted_hrc_seq,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  }
}

function mapPresentation(row: PresentationRow): HrcMailPresentation {
  return {
    envelopeId: row.envelope_id,
    runtimeId: row.runtime_id,
    targetSessionRef: row.target_session_ref,
    ...(row.generation === null ? {} : { generation: row.generation }),
    presentationId: row.presentation_id,
    ...(row.input_id === null ? {} : { inputId: row.input_id }),
    deliveryOutcome: row.delivery_outcome,
    landingHrcSeq: row.landing_hrc_seq,
    landedAt: row.landed_at,
    ...(row.receipt_committed_at === null ? {} : { receiptCommittedAt: row.receipt_committed_at }),
    ...(row.turn_ended_at === null ? {} : { turnEndedAt: row.turn_ended_at }),
    ...(row.reminder_armed_at === null ? {} : { reminderArmedAt: row.reminder_armed_at }),
    ...(row.reminder_due_at === null ? {} : { reminderDueAt: row.reminder_due_at }),
    ...(row.reminder_landing_hrc_seq === null
      ? {}
      : { reminderLandingHrcSeq: row.reminder_landing_hrc_seq }),
    ...(row.reminder_landed_at === null ? {} : { reminderLandedAt: row.reminder_landed_at }),
    ...(row.disposed_at === null ? {} : { disposedAt: row.disposed_at }),
    ...(row.disposition === null ? {} : { disposition: row.disposition }),
  }
}

function mapBirthRefusal(row: BirthRefusalRow): HrcMailBirthRefusal {
  return {
    targetSessionRef: row.target_session_ref,
    scopeRef: row.scope_ref,
    refusals: row.refusals,
    ...(row.last_reason === null ? {} : { lastReason: row.last_reason }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapFailureNotice(row: FailureNoticeRow): HrcMailFailureNotice {
  return {
    envelopeId: row.envelope_id,
    targetSessionRef: row.target_session_ref,
    notice: row.notice,
    createdAt: row.created_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  }
}

function normalizeTarget(targetSessionRef: string): string {
  const target = targetSessionRef.trim()
  if (target.length === 0) throw new Error('targetSessionRef must be a non-empty string')
  return target
}

export class HrcMailDeliveryRepository {
  constructor(private readonly db: Database) {}

  // ── Write-ahead delivery intents ───────────────────────────────────────────

  /**
   * Commit the intent to deliver ONE envelope, before any door is called.
   *
   * Returns undefined when an open intent already exists for that envelope.
   * That refusal is the whole fence: it is a primary-key conflict rather than a
   * read-then-write, so two wakes racing for the same envelope cannot both
   * submit it, and a daemon that dies immediately after this row is written
   * still has durable evidence that a delivery may be in flight.
   */
  openIntent(input: {
    envelopeId: string
    targetSessionRef: string
    door: HrcMailDeliveryDoor
    form: HrcMailDeliveryForm
    presentationId: string
    runtimeId?: string | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
    deliveryOutcome?: string | undefined
    invocationId?: string | undefined
    brokerAfterSeq?: number | undefined
    submittedHrcSeq: number
  }): HrcMailDeliveryIntent | undefined {
    const now = new Date().toISOString()
    const changes = this.db
      .query(
        `INSERT OR IGNORE INTO hrcmail_delivery_intents (
           envelope_id, target_session_ref, door, form, presentation_id, runtime_id,
           submission_id, host_session_id, generation, delivery_outcome,
           submitted_hrc_seq, submitted_at, updated_at, invocation_id, broker_after_seq
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.envelopeId,
        normalizeTarget(input.targetSessionRef),
        input.door,
        input.form,
        input.presentationId,
        input.runtimeId ?? null,
        input.hostSessionId ?? null,
        input.generation ?? null,
        input.deliveryOutcome ?? null,
        input.submittedHrcSeq,
        now,
        now,
        input.invocationId ?? null,
        input.brokerAfterSeq ?? null
      ).changes
    return changes > 0 ? this.getIntent(input.envelopeId) : undefined
  }

  getIntent(envelopeId: string): HrcMailDeliveryIntent | undefined {
    const row = this.db
      .query<IntentRow, [string]>(
        `SELECT ${INTENT_COLUMNS} FROM hrcmail_delivery_intents WHERE envelope_id = ?`
      )
      .get(envelopeId)
    return row === null ? undefined : mapIntent(row)
  }

  /** Fill in what the door's admission response reported. */
  attachAdmission(
    envelopeId: string,
    patch: {
      door?: HrcMailDeliveryDoor | undefined
      submissionId?: string | undefined
      runtimeId?: string | undefined
      hostSessionId?: string | undefined
      generation?: number | undefined
      deliveryOutcome?: string | undefined
    }
  ): HrcMailDeliveryIntent | undefined {
    const existing = this.getIntent(envelopeId)
    if (existing === undefined) return undefined
    this.db
      .query(
        `UPDATE hrcmail_delivery_intents
            SET door = ?, submission_id = ?, runtime_id = ?, host_session_id = ?,
                generation = ?, delivery_outcome = ?, updated_at = ?
          WHERE envelope_id = ?`
      )
      .run(
        patch.door ?? existing.door,
        patch.submissionId ?? existing.submissionId ?? null,
        patch.runtimeId ?? existing.runtimeId ?? null,
        patch.hostSessionId ?? existing.hostSessionId ?? null,
        patch.generation ?? existing.generation ?? null,
        patch.deliveryOutcome ?? existing.deliveryOutcome ?? null,
        new Date().toISOString(),
        envelopeId
      )
    return this.getIntent(envelopeId)
  }

  /** Close one intent. Idempotent: a landing and a refusal can race. */
  clearIntent(envelopeId: string): boolean {
    return (
      this.db.query('DELETE FROM hrcmail_delivery_intents WHERE envelope_id = ?').run(envelopeId)
        .changes > 0
    )
  }

  listOpenIntents(targetSessionRef?: string): HrcMailDeliveryIntent[] {
    const rows =
      targetSessionRef === undefined
        ? this.db
            .query<IntentRow, []>(
              `SELECT ${INTENT_COLUMNS} FROM hrcmail_delivery_intents
                ORDER BY submitted_at ASC, envelope_id ASC`
            )
            .all()
        : this.db
            .query<IntentRow, [string]>(
              `SELECT ${INTENT_COLUMNS} FROM hrcmail_delivery_intents
                WHERE target_session_ref = ?
                ORDER BY submitted_at ASC, envelope_id ASC`
            )
            .all(normalizeTarget(targetSessionRef))
    return rows.map(mapIntent)
  }

  /** An ambiguous/native-held or terminal envelope is a fence, never a wake candidate. */
  listActiveOpenIntents(targetSessionRef?: string): HrcMailDeliveryIntent[] {
    return this.listOpenIntents(targetSessionRef).filter(
      (intent) => intent.terminalEnvelopeAt === undefined
    )
  }

  markUncertain(
    envelopeId: string,
    cause: string,
    evidenceKind?: string
  ): HrcMailDeliveryIntent | undefined {
    this.db
      .query(
        'UPDATE hrcmail_delivery_intents SET uncertain_cause = ?, uncertain_at = COALESCE(uncertain_at, ?), last_evidence_kind = COALESCE(?, last_evidence_kind), last_evidence_at = ?, updated_at = ? WHERE envelope_id = ?'
      )
      .run(
        cause,
        new Date().toISOString(),
        evidenceKind ?? null,
        new Date().toISOString(),
        new Date().toISOString(),
        envelopeId
      )
    return this.getIntent(envelopeId)
  }

  markTerminalEnvelope(envelopeId: string, cause: string): HrcMailDeliveryIntent | undefined {
    const now = new Date().toISOString()
    this.db
      .query(
        'UPDATE hrcmail_delivery_intents SET terminal_envelope_cause = ?, terminal_envelope_at = COALESCE(terminal_envelope_at, ?), updated_at = ? WHERE envelope_id = ?'
      )
      .run(cause, now, now, envelopeId)
    return this.getIntent(envelopeId)
  }

  recordTerminalCleanup(envelopeId: string, outcome: string): HrcMailDeliveryIntent | undefined {
    const now = new Date().toISOString()
    this.db
      .query(
        'UPDATE hrcmail_delivery_intents SET cleanup_outcome = COALESCE(cleanup_outcome, ?), cleanup_at = COALESCE(cleanup_at, ?), updated_at = ? WHERE envelope_id = ?'
      )
      .run(outcome, now, now, envelopeId)
    return this.getIntent(envelopeId)
  }

  getIntentBySubmissionId(submissionId: string): HrcMailDeliveryIntent | undefined {
    const row = this.db
      .query<IntentRow, [string]>(
        `SELECT ${INTENT_COLUMNS} FROM hrcmail_delivery_intents WHERE submission_id = ?`
      )
      .get(submissionId)
    return row === null ? undefined : mapIntent(row)
  }

  /** Open launch-carried intents for one runtime; their landing is its first turn. */
  listLaunchIntentsForRuntime(runtimeId: string): HrcMailDeliveryIntent[] {
    return this.db
      .query<IntentRow, [string]>(
        `SELECT ${INTENT_COLUMNS} FROM hrcmail_delivery_intents
          WHERE runtime_id = ? AND door = 'launch'
          ORDER BY submitted_at ASC, envelope_id ASC`
      )
      .all(runtimeId)
      .map(mapIntent)
  }

  /** Targets holding an open intent: "a delivery is already in flight for this seat". */
  listIntentTargets(): string[] {
    return this.db
      .query<{ target_session_ref: string }, []>(
        `SELECT DISTINCT target_session_ref FROM hrcmail_delivery_intents
          WHERE terminal_envelope_at IS NULL
          ORDER BY target_session_ref ASC`
      )
      .all()
      .map((row) => row.target_session_ref)
  }

  /** Open intents whose door has not reported a landing within the TTL. */
  listExpiredIntents(before: string): HrcMailDeliveryIntent[] {
    return this.db
      .query<IntentRow, [string]>(
        `SELECT ${INTENT_COLUMNS} FROM hrcmail_delivery_intents
          WHERE submitted_at <= ? AND terminal_envelope_at IS NULL
          ORDER BY submitted_at ASC, envelope_id ASC`
      )
      .all(before)
      .map(mapIntent)
  }

  // ── Presentation records ───────────────────────────────────────────────────

  /**
   * Record one LANDED presentation.
   *
   * `landing_hrc_seq` decides the write when the pair already exists: a later
   * landing (a defer retry re-presented into the same runtime) replaces the
   * record and clears the reminder and disposition it had decided about the
   * older delivery. An equal or older sequence is a replay and changes nothing,
   * which is what makes reconcile idempotent.
   */
  recordPresentation(input: {
    envelopeId: string
    runtimeId: string
    targetSessionRef: string
    generation?: number | undefined
    presentationId: string
    inputId?: string | undefined
    deliveryOutcome: string
    landingHrcSeq: number
  }): { recorded: boolean; presentation: HrcMailPresentation } {
    return this.db
      .transaction(() => {
        const existing = this.getPresentation(input.envelopeId, input.runtimeId)
        if (existing !== undefined && existing.landingHrcSeq >= input.landingHrcSeq) {
          return { recorded: false, presentation: existing }
        }
        const now = new Date().toISOString()
        this.db
          .query(
            `INSERT INTO hrcmail_presentations (
               envelope_id, runtime_id, target_session_ref, generation, presentation_id,
               input_id, delivery_outcome, landing_hrc_seq, landed_at, receipt_committed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(envelope_id, runtime_id) DO UPDATE SET
               target_session_ref = excluded.target_session_ref,
               generation = excluded.generation,
               presentation_id = excluded.presentation_id,
               input_id = excluded.input_id,
               delivery_outcome = excluded.delivery_outcome,
               landing_hrc_seq = excluded.landing_hrc_seq,
               landed_at = excluded.landed_at,
               receipt_committed_at = NULL,
               turn_ended_at = NULL,
               reminder_armed_at = NULL,
               reminder_due_at = NULL,
               reminder_landing_hrc_seq = NULL,
               reminder_landed_at = NULL,
               disposed_at = NULL,
               disposition = NULL`
          )
          .run(
            input.envelopeId,
            input.runtimeId,
            normalizeTarget(input.targetSessionRef),
            input.generation ?? null,
            input.presentationId,
            input.inputId ?? null,
            input.deliveryOutcome,
            input.landingHrcSeq,
            now
          )
        const presentation = this.getPresentation(input.envelopeId, input.runtimeId)
        if (presentation === undefined) {
          throw new Error(`failed to reload presentation ${input.envelopeId}`)
        }
        return { recorded: true, presentation }
      })
      .immediate() as { recorded: boolean; presentation: HrcMailPresentation }
  }

  getPresentation(envelopeId: string, runtimeId: string): HrcMailPresentation | undefined {
    const row = this.db
      .query<PresentationRow, [string, string]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE envelope_id = ? AND runtime_id = ?`
      )
      .get(envelopeId, runtimeId)
    return row === null ? undefined : mapPresentation(row)
  }

  /** Promote a local landing to D3 authority only after wrkq accepted its receipt. */
  markReceiptCommitted(envelopeId: string, runtimeId: string): boolean {
    return (
      this.db
        .query(
          'UPDATE hrcmail_presentations SET receipt_committed_at = COALESCE(receipt_committed_at, ?) WHERE envelope_id = ? AND runtime_id = ?'
        )
        .run(new Date().toISOString(), envelopeId, runtimeId).changes > 0
    )
  }

  presentationsForEnvelope(envelopeId: string): HrcMailPresentation[] {
    return this.db
      .query<PresentationRow, [string]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE envelope_id = ?
          ORDER BY landed_at ASC, runtime_id ASC`
      )
      .all(envelopeId)
      .map(mapPresentation)
  }

  presentationsForRuntime(runtimeId: string): HrcMailPresentation[] {
    return this.db
      .query<PresentationRow, [string]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE runtime_id = ?
          ORDER BY landed_at ASC, envelope_id ASC`
      )
      .all(runtimeId)
      .map(mapPresentation)
  }

  presentationsForTarget(targetSessionRef: string, limit = 50): HrcMailPresentation[] {
    return this.db
      .query<PresentationRow, [string, number]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE target_session_ref = ?
          ORDER BY landed_at DESC, envelope_id ASC
          LIMIT ?`
      )
      .all(normalizeTarget(targetSessionRef), limit)
      .map(mapPresentation)
  }

  /** Undisposed presentations on one runtime: D3's whole candidate set. */
  listUndisposedForRuntime(runtimeId: string): HrcMailPresentation[] {
    return this.db
      .query<PresentationRow, [string]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE runtime_id = ? AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL
          ORDER BY landing_hrc_seq ASC, envelope_id ASC`
      )
      .all(runtimeId)
      .map(mapPresentation)
  }

  /**
   * Every undisposed presentation, whole-history.
   *
   * No time horizon, deliberately: a lookback window puts a recovery TTL on
   * keep-forever collaboration state. The set is bounded STRUCTURALLY — a row
   * leaves it permanently once dispositioned.
   */
  listUndisposedPresentations(limit = 500): HrcMailPresentation[] {
    return this.db
      .query<PresentationRow, [number]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE disposed_at IS NULL AND receipt_committed_at IS NOT NULL
          ORDER BY landed_at ASC, envelope_id ASC
          LIMIT ?`
      )
      .all(limit)
      .map(mapPresentation)
  }

  /** (target, runtime) pairs a presentation has bound since `since`. */
  listRuntimeBoundTargets(since: string): { targetSessionRef: string; runtimeId: string }[] {
    return this.db
      .query<{ target_session_ref: string; runtime_id: string }, [string]>(
        `SELECT DISTINCT target_session_ref, runtime_id
           FROM hrcmail_presentations
          WHERE landed_at >= ?
          ORDER BY target_session_ref ASC, runtime_id ASC`
      )
      .all(since)
      .map((row) => ({ targetSessionRef: row.target_session_ref, runtimeId: row.runtime_id }))
  }

  /**
   * Arm the D3 reminder for one (envelope, runtime), at most once per landing.
   *
   * Returns false when this record already carries a reminder. That is the
   * at-most-once guarantee, and it lives in the record rather than a
   * read-then-write because the arming trigger is deliberately loose: every
   * turn terminal on the runtime re-offers the same pair, and all but the first
   * must be no-ops.
   */
  armReminder(input: {
    envelopeId: string
    runtimeId: string
    turnEndedAt: string
    remindAt: string
  }): boolean {
    return (
      this.db
        .query(
          `UPDATE hrcmail_presentations
              SET reminder_armed_at = ?, reminder_due_at = ?, turn_ended_at = ?
            WHERE envelope_id = ? AND runtime_id = ?
              AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL AND reminder_armed_at IS NULL`
        )
        .run(
          new Date().toISOString(),
          input.remindAt,
          input.turnEndedAt,
          input.envelopeId,
          input.runtimeId
        ).changes > 0
    )
  }

  /** Armed, undelivered reminders for one target whose hold has expired. */
  listDueReminders(targetSessionRef: string, now: string): HrcMailPresentation[] {
    return this.db
      .query<PresentationRow, [string, string]>(
        `SELECT ${PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE target_session_ref = ?
            AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL
            AND reminder_due_at IS NOT NULL
            AND reminder_due_at <= ?
            AND reminder_landing_hrc_seq IS NULL
          ORDER BY reminder_due_at ASC, envelope_id ASC`
      )
      .all(normalizeTarget(targetSessionRef), now)
      .map(mapPresentation)
  }

  /** Targets owed a due reminder; a sweep candidate source of its own. */
  listDueReminderTargets(now: string): string[] {
    return this.db
      .query<{ target_session_ref: string }, [string]>(
        `SELECT DISTINCT target_session_ref FROM hrcmail_presentations
          WHERE disposed_at IS NULL AND receipt_committed_at IS NOT NULL
            AND reminder_due_at IS NOT NULL
            AND reminder_due_at <= ?
            AND reminder_landing_hrc_seq IS NULL
          ORDER BY target_session_ref ASC`
      )
      .all(now)
      .map((row) => row.target_session_ref)
  }

  /** The reminder's own delivery landed: record the sequence D3 strikes out on. */
  recordReminderLanding(envelopeId: string, runtimeId: string, landingHrcSeq: number): boolean {
    return (
      this.db
        .query(
          `UPDATE hrcmail_presentations
              SET reminder_landing_hrc_seq = ?, reminder_landed_at = ?
            WHERE envelope_id = ? AND runtime_id = ?
              AND reminder_landing_hrc_seq IS NULL`
        )
        .run(landingHrcSeq, new Date().toISOString(), envelopeId, runtimeId).changes > 0
    )
  }

  /**
   * Retire a reminder whose obligation is no longer standing on that runtime.
   *
   * Marked as landed at the sentinel sequence -1 rather than deleted: the row
   * leaves the due set permanently, and a sequence below every real terminal
   * can never be read as "the reader was shown a reminder and ignored it".
   */
  retireReminder(envelopeId: string, runtimeId: string): boolean {
    return (
      this.db
        .query(
          `UPDATE hrcmail_presentations
              SET reminder_due_at = NULL
            WHERE envelope_id = ? AND runtime_id = ?
              AND reminder_due_at IS NOT NULL AND reminder_landing_hrc_seq IS NULL`
        )
        .run(envelopeId, runtimeId).changes > 0
    )
  }

  /** A disposition is durable the moment it is DECIDED, not when a loop ends. */
  recordDisposition(envelopeId: string, runtimeId: string, disposition: string): boolean {
    return (
      this.db
        .query(
          `UPDATE hrcmail_presentations
              SET disposed_at = ?, disposition = ?
            WHERE envelope_id = ? AND runtime_id = ? AND disposed_at IS NULL`
        )
        .run(new Date().toISOString(), disposition, envelopeId, runtimeId).changes > 0
    )
  }

  countPreMigrationUnknownPresentations(): number {
    return (
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM hrcmail_presentations
            WHERE disposition = 'pre_migration_unknown'`
        )
        .get()?.count ?? 0
    )
  }

  // ── Non-landing accounting ─────────────────────────────────────────────────
  //
  // The table is 0059's `hrcmail_delivery_expiries` and its columns still say
  // "expiry", because 0059 bounded only the TTL arm. Chief's ruling widened the
  // rule without widening the storage: what is counted is a NON-LANDING
  // OUTCOME, of which a TTL expiry is one kind and a post-write refusal is
  // another. The names below say what is counted; the column names are history.

  /**
   * Count one non-landing outcome for this envelope on this runtime, and say
   * how many consecutive ones it has now had.
   *
   * Keyed by (envelope, runtime) so a rotation or restart resets the count
   * structurally: a different runtime is a different row, and the next seat gets
   * its full allowance. Cleared on a successful landing, so an intermittent seat
   * never accumulates toward the bound.
   */
  recordNonLandingStrike(envelopeId: string, runtimeId: string): number {
    const now = new Date().toISOString()
    this.db
      .query(
        `INSERT INTO hrcmail_delivery_expiries (
           envelope_id, runtime_id, expiries, first_expired_at, last_expired_at
         ) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(envelope_id, runtime_id) DO UPDATE SET
           expiries = hrcmail_delivery_expiries.expiries + 1,
           last_expired_at = excluded.last_expired_at`
      )
      .run(envelopeId, runtimeId, now, now)
    return this.nonLandingStrikes(envelopeId, runtimeId)
  }

  /** A landing means the seat can take deliveries after all; the count goes. */
  clearNonLandingStrikes(envelopeId: string): void {
    this.db.query('DELETE FROM hrcmail_delivery_expiries WHERE envelope_id = ?').run(envelopeId)
  }

  nonLandingStrikes(envelopeId: string, runtimeId: string): number {
    return (
      this.db
        .query<{ expiries: number }, [string, string]>(
          `SELECT expiries FROM hrcmail_delivery_expiries
            WHERE envelope_id = ? AND runtime_id = ?`
        )
        .get(envelopeId, runtimeId)?.expiries ?? 0
    )
  }

  /**
   * Open the continuous-refusal window if it is not already open, and say when
   * it opened.
   *
   * A pre-write refusal clears the intent, so the intent row cannot carry this:
   * without it a seat that refuses every attempt before writing would back off
   * forever and strike never. Opening is idempotent — the window belongs to the
   * RUN of refusals, not to any one of them — and `closeRefusalWindow` is what
   * a strike or a landing calls to start the next one from scratch.
   */
  openRefusalWindow(envelopeId: string, runtimeId: string, at = new Date().toISOString()): string {
    this.db
      .query(
        `INSERT INTO hrcmail_delivery_expiries (
           envelope_id, runtime_id, expiries, first_expired_at, last_expired_at,
           refusal_window_opened_at
         ) VALUES (?, ?, 0, ?, ?, ?)
         ON CONFLICT(envelope_id, runtime_id) DO UPDATE SET
           refusal_window_opened_at =
             COALESCE(hrcmail_delivery_expiries.refusal_window_opened_at, excluded.refusal_window_opened_at)`
      )
      .run(envelopeId, runtimeId, at, at, at)
    return this.refusalWindowOpenedAt(envelopeId, runtimeId) ?? at
  }

  refusalWindowOpenedAt(envelopeId: string, runtimeId: string): string | undefined {
    return (
      this.db
        .query<{ refusal_window_opened_at: string | null }, [string, string]>(
          `SELECT refusal_window_opened_at FROM hrcmail_delivery_expiries
            WHERE envelope_id = ? AND runtime_id = ?`
        )
        .get(envelopeId, runtimeId)?.refusal_window_opened_at ?? undefined
    )
  }

  /** End the current run of refusals; the next pre-write refusal opens a new one. */
  closeRefusalWindow(envelopeId: string, runtimeId: string): void {
    this.db
      .query(
        `UPDATE hrcmail_delivery_expiries SET refusal_window_opened_at = NULL
          WHERE envelope_id = ? AND runtime_id = ?`
      )
      .run(envelopeId, runtimeId)
  }

  // ── Birth refusals ─────────────────────────────────────────────────────────

  /** Record that this node attempted a birth for a target and was refused. */
  recordBirthRefusal(input: {
    targetSessionRef: string
    scopeRef: string
    reason: string
  }): HrcMailBirthRefusal | undefined {
    const now = new Date().toISOString()
    this.db
      .query(
        `INSERT INTO hrcmail_birth_refusals (
           target_session_ref, scope_ref, refusals, last_reason, resolved_at,
           created_at, updated_at
         ) VALUES (?, ?, 1, ?, NULL, ?, ?)
         ON CONFLICT(target_session_ref) DO UPDATE SET
           scope_ref = excluded.scope_ref,
           refusals = hrcmail_birth_refusals.refusals + 1,
           last_reason = excluded.last_reason,
           resolved_at = NULL,
           updated_at = excluded.updated_at`
      )
      .run(normalizeTarget(input.targetSessionRef), input.scopeRef, input.reason, now, now)
    return this.getBirthRefusal(input.targetSessionRef)
  }

  getBirthRefusal(targetSessionRef: string): HrcMailBirthRefusal | undefined {
    const row = this.db
      .query<BirthRefusalRow, [string]>(
        `SELECT target_session_ref, scope_ref, refusals, last_reason, resolved_at,
                created_at, updated_at
           FROM hrcmail_birth_refusals WHERE target_session_ref = ?`
      )
      .get(normalizeTarget(targetSessionRef))
    return row === null ? undefined : mapBirthRefusal(row)
  }

  /** Targets this node still owes a birth for; the T-07661 candidate source. */
  listRefusedBirthTargets(): string[] {
    return this.db
      .query<{ target_session_ref: string }, []>(
        `SELECT target_session_ref FROM hrcmail_birth_refusals
          WHERE resolved_at IS NULL
          ORDER BY target_session_ref ASC`
      )
      .all()
      .map((row) => row.target_session_ref)
  }

  resolveBirthRefusal(targetSessionRef: string, reason: string): boolean {
    return (
      this.db
        .query(
          `UPDATE hrcmail_birth_refusals
              SET resolved_at = ?, last_reason = ?, updated_at = ?
            WHERE target_session_ref = ? AND resolved_at IS NULL`
        )
        .run(
          new Date().toISOString(),
          reason,
          new Date().toISOString(),
          normalizeTarget(targetSessionRef)
        ).changes > 0
    )
  }

  // ── The mail hint ──────────────────────────────────────────────────────────

  /**
   * Should this seat be told mail is waiting, and how much?
   *
   * Only ENQUEUE submissions count: those are the ones the harness holds until
   * the boundary, so the seat cannot read them from inside the turn. A steer
   * has already landed in the turn and needs no hint about itself.
   */
  evaluateSeatHint(
    targetSessionRef: string,
    runtimeId: string,
    now = new Date()
  ): HrcMailHintDecision {
    const target = normalizeTarget(targetSessionRef)
    return this.db
      .transaction(() => {
        const row = this.db
          .query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) AS count FROM hrcmail_delivery_intents
              WHERE target_session_ref = ? AND runtime_id = ? AND door = 'enqueue'`
          )
          .get(target, runtimeId)
        const outstandingCount = row?.count ?? 0
        if (outstandingCount === 0) {
          return { outcome: 'suppressed', reason: 'no_outstanding_mail' }
        }
        const state = this.db
          .query<{ hint_count: number; last_hint_at: string | null; last_count: number }, [string]>(
            `SELECT hint_count, last_hint_at, last_count FROM hrcmail_seat_hints
              WHERE runtime_id = ?`
          )
          .get(runtimeId)
        const lastHintMs = state?.last_hint_at === null ? 0 : Date.parse(state?.last_hint_at ?? '')
        const reason =
          state === null || state === undefined
            ? 'first'
            : state.last_count !== outstandingCount
              ? 'count_changed'
              : Number.isFinite(lastHintMs) && now.getTime() - lastHintMs >= HINT_CADENCE_MS
                ? 'periodic'
                : undefined
        if (reason === undefined) return { outcome: 'suppressed', reason: 'cadence' }
        const at = now.toISOString()
        this.db
          .query(
            `INSERT INTO hrcmail_seat_hints (runtime_id, target_session_ref, hint_count, last_hint_at, last_count)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT(runtime_id) DO UPDATE SET
               target_session_ref = excluded.target_session_ref,
               hint_count = hrcmail_seat_hints.hint_count + 1,
               last_hint_at = excluded.last_hint_at,
               last_count = excluded.last_count`
          )
          .run(runtimeId, target, at, outstandingCount)
        return { outcome: 'issued', reason, outstandingCount }
      })
      .immediate() as HrcMailHintDecision
  }

  // ── §5 sender-side failure notices ─────────────────────────────────────────

  /**
   * Queue a §5 failure notice for a sender scope.
   *
   * Keyed on (envelope, target) so the ledger tail re-reading a page, or two
   * nodes observing the same `envelope.failed`, cannot tell one sender the same
   * thing twice.
   */
  recordFailureNotice(input: {
    envelopeId: string
    targetSessionRef: string
    notice: string
  }): boolean {
    return (
      this.db
        .query(
          `INSERT OR IGNORE INTO hrcmail_failure_notices (
             envelope_id, target_session_ref, notice, created_at
           ) VALUES (?, ?, ?, ?)`
        )
        .run(
          input.envelopeId,
          normalizeTarget(input.targetSessionRef),
          input.notice,
          new Date().toISOString()
        ).changes > 0
    )
  }

  listUndeliveredFailureNotices(targetSessionRef: string): HrcMailFailureNotice[] {
    return this.db
      .query<FailureNoticeRow, [string]>(
        `SELECT envelope_id, target_session_ref, notice, created_at, delivered_at
           FROM hrcmail_failure_notices
          WHERE target_session_ref = ? AND delivered_at IS NULL
          ORDER BY created_at ASC, envelope_id ASC`
      )
      .all(normalizeTarget(targetSessionRef))
      .map(mapFailureNotice)
  }

  /** Scopes holding an undelivered notice: "on next attend", made findable. */
  listFailureNoticeTargets(): string[] {
    return this.db
      .query<{ target_session_ref: string }, []>(
        `SELECT DISTINCT target_session_ref FROM hrcmail_failure_notices
          WHERE delivered_at IS NULL
          ORDER BY target_session_ref ASC`
      )
      .all()
      .map((row) => row.target_session_ref)
  }

  markFailureNoticesDelivered(targetSessionRef: string, envelopeIds: readonly string[]): void {
    if (envelopeIds.length === 0) return
    const now = new Date().toISOString()
    const target = normalizeTarget(targetSessionRef)
    this.db
      .transaction(() => {
        for (const envelopeId of envelopeIds) {
          this.db
            .query(
              `UPDATE hrcmail_failure_notices
                  SET delivered_at = ?
                WHERE envelope_id = ? AND target_session_ref = ? AND delivered_at IS NULL`
            )
            .run(now, envelopeId, target)
        }
      })
      .immediate()
  }

  failureNoticesForEnvelope(envelopeId: string): HrcMailFailureNotice[] {
    return this.db
      .query<FailureNoticeRow, [string]>(
        `SELECT envelope_id, target_session_ref, notice, created_at, delivered_at
           FROM hrcmail_failure_notices
          WHERE envelope_id = ?
          ORDER BY created_at ASC, target_session_ref ASC`
      )
      .all(envelopeId)
      .map(mapFailureNotice)
  }
}
