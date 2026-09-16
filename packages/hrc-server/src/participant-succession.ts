import { randomUUID } from 'node:crypto'

import type {
  ParticipantAttempt,
  ParticipantContinuationSelection,
  ParticipantRegistration,
} from 'hrc-store-sqlite'
import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { DirectJoinRequest, DirectJoinResult } from './participant-host-registration.js'
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
    intent.predecessor.hostIncarnationId === request.expectedPredecessor?.hostIncarnationId &&
    intent.predecessor.runtimeId === request.expectedPredecessor?.runtimeId &&
    intent.predecessor.generation === request.expectedPredecessor?.generation
  )
}

function continuationForSuccessor(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration
): ParticipantContinuationSelection {
  const prior = server.db.sessions.getByHostSessionId(registration.hostSessionId)
  if (prior?.continuation === undefined) return { carried: false, reason: 'no_continuation' }
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
    attached: attempt.preparedProfileJson !== undefined,
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
  attempt: ParticipantAttempt
): string {
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
  if (expected === undefined || binding === null) {
    return refusal(
      'rejected',
      'host_binding_precondition_failed',
      'replacement requires the exact durable predecessor binding identity'
    )
  }
  if (
    binding.hostIncarnationId !== expected.hostIncarnationId ||
    binding.runtimeId !== expected.runtimeId ||
    binding.generation !== expected.generation
  ) {
    return refusal(
      'rejected',
      'host_binding_precondition_failed',
      `observed predecessor ${binding.hostIncarnationId}/${binding.runtimeId}/generation-${binding.generation}`
    )
  }

  const kind: ReplacementKind =
    request.hostIncarnationId === binding.hostIncarnationId ? 'bridge' : 'host'
  const currentIntent = parseIntent(initialAttempt.replacementIntentJson)
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
  // A producer-less direct registration is a known, stable hold. Do not arm a
  // replacement work item merely to rediscover that fact five times: no A0
  // effect is possible and the predecessor's reconnect work remains untouched.
  if (
    adapter === undefined ||
    registration.classId === undefined ||
    registration.participantKey === undefined ||
    !evidenceMethodAvailable
  ) {
    if (currentIntent !== null && initialAttempt.replacementIntentJson !== undefined) {
      pauseOrCancelReplacement(
        server,
        initialAttempt,
        currentIntent,
        initialAttempt.replacementIntentJson,
        'host_retirement_unproven: producer evidence unavailable'
      )
    }
    return refusal(
      'pending',
      'host_retirement_unproven',
      'producer evidence unavailable: this registration has no resolvable writer-evidence owner or key-capable WriterRef'
    )
  }
  const now = timestamp()
  const freshIntent: ReplacementIntent = {
    schemaVersion: 'participant-replacement-intent/v1',
    kind,
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

  const observedEvidence = await observeParticipantWriterEvidence(
    server,
    adapter,
    registration,
    attempt,
    kind
  )
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
  const persistedAttempt = attempt
  const priorIntentJson = persistedAttempt.replacementIntentJson
  if (priorIntentJson === undefined) {
    return refusal(
      'pending',
      'participant_successor_gate_changed',
      'replacement intent disappeared'
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
        : 'host_retirement_unproven: predecessor retirement remains unknown'
    )
    return refusal(
      currentDecision === 'refused' ? 'rejected' : 'pending',
      currentDecision === 'refused' ? 'host_binding_conflict' : 'host_retirement_unproven',
      currentDecision === 'refused'
        ? 'the exact predecessor remains writable and live'
        : priorBasis === undefined
          ? 'predecessor retirement is unknown'
          : 'later evidence voided the uncommitted succession on its satisfying axis'
    )
  }
  const authorizingEvidence = retirementBasis ?? evidence

  // TX-D: disposition is committed separately and therefore independently recoverable.
  const disposingAttemptId = attempt.attemptId
  server.db.sqlite.transaction(() => {
    const current = server.db.participantRegistrations.getAttempt(disposingAttemptId)
    if (current === null) throw new Error('predecessor disappeared before disposition')
    if (!isAbsorbingParticipantAttempt(current)) {
      if (
        !server.db.participantRegistrations.transitionAttempt(
          current.attemptId,
          [current.state],
          'ABANDONED',
          timestamp(),
          dispositionReason(kind, authorizingEvidence, current)
        )
      ) {
        throw new Error('predecessor disposition raced')
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
  })()

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
      ? (attempt.continuation ?? { carried: false, reason: 'no_continuation' as const })
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
          dispositionReason: 'host_replaced',
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
