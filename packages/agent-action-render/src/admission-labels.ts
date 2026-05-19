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
export function admissionLabel(input: AdmissionLabelInput): string {
  const { eventKind, reason } = input

  switch (eventKind) {
    case 'input.application.accepted':
      return 'Contribution accepted'
    case 'input.application.pending':
      return 'Contribution pending'
    case 'input.application.ambiguous':
      return 'Contribution ambiguous'
    case 'input.application.failed':
      return 'Contribution failed'
    case 'input.rejected':
      return 'Input rejected'
    case 'input.queued':
      if (reason === 'contribution_unsupported_fallback_queued') {
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
export function admissionLabelFromResponse(payload: {
  admission?: { kind?: string } | undefined
  inputApplication?: { status?: string } | undefined
  currentState?:
    | {
        applicationStatus?: string
        queueStatus?: string
        reason?: string
      }
    | undefined
}): string {
  const admissionKind = payload.admission?.kind
  const applicationStatus =
    payload.inputApplication?.status ?? payload.currentState?.applicationStatus
  const reason = payload.currentState?.reason

  // Map admission kind + application status to an eventKind for label lookup
  if (admissionKind === 'accepted_in_flight' && applicationStatus === 'accepted') {
    return admissionLabel({ eventKind: 'input.application.accepted' })
  }
  if (admissionKind === 'admission_pending' && applicationStatus === 'pending') {
    return admissionLabel({ eventKind: 'input.application.pending' })
  }
  if (applicationStatus === 'ambiguous') {
    return admissionLabel({ eventKind: 'input.application.ambiguous' })
  }
  if (reason === 'contribution_unsupported_fallback_queued') {
    return admissionLabel({
      eventKind: 'input.queued',
      reason: 'contribution_unsupported_fallback_queued',
    })
  }
  if (admissionKind === 'queued_run') {
    return admissionLabel({ eventKind: 'input.queued' })
  }

  // Fallback: use applicationStatus or admissionKind as-is
  return applicationStatus ?? admissionKind ?? ''
}
