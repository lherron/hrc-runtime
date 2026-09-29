import type {
  HrcMailBirthRefusal,
  HrcMailDeliveryDoor,
  HrcMailDeliveryForm,
  HrcMailDeliveryIntent,
  HrcMailFailureNotice,
  HrcMailPresentation,
} from './delivery-types.js'

export type IntentRow = {
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

export type PresentationRow = {
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

export type BirthRefusalRow = {
  target_session_ref: string
  scope_ref: string
  refusals: number
  last_reason: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export type FailureNoticeRow = {
  envelope_id: string
  target_session_ref: string
  notice: string
  created_at: string
  delivered_at: string | null
}

export const INTENT_COLUMNS = `
  envelope_id, target_session_ref, door, form, presentation_id, runtime_id,
  submission_id, host_session_id, generation, delivery_outcome,
  submitted_hrc_seq, submitted_at, updated_at, invocation_id, broker_after_seq,
  uncertain_cause, uncertain_at, last_evidence_kind, last_evidence_at,
  terminal_envelope_cause, terminal_envelope_at, cleanup_outcome, cleanup_at
`

export const PRESENTATION_COLUMNS = `
  envelope_id, runtime_id, target_session_ref, generation, presentation_id,
  input_id, delivery_outcome, landing_hrc_seq, landed_at, receipt_committed_at, turn_ended_at,
  reminder_armed_at, reminder_due_at, reminder_landing_hrc_seq,
  reminder_landed_at, disposed_at, disposition
`

export function mapIntent(row: IntentRow): HrcMailDeliveryIntent {
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

export function mapPresentation(row: PresentationRow): HrcMailPresentation {
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

export function mapBirthRefusal(row: BirthRefusalRow): HrcMailBirthRefusal {
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

export function mapFailureNotice(row: FailureNoticeRow): HrcMailFailureNotice {
  return {
    envelopeId: row.envelope_id,
    targetSessionRef: row.target_session_ref,
    notice: row.notice,
    createdAt: row.created_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  }
}

export function normalizeTarget(targetSessionRef: string): string {
  const target = targetSessionRef.trim()
  if (target.length === 0) throw new Error('targetSessionRef must be a non-empty string')
  return target
}
