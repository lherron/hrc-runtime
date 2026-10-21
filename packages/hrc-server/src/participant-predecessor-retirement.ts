import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { ReplacementIntent, ReplacementKind } from './participant-replacement-intent.js'
import { isAbsorbingParticipantAttempt } from './participant-writer-evidence.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

/**
 * Whether the predecessor's writer is proven retired, and the TX-D commit that
 * records its disposition once it is.
 */

/** Where the retirement evidence came from: a transport probe or a never-attached predecessor. */
export type RetirementEvidenceSource = 'transport' | 'pre-attach'

export type RetirementDecision = 'satisfied' | 'hold' | 'refused'

export function isNeverAttachedDirectAttempt(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt
): boolean {
  return (
    attempt.state === 'IDENTITY_MINTED' &&
    attempt.attachSocketPath === undefined &&
    attempt.preparedDescriptorJson === undefined &&
    attempt.brokerIdentityJson === undefined &&
    server.db.runtimes.getByRuntimeId(attempt.runtimeId) === null
  )
}

export function preAttachRetirementReceipt(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  hostIncarnationId: string
): WriterEvidence {
  const detail = { basis: 'pre_attach_superseded', attemptId: attempt.attemptId }
  return {
    schemaVersion: 'writer-evidence/v1',
    writerRef: {
      subject: 'host',
      classId: registration.classId ?? 'hrc-direct-registration',
      participantKey: registration.participantKey ?? registration.registrationId,
      attemptId: attempt.attemptId,
      invocationId: attempt.invocationId as WriterEvidence['writerRef']['invocationId'],
      attachEpoch: attempt.attachEpoch,
      hostIncarnationId,
    },
    observedAt: timestamp(),
    writePath: { state: 'retired', reason: 'pre_attach_superseded', detail },
    liveness: { state: 'unknown', reason: 'host_liveness_not_observed', detail },
    priorRecovery: { state: 'unknown', reason: 'no_broker_ever_attached', detail },
  }
}

function directRetirementDecision(evidence: WriterEvidence): RetirementDecision {
  if (evidence.writePath.state === 'retired' || evidence.liveness.state === 'dead') {
    return 'satisfied'
  }
  return evidence.writePath.state === 'writable' && evidence.liveness.state === 'live'
    ? 'refused'
    : 'hold'
}

/** The first satisfying evidence an intent already recorded, if any. */
export function priorRetirementBasis(intent: ReplacementIntent): WriterEvidence | undefined {
  return (
    intent.retirementBasis ??
    (intent.receipt !== undefined && directRetirementDecision(intent.receipt) === 'satisfied'
      ? intent.receipt
      : undefined)
  )
}

/**
 * A satisfying observation is durable, but a later observation may void the
 * still-uncommitted succession only on the axis that supplied that fact.
 * Contradiction returns to pending; it never turns a previously authorized
 * TX-D into a forced conflict.
 */
export function retirementDecision(
  current: WriterEvidence,
  basis: WriterEvidence | undefined
): RetirementDecision {
  if (basis === undefined) return directRetirementDecision(current)
  if (basis.writePath.state === 'retired') {
    if (current.writePath.state !== 'writable') return 'satisfied'
    return current.liveness.state === 'dead' ? 'satisfied' : 'hold'
  }
  if (basis.liveness.state === 'dead') {
    if (current.liveness.state !== 'live') return 'satisfied'
    return current.writePath.state === 'retired' ? 'satisfied' : 'hold'
  }
  return directRetirementDecision(current)
}

export function recoverySatisfied(attempt: ParticipantAttempt, evidence: WriterEvidence): boolean {
  return (
    (evidence.priorRecovery.state === 'recovered' &&
      attempt.recoveryDisposition === 'reconciled') ||
    (attempt.recoveryDisposition === 'abandoned' && Boolean(attempt.recoveryReason?.trim()))
  )
}

/** Evidence that by itself ends the predecessor's recovery, named as its reason. */
function settledRetirementReason(
  source: RetirementEvidenceSource,
  evidence: WriterEvidence
): 'pre_attach_superseded' | 'transport_dead' | undefined {
  if (source === 'pre-attach') return 'pre_attach_superseded'
  return evidence.liveness.state === 'dead' ? 'transport_dead' : undefined
}

/** Why the predecessor binding ends RETIRED at successor allocation. */
export function bindingRetirementReason(
  source: RetirementEvidenceSource,
  evidence: WriterEvidence
): string {
  return settledRetirementReason(source, evidence) ?? 'host_replaced'
}

function dispositionReason(
  kind: ReplacementKind,
  evidence: WriterEvidence,
  attempt: ParticipantAttempt,
  source: RetirementEvidenceSource
): string {
  if (source === 'pre-attach') return `pre_attach_superseded:${attempt.attemptId}`
  if (evidence.liveness.state === 'dead') {
    return `transport_dead:${evidence.observedAt}:${JSON.stringify(evidence.liveness.detail)}`
  }
  if (attempt.initialActivationConfirmedAt === undefined) {
    return `establishment_abandoned_before_activation:${kind}:${evidence.observedAt}:${JSON.stringify(evidence.writerRef)}`
  }
  const reason =
    evidence.writePath.state === 'retired'
      ? kind === 'host'
        ? 'host_incarnation_write_path_retired'
        : 'bridge_write_path_retired'
      : kind === 'host'
        ? 'host_incarnation_writer_dead'
        : 'bridge_writer_dead'
  return `${reason}:${evidence.observedAt}:${JSON.stringify(evidence.writerRef)}`
}

/**
 * TX-D: disposition is committed separately and therefore independently
 * recoverable. Returns false when a pre-attach predecessor changed under the
 * gate; a lost CAS on an already-authorized step throws.
 */
export function disposePredecessor(
  server: HrcServerInstanceForHandlers,
  input: {
    attemptId: string
    bindingId: string
    kind: ReplacementKind
    source: RetirementEvidenceSource
    authorizingEvidence: WriterEvidence
  }
): boolean {
  const { kind, source, authorizingEvidence } = input
  return server.db.sqlite.transaction(() => {
    const current = server.db.participantRegistrations.getAttempt(input.attemptId)
    if (current === null) throw new Error('predecessor disappeared before disposition')
    if (
      source === 'pre-attach' &&
      !isAbsorbingParticipantAttempt(current) &&
      (!isNeverAttachedDirectAttempt(server, current) ||
        server.db.participantHostBindings.getBindingById(input.bindingId)?.state !== 'BINDING')
    )
      return false
    if (!isAbsorbingParticipantAttempt(current)) {
      if (
        !server.db.participantRegistrations.transitionAttempt(
          current.attemptId,
          [current.state],
          'ABANDONED',
          timestamp(),
          dispositionReason(kind, authorizingEvidence, current, source)
        )
      ) {
        throw new Error('predecessor disposition raced')
      }
    }
    const settledReason = settledRetirementReason(source, authorizingEvidence)
    if (settledReason !== undefined && current.recoveryDisposition === 'unresolved') {
      if (
        !server.db.participantRegistrations.recordRecoveryDisposition(
          current.attemptId,
          'abandoned',
          settledReason,
          timestamp()
        )
      ) {
        throw new Error('predecessor transport-dead recovery disposition raced')
      }
    }
    const currentBinding = server.db.participantHostBindings.getBindingById(input.bindingId)
    if (
      kind === 'host' &&
      currentBinding !== null &&
      (currentBinding.state === 'BOUND' || currentBinding.state === 'DETACHED')
    ) {
      if (
        !server.db.participantHostBindings.transitionBinding({
          bindingId: currentBinding.bindingId,
          from: [currentBinding.state],
          to: 'RETIRING',
          now: timestamp(),
          retirementReceiptJson: JSON.stringify(authorizingEvidence),
        })
      ) {
        throw new Error('predecessor binding retirement raced')
      }
    }
    return true
  })()
}
