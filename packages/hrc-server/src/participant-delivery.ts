import { HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import { participantNeedsReconnect } from './participant-establishment.js'
import { isAbsorbingParticipantAttempt } from './participant-writer-evidence.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { isRuntimeUnavailableStatus } from './server-util.js'

/**
 * Delivering addressed work INTO an attached participant (contract R7.6).
 *
 * Section 7.1 maps queue and steer onto the existing public doors, but those
 * doors provision a runtime by compiling an intent, and a participant has none
 * to compile: nothing has ever written `lastAppliedIntentJson` for one. So the
 * doors answered `missing_runtime_intent`, and when an intent WAS supplied they
 * birthed a competing HRC-owned runtime at an address an external host already
 * held. The mapping was never actually implemented.
 *
 * This resolves the target from durable registration facts INSTEAD of from an
 * intent, and hands the participant's own existing runtime to the existing
 * broker input-turn path. That keeps one queue, one set of receipts, and the
 * established run accounting, wait and replay semantics: nothing here submits
 * to a broker or invents an outcome of its own.
 *
 * Deliberately NOT `activeBrokerRuntimeForSession`, which takes the latest
 * matching runtime. R7.6 forbids an arbitrary latest runtime, because "latest"
 * is exactly how stale linkage targets a different writer.
 *
 * The linkage actually enforced, in order, because a comment that claims more
 * than the code checks is worse than no comment:
 *   1. the registration's session and generation match the session addressed;
 *   2. the attempt has a frozen profile (otherwise: attachment pending);
 *   3. the attempt is ACTIVE -- a nonterminal runtime alone is NOT activated
 *      attachment, and an absorbing attempt will never serve;
 *   4. for a DIRECT join, the attempt's host binding exists, is BOUND, and
 *      still names the same registration, incarnation, session, generation and
 *      runtime. A legacy key-scoped attempt has no binding by construction and
 *      is validated by its attempt linkage alone;
 *   5. the runtime row exists and is not in an unavailable status;
 *   6. the runtime is serving THIS attempt's invocation;
 *   7. the runtime's own session and generation match the registration's.
 */

export type ParticipantDeliveryTarget = {
  outcome: 'attached'
  registration: ParticipantRegistration
  attempt: ParticipantAttempt
  /** The one runtime this attempt's durable linkage names. */
  runtime: HrcRuntimeSnapshot
}

export type ParticipantDeliveryRefusal = {
  outcome: 'refused'
  /**
   * `pending` is a participant that exists and has not attached yet: its mail
   * stays eligible and drains through the ordinary machinery once it does.
   * `unavailable` is one whose linkage cannot be trusted right now. Neither
   * ever falls through to a generic birth.
   */
  kind: 'pending' | 'unavailable'
  reason: string
  detail: string
}

/** Everything is linked, but this controller instance has no client yet. */
export type ParticipantDeliveryReconnect = {
  outcome: 'reconnect'
  registration: ParticipantRegistration
  attempt: ParticipantAttempt
  runtime: HrcRuntimeSnapshot
}

export type ParticipantDelivery =
  | ParticipantDeliveryTarget
  | ParticipantDeliveryReconnect
  | ParticipantDeliveryRefusal

/**
 * Resolve a session to its participant delivery target, or report that it is
 * not a participant at all by returning null. A null is the ONLY path that
 * leaves ordinary dispatch behavior untouched.
 */
export function resolveParticipantDelivery(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): ParticipantDelivery | null {
  const registration = server.db.participantRegistrations.getRegistrationByScopeRef(
    session.scopeRef
  )
  if (registration === null) return null

  const refuse = (
    kind: ParticipantDeliveryRefusal['kind'],
    reason: string,
    detail: string
  ): ParticipantDeliveryRefusal => ({ outcome: 'refused', kind, reason, detail })

  const attempt = server.db.participantRegistrations.getAttemptByRegistrationId(
    registration.registrationId
  )
  if (attempt === null) {
    return refuse(
      'unavailable',
      'participant_attempt_unavailable',
      'the participant registration has no durable attempt to deliver into'
    )
  }

  // Registered but not attached. This is the ordinary pre-attachment state, not
  // a fault, and the work waits rather than being refused permanently.
  if (attempt.preparedProfileJson === undefined) {
    return refuse(
      'pending',
      'participant_attachment_pending',
      `participant ${registration.registrationId} has joined but not attached; addressed work stays pending until it does`
    )
  }

  // R7.6: a nonterminal runtime alone is NOT activated attachment. Between the
  // attach transaction and activation the profile is durable and the host is
  // not yet serving, so work waits rather than being pushed at a seat that has
  // not confirmed it. An absorbing attempt is a different answer: that address
  // is not going to serve this attempt at all.
  if (isAbsorbingParticipantAttempt(attempt)) {
    return refuse(
      'unavailable',
      'participant_attempt_absorbing',
      `participant attempt ${attempt.attemptId} is ${attempt.state}; it will not serve addressed work`
    )
  }
  if (attempt.state !== 'ACTIVE') {
    // A reconnect cycle persists DETACHED before it awaits install/hello, so a
    // non-ACTIVE attempt is usually a recovery in flight rather than a failure.
    // Distinguish them: reporting an exhausted cycle as `activation_pending`
    // reads as "not finished yet" for a state that is not coming back on its
    // own, which is the kind of pending-shaped verdict that teaches a reader to
    // ignore the field.
    if (attempt.establishmentWorkState === 'exhausted') {
      return refuse(
        'unavailable',
        'participant_reconnect_exhausted',
        `participant attempt ${attempt.attemptId} is ${attempt.state} with an exhausted reconnect budget after ${attempt.establishmentAttemptCount} attempt(s); it needs an explicit re-attach, and its addressed work stays pending meanwhile`
      )
    }
    const recovering =
      attempt.establishmentWorkState === 'pending' ||
      attempt.establishmentWorkState === 'retry_wait'
    return refuse(
      'pending',
      recovering ? 'participant_reconnect_in_progress' : 'participant_activation_pending',
      recovering
        ? `participant attempt ${attempt.attemptId} is ${attempt.state} with a reconnect cycle in progress; addressed work stays pending until it is restored`
        : `participant attempt ${attempt.attemptId} is ${attempt.state}, not ACTIVE; its broker establishment has not finished activating`
    )
  }

  // R7.6: the DIRECT host binding is part of current linkage. A legacy
  // key-scoped attempt has none by construction and is validated by its attempt
  // linkage alone, which is why this is keyed on the binding's presence rather
  // than on the registration mode.
  if (attempt.hostBindingId !== undefined) {
    const binding = server.db.participantHostBindings.getBindingById(attempt.hostBindingId)
    if (binding === null) {
      return refuse(
        'unavailable',
        'participant_linkage_stale',
        `participant attempt ${attempt.attemptId} names host binding ${attempt.hostBindingId}, which no longer exists`
      )
    }
    if (binding.state !== 'BOUND') {
      return refuse(
        binding.state === 'BINDING' ? 'pending' : 'unavailable',
        'participant_binding_not_bound',
        `participant host binding ${binding.bindingId} is ${binding.state}, not BOUND`
      )
    }
    // The binding must still describe the same incarnation and the same
    // session/generation the registration names. A binding that has moved on is
    // exactly how a stale attempt would address a different writer.
    if (
      binding.registrationId !== registration.registrationId ||
      binding.hostIncarnationId !== registration.hostIncarnationId ||
      binding.hostSessionId !== registration.hostSessionId ||
      binding.generation !== registration.generation ||
      binding.runtimeId !== attempt.runtimeId
    ) {
      return refuse(
        'unavailable',
        'participant_linkage_stale',
        `participant host binding ${binding.bindingId} no longer matches the registration's incarnation, session, generation or runtime`
      )
    }
  }

  // R7.6: recheck the CURRENT identity at dispatch. A session or generation that
  // has moved on means the linkage in hand describes a different writer.
  if (
    registration.hostSessionId !== session.hostSessionId ||
    registration.generation !== session.generation
  ) {
    return refuse(
      'unavailable',
      'participant_linkage_stale',
      `participant ${registration.registrationId} is bound to session ${registration.hostSessionId} generation ${registration.generation}, not ${session.hostSessionId} generation ${session.generation}`
    )
  }

  const runtime = server.db.runtimes.getByRuntimeId(attempt.runtimeId)
  if (runtime === null) {
    // The runtimeId is reserved at registration and the row only exists once a
    // real broker hello supplied transport/harness/provider, so its absence is
    // "not yet", not "broken".
    return refuse(
      'pending',
      'participant_runtime_not_materialized',
      `participant runtime ${attempt.runtimeId} is reserved but not yet materialized`
    )
  }
  if (isRuntimeUnavailableStatus(runtime.status)) {
    return refuse(
      'unavailable',
      'participant_host_unavailable',
      `participant runtime ${runtime.runtimeId} is ${runtime.status}; the external host is not serving this address right now`
    )
  }
  if (runtime.activeInvocationId !== attempt.invocationId) {
    return refuse(
      'unavailable',
      'participant_linkage_stale',
      `participant runtime ${runtime.runtimeId} is serving invocation ${runtime.activeInvocationId ?? '(none)'}, not the current attempt's ${attempt.invocationId}`
    )
  }
  // The runtime's OWN session and generation, not just the registration's.
  // Checking the registration against the session proves the caller addressed
  // the right registration; this proves the runtime about to receive the input
  // belongs to that same incarnation.
  if (
    runtime.hostSessionId !== registration.hostSessionId ||
    runtime.generation !== registration.generation
  ) {
    return refuse(
      'unavailable',
      'participant_linkage_stale',
      `participant runtime ${runtime.runtimeId} belongs to session ${runtime.hostSessionId} generation ${runtime.generation}, not the registration's ${registration.hostSessionId} generation ${registration.generation}`
    )
  }

  // The controller instance may be newer than the attachment (§6.2). Report it
  // as its own outcome so the caller joins ONE recovery operation rather than
  // pushing input at a seat with no client behind it.
  if (participantNeedsReconnect(server, attempt)) {
    return { outcome: 'reconnect', registration, attempt, runtime }
  }
  return { outcome: 'attached', registration, attempt, runtime }
}

/**
 * The typed refusal a door returns for a participant it cannot deliver into.
 *
 * Both kinds are `runtime_unavailable` on the wire, which is the existing
 * vocabulary for "this target cannot take work right now" and is what keeps
 * pending mail eligible instead of completing an envelope that was never
 * presented. The `reason` distinguishes them for a reader.
 */
export function participantDeliveryUnavailable(
  session: HrcSessionRecord,
  refusal: ParticipantDeliveryRefusal
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(refusal.detail, {
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    reason: refusal.reason,
    kind: refusal.kind,
  })
}

/**
 * R-4.3.2/R-4.3.3: a reserved participant address is never given a SUBSTITUTE
 * birth.
 *
 * Delivery now routes into the participant's own runtime before provisioning is
 * reached, so in the ordinary case nothing gets here. It is kept, and kept at
 * the two points where a broker runtime is actually BORN rather than at the
 * dispatch door, because that is what makes it a backstop instead of a second
 * spelling of the routing above: any future caller that reaches provisioning
 * with a participant session meets it, whatever door it came through.
 *
 * A live enqueue once walked past the `startRuntimeForSession` guard this way
 * and created a second, HRC-owned tmux runtime at an address an external Arris
 * host already held.
 */
export function assertParticipantAddressNotSubstituted(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): void {
  const registration = server.db.participantRegistrations.getRegistrationByScopeRef(
    session.scopeRef
  )
  if (registration === null) return
  throw new HrcRuntimeUnavailableError(
    'participant address cannot be served by a substitute runtime',
    {
      scopeRef: session.scopeRef,
      registrationId: registration.registrationId,
      reason: 'participant_address_reserved',
    }
  )
}

/** A rotation request that would silently replace someone else's process. */
export function participantRotationUnsupported(
  session: HrcSessionRecord,
  operation: string
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(
    `${operation} is not supported for an externally owned participant address`,
    {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      reason: 'participant_rotation_unsupported',
      code: HrcErrorCode.RUNTIME_UNAVAILABLE,
    }
  )
}
