/**
 * One pass of delivery policy for one target (spec T-08092 rev 4, D2).
 *
 * The shape is: read the pending view, probe the seat, then deliver each
 * actionable envelope through its own door as its own submission. There is no
 * drive slot, no held batch and no attempt: the OUTSTANDING INTENT SET replaces
 * every "already delivering" guard, because it is durable and a slot was not.
 *
 * Routing, per envelope, in ledger order:
 *
 *  - `delivery = hold` → preempt, under the existing operator-authority gate;
 *    refused authority falls into the queue policy below and the eventual
 *    receipt carries `hold_refused_authority`;
 *  - seat turn-active AND the driver advertises `steer` → the steer door, so
 *    the body lands inside the turn the reader is already in;
 *  - seat turn-active without steer → enqueue, and the harness-local queue
 *    drains it at the boundary;
 *  - seat idle → enqueue, as before;
 *  - seat absent → cold birth, and the launch carries the body.
 */
import type { HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { errorText } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { deliverFailureNotices } from '../terminal/failure-notices.js'
import {
  birthDeferralFor,
  deferBirthForTarget,
  kickerScopeRefFor,
  skipForeignHomedTarget,
} from './authority.js'
import { deliverByColdBirth, deliverToSeat } from './delivery.js'
import type { ActionableEnvelope } from './presentation.js'
import { readActionableEnvelopes, summonsATurn } from './presentation.js'
import { observeBrokerSeat } from './seat.js'

export type DriveMailTargetOutcome = { outcome: 'birth-refused' } | undefined

export async function driveMailTargetOnce(
  server: MailKickerContext,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason
): Promise<DriveMailTargetOutcome> {
  // Placement first, before the ledger read or any door. A scope homed on
  // another node cannot be driven from here by any wake reason, so submitting
  // for it only manufactures the failure (T-07650). A ref this daemon cannot
  // parse gets no verdict and falls through to the path that already reported
  // that for what it is.
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  const foreign = scopeRef === undefined ? undefined : await server.resolveForeignHome(scopeRef)
  if (scopeRef !== undefined && foreign !== undefined) {
    skipForeignHomedTarget(server, targetSessionRef, scopeRef, foreign, wakeReason)
    return
  }

  const session = server.findTargetSession(targetSessionRef) ?? undefined
  // §5 — the sender-side failure notices this scope is owed. Delivered here
  // rather than folded into the drive because a notice is not an obligation:
  // it rides a live generation if there is one and waits for the next attend
  // otherwise, and it NEVER summons.
  if (session !== undefined) await deliverFailureNotices(server, targetSessionRef, session)

  let actionable: ActionableEnvelope[]
  try {
    actionable = await readActionableEnvelopes(server, targetSessionRef)
  } catch (error) {
    // wrkq owns the obligations. Unreachable means HRC does not know what to
    // deliver, which is a reason to do nothing, never a reason to guess.
    server.log(
      error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
      'wrkq.kicker.pending_view_failed',
      { targetSessionRef, wakeReason, error: errorText(error) }
    )
    return
  }
  if (actionable.length === 0) return

  if (session === undefined) {
    // A non-summoning envelope (a legacy `fyi`) is presented into a live
    // generation if there is one, and otherwise waits. It is never the reason a
    // session is born, so a wake set holding nothing else stops here.
    const summons = actionable.find((item) => summonsATurn(item.envelope))
    if (summons === undefined) return
    try {
      const outcome = await deliverByColdBirth(server, targetSessionRef, summons, wakeReason)
      if (outcome === 'submitted' && actionable.length > 1) {
        // One launch carries one envelope; the rest are delivered by policy
        // once the seat is live.
        server.wake(targetSessionRef, wakeReason)
      }
      return
    } catch (error) {
      // A birth deferral is not a failed delivery. It is this node correctly
      // declining a birth the collective designated elsewhere, and reporting it
      // as a failure is what made the pre-T-07655 race look like breakage on
      // every node that lost it.
      const deferral = birthDeferralFor(error)
      if (deferral !== undefined && scopeRef !== undefined) {
        deferBirthForTarget(server, targetSessionRef, scopeRef, deferral, wakeReason)
        return
      }
      server.log('WARN', 'wrkq.kicker.birth_failed', {
        targetSessionRef,
        wakeReason,
        envelope: summons.envelope.id,
        error: errorText(error),
      })
      if (scopeRef !== undefined) {
        server.db.mailDelivery.recordBirthRefusal({
          targetSessionRef,
          scopeRef,
          reason: errorText(error),
        })
      }
      return { outcome: 'birth-refused' }
    }
  }

  const seat = await observeBrokerSeat(server, session)
  if (seat.state === 'unavailable' || seat.state === 'starting' || seat.state === 'stopping') {
    server.log('INFO', 'wrkq.kicker.seat_not_ready', {
      targetSessionRef,
      wakeReason,
      observedSeatState: seat.state,
      envelopeIds: actionable.map((item) => item.envelope.id),
    })
    return
  }

  // A seat this node knows about but the broker calls terminal is a dead
  // generation; nothing can land in it and the runtime-lapse path owns what it
  // was holding.
  if (seat.state === 'terminal') {
    server.log('INFO', 'wrkq.kicker.seat_not_ready', {
      targetSessionRef,
      wakeReason,
      observedSeatState: seat.state,
      envelopeIds: actionable.map((item) => item.envelope.id),
    })
    return
  }

  for (const item of actionable) {
    const outcome = await deliverToSeat(
      server,
      targetSessionRef,
      session,
      seat,
      item,
      wakeReason
    ).catch((error: unknown) => {
      server.log('WARN', 'wrkq.kicker.delivery_failed', {
        targetSessionRef,
        wakeReason,
        envelope: item.envelope.id,
        error: errorText(error),
      })
      return 'refused' as const
    })
    // A refusal is about THIS envelope's door, not about the seat, so the pass
    // continues: one envelope whose preview failed must not hold the rest.
    if (outcome === 'refused') continue
  }
}
