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
 *
 * ONE address family is exempt from the last rule: a scope permanently reserved
 * for a Codex desktop conversation (P-00502 §6). HRC does not own that process,
 * so "nothing is seated" is a reason to WAIT under the registered address, never
 * to birth a replacement. See `desktop.ts`.
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
import { deferDesktopDelivery, desktopRegistrationForTarget } from './desktop.js'
import type { ActionableEnvelope } from './presentation.js'
import { readActionableEnvelopes, summonsATurn } from './presentation.js'
import { observeBrokerSeat } from './seat.js'

export type DriveMailTargetOutcome = { outcome: 'birth-refused' } | undefined

/**
 * Take the launch-carried door for a target with no live runtime.
 *
 * Shared by the two ways a target can have nothing seated: no session row at
 * all, and a session row whose seat the broker reports `absent`. They are the
 * same delivery problem — there is no harness to submit into — and routing only
 * the first one here is what let the second fall to `enqueue` and race the
 * launch's own priming prompt (T-08394).
 */
async function birthForTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  scopeRef: string | undefined,
  actionable: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason
): Promise<DriveMailTargetOutcome> {
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

  // A registered desktop conversation is never HRC's to seat (P-00502 §6). The
  // check sits after the ledger read so the deferral line can name the mail it
  // is holding, and before every door so no branch below can birth or dispatch.
  const desktopRegistration = desktopRegistrationForTarget(server, targetSessionRef)

  if (session === undefined) {
    if (desktopRegistration !== undefined) {
      deferDesktopDelivery(server, {
        targetSessionRef,
        registration: desktopRegistration,
        reason: 'no_registered_session',
        envelopeIds: actionable.map((item) => item.envelope.id),
        detail: { wakeReason },
      })
      return
    }
    return await birthForTarget(server, targetSessionRef, scopeRef, actionable, wakeReason)
  }

  const seat = await observeBrokerSeat(server, session)

  // `absent` means no live broker observation of this conversation. For a
  // desktop conversation, provisioning one IS the forbidden cold CLI
  // replacement, because the session row outlives every observer. Detachment is
  // also not evidence about the desktop process itself, so this is a wait, not
  // a verdict.
  if (desktopRegistration !== undefined && seat.state === 'absent') {
    deferDesktopDelivery(server, {
      targetSessionRef,
      registration: desktopRegistration,
      reason: 'observer_absent',
      envelopeIds: actionable.map((item) => item.envelope.id),
      detail: { wakeReason },
    })
    return
  }

  // For an ordinary seat, absent means there is no harness to submit into, so a
  // SUMMONING envelope takes the launch-carried door — the same one a target
  // with no session row takes. A session row is not a seat: it outlives every
  // runtime, so routing on the row is what sent this case to `enqueue`, where
  // the body was written into a harness still booting and lost the first turn
  // to the launch's own priming prompt (T-08394).
  //
  // A wake set holding ONLY non-summoning mail keeps the pre-existing path: it
  // falls through to `deliverToSeat`, which provisions a runtime for the session
  // row that already exists. That is not the birth §5 forbids — the session was
  // already minted, and the rule is that a fyi never mints one — and routing it
  // here instead silently stopped delivering fyi mail to driven targets with an
  // existing session and an absent broker (regression in 70e683c7, caught by
  // the T-07615 suite).
  if (seat.state === 'absent' && actionable.some((item) => summonsATurn(item.envelope))) {
    return await birthForTarget(server, targetSessionRef, scopeRef, actionable, wakeReason)
  }
  if (
    seat.state === 'unavailable' ||
    seat.state === 'starting' ||
    seat.state === 'stopping' ||
    seat.state === 'turn-observed'
  ) {
    server.log('INFO', 'wrkq.kicker.seat_not_ready', {
      targetSessionRef,
      wakeReason,
      observedSeatState: seat.state,
      envelopeIds: actionable.map((item) => item.envelope.id),
      ...(desktopRegistration === undefined ? {} : { desktopReservation: true }),
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
      ...(desktopRegistration === undefined ? {} : { desktopReservation: true }),
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
