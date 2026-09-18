import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { ParticipantAdapter, WriterEvidence, WriterRef } from 'spaces-runtime-contracts'
import { validateWriterEvidence } from 'spaces-runtime-contracts'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'

function parseJson<T>(json: string | undefined): T | null {
  if (json === undefined) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

/**
 * The exact writer a successor would replace: the broker instance HRC committed
 * at install acknowledgement.
 *
 * That instance is a bridge in both join directions. HRC hosting a broker
 * process conveys broker resource ownership only, so a broker instance id is
 * never relabeled as an application host incarnation id, and `subject` is never
 * inferred from the join. This phase declares only `key-scoped` classes, which
 * own no host incarnation identity at all; a `host` subject belongs to the
 * separately authored host-incarnation policy and is not minted here.
 */
export function participantWriterRef(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterRef['subject'] = 'bridge'
): WriterRef | null {
  const identity = parseJson<{ brokerInstanceId?: unknown }>(attempt.brokerIdentityJson)
  const brokerInstanceId = identity?.brokerInstanceId
  if (
    subject === 'bridge' &&
    (typeof brokerInstanceId !== 'string' || brokerInstanceId.length === 0)
  ) {
    return null
  }
  // A `WriterRef` is identified by class and key. A direct protocol join may
  // have neither, and this evidence path is the key-scoped one, so an absent
  // pair means there is no ref to mint -- not a ref with placeholder parts.
  if (registration.classId === undefined || registration.participantKey === undefined) return null
  return {
    subject,
    classId: registration.classId,
    participantKey: registration.participantKey,
    attemptId: attempt.attemptId,
    invocationId: attempt.invocationId as WriterRef['invocationId'],
    attachEpoch: attempt.attachEpoch,
    ...(subject === 'bridge' ? { brokerInstanceId: brokerInstanceId as string } : {}),
    ...(subject === 'host' && registration.hostIncarnationId !== undefined
      ? { hostIncarnationId: registration.hostIncarnationId }
      : {}),
  }
}

const ABSORBING_ATTEMPT_STATES = new Set(['SUPERSEDED', 'ABANDONED', 'TERMINAL'])

export function isAbsorbingParticipantAttempt(attempt: ParticipantAttempt): boolean {
  return ABSORBING_ATTEMPT_STATES.has(attempt.state)
}

/**
 * Evidence about the exact writer a successor would replace, from that writer's
 * owner: the adapter. A missing adapter method, a thrown call and a failed
 * validation are all read as no evidence, which holds; none is read as a state.
 */
export async function obtainParticipantWriterEvidence(
  server: HrcServerInstanceForHandlers,
  adapter: ParticipantAdapter,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterRef['subject'] = 'bridge'
): Promise<WriterEvidence | null> {
  const observed = await observeParticipantWriterEvidence(
    server,
    adapter,
    registration,
    attempt,
    subject
  )
  return observed.outcome === 'evidence' ? observed.evidence : null
}

export type ParticipantWriterEvidenceObservation =
  | { outcome: 'evidence'; evidence: WriterEvidence }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' }

/** Detailed form used when invalid producer evidence must be refused distinctly. */
export async function observeParticipantWriterEvidence(
  _server: HrcServerInstanceForHandlers,
  adapter: ParticipantAdapter,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterRef['subject'] = 'bridge'
): Promise<ParticipantWriterEvidenceObservation> {
  const exactWriter = participantWriterRef(registration, attempt, subject)
  if (exactWriter === null) return { outcome: 'unavailable' }
  // An already-absorbing prior writer is only inspected: asking its owner to
  // retire it again would be a fresh effect on someone else's writer rather
  // than an observation. Either method is read as evidence about the same
  // exact writer, and the request actually made is the one validated against.
  const preferInspection =
    isAbsorbingParticipantAttempt(attempt) || adapter.retireWriter === undefined
  const inspect = preferInspection && adapter.inspectWriter !== undefined
  const request = inspect
    ? { writerRef: exactWriter }
    : { writerRef: exactWriter, reason: 'successor-registration' }
  let raw: unknown
  try {
    raw = inspect
      ? await adapter.inspectWriter?.(request as { writerRef: WriterRef })
      : await adapter.retireWriter?.(request as { writerRef: WriterRef; reason: string })
  } catch {
    return { outcome: 'unavailable' }
  }
  if (raw === undefined) return { outcome: 'unavailable' }
  const validated = validateWriterEvidence(request, raw)
  return validated.ok ? { outcome: 'evidence', evidence: validated.value } : { outcome: 'invalid' }
}
