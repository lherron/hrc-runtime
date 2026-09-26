import { randomUUID } from 'node:crypto'

import type {
  ParticipantAttempt,
  ParticipantContinuationSelection,
  ParticipantRegistration,
} from 'hrc-store-sqlite'
import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { DirectJoinRequest, DirectJoinResult } from './participant-host-registration.js'
import { observeParticipantTransportEvidence } from './participant-transport-evidence.js'
import {
  isAbsorbingParticipantAttempt,
  observeParticipantWriterEvidence,
} from './participant-writer-evidence.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'
import { detectResumeInvalidationBarrier } from './session-resume-continuation.js'
import { createSessionSuccessorFromContinuation } from './session-successor.js'

type ReplacementKind = 'bridge' | 'host'

type ReplacementIntent = {
  schemaVersion: 'participant-replacement-intent/v1'
  kind: ReplacementKind
  operationId: string
  predecessor: {
    bindingId: string
    hostIncarnationId: string
    hostSessionId: string
    generation: number
    runtimeId: string
    attemptId: string
    attachEpoch: number
    invocationId: string
  }
  predecessorWork: {
    state: ParticipantAttempt['establishmentWorkState']
    attemptCount: number
    nextAttemptAt?: string | undefined
    lastError?: string | undefined
  }
  candidate: {
    hostIncarnationId: string
    classId?: string | undefined
    participantKey?: string | undefined
    workspaceCwd?: string | undefined
    socketPath?: string | undefined
  }
  preAttachSupersession?: boolean | undefined
  receipt?: WriterEvidence | undefined
  /** First satisfying evidence; retained so freshness is evaluated per axis. */
  retirementBasis?: WriterEvidence | undefined
  allocatedAttemptId?: string | undefined
  renewedRecovery?: { reason: string; recordedAt: string } | undefined
  createdAt: string
}

function parseIntent(value: string | undefined): ReplacementIntent | null {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(value) as ReplacementIntent
    return parsed.schemaVersion === 'participant-replacement-intent/v1' ? parsed : null
  } catch {
    return null
  }
}

function sameRequest(intent: ReplacementIntent, request: DirectJoinRequest): boolean {
  return (
    intent.candidate.hostIncarnationId === request.hostIncarnationId &&
    (request.expectedPredecessor === undefined
      ? intent.preAttachSupersession === true
      : intent.predecessor.hostIncarnationId === request.expectedPredecessor.hostIncarnationId &&
        intent.predecessor.runtimeId === request.expectedPredecessor.runtimeId &&
        intent.predecessor.generation === request.expectedPredecessor.generation)
  )
}

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

function preAttachRetirementReceipt(
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

function identityResult(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  created: boolean
): DirectJoinResult {
  const selection = attempt.continuation ?? { carried: false, reason: 'no_continuation' as const }
  return {
    outcome: 'registered',
    identity: {
      registrationId: registration.registrationId,
      scopeRef: registration.scopeRef,
      laneRef: registration.laneRef,
      hostSessionId: registration.hostSessionId,
      generation: registration.generation,
      runtimeId: attempt.runtimeId,
      attemptId: attempt.attemptId,
      invocationId: attempt.invocationId,
      attachEpoch: attempt.attachEpoch,
      requestId: attempt.requestId,
      operationId: attempt.operationId,
    },
    continuation: {
      carried: selection.carried,
      reason: selection.reason,
      selected: selection.selectedJson === undefined ? null : JSON.parse(selection.selectedJson),
      resumeState: attempt.resumeState ?? 'not_requested',
    },
    created,
    attached: attempt.preparedDescriptorJson !== undefined,
  }
}

function refusal(status: 'pending' | 'rejected', reason: string, detail: string): DirectJoinResult {
  return { outcome: 'refused', status, reason, detail }
}

function pauseOrCancelReplacement(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt,
  intent: ReplacementIntent,
  intentJson: string,
  reason: string
): void {
  if (isAbsorbingParticipantAttempt(attempt)) {
    server.db.participantRegistrations.pauseReplacementWork({
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      expectedIntentJson: intentJson,
      reason,
      updatedAt: timestamp(),
    })
    return
  }
  server.db.participantRegistrations.cancelReplacementIntent({
    attemptId: attempt.attemptId,
    attachEpoch: attempt.attachEpoch,
    expectedIntentJson: intentJson,
    establishmentWorkState: intent.predecessorWork.state,
    establishmentAttemptCount: intent.predecessorWork.attemptCount,
    ...(intent.predecessorWork.nextAttemptAt === undefined
      ? {}
      : { establishmentNextAttemptAt: intent.predecessorWork.nextAttemptAt }),
    ...(intent.predecessorWork.lastError === undefined
      ? {}
      : { establishmentLastError: intent.predecessorWork.lastError }),
    updatedAt: timestamp(),
  })
}

function dispositionReason(
  kind: ReplacementKind,
  evidence: WriterEvidence,
  attempt: ParticipantAttempt,
  evidenceSource: 'producer' | 'transport' | 'pre-attach'
): string {
  if (evidenceSource === 'pre-attach') return `pre_attach_superseded:${attempt.attemptId}`
  if (evidenceSource === 'transport' && evidence.liveness.state === 'dead') {
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

function recoverySatisfied(attempt: ParticipantAttempt, evidence: WriterEvidence): boolean {
  return (
    (evidence.priorRecovery.state === 'recovered' &&
      attempt.recoveryDisposition === 'reconciled') ||
    (attempt.recoveryDisposition === 'abandoned' && Boolean(attempt.recoveryReason?.trim()))
  )
}

type RetirementDecision = 'satisfied' | 'hold' | 'refused'

function directRetirementDecision(evidence: WriterEvidence): RetirementDecision {
  if (evidence.writePath.state === 'retired' || evidence.liveness.state === 'dead') {
    return 'satisfied'
  }
  return evidence.writePath.state === 'writable' && evidence.liveness.state === 'live'
    ? 'refused'
    : 'hold'
}

/**
 * A satisfying observation is durable, but a later observation may void the
 * still-uncommitted succession only on the axis that supplied that fact.
 * Contradiction returns to pending; it never turns a previously authorized
 * TX-D into a forced conflict.
 */
function retirementDecision(
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

function findCommittedResult(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  request: DirectJoinRequest
): DirectJoinResult | null {
  for (const prior of server.db.participantRegistrations.listAttemptsByRegistrationId(
    registration.registrationId
  )) {
    const intent = parseIntent(prior.replacementIntentJson)
    if (!intent || !sameRequest(intent, request) || intent.allocatedAttemptId === undefined)
      continue
    const successor = server.db.participantRegistrations.getAttempt(intent.allocatedAttemptId)
    const current = server.db.participantRegistrations.getRegistrationById(
      registration.registrationId
    )
    if (successor !== null && current !== null) return identityResult(current, successor, false)
  }
  return null
}

/**
 * Execute the durable A0 -> TX-D -> gate -> TX-6/TX-6' replacement path.
 * The caller already holds the address mutex via the direct-registration door.
 */
export async function driveParticipantReplacement(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt,
  request: DirectJoinRequest
): Promise<DirectJoinResult> {
  const committed = findCommittedResult(server, registration, request)
  if (committed !== null) return committed

  const expected = request.expectedPredecessor
  const binding =
    initialAttempt.hostBindingId === undefined
      ? null
      : server.db.participantHostBindings.getBindingById(initialAttempt.hostBindingId)
  const currentIntent = parseIntent(initialAttempt.replacementIntentJson)
  const preAttachSupersession =
    registration.registrationMode === 'direct' &&
    (request.hostIncarnationId !== binding?.hostIncarnationId ||
      hasLegacyArrisHostIncarnationSelection(initialAttempt.continuation)) &&
    (isNeverAttachedDirectAttempt(server, initialAttempt) ||
      currentIntent?.preAttachSupersession === true)
  if ((expected === undefined && !preAttachSupersession) || binding === null) {
    return refusal(
      'rejected',
      'host_binding_precondition_failed',
      'replacement requires the exact durable predecessor binding identity'
    )
  }
  if (
    expected !== undefined &&
    (binding.hostIncarnationId !== expected.hostIncarnationId ||
      binding.runtimeId !== expected.runtimeId ||
      binding.generation !== expected.generation)
  ) {
    const suppliedBinding = server.db.participantHostBindings
      .listBindingsByReservationId(binding.reservationId)
      .find(
        (candidate) =>
          candidate.hostIncarnationId === expected.hostIncarnationId &&
          candidate.runtimeId === expected.runtimeId &&
          candidate.generation === expected.generation
      )
    const suppliedDetail =
      suppliedBinding?.state === 'RETIRED'
        ? `; supplied predecessor ${expected.hostIncarnationId}/${expected.runtimeId}/generation-${expected.generation} is RETIRED (${suppliedBinding.dispositionReason ?? 'reason unavailable'})`
        : ''
    return refusal(
      'rejected',
      'host_binding_precondition_failed',
      `observed predecessor ${binding.hostIncarnationId}/${binding.runtimeId}/generation-${binding.generation}${suppliedDetail}`
    )
  }

  const kind: ReplacementKind =
    request.hostIncarnationId === binding.hostIncarnationId ? 'bridge' : 'host'
  if (currentIntent !== null && !sameRequest(currentIntent, request)) {
    return refusal(
      'rejected',
      'host_binding_precondition_failed',
      'a different durable replacement intent already owns this predecessor'
    )
  }
  const adapter =
    registration.adapterId === undefined
      ? undefined
      : server.options.participantAdapterRegistry?.get(registration.adapterId)
  const evidenceMethodAvailable = isAbsorbingParticipantAttempt(initialAttempt)
    ? adapter?.inspectWriter !== undefined
    : adapter?.retireWriter !== undefined
  const producerEvidenceAvailable =
    adapter !== undefined &&
    registration.classId !== undefined &&
    registration.participantKey !== undefined &&
    evidenceMethodAvailable
  const now = timestamp()
  const freshIntent: ReplacementIntent = {
    schemaVersion: 'participant-replacement-intent/v1',
    kind,
    ...(preAttachSupersession ? { preAttachSupersession: true } : {}),
    operationId: `participant-replacement-${randomUUID()}`,
    predecessor: {
      bindingId: binding.bindingId,
      hostIncarnationId: binding.hostIncarnationId,
      hostSessionId: binding.hostSessionId,
      generation: binding.generation,
      runtimeId: binding.runtimeId,
      attemptId: initialAttempt.attemptId,
      attachEpoch: initialAttempt.attachEpoch,
      invocationId: initialAttempt.invocationId,
    },
    predecessorWork: {
      state: initialAttempt.establishmentWorkState,
      attemptCount: initialAttempt.establishmentAttemptCount,
      ...(initialAttempt.establishmentNextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: initialAttempt.establishmentNextAttemptAt }),
      ...(initialAttempt.establishmentLastError === undefined
        ? {}
        : { lastError: initialAttempt.establishmentLastError }),
    },
    candidate: {
      hostIncarnationId: request.hostIncarnationId,
      ...(request.classId === undefined ? {} : { classId: request.classId }),
      ...(request.participantKey === undefined ? {} : { participantKey: request.participantKey }),
      ...(request.workspaceCwd === undefined ? {} : { workspaceCwd: request.workspaceCwd }),
      ...(request.socketPath === undefined ? {} : { socketPath: request.socketPath }),
    },
    createdAt: now,
  }
  if (currentIntent === null) {
    const stored = server.db.participantRegistrations.storeReplacementIntent({
      attemptId: initialAttempt.attemptId,
      attachEpoch: initialAttempt.attachEpoch,
      replacementIntentJson: JSON.stringify(freshIntent),
      updatedAt: now,
    })
    if (stored === 'conflict') {
      return refusal('pending', 'participant_successor_gate_changed', 'replacement intent raced')
    }
  }

  let attempt = server.db.participantRegistrations.getAttempt(initialAttempt.attemptId)
  if (attempt === null)
    return refusal('pending', 'participant_attempt_unavailable', 'predecessor disappeared')
  let intent = parseIntent(attempt.replacementIntentJson)
  if (intent === null || !sameRequest(intent, request)) {
    return refusal('pending', 'participant_successor_gate_changed', 'replacement intent changed')
  }

  const observedEvidence = preAttachSupersession
    ? {
        outcome: 'evidence' as const,
        evidence: preAttachRetirementReceipt(registration, attempt, binding.hostIncarnationId),
      }
    : producerEvidenceAvailable
      ? await observeParticipantWriterEvidence(server, adapter, registration, attempt, kind)
      : {
          outcome: 'evidence' as const,
          evidence: (await observeParticipantTransportEvidence(server, registration, attempt, kind))
            .evidence,
        }
  if (observedEvidence.outcome === 'invalid') {
    if (attempt.replacementIntentJson !== undefined) {
      pauseOrCancelReplacement(
        server,
        attempt,
        intent,
        attempt.replacementIntentJson,
        'participant_host_evidence_invalid'
      )
    }
    return refusal(
      'rejected',
      'participant_host_evidence_invalid',
      `producer writer evidence did not match the exact ${kind} writer requested`
    )
  }
  if (observedEvidence.outcome === 'unavailable') {
    if (attempt.replacementIntentJson !== undefined) {
      pauseOrCancelReplacement(
        server,
        attempt,
        intent,
        attempt.replacementIntentJson,
        'host_retirement_unproven: producer evidence unavailable'
      )
    }
    return refusal(
      'pending',
      'host_retirement_unproven',
      'producer evidence unavailable for the exact predecessor writer'
    )
  }
  const evidence = observedEvidence.evidence
  const evidenceSource = preAttachSupersession
    ? 'pre-attach'
    : producerEvidenceAvailable
      ? 'producer'
      : 'transport'
  const persistedAttempt = attempt
  const priorIntentJson = persistedAttempt.replacementIntentJson
  if (priorIntentJson === undefined) {
    return refusal(
      'pending',
      'participant_successor_gate_changed',
      'replacement intent disappeared'
    )
  }
  if (
    evidenceSource === 'pre-attach' &&
    !isAbsorbingParticipantAttempt(persistedAttempt) &&
    !isNeverAttachedDirectAttempt(server, persistedAttempt)
  ) {
    pauseOrCancelReplacement(
      server,
      persistedAttempt,
      intent,
      priorIntentJson,
      'pre-attach predecessor changed'
    )
    return refusal(
      'pending',
      'participant_successor_gate_changed',
      'pre-attach predecessor changed'
    )
  }
  const priorBasis =
    intent.retirementBasis ??
    (intent.receipt !== undefined && directRetirementDecision(intent.receipt) === 'satisfied'
      ? intent.receipt
      : undefined)
  const currentDecision = retirementDecision(evidence, priorBasis)
  const retirementBasis = priorBasis ?? (currentDecision === 'satisfied' ? evidence : undefined)
  intent = {
    ...intent,
    receipt: evidence,
    ...(retirementBasis === undefined ? {} : { retirementBasis }),
  }
  const intentWithReceiptJson = JSON.stringify(intent)
  if (
    !server.db.sqlite.transaction(() => {
      const current = server.db.participantRegistrations.getAttempt(persistedAttempt.attemptId)
      if (
        evidenceSource === 'pre-attach' &&
        (current === null ||
          (!isAbsorbingParticipantAttempt(current) &&
            !isNeverAttachedDirectAttempt(server, current)))
      )
        return false
      const intentUpdated = server.db.participantRegistrations.replaceReplacementIntent({
        attemptId: persistedAttempt.attemptId,
        attachEpoch: persistedAttempt.attachEpoch,
        expectedJson: priorIntentJson,
        replacementJson: intentWithReceiptJson,
        updatedAt: timestamp(),
      })
      if (!intentUpdated) return false
      return server.db.participantRegistrations.recordWriterEvidence(
        persistedAttempt.attemptId,
        persistedAttempt.attachEpoch,
        JSON.stringify(evidence),
        timestamp()
      )
    })()
  ) {
    if (evidenceSource === 'pre-attach') {
      const changed = server.db.participantRegistrations.getAttempt(persistedAttempt.attemptId)
      if (changed !== null && changed.replacementIntentJson === priorIntentJson) {
        pauseOrCancelReplacement(
          server,
          changed,
          intent,
          priorIntentJson,
          'pre-attach predecessor changed'
        )
      }
    }
    return refusal(
      'pending',
      'participant_successor_gate_changed',
      'writer receipt persistence raced'
    )
  }

  if (currentDecision !== 'satisfied') {
    pauseOrCancelReplacement(
      server,
      attempt,
      intent,
      intentWithReceiptJson,
      currentDecision === 'refused'
        ? 'host_binding_conflict: predecessor remains writable and live'
        : evidenceSource === 'transport'
          ? 'host_retirement_unproven: transport_indeterminate'
          : 'host_retirement_unproven: predecessor retirement remains unknown'
    )
    return refusal(
      currentDecision === 'refused' ? 'rejected' : 'pending',
      currentDecision === 'refused' ? 'host_binding_conflict' : 'host_retirement_unproven',
      currentDecision === 'refused'
        ? 'the exact predecessor remains writable and live'
        : evidenceSource === 'transport'
          ? persistedAttempt.attachSocketPath === undefined
            ? 'transport_indeterminate: predecessor has no durable attach socket path'
            : 'transport_indeterminate: predecessor broker hello did not complete within the bounded probe'
          : priorBasis === undefined
            ? 'predecessor retirement is unknown'
            : 'later evidence voided the uncommitted succession on its satisfying axis'
    )
  }
  const authorizingEvidence = retirementBasis ?? evidence

  // TX-D: disposition is committed separately and therefore independently recoverable.
  const disposingAttemptId = attempt.attemptId
  const disposed = server.db.sqlite.transaction(() => {
    const current = server.db.participantRegistrations.getAttempt(disposingAttemptId)
    if (current === null) throw new Error('predecessor disappeared before disposition')
    if (
      evidenceSource === 'pre-attach' &&
      !isAbsorbingParticipantAttempt(current) &&
      (!isNeverAttachedDirectAttempt(server, current) ||
        server.db.participantHostBindings.getBindingById(binding.bindingId)?.state !== 'BINDING')
    )
      return false
    if (!isAbsorbingParticipantAttempt(current)) {
      if (
        !server.db.participantRegistrations.transitionAttempt(
          current.attemptId,
          [current.state],
          'ABANDONED',
          timestamp(),
          dispositionReason(kind, authorizingEvidence, current, evidenceSource)
        )
      ) {
        throw new Error('predecessor disposition raced')
      }
    }
    if (
      ((evidenceSource === 'transport' && authorizingEvidence.liveness.state === 'dead') ||
        evidenceSource === 'pre-attach') &&
      current.recoveryDisposition === 'unresolved'
    ) {
      if (
        !server.db.participantRegistrations.recordRecoveryDisposition(
          current.attemptId,
          'abandoned',
          evidenceSource === 'pre-attach' ? 'pre_attach_superseded' : 'transport_dead',
          timestamp()
        )
      ) {
        throw new Error('predecessor transport-dead recovery disposition raced')
      }
    }
    const currentBinding = server.db.participantHostBindings.getBindingById(binding.bindingId)
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
  if (!disposed) {
    const changed = server.db.participantRegistrations.getAttempt(disposingAttemptId)
    if (changed !== null && changed.replacementIntentJson === intentWithReceiptJson) {
      pauseOrCancelReplacement(
        server,
        changed,
        intent,
        intentWithReceiptJson,
        'pre-attach predecessor changed'
      )
    }
    return refusal(
      'pending',
      'participant_successor_gate_changed',
      'pre-attach predecessor changed'
    )
  }

  attempt = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (
    attempt === null ||
    !isAbsorbingParticipantAttempt(attempt) ||
    !attempt.dispositionReason?.trim()
  ) {
    return refusal(
      'pending',
      'participant_prior_disposition_unresolved',
      'predecessor is not durably absorbing'
    )
  }
  if (
    attempt.recoveryDisposition === 'unresolved' &&
    evidence.priorRecovery.state === 'recovered'
  ) {
    server.db.participantRegistrations.recordRecoveryDisposition(
      attempt.attemptId,
      'reconciled',
      `writer-evidence:${evidence.priorRecovery.reason}`,
      timestamp()
    )
    attempt = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  }
  if (attempt === null || !recoverySatisfied(attempt, evidence)) {
    if (attempt !== null && attempt.replacementIntentJson !== undefined) {
      const heldIntent = parseIntent(attempt.replacementIntentJson)
      if (heldIntent !== null) {
        pauseOrCancelReplacement(
          server,
          attempt,
          heldIntent,
          attempt.replacementIntentJson,
          'participant_prior_recovery_unresolved'
        )
      }
    }
    return refusal(
      'pending',
      'participant_prior_recovery_unresolved',
      'predecessor recovery is neither reconciled nor explicitly abandoned'
    )
  }

  const successorAttemptId = `participant-attempt-${randomUUID()}`
  const successorRuntimeId = kind === 'bridge' ? binding.runtimeId : `rt-${randomUUID()}`
  const successorBindingId =
    kind === 'bridge' ? binding.bindingId : `participant-binding-${randomUUID()}`
  const selection =
    kind === 'bridge'
      ? preAttachSupersession && hasLegacyArrisHostIncarnationSelection(attempt.continuation)
        ? continuationForSuccessor(server, registration)
        : (attempt.continuation ?? { carried: false, reason: 'no_continuation' as const })
      : continuationForSuccessor(server, registration)
  const successor: ParticipantAttempt = {
    attemptId: successorAttemptId,
    registrationId: registration.registrationId,
    attachEpoch: attempt.attachEpoch + 1,
    requestId: `req-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    invocationId: `inv-${randomUUID()}`,
    runtimeId: successorRuntimeId,
    hostBindingId: successorBindingId,
    state: 'IDENTITY_MINTED',
    recoveryDisposition: 'unresolved',
    establishmentWorkState: 'pending',
    establishmentAttemptCount: 0,
    continuation: selection,
    // Selection is not a native-resume result. The attach call changes this to
    // requested only when a profile actually expresses the selected value.
    resumeState: 'not_requested',
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }
  const completedIntent = { ...intent, allocatedAttemptId: successorAttemptId }
  const priorAttemptId = attempt.attemptId
  const allocated = server.db.sqlite.transaction(() => {
    const currentPrior = server.db.participantRegistrations.getAttempt(priorAttemptId)
    const currentBinding = server.db.participantHostBindings.getBindingById(binding.bindingId)
    if (
      currentPrior === null ||
      currentPrior.replacementIntentJson !== intentWithReceiptJson ||
      !isAbsorbingParticipantAttempt(currentPrior) ||
      !currentPrior.dispositionReason?.trim() ||
      !recoverySatisfied(currentPrior, evidence) ||
      currentBinding === null
    ) {
      return false
    }

    if (kind === 'host') {
      if (currentBinding.state !== 'RETIRING' && currentBinding.state !== 'BINDING') return false
      const priorSession = server.db.sessions.getByHostSessionId(registration.hostSessionId)
      if (priorSession === null) return false
      const nextGeneration = registration.generation + 1
      const successorSource = selection.carried
        ? priorSession
        : (({ continuation: _continuation, ...withoutContinuation }) => withoutContinuation)(
            priorSession
          )
      const nextSession = createSessionSuccessorFromContinuation(server.db, successorSource, {
        generation: nextGeneration,
      })
      if (
        !server.db.participantHostBindings.transitionBinding({
          bindingId: currentBinding.bindingId,
          from: [currentBinding.state],
          to: 'RETIRED',
          now: timestamp(),
          dispositionReason:
            evidenceSource === 'pre-attach'
              ? 'pre_attach_superseded'
              : evidenceSource === 'transport' && authorizingEvidence.liveness.state === 'dead'
                ? 'transport_dead'
                : 'host_replaced',
        })
      ) {
        throw new Error('predecessor binding final retirement raced')
      }
      if (
        !server.db.participantRegistrations.updateDirectRegistrationForHostSuccessor({
          registrationId: registration.registrationId,
          expectedHostSessionId: registration.hostSessionId,
          hostSessionId: nextSession.hostSessionId,
          generation: nextGeneration,
          hostIncarnationId: request.hostIncarnationId,
          ...(request.workspaceCwd === undefined ? {} : { workspaceCwd: request.workspaceCwd }),
          ...(request.socketPath === undefined ? {} : { socketPath: request.socketPath }),
          updatedAt: timestamp(),
        })
      ) {
        throw new Error('successor registration ownership update raced')
      }
      server.db.participantHostBindings.insertBinding({
        bindingId: successorBindingId,
        reservationId: binding.reservationId,
        registrationId: registration.registrationId,
        hostIncarnationId: request.hostIncarnationId,
        hostSessionId: nextSession.hostSessionId,
        generation: nextGeneration,
        runtimeId: successorRuntimeId,
        state: 'BINDING',
        predecessorBindingId: binding.bindingId,
        admittedAt: timestamp(),
        updatedAt: timestamp(),
      })
      const priorRuntime = server.db.runtimes.getByRuntimeId(binding.runtimeId)
      if (priorRuntime !== null) {
        server.db.runtimes.update(binding.runtimeId, {
          status: 'terminated',
          statusChangedAt: timestamp(),
          lifecycleTerminalReason: 'host_replaced',
          runtimeStateJson: {
            ...(priorRuntime.runtimeStateJson ?? {}),
            status: 'terminated',
            terminalReason: 'host_replaced',
          },
          updatedAt: timestamp(),
        })
      }
    } else if (
      !server.db.participantRegistrations.updateDirectRegistrationForBridgeSuccessor({
        registrationId: registration.registrationId,
        expectedHostSessionId: registration.hostSessionId,
        expectedHostIncarnationId: binding.hostIncarnationId,
        ...(request.workspaceCwd === undefined ? {} : { workspaceCwd: request.workspaceCwd }),
        ...(request.socketPath === undefined ? {} : { socketPath: request.socketPath }),
        updatedAt: timestamp(),
      })
    ) {
      throw new Error('bridge successor endpoint update raced')
    }
    server.db.participantRegistrations.insertAttempt(successor)
    return server.db.participantRegistrations.completeReplacementWork({
      attemptId: currentPrior.attemptId,
      attachEpoch: currentPrior.attachEpoch,
      expectedIntentJson: intentWithReceiptJson,
      completedIntentJson: JSON.stringify(completedIntent),
      updatedAt: timestamp(),
    })
  })()
  if (!allocated) {
    return refusal(
      'pending',
      'participant_successor_gate_changed',
      'successor allocation gate changed'
    )
  }
  const currentRegistration = server.db.participantRegistrations.getRegistrationById(
    registration.registrationId
  )
  return identityResult(currentRegistration ?? registration, successor, true)
}

/** Authorized recovery records one of the two explicit recovery exits. */
export function recordParticipantRecoveryDisposition(
  server: HrcServerInstanceForHandlers,
  attemptId: string,
  disposition: 'reconciled' | 'abandoned',
  reason: string
): boolean {
  const recorded = server.db.participantRegistrations.recordRecoveryDisposition(
    attemptId,
    disposition,
    reason,
    timestamp()
  )
  if (recorded) {
    server.db.participantRegistrations.rearmReplacementWork({
      attemptId,
      reason: `explicit recovery ${disposition}: ${reason}`,
      updatedAt: timestamp(),
    })
  }
  return recorded
}

/** Explicit renewed recovery; ordinary duplicate register requests never call this. */
export function renewParticipantReplacementRecovery(
  server: HrcServerInstanceForHandlers,
  attemptId: string,
  reason: string
): boolean {
  return server.db.participantRegistrations.renewExhaustedReplacement({
    attemptId,
    reason,
    updatedAt: timestamp(),
  })
}

/** Startup/scheduler re-entry from the predecessor's durable intent. */
export async function recoverParticipantReplacement(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt
): Promise<DirectJoinResult> {
  const intent = parseIntent(attempt.replacementIntentJson)
  const registration = server.db.participantRegistrations.getRegistrationById(
    attempt.registrationId
  )
  if (intent === null || registration === null) {
    return refusal(
      'pending',
      'participant_attempt_unavailable',
      'replacement recovery input is missing'
    )
  }
  return driveParticipantReplacement(server, registration, attempt, {
    requestedSessionRef: registration.scopeRef,
    hostIncarnationId: intent.candidate.hostIncarnationId,
    laneRef: registration.laneRef,
    ...(intent.candidate.classId === undefined ? {} : { classId: intent.candidate.classId }),
    ...(intent.candidate.participantKey === undefined
      ? {}
      : { participantKey: intent.candidate.participantKey }),
    ...(intent.candidate.workspaceCwd === undefined
      ? {}
      : { workspaceCwd: intent.candidate.workspaceCwd }),
    ...(intent.candidate.socketPath === undefined
      ? {}
      : { socketPath: intent.candidate.socketPath }),
    expectedPredecessor: {
      hostIncarnationId: intent.predecessor.hostIncarnationId,
      runtimeId: intent.predecessor.runtimeId,
      generation: intent.predecessor.generation,
    },
  })
}
