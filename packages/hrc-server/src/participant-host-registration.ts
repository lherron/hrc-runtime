import { randomUUID } from 'node:crypto'

import { parseScopeRef } from 'agent-scope'
import type {
  ParticipantAttempt,
  ParticipantContinuationSelection,
  ParticipantHostBinding,
  ParticipantRegistration,
  ParticipantRegistrationPolicy,
} from 'hrc-store-sqlite'

import { claimParticipantAddress } from './participant-address-provisioning.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { createHostSessionId, timestamp } from './server-util.js'

/**
 * Direct protocol join (contract R6.1-R6.4, R7.1-R7.4).
 *
 * The participant declares its own address and its own current host identity,
 * and HRC records the declaration. There is no `admit`, no host descriptor, no
 * evidence file and no adapter load anywhere on this path: an adapter
 * identifier is a delivery default, never admission authority. What HRC still
 * owns is the part that was always HRC's -- parsing the message, naming the
 * canonical home, serializing the address claim, and refusing an address a
 * different live incarnation already holds.
 *
 * Nothing here executes a model. A join ends at durable identity; the profile
 * that could run something arrives later through `/v1/participants/attach`.
 */

/**
 * R6.2's defaults for a participant that named no class.
 *
 * A configured class supplies delivery defaults and nothing else, so a
 * participant without one is not missing permission -- it is simply using
 * these. `externally-owned` is the load-bearing entry: HRC never acquires
 * authority over a process just because that process spoke to it.
 */
export const DIRECT_JOIN_POLICY: ParticipantRegistrationPolicy = {
  addressPolicy: 'selected-scope',
  continuityPolicy: 'host-incarnation',
  lifecycleOwner: 'externally-owned',
  replaySemantics: 'full-source-replay',
}

/** The identities a joined participant needs to compose its own attachment. */
export type DirectJoinIdentity = {
  registrationId: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  /**
   * Reserved as an identifier on the binding and attempt. It asserts no
   * materialized or running runtime: `runtimes.transport`, `.harness` and
   * `.provider` are NOT NULL and all profile-derived, so the row cannot exist
   * honestly until attachment supplies them (R6.3).
   */
  runtimeId: string
  attemptId: string
  invocationId: string
  attachEpoch: number
  /**
   * Returned because the participant cannot compose a valid profile without
   * them. The published `validateParticipantAdapterPreparation` requires the
   * profile's observability correlation to carry HRC's requestId and
   * operationId, and a real external participant has no other way to learn
   * them -- a live Arris join failed on exactly this before they were here.
   */
  requestId: string
  operationId: string
}

export type DirectJoinContinuation = {
  carried: boolean
  reason: ParticipantContinuationSelection['reason']
  /** The HRC continuation object carried in, parsed, or null when none was. */
  selected: unknown
  resumeState: 'not_requested' | 'requested' | 'unsupported' | 'indeterminate'
}

export type DirectJoinResult =
  | {
      outcome: 'registered'
      identity: DirectJoinIdentity
      continuation: DirectJoinContinuation
      created: boolean
      attached: boolean
    }
  | {
      outcome: 'redirect'
      reason: 'participant_scope_bound_elsewhere' | 'participant_scope_birth_designated_elsewhere'
      detail: string
      homeNodeId?: string | undefined
    }
  | {
      outcome: 'refused'
      status: 'pending' | 'rejected'
      reason: string
      detail: string
    }

export type DirectJoinRequest = {
  requestedSessionRef: string
  hostIncarnationId: string
  laneRef: string
  classId?: string | undefined
  participantKey?: string | undefined
  workspaceCwd?: string | undefined
  socketPath?: string | undefined
}

/**
 * R6.6/R7.3: continuation is decided from HRC's own records.
 *
 * The predecessor candidate is read from the attempt of the binding this one
 * replaces. In slice A no such predecessor can exist, because a
 * different-incarnation takeover is refused before reaching here -- so today
 * this returns `no_continuation` for every real call. It is written as the
 * lookup rather than as a constant so that when succession lands, the shape of
 * the answer does not change; and so that a reader can see WHY the answer is
 * what it is instead of finding a hardcoded verdict.
 */
function selectContinuation(
  server: HrcServerInstanceForHandlers,
  predecessor: ParticipantHostBinding | null
): ParticipantContinuationSelection {
  if (predecessor === null) {
    return { carried: false, reason: 'no_continuation' }
  }
  const priorAttempt = server.db.participantRegistrations.getAttemptByRegistrationId(
    predecessor.registrationId
  )
  const candidate = priorAttempt?.continuation?.selectedJson
  if (candidate === undefined) {
    return { carried: false, reason: 'no_continuation' }
  }
  return { carried: true, reason: 'carried', selectedJson: candidate }
}

function asDirectJoinContinuation(attempt: ParticipantAttempt): DirectJoinContinuation {
  const stored = attempt.continuation
  // An attempt written before its selection was recorded is reported as what it
  // is. Inventing `no_continuation` here would be a claim about a decision that
  // has not been made.
  if (stored === undefined) {
    return {
      carried: false,
      reason: 'no_continuation',
      selected: null,
      resumeState: 'indeterminate',
    }
  }
  return {
    carried: stored.carried,
    reason: stored.reason,
    selected: stored.selectedJson === undefined ? null : JSON.parse(stored.selectedJson),
    resumeState: attempt.resumeState ?? 'not_requested',
  }
}

function identityOf(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt
): DirectJoinIdentity {
  return {
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
  }
}

/**
 * The join itself.
 *
 * Ordering is shape -> home/claim -> occupancy -> allocation, which is R6.3's
 * ordering once admission is gone. It matters: with admission removed, the
 * address outcomes are the first thing a misprovisioned host learns, instead of
 * being shadowed by an admission-sourced refusal that told it nothing about
 * where its address actually lives.
 */
export async function registerDirectParticipant(
  server: HrcServerInstanceForHandlers,
  request: DirectJoinRequest
): Promise<DirectJoinResult> {
  const { requestedSessionRef: scopeRef, laneRef, hostIncarnationId } = request

  // A duplicate direct request is identified by address plus incarnation, which
  // a direct request always carries. It needs no extra retry token, and it
  // converges after a daemon loss that happened before attachment began.
  const existingByIncarnation =
    server.db.participantRegistrations.getDirectRegistrationByAddressAndIncarnation(
      scopeRef,
      hostIncarnationId
    )
  if (existingByIncarnation !== null) {
    const attempt = server.db.participantRegistrations.getAttemptByRegistrationId(
      existingByIncarnation.registrationId
    )
    if (attempt === null) {
      return {
        outcome: 'refused',
        status: 'pending',
        reason: 'participant_attempt_unavailable',
        detail: 'the registered participant has no durable attempt',
      }
    }
    return {
      outcome: 'registered',
      identity: identityOf(existingByIncarnation, attempt),
      continuation: asDirectJoinContinuation(attempt),
      created: false,
      attached: attempt.preparedProfileJson !== undefined,
    }
  }

  const claim = await claimParticipantAddress(server, {
    scopeRef,
    laneRef,
    ...(request.classId === undefined ? {} : { classId: request.classId }),
  })
  if (claim.outcome === 'refused') {
    if (
      claim.reason === 'participant_scope_bound_elsewhere' ||
      claim.reason === 'participant_scope_birth_designated_elsewhere'
    ) {
      // R7.4: routing information, not a completed registration, and not a
      // forwarded request. Nothing local is committed.
      return {
        outcome: 'redirect',
        reason: claim.reason,
        detail: claim.detail,
        ...(claim.homeNodeId === undefined ? {} : { homeNodeId: claim.homeNodeId }),
      }
    }
    return {
      outcome: 'refused',
      status: claim.retryable ? 'pending' : 'rejected',
      reason: claim.reason,
      detail: claim.detail,
    }
  }

  const reservation = claim.reservation
  const occupant = server.db.participantHostBindings.getLiveBindingByReservationId(
    reservation.reservationId
  )
  if (occupant !== null) {
    // Speaking the protocol does not transfer another live process's address.
    // Replacing an occupant is the explicit succession procedure, which this
    // slice does not implement -- so it is refused, out loud, rather than
    // performed silently or dressed up as a reconnection that occurred.
    return {
      outcome: 'refused',
      status: 'pending',
      reason: 'participant_host_replacement_unsupported',
      detail: `${scopeRef} is held by host incarnation ${occupant.hostIncarnationId} (${occupant.state}); replacing a live incarnation requires the explicit succession procedure, which this HRC release does not yet execute`,
    }
  }
  const retiredHere = server.db.participantHostBindings.listBindingsByReservationId(
    reservation.reservationId
  )
  if (retiredHere.length > 0) {
    return {
      outcome: 'refused',
      status: 'pending',
      reason: 'participant_host_succession_unsupported',
      detail: `${scopeRef} has ${retiredHere.length} retired host binding(s); succeeding a previous incarnation at a held address requires the explicit succession procedure, which this HRC release does not yet execute`,
    }
  }

  const now = timestamp()
  const hostSessionId = createHostSessionId()
  const registrationId = `participant-registration-${randomUUID()}`
  const bindingId = `participant-binding-${randomUUID()}`
  const attemptId = `participant-attempt-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const continuation = selectContinuation(server, null)

  const registration: ParticipantRegistration = {
    registrationId,
    registrationMode: 'direct',
    // No class, no adapter, no preparation and no workspace are stored unless
    // the participant actually supplied them. R7.1 forbids the placeholders
    // that would otherwise make these columns look answered.
    ...(request.classId === undefined ? {} : { classId: request.classId }),
    join: 'participant-served',
    ...(request.participantKey === undefined ? {} : { participantKey: request.participantKey }),
    scopeRef,
    laneRef,
    hostSessionId,
    generation: 1,
    ...(request.workspaceCwd === undefined ? {} : { workspaceCwd: request.workspaceCwd }),
    ...(request.socketPath === undefined ? {} : { socketPath: request.socketPath }),
    policy: DIRECT_JOIN_POLICY,
    hostIncarnationId,
    createdAt: now,
    updatedAt: now,
  }
  const binding: ParticipantHostBinding = {
    bindingId,
    reservationId: reservation.reservationId,
    registrationId,
    hostIncarnationId,
    hostSessionId,
    generation: 1,
    runtimeId,
    // BINDING, not BOUND: the incarnation holds the address, and nothing has
    // attached to it yet.
    state: 'BINDING',
    admittedAt: now,
    updatedAt: now,
  }
  const attempt: ParticipantAttempt = {
    attemptId,
    registrationId,
    attachEpoch: 1,
    requestId: `req-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    invocationId: `inv-${randomUUID()}`,
    runtimeId,
    hostBindingId: bindingId,
    // Registered, attachment pending. Both profile columns stay NULL, which the
    // paired-NULL CHECK keeps honest, and the state is the one migration 0064
    // already has for exactly this.
    state: 'IDENTITY_MINTED',
    recoveryDisposition: 'unresolved',
    // Pending is the durable arming; R7.2's non-runnable predicate is what
    // keeps the worker from burning retries on it before a profile exists.
    establishmentWorkState: 'pending',
    establishmentAttemptCount: 0,
    continuation,
    resumeState: 'not_requested',
    createdAt: now,
    updatedAt: now,
  }

  server.db.sqlite.transaction(() => {
    server.db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      parsedScopeJson: parseScopeRef(scopeRef) as unknown as Record<string, unknown>,
      ancestorScopeRefs: [],
    })
    server.db.continuities.upsert({
      scopeRef,
      laneRef,
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })
    server.db.participantRegistrations.insertRegistration(registration)
    server.db.participantHostBindings.insertBinding(binding)
    server.db.participantRegistrations.insertAttempt(attempt)
  })()

  return {
    outcome: 'registered',
    identity: identityOf(registration, attempt),
    continuation: asDirectJoinContinuation(attempt),
    created: true,
    attached: false,
  }
}
