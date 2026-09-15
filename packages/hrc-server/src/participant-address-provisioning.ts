import { randomUUID } from 'node:crypto'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { ParticipantAddressReservation } from 'hrc-store-sqlite'

import { withSummonAuthority } from './federation/summon-gate-server.js'
import { isClaimScopeFree } from './scope-claim-core.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

/**
 * Claiming a participant's address, registry-first (contract R6.3).
 *
 * Revision 5 made pre-provisioning an operator act that had to happen before
 * any host could register. R6.3 withdraws that condition: a direct registration
 * at a virgin address performs the claim itself. What survives unchanged is the
 * part that made pre-provisioning safe -- the claim wins collective authority
 * BEFORE it writes anything locally.
 *
 * That ordering is the whole point. `resolveImplicitScopeHome` resolves a home
 * "without establishing or mutating anything", so a path that only resolves can
 * durably reserve an address the collective has never bound, and another node
 * under policy skew would then resolve the same scope as virgin and establish
 * it. So this reuses `withSummonAuthority` verbatim, exactly as
 * `mintClaimedSession` does: the gate takes the scope summon lock, wins
 * authority through `establishLocalPlacement` (registry-first by construction),
 * and the reservation insert runs inside the mint callback -- after authority is
 * won and under the same locks the claim path takes.
 */

/**
 * The home node a reservation records. It is the federated node id when this
 * daemon has one, matching the `homeNodeId` `establishLocalPlacement` bound; an
 * unfederated daemon has no collective identity, and `'local'` is the reserved
 * id the placement resolver already uses for exactly that case.
 */
export function localParticipantHomeNodeId(server: HrcServerInstanceForHandlers): string {
  return (
    (server as { federationConfig?: { nodeId?: string } }).federationConfig?.nodeId ??
    server.options?.federationConfig?.nodeId ??
    'local'
  )
}

/**
 * R7.4 keeps these distinct all the way out to the caller.
 * `scope_bound_elsewhere` means a real birth happened on another node;
 * `scope_birth_designated_elsewhere` means NO birth happened at all. Collapsing
 * them would send a participant looking for a binding that does not exist.
 */
export type ParticipantAddressClaimRefusal =
  | 'participant_scope_bound_elsewhere'
  | 'participant_scope_birth_designated_elsewhere'
  | 'participant_placement_unavailable'
  | 'participant_scope_occupied'

export type ParticipantAddressClaim =
  | {
      outcome: 'reserved'
      reservation: ParticipantAddressReservation
      /** False when an earlier identical claim had already committed it. */
      created: boolean
    }
  | {
      outcome: 'refused'
      reason: ParticipantAddressClaimRefusal
      detail: string
      retryable: boolean
      homeNodeId?: string | undefined
    }

/**
 * Map a summon-gate refusal onto the claim vocabulary.
 *
 * The gate already distinguishes every case this needs and records its own
 * diagnostic, so this reads its `reason` rather than re-deriving a verdict from
 * the message text. A registry that refuses this node's entry is not retryable;
 * a registry we could not reach is, and R7.4 requires that it stay a pending
 * retry rather than becoming a local fallback mint.
 */
function refusalFromSummonError(error: unknown): ParticipantAddressClaim | null {
  if (!(error instanceof HrcConflictError)) return null
  const details = error.detail
  const reason = typeof details['reason'] === 'string' ? details['reason'] : ''
  const homeNodeId = typeof details['homeNodeId'] === 'string' ? details['homeNodeId'] : undefined
  const base = { outcome: 'refused' as const, detail: error.message }
  switch (reason) {
    case 'bound-elsewhere':
      return {
        ...base,
        reason: 'participant_scope_bound_elsewhere',
        retryable: false,
        ...(homeNodeId === undefined ? {} : { homeNodeId }),
      }
    case 'birth-designation-mismatch':
      return {
        ...base,
        reason: 'participant_scope_birth_designated_elsewhere',
        retryable: false,
        ...(homeNodeId === undefined ? {} : { homeNodeId }),
      }
    case 'registry-refused':
      return { ...base, reason: 'participant_placement_unavailable', retryable: false }
    case 'registry-unreachable':
      return { ...base, reason: 'participant_placement_unavailable', retryable: true }
    default:
      return null
  }
}

export type ClaimParticipantAddressInput = {
  scopeRef: string
  laneRef: string
  /** Delivery-defaults class, when the participant named one. Never authority. */
  classId?: string | undefined
}

/**
 * Establish this address in the collective registry and hold it locally.
 *
 * Idempotent: a re-run after a crash converges. `establishLocalPlacement`
 * returns `already-established` for a binding this node already won, and the
 * reservation insert is skipped when the row is already there.
 */
export async function claimParticipantAddress(
  server: HrcServerInstanceForHandlers,
  input: ClaimParticipantAddressInput
): Promise<ParticipantAddressClaim> {
  const { scopeRef, laneRef } = input

  const existing = server.db.participantHostBindings.getReservationByAddress(scopeRef, laneRef)
  if (existing !== null && existing.state === 'held') {
    if (existing.homeNodeId !== localParticipantHomeNodeId(server)) {
      return {
        outcome: 'refused',
        reason: 'participant_scope_bound_elsewhere',
        detail: `${scopeRef} is reserved on ${existing.homeNodeId}; register the host there`,
        retryable: false,
        homeNodeId: existing.homeNodeId,
      }
    }
    return { outcome: 'reserved', reservation: existing, created: false }
  }

  try {
    return await withSummonAuthority(
      server,
      { scopeRef, laneRef, path: 'resolve-session', intent: 'explicit_local' },
      (): ParticipantAddressClaim => {
        // Refuse rather than evict. A local claim can only have won this scope
        // inside a process crash within this very call, because outside that
        // window the reservation row exists and the birth doors refuse. If one
        // did win, the claim refuses as occupied; HRC never evicts a live claim
        // to install a reservation.
        const session = server.db.continuities.getByKey(scopeRef, laneRef)
        if (session !== null) {
          const active = server.db.sessions.getByHostSessionId(session.activeHostSessionId)
          if (active !== null && !isClaimScopeFree(server, active)) {
            return {
              outcome: 'refused',
              reason: 'participant_scope_occupied',
              detail: `${scopeRef} is occupied by a live runtime on session ${active.hostSessionId}; retire the occupant before a participant claims this address`,
              retryable: false,
            }
          }
        }
        const now = timestamp()
        const claimed = server.db.sqlite.transaction(() => {
          const current = server.db.participantHostBindings.getReservationByAddress(
            scopeRef,
            laneRef
          )
          if (current !== null && current.state === 'held') {
            return { row: current, created: false, released: false }
          }
          if (current !== null) {
            // A released address is re-claimed by an explicit act, and the
            // release stays on the record rather than being overwritten.
            return { row: current, created: false, released: true }
          }
          const row: ParticipantAddressReservation = {
            reservationId: `participant-reservation-${randomUUID()}`,
            ...(input.classId === undefined ? {} : { classId: input.classId }),
            scopeRef,
            laneRef,
            homeNodeId: localParticipantHomeNodeId(server),
            state: 'held',
            createdAt: now,
            updatedAt: now,
          }
          server.db.participantHostBindings.insertReservation(row)
          return { row, created: true, released: false }
        })()
        if (claimed.released) {
          return {
            outcome: 'refused',
            reason: 'participant_scope_occupied',
            detail: `${scopeRef} carries a released reservation ${claimed.row.reservationId}; a released address is re-claimed under a new explicit operation`,
            retryable: false,
          }
        }
        return { outcome: 'reserved', reservation: claimed.row, created: claimed.created }
      }
    )
  } catch (error) {
    const refusal = refusalFromSummonError(error)
    if (refusal !== null) return refusal
    throw error
  }
}

/**
 * R-4.3.3. Does this address carry a reservation, and is its host attached?
 *
 * Both answers refuse a substitute birth; only the explanation differs. An
 * unbound reserved address is a host that has not attached, and mail to it is a
 * truthful open obligation, not a reason to start something else. A bound one
 * already has its own runtime.
 */
export function reservedAddressBirthRefusal(
  server: HrcServerInstanceForHandlers,
  scopeRef: string,
  laneRef: string
): string | null {
  const reservation = server.db.participantHostBindings.getReservationByAddress(scopeRef, laneRef)
  if (reservation === null || reservation.state !== 'held') return null
  const live = server.db.participantHostBindings.getLiveBindingByReservationId(
    reservation.reservationId
  )
  return live === null
    ? `${scopeRef} is a reserved host address with no live incarnation; the obligation stays open and no substitute runtime is born`
    : `${scopeRef} is bound to host incarnation ${live.hostIncarnationId} (${live.state}); its own runtime serves this address`
}

/**
 * R-4.3.2 — the refusal a birth door raises rather than minting a substitute
 * session at a reserved address.
 *
 * It is a conflict, not a delivery: the envelope is neither replied to nor
 * marked delivered, and the caller's ordinary retry policy applies.
 */
export function assertReservedAddressAllowsBirth(
  server: HrcServerInstanceForHandlers,
  scopeRef: string,
  laneRef: string
): void {
  const detail = reservedAddressBirthRefusal(server, scopeRef, laneRef)
  if (detail === null) return
  throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, detail, {
    scopeRef,
    laneRef,
    reason: 'host_absent',
    retryable: true,
  })
}
