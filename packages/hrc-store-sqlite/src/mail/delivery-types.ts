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
