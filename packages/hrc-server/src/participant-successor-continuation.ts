import type {
  ParticipantAttempt,
  ParticipantContinuationSelection,
  ParticipantRegistration,
} from 'hrc-store-sqlite'

import type { DirectJoinRequest } from './participant-host-registration.js'
import type { ReplacementKind } from './participant-replacement-intent.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { detectResumeInvalidationBarrier } from './session-resume-continuation.js'

/**
 * Which conversation a successor attempt starts from (R6.6/R7.3): the
 * participant's `continue`/`fresh` declaration, then HRC's automatic selector.
 */

export function declarationOf(
  continuation: 'continue' | 'fresh' | undefined
): 'continue' | 'fresh' {
  return continuation ?? 'continue'
}

/**
 * A selection already allocated for one declaration cannot answer the other:
 * `fresh` never yields a carried record, and only `fresh` yields
 * `participant_fresh`.
 */
export function declarationContradictsSelection(
  request: DirectJoinRequest,
  selection: ParticipantContinuationSelection | undefined
): boolean {
  return declarationOf(request.continuation) === 'fresh'
    ? selection?.carried === true
    : selection?.reason === 'participant_fresh'
}

function isLegacyArrisHostIncarnationContinuation(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provider' in value &&
    value.provider === 'arris' &&
    'kind' in value &&
    value.kind === 'host-incarnation'
  )
}

export function hasLegacyArrisHostIncarnationSelection(
  selection: ParticipantContinuationSelection | undefined
): boolean {
  if (selection?.carried !== true || selection.selectedJson === undefined) return false
  try {
    return isLegacyArrisHostIncarnationContinuation(JSON.parse(selection.selectedJson))
  } catch {
    return false
  }
}

function continuationForSuccessor(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration
): ParticipantContinuationSelection {
  const prior = server.db.sessions.getByHostSessionId(registration.hostSessionId)
  if (prior?.continuation === undefined) return { carried: false, reason: 'no_continuation' }
  // The old Arris broker stored its host-incarnation marker as a continuation.
  // It names the process that is being retired, not native state the successor
  // driver can resume. Migrate that legacy selection at the HRC decision point.
  if (isLegacyArrisHostIncarnationContinuation(prior.continuation)) {
    return { carried: false, reason: 'continuation_invalidated' }
  }
  if (detectResumeInvalidationBarrier(server.db, prior) !== undefined) {
    return { carried: false, reason: 'continuation_invalidated' }
  }
  if (server.db.sessions.isContinuationReuseDisabled(prior.hostSessionId)) {
    return { carried: false, reason: 'reuse_disabled' }
  }
  return { carried: true, reason: 'carried', selectedJson: JSON.stringify(prior.continuation) }
}

/**
 * R6.6 amendment: `fresh` is the participant's declaration, recorded as is.
 * `continue` (or omitted) keeps the automatic selection unchanged.
 */
export function selectionForSuccessor(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  predecessor: ParticipantAttempt,
  request: DirectJoinRequest,
  kind: ReplacementKind,
  preAttachSupersession: boolean
): ParticipantContinuationSelection {
  if (request.continuation === 'fresh') return { carried: false, reason: 'participant_fresh' }
  if (kind === 'host') return continuationForSuccessor(server, registration)
  return preAttachSupersession && hasLegacyArrisHostIncarnationSelection(predecessor.continuation)
    ? continuationForSuccessor(server, registration)
    : (predecessor.continuation ?? { carried: false, reason: 'no_continuation' })
}
