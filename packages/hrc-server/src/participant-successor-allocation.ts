import { randomUUID } from 'node:crypto'

import type {
  ParticipantAttempt,
  ParticipantContinuationSelection,
  ParticipantHostBinding,
  ParticipantRegistration,
} from 'hrc-store-sqlite'
import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { DirectJoinRequest } from './participant-host-registration.js'
import { recoverySatisfied } from './participant-predecessor-retirement.js'
import type { ReplacementKind } from './participant-replacement-intent.js'
import { isAbsorbingParticipantAttempt } from './participant-writer-evidence.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'
import { createSessionSuccessorFromContinuation } from './session-successor.js'
import { settleTerminalRuntimeRuns } from './terminal-runtime-runs.js'

/**
 * TX-6/TX-6': allocating the successor attempt once the predecessor is
 * durably disposed. A bridge successor reuses the predecessor's binding and
 * runtime; a host successor gets a new binding, session generation and runtime.
 */

/** A successor always names its binding and carries its continuation selection. */
type MintedSuccessor = ParticipantAttempt & {
  hostBindingId: string
  continuation: ParticipantContinuationSelection
}

export function mintSuccessorAttempt(input: {
  registration: ParticipantRegistration
  predecessor: ParticipantAttempt
  binding: ParticipantHostBinding
  kind: ReplacementKind
  selection: ParticipantContinuationSelection
}): MintedSuccessor {
  const { binding, kind } = input
  return {
    attemptId: `participant-attempt-${randomUUID()}`,
    registrationId: input.registration.registrationId,
    attachEpoch: input.predecessor.attachEpoch + 1,
    requestId: `req-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    invocationId: `inv-${randomUUID()}`,
    runtimeId: kind === 'bridge' ? binding.runtimeId : `rt-${randomUUID()}`,
    hostBindingId: kind === 'bridge' ? binding.bindingId : `participant-binding-${randomUUID()}`,
    state: 'IDENTITY_MINTED',
    recoveryDisposition: 'unresolved',
    establishmentWorkState: 'pending',
    establishmentAttemptCount: 0,
    continuation: input.selection,
    // Selection is not a native-resume result. The attach call changes this to
    // requested only when a profile actually expresses the selected value.
    resumeState: 'not_requested',
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }
}

/**
 * The successor binding retired the predecessor host, so its runtime row ends
 * `host_replaced` and owns no run (T-10829). An already-terminated predecessor
 * keeps the reason HRC recorded.
 */
function terminateReplacedPredecessorRuntime(
  server: HrcServerInstanceForHandlers,
  runtimeId: string
): void {
  const priorRuntime = server.db.runtimes.getByRuntimeId(runtimeId)
  if (priorRuntime === null || priorRuntime.status === 'terminated') return
  const now = timestamp()
  settleTerminalRuntimeRuns(server.db, runtimeId, {
    now,
    errorMessage: 'participant host was replaced: host_replaced',
  })
  server.db.runtimes.update(runtimeId, {
    status: 'terminated',
    statusChangedAt: now,
    lifecycleTerminalReason: 'host_replaced',
    runtimeStateJson: {
      ...(priorRuntime.runtimeStateJson ?? {}),
      status: 'terminated',
      terminalReason: 'host_replaced',
    },
    updatedAt: now,
  })
}

type SuccessorAllocation = {
  registration: ParticipantRegistration
  request: DirectJoinRequest
  /** The predecessor binding as admitted by the intent. */
  binding: ParticipantHostBinding
  kind: ReplacementKind
  successor: MintedSuccessor
  priorAttemptId: string
  /** The predecessor's intent must still be exactly this JSON. */
  gateIntentJson: string
  completedIntentJson: string
  /** The evidence the predecessor's recovery is judged against. */
  recoveryEvidence: WriterEvidence
  bindingRetirementReason: string
}

/** Host path: new session generation and binding; the predecessor binding ends RETIRED. */
function commitHostSuccessor(
  server: HrcServerInstanceForHandlers,
  allocation: SuccessorAllocation,
  currentBinding: ParticipantHostBinding
): boolean {
  const { registration, request, binding, successor } = allocation
  if (currentBinding.state !== 'RETIRING' && currentBinding.state !== 'BINDING') return false
  const priorSession = server.db.sessions.getByHostSessionId(registration.hostSessionId)
  if (priorSession === null) return false
  const nextGeneration = registration.generation + 1
  const successorSource = successor.continuation.carried
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
      dispositionReason: allocation.bindingRetirementReason,
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
    bindingId: successor.hostBindingId,
    reservationId: binding.reservationId,
    registrationId: registration.registrationId,
    hostIncarnationId: request.hostIncarnationId,
    hostSessionId: nextSession.hostSessionId,
    generation: nextGeneration,
    runtimeId: successor.runtimeId,
    state: 'BINDING',
    predecessorBindingId: binding.bindingId,
    admittedAt: timestamp(),
    updatedAt: timestamp(),
  })
  terminateReplacedPredecessorRuntime(server, binding.runtimeId)
  return true
}

/** Bridge path: same binding and runtime; only the registration's endpoint moves. */
function commitBridgeSuccessor(
  server: HrcServerInstanceForHandlers,
  allocation: SuccessorAllocation
): void {
  const { registration, request, binding } = allocation
  if (
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
}

/**
 * Commit the successor in one transaction, gated on the predecessor still
 * holding the receipt-bearing intent, being durably absorbing, and having a
 * satisfied recovery. Returns false when that gate changed.
 */
export function commitSuccessorAllocation(
  server: HrcServerInstanceForHandlers,
  allocation: SuccessorAllocation
): boolean {
  return server.db.sqlite.transaction(() => {
    const currentPrior = server.db.participantRegistrations.getAttempt(allocation.priorAttemptId)
    const currentBinding = server.db.participantHostBindings.getBindingById(
      allocation.binding.bindingId
    )
    if (
      currentPrior === null ||
      currentPrior.replacementIntentJson !== allocation.gateIntentJson ||
      !isAbsorbingParticipantAttempt(currentPrior) ||
      !currentPrior.dispositionReason?.trim() ||
      !recoverySatisfied(currentPrior, allocation.recoveryEvidence) ||
      currentBinding === null
    ) {
      return false
    }

    if (allocation.kind === 'host') {
      if (!commitHostSuccessor(server, allocation, currentBinding)) return false
    } else {
      commitBridgeSuccessor(server, allocation)
    }
    server.db.participantRegistrations.insertAttempt(allocation.successor)
    return server.db.participantRegistrations.completeReplacementWork({
      attemptId: currentPrior.attemptId,
      attachEpoch: currentPrior.attachEpoch,
      expectedIntentJson: allocation.gateIntentJson,
      completedIntentJson: allocation.completedIntentJson,
      updatedAt: timestamp(),
    })
  })()
}
