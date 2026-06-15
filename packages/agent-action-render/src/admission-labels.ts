/**
 * Centralized label map for input admission / application UX labels.
 * Cody-mandated label set (T-01379, T-01383).
 *
 * NEVER use 'steered' or 'applied' in any label.
 */

export type AdmissionLabelInput = {
  eventKind: string
  admissionKind?: string | undefined
  applicationStatus?: string | undefined
  reason?: string | undefined
}

/**
 * Derive the user-facing label for an input admission / application event.
 * All consumers (CLI, projection, ops-server, ops-web, Discord gateway) must
 * call this single function so wording stays consistent.
 */
/** Event-kind string constants shared by admissionLabel and the response mapping. */
const EVENT_KIND = {
  applicationAccepted: 'input.application.accepted',
  applicationPending: 'input.application.pending',
  applicationAmbiguous: 'input.application.ambiguous',
  queued: 'input.queued',
} as const

/** Admission/application status string constants used to derive an eventKind. */
const ADMISSION_KIND = {
  acceptedInFlight: 'accepted_in_flight',
  admissionPending: 'admission_pending',
  queuedRun: 'queued_run',
} as const

const APPLICATION_STATUS = {
  accepted: 'accepted',
  pending: 'pending',
  ambiguous: 'ambiguous',
} as const

const REASON_FALLBACK_QUEUED = 'contribution_unsupported_fallback_queued'

type AdmissionResponsePayload = {
  admission?: { kind?: string } | undefined
  inputApplication?: { status?: string } | undefined
  currentState?:
    | {
        applicationStatus?: string
        queueStatus?: string
        reason?: string
      }
    | undefined
}

type AdmissionResponseContext = {
  admissionKind?: string | undefined
  applicationStatus?: string | undefined
  reason?: string | undefined
}

const ADMISSION_RESPONSE_LABEL_RULES: ReadonlyArray<{
  matches: (context: AdmissionResponseContext) => boolean
  label: (context: AdmissionResponseContext) => string
}> = [
  {
    matches: ({ admissionKind, applicationStatus }) =>
      admissionKind === ADMISSION_KIND.acceptedInFlight &&
      applicationStatus === APPLICATION_STATUS.accepted,
    label: () => admissionLabel({ eventKind: EVENT_KIND.applicationAccepted }),
  },
  {
    matches: ({ admissionKind, applicationStatus }) =>
      admissionKind === ADMISSION_KIND.admissionPending &&
      applicationStatus === APPLICATION_STATUS.pending,
    label: () => admissionLabel({ eventKind: EVENT_KIND.applicationPending }),
  },
  {
    matches: ({ applicationStatus }) => applicationStatus === APPLICATION_STATUS.ambiguous,
    label: () => admissionLabel({ eventKind: EVENT_KIND.applicationAmbiguous }),
  },
  {
    matches: ({ reason }) => reason === REASON_FALLBACK_QUEUED,
    label: () =>
      admissionLabel({
        eventKind: EVENT_KIND.queued,
        reason: REASON_FALLBACK_QUEUED,
      }),
  },
  {
    matches: ({ admissionKind }) => admissionKind === ADMISSION_KIND.queuedRun,
    label: () => admissionLabel({ eventKind: EVENT_KIND.queued }),
  },
]

export function admissionLabel(input: AdmissionLabelInput): string {
  const { eventKind, reason } = input

  switch (eventKind) {
    case EVENT_KIND.applicationAccepted:
      return 'Contribution accepted'
    case EVENT_KIND.applicationPending:
      return 'Contribution pending'
    case EVENT_KIND.applicationAmbiguous:
      return 'Contribution ambiguous'
    case 'input.application.failed':
      return 'Contribution failed'
    case 'input.rejected':
      return 'Input rejected'
    case EVENT_KIND.queued:
      if (reason === REASON_FALLBACK_QUEUED) {
        return 'Unsupported contribution fallback queued'
      }
      return 'Queued'
    case 'input.admitted':
      return 'Input admitted'
    case 'input.dispatching':
      return 'Dispatching queued work'
    case 'input.started':
      return 'Input started'
    case 'input.queue.expired':
      return 'Queued input expired'
    default:
      return eventKind
  }
}

/**
 * Derive the label for a CLI table row from a send response payload.
 */
export function admissionLabelFromResponse(payload: AdmissionResponsePayload): string {
  const admissionKind = payload.admission?.kind
  const applicationStatus =
    payload.inputApplication?.status ?? payload.currentState?.applicationStatus
  const reason = payload.currentState?.reason
  const context = { admissionKind, applicationStatus, reason }

  // Map admission kind + application status to an eventKind for label lookup
  for (const rule of ADMISSION_RESPONSE_LABEL_RULES) {
    if (rule.matches(context)) {
      return rule.label(context)
    }
  }

  // Fallback: use applicationStatus or admissionKind as-is
  return applicationStatus ?? admissionKind ?? ''
}
