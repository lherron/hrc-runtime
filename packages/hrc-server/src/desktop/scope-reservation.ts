/**
 * Permanent readable scope reservation for desktop conversations (T-08294 §4).
 *
 * The address a person reads in a fleet view — `stella@hrc-ios:primary-nova` —
 * is an ORDINARY scope token, not a presentation alias. That is the whole point:
 * it addresses over hrcchat and wrkc like any other handle. It is also why this
 * allocator cannot live in its own namespace: `primary-nova` is simultaneously a
 * member of the suffix-roster family for base task `primary` and a legal exact
 * claim (see roster-claim.ts / exact-claim.ts). Three allocators over one
 * namespace need one lock and one definition of "taken", so this module shares
 * `withScopeClaimMutex`'s `roster:<agentId>:<projectId>` key and adds ONE new
 * predicate the other two must honor: {@link isScopeReservedForDesktop}.
 *
 * Reservation semantics differ from a claim in exactly one way, and it is the
 * important way: a claim is released when its session dies, a reservation never
 * is. Contract §4: "Reservations survive idle, detach, archival and observer
 * restart; no other thread or launch may recycle them."
 */

import { buildScopeRef } from 'agent-scope'
import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { ROSTER_SLOT_TOKENS } from 'spaces-config'

import { DESKTOP_LANE_REF } from './native-identity.js'

/**
 * Upper bound on numbered rounds. Ten tokens per round, so this is 10 000
 * addressable desktop conversations in ONE agent+project namespace — far beyond
 * any real fleet, while still terminating rather than looping forever if the
 * freedom predicate is ever wrong.
 */
const MAX_ROUNDS = 1_000

/**
 * The reservation order: `primary-nova` … `primary-cosmos`, then
 * `primary-nova-2` … `primary-cosmos-2`, then `-3`, and so on.
 *
 * Bare `primary` is excluded by contract. It is the base slot an ordinary
 * roster press lands on first and the handle a person types to reach the
 * standing seat; reserving it for a desktop conversation would take the
 * collective's front door away permanently.
 */
export function* desktopSlotTokenSequence(baseTask = 'primary'): Generator<string, void, void> {
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const suffix = round === 1 ? '' : `-${round}`
    for (const token of ROSTER_SLOT_TOKENS) {
      yield `${baseTask}-${token}${suffix}`
    }
  }
}

/** The first `count` tokens of the reservation order — for tests and diagnostics. */
export function desktopSlotTokens(count: number): string[] {
  const tokens: string[] = []
  for (const token of desktopSlotTokenSequence()) {
    if (tokens.length >= count) break
    tokens.push(token)
  }
  return tokens
}

export function desktopScopeRef(agentId: string, projectId: string, slotToken: string): string {
  return buildScopeRef({ agentId, projectId, taskId: slotToken })
}

/**
 * The predicate the ORDINARY allocators consult.
 *
 * A reserved scope is not "occupied by a live session" — it is frequently
 * occupied by nothing at all, because a desktop conversation Lance has not
 * touched in a week has no live runtime. The existing FREE predicate in
 * scope-claim-core.ts would therefore read it free and recycle it, handing
 * `stella@hrc-ios:primary-nova` to an unrelated press and silently redirecting
 * every future mail addressed to that conversation. This is the fence.
 */
export function isScopeReservedForDesktop(db: HrcDatabase, scopeRef: string): boolean {
  return db.desktopThreadRegistrations.getByScopeRef(scopeRef) !== null
}

export type DesktopSlotAvailability = {
  /** True when nothing — reservation, continuity, or in-flight start — holds this slot. */
  readonly available: boolean
  readonly heldBy?: 'desktop_reservation' | 'existing_continuity' | undefined
}

/**
 * Slot freedom for a NEW desktop reservation.
 *
 * Stricter than `isClaimScopeFree`: any existing continuity disqualifies the
 * slot, live or not. A desktop reservation is permanent and carries a mail
 * address, so adopting a token some other seat has ever answered on would make
 * historical and future traffic to the same string mean two different things.
 * An ordinary claim can afford to recycle a dead scope; this one cannot.
 */
export function desktopSlotAvailability(
  db: HrcDatabase,
  scopeRef: string
): DesktopSlotAvailability {
  if (isScopeReservedForDesktop(db, scopeRef)) {
    return { available: false, heldBy: 'desktop_reservation' }
  }
  if (db.continuities.getByKey(scopeRef, DESKTOP_LANE_REF) !== null) {
    return { available: false, heldBy: 'existing_continuity' }
  }
  return { available: true }
}

export class DesktopRosterExhaustedError extends Error {
  constructor(
    readonly agentId: string,
    readonly projectId: string
  ) {
    super(`no free desktop slot in ${agentId}/${projectId} after ${MAX_ROUNDS} rounds`)
    this.name = 'DesktopRosterExhaustedError'
  }
}

/**
 * Pick the next free reservation slot.
 *
 * MUST be called inside `withScopeClaimMutex` on the shared
 * `roster:<agentId>:<projectId>` key, and the reservation row MUST be committed
 * before the mutex is released. Otherwise two concurrent distinct threads both
 * observe `primary-nova` free and the unique index on `scope_ref` decides the
 * race after one of them has already told a hook its address.
 */
export function allocateDesktopSlot(
  db: HrcDatabase,
  agentId: string,
  projectId: string,
  baseTask = 'primary'
): { readonly slotToken: string; readonly scopeRef: string } {
  for (const slotToken of desktopSlotTokenSequence(baseTask)) {
    const scopeRef = desktopScopeRef(agentId, projectId, slotToken)
    if (desktopSlotAvailability(db, scopeRef).available) return { slotToken, scopeRef }
  }
  throw new DesktopRosterExhaustedError(agentId, projectId)
}

/**
 * The cold-birth fence (§6: "suppress ordinary cold-birth fallback for reserved
 * desktop scopes, including after observer/runtime detach").
 *
 * A registered desktop conversation always HAS a session, so the mail kicker's
 * `session === undefined` cold-birth branch is not the exposure. The exposure is
 * everything downstream of it: a dispatch that finds no live runtime for the
 * seat and starts one. For an ordinary scope that is correct and is how mail
 * wakes a quiet agent. For `stella@hrc-ios:primary-nova` it would boot a Codex
 * CLI beside Lance's desktop conversation, on the same readable address, and
 * answer his mail from a process he never opened.
 *
 * So the refusal lives at `startRuntimeForSession`, the single door every start
 * path (roster claim, exact claim, dispatch cold start, kicker birth) passes
 * through. HRC's own observer attachment deliberately does NOT use that door —
 * it calls the broker controller directly — so this fence costs the observer
 * nothing.
 *
 * `retryable: true` is the honest code: the work is not rejected, it is PENDING
 * under the registered address until desktop is available. Desktop
 * unavailability is not a delivery failure.
 */
export function assertDesktopScopeNotColdBorn(db: HrcDatabase, scopeRef: string): void {
  const reservation = db.desktopThreadRegistrations.getByScopeRef(scopeRef)
  if (reservation === null) return
  throw new HrcRuntimeUnavailableError(
    'scope is a Codex desktop conversation; HRC never births a runtime for it',
    {
      scopeRef,
      nativeThreadId: reservation.nativeThreadId,
      reservation: 'codex-desktop',
      retryable: true,
    }
  )
}
