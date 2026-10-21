import type {
  ParticipantAttempt,
  ParticipantHostBinding,
  ParticipantRegistration,
} from 'hrc-store-sqlite'
import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { DirectJoinRequest, DirectJoinResult } from './participant-host-registration.js'
import {
  type RetirementDecision,
  type RetirementEvidenceSource,
  bindingRetirementReason,
  disposePredecessor,
  isNeverAttachedDirectAttempt,
  preAttachRetirementReceipt,
  priorRetirementBasis,
  recoverySatisfied,
  retirementDecision,
} from './participant-predecessor-retirement.js'
import {
  DECLARATION_MISMATCH_DETAIL,
  type ReplacementIntent,
  type ReplacementKind,
  buildReplacementIntent,
  joinRequestFromIntent,
  parseReplacementIntent,
  sameReplacementRequest,
  sameReplacementTarget,
} from './participant-replacement-intent.js'
import {
  commitSuccessorAllocation,
  mintSuccessorAttempt,
} from './participant-successor-allocation.js'
import {
  hasLegacyArrisHostIncarnationSelection,
  selectionForSuccessor,
} from './participant-successor-continuation.js'
import { observeParticipantTransportEvidence } from './participant-transport-evidence.js'
import { isAbsorbingParticipantAttempt } from './participant-writer-evidence.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

/**
 * Drives one participant replacement through its durable phases:
 * A0 (intent) -> writer receipt -> TX-D (predecessor disposition) -> recovery
 * gate -> TX-6/TX-6' (successor allocation). Every phase re-reads the
 * predecessor and fails closed to `pending` when its gate moved.
 */

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

function gateChanged(detail: string): DirectJoinResult {
  return refusal('pending', 'participant_successor_gate_changed', detail)
}

const PRE_ATTACH_PREDECESSOR_CHANGED = 'pre-attach predecessor changed'

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

/** After a lost pre-attach gate, pause only if the predecessor still holds this intent. */
function pauseChangedPreAttachPredecessor(
  server: HrcServerInstanceForHandlers,
  attemptId: string,
  intent: ReplacementIntent,
  expectedIntentJson: string
): void {
  const changed = server.db.participantRegistrations.getAttempt(attemptId)
  if (changed !== null && changed.replacementIntentJson === expectedIntentJson) {
    pauseOrCancelReplacement(
      server,
      changed,
      intent,
      expectedIntentJson,
      PRE_ATTACH_PREDECESSOR_CHANGED
    )
  }
}

/**
 * A committed intent is replayed only while its successor is still the
 * registration's current attempt. A bridge successor keeps its predecessor's
 * host binding, so once a broker has received its identity, the same
 * predecessor triple names the successor itself and a matching request is the
 * next replacement, not a retry of this one. A host successor gets a new
 * binding, so its triple stays unambiguous after establishment.
 */
function findCommittedResult(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  request: DirectJoinRequest
): DirectJoinResult | null {
  const currentAttempt = server.db.participantRegistrations.getAttemptByRegistrationId(
    registration.registrationId
  )
  for (const prior of server.db.participantRegistrations.listAttemptsByRegistrationId(
    registration.registrationId
  )) {
    const intent = parseReplacementIntent(prior.replacementIntentJson)
    if (
      !intent ||
      !sameReplacementTarget(intent, request) ||
      intent.allocatedAttemptId === undefined
    )
      continue
    const successor = server.db.participantRegistrations.getAttempt(intent.allocatedAttemptId)
    if (
      successor === null ||
      successor.attemptId !== currentAttempt?.attemptId ||
      (intent.kind === 'bridge' && successor.brokerIdentityJson !== undefined)
    )
      continue
    if (!sameReplacementRequest(intent, request)) {
      return refusal('rejected', 'host_binding_precondition_failed', DECLARATION_MISMATCH_DETAIL)
    }
    const current = server.db.participantRegistrations.getRegistrationById(
      registration.registrationId
    )
    if (current !== null) return identityResult(current, successor, false)
  }
  return null
}

/**
 * A bridge successor keeps the predecessor's runtime row, so it is only
 * possible while that row is live. Once HRC has settled the host's death itself
 * (T-10333 terminates a participant-served runtime whose broker is gone), the
 * same incarnation reattaching is a new host to HRC: a terminated runtime is
 * never revived, so the successor takes the host path and gets a fresh
 * binding, session generation and runtime (T-10741).
 */
function replacementKind(
  server: HrcServerInstanceForHandlers,
  request: DirectJoinRequest,
  binding: { hostIncarnationId: string; runtimeId: string }
): ReplacementKind {
  return request.hostIncarnationId === binding.hostIncarnationId &&
    server.db.runtimes.getByRuntimeId(binding.runtimeId)?.status !== 'terminated'
    ? 'bridge'
    : 'host'
}

type AdmittedReplacement = {
  binding: ParticipantHostBinding
  kind: ReplacementKind
  preAttachSupersession: boolean
  /** The predecessor as re-read after its intent was stored. */
  attempt: ParticipantAttempt
  intent: ReplacementIntent
  /** The intent exactly as stored on the predecessor; the next write CASes on it. */
  intentJson: string
}

/** A0: check the exact predecessor binding, then store (or match) the durable intent. */
function admitReplacementIntent(
  server: HrcServerInstanceForHandlers,
  initialAttempt: ParticipantAttempt,
  request: DirectJoinRequest
): AdmittedReplacement | DirectJoinResult {
  const expected = request.expectedPredecessor
  const binding =
    initialAttempt.hostBindingId === undefined
      ? null
      : server.db.participantHostBindings.getBindingById(initialAttempt.hostBindingId)
  const currentIntent = parseReplacementIntent(initialAttempt.replacementIntentJson)
  const preAttachSupersession =
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

  const kind = replacementKind(server, request, binding)
  if (currentIntent !== null && !sameReplacementRequest(currentIntent, request)) {
    return refusal(
      'rejected',
      'host_binding_precondition_failed',
      sameReplacementTarget(currentIntent, request)
        ? DECLARATION_MISMATCH_DETAIL
        : 'a different durable replacement intent already owns this predecessor'
    )
  }
  if (currentIntent === null) {
    const now = timestamp()
    const intent = buildReplacementIntent({
      kind,
      preAttachSupersession,
      binding,
      predecessor: initialAttempt,
      request,
      createdAt: now,
    })
    const stored = server.db.participantRegistrations.storeReplacementIntent({
      attemptId: initialAttempt.attemptId,
      attachEpoch: initialAttempt.attachEpoch,
      replacementIntentJson: JSON.stringify(intent),
      updatedAt: now,
    })
    if (stored === 'conflict') return gateChanged('replacement intent raced')
  }

  const attempt = server.db.participantRegistrations.getAttempt(initialAttempt.attemptId)
  if (attempt === null) {
    return refusal('pending', 'participant_attempt_unavailable', 'predecessor disappeared')
  }
  const intentJson = attempt.replacementIntentJson
  const intent = parseReplacementIntent(intentJson)
  if (intentJson === undefined || intent === null || !sameReplacementRequest(intent, request)) {
    return gateChanged('replacement intent changed')
  }
  return { binding, kind, preAttachSupersession, attempt, intent, intentJson }
}

type ReceiptedReplacement = AdmittedReplacement & {
  source: RetirementEvidenceSource
  evidence: WriterEvidence
  /** The satisfying evidence carried from an earlier receipt, if any. */
  priorBasis: WriterEvidence | undefined
  decision: RetirementDecision
  /** The first satisfying evidence, now recorded on the intent. */
  retirementBasis: WriterEvidence | undefined
  /** The predecessor's intent with this receipt, exactly as persisted. */
  intentJson: string
}

/** Observe the predecessor's writer and persist that receipt on the intent and attempt. */
async function recordRetirementReceipt(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  admitted: AdmittedReplacement
): Promise<ReceiptedReplacement | DirectJoinResult> {
  const { attempt, binding, kind } = admitted
  const source: RetirementEvidenceSource = admitted.preAttachSupersession
    ? 'pre-attach'
    : 'transport'
  const evidence =
    source === 'pre-attach'
      ? preAttachRetirementReceipt(registration, attempt, binding.hostIncarnationId)
      : (await observeParticipantTransportEvidence(server, registration, attempt, kind)).evidence
  const priorIntentJson = admitted.intentJson
  if (
    source === 'pre-attach' &&
    !isAbsorbingParticipantAttempt(attempt) &&
    !isNeverAttachedDirectAttempt(server, attempt)
  ) {
    pauseOrCancelReplacement(
      server,
      attempt,
      admitted.intent,
      priorIntentJson,
      PRE_ATTACH_PREDECESSOR_CHANGED
    )
    return gateChanged(PRE_ATTACH_PREDECESSOR_CHANGED)
  }
  const priorBasis = priorRetirementBasis(admitted.intent)
  const decision = retirementDecision(evidence, priorBasis)
  const retirementBasis = priorBasis ?? (decision === 'satisfied' ? evidence : undefined)
  const intent: ReplacementIntent = {
    ...admitted.intent,
    receipt: evidence,
    ...(retirementBasis === undefined ? {} : { retirementBasis }),
  }
  const intentJson = JSON.stringify(intent)
  const persisted = server.db.sqlite.transaction(() => {
    const current = server.db.participantRegistrations.getAttempt(attempt.attemptId)
    if (
      source === 'pre-attach' &&
      (current === null ||
        (!isAbsorbingParticipantAttempt(current) && !isNeverAttachedDirectAttempt(server, current)))
    )
      return false
    const intentUpdated = server.db.participantRegistrations.replaceReplacementIntent({
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      expectedJson: priorIntentJson,
      replacementJson: intentJson,
      updatedAt: timestamp(),
    })
    if (!intentUpdated) return false
    return server.db.participantRegistrations.recordWriterEvidence(
      attempt.attemptId,
      attempt.attachEpoch,
      JSON.stringify(evidence),
      timestamp()
    )
  })()
  if (!persisted) {
    if (source === 'pre-attach') {
      pauseChangedPreAttachPredecessor(server, attempt.attemptId, intent, priorIntentJson)
    }
    return gateChanged('writer receipt persistence raced')
  }
  return {
    ...admitted,
    intent,
    source,
    evidence,
    priorBasis,
    decision,
    retirementBasis,
    intentJson,
  }
}

/** An unproven or contradicted retirement parks the intent and answers why. */
function holdUnsatisfiedRetirement(
  server: HrcServerInstanceForHandlers,
  receipted: ReceiptedReplacement
): DirectJoinResult {
  const { attempt, decision, source } = receipted
  const refused = decision === 'refused'
  pauseOrCancelReplacement(
    server,
    attempt,
    receipted.intent,
    receipted.intentJson,
    refused
      ? 'host_binding_conflict: predecessor remains writable and live'
      : source === 'transport'
        ? 'host_retirement_unproven: transport_indeterminate'
        : 'host_retirement_unproven: predecessor retirement remains unknown'
  )
  return refusal(
    refused ? 'rejected' : 'pending',
    refused ? 'host_binding_conflict' : 'host_retirement_unproven',
    refused
      ? 'the exact predecessor remains writable and live'
      : source === 'transport'
        ? attempt.attachSocketPath === undefined
          ? 'transport_indeterminate: predecessor has no durable attach socket path'
          : 'transport_indeterminate: predecessor broker hello did not complete within the bounded probe'
        : receipted.priorBasis === undefined
          ? 'predecessor retirement is unknown'
          : 'later evidence voided the uncommitted succession on its satisfying axis'
  )
}

/**
 * After TX-D the predecessor must be durably absorbing with its recovery
 * reconciled or explicitly abandoned before any successor is allocated.
 */
function gatePredecessorRecovery(
  server: HrcServerInstanceForHandlers,
  attemptId: string,
  evidence: WriterEvidence
): ParticipantAttempt | DirectJoinResult {
  let attempt = server.db.participantRegistrations.getAttempt(attemptId)
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
      const heldIntent = parseReplacementIntent(attempt.replacementIntentJson)
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
  return attempt
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

  const admitted = admitReplacementIntent(server, initialAttempt, request)
  if ('outcome' in admitted) return admitted
  const receipted = await recordRetirementReceipt(server, registration, admitted)
  if ('outcome' in receipted) return receipted
  if (receipted.decision !== 'satisfied') return holdUnsatisfiedRetirement(server, receipted)

  const { binding, kind, source, evidence, intent, intentJson } = receipted
  const authorizingEvidence = receipted.retirementBasis ?? evidence
  const predecessorAttemptId = receipted.attempt.attemptId
  const disposed = disposePredecessor(server, {
    attemptId: predecessorAttemptId,
    bindingId: binding.bindingId,
    kind,
    source,
    authorizingEvidence,
  })
  if (!disposed) {
    pauseChangedPreAttachPredecessor(server, predecessorAttemptId, intent, intentJson)
    return gateChanged(PRE_ATTACH_PREDECESSOR_CHANGED)
  }

  const predecessor = gatePredecessorRecovery(server, predecessorAttemptId, evidence)
  if ('outcome' in predecessor) return predecessor

  const selection = selectionForSuccessor(
    server,
    registration,
    predecessor,
    request,
    kind,
    receipted.preAttachSupersession
  )
  const successor = mintSuccessorAttempt({ registration, predecessor, binding, kind, selection })
  const allocated = commitSuccessorAllocation(server, {
    registration,
    request,
    binding,
    kind,
    successor,
    priorAttemptId: predecessor.attemptId,
    gateIntentJson: intentJson,
    completedIntentJson: JSON.stringify({ ...intent, allocatedAttemptId: successor.attemptId }),
    recoveryEvidence: evidence,
    bindingRetirementReason: bindingRetirementReason(source, authorizingEvidence),
  })
  if (!allocated) return gateChanged('successor allocation gate changed')
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
  const intent = parseReplacementIntent(attempt.replacementIntentJson)
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
  return driveParticipantReplacement(
    server,
    registration,
    attempt,
    joinRequestFromIntent(registration, intent)
  )
}
