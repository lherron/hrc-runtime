import { isQueuedAttempt } from './attempt-lifecycle.js'

export type DriveMailTargetOutcome =
  | { outcome: 'birth-refused'; driveAttemptId: string }
  | undefined

export async function driveMailTargetOnce(
  server: MailKickerContext,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason,
  /** Bounded re-entry for the claim race; see the `finished` branch below. */
  redriveDepth = 0
): Promise<DriveMailTargetOutcome> {
  // Placement first, before the drive slot, the ledger read, or the gate. A
  // scope homed on another node cannot be driven from here by any wake reason,
  // so claiming an attempt for it only manufactures the failure (T-07650).
  // A ref this daemon cannot parse gets no verdict and no new failure mode:
  // it falls through to the path that already reported that for what it is.
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  const foreign = scopeRef === undefined ? undefined : await server.resolveForeignHome(scopeRef)
  if (scopeRef !== undefined && foreign !== undefined) {
    skipForeignHomedTarget(server, targetSessionRef, scopeRef, foreign, wakeReason)
    return
  }

  let attempt = server.db.mailDrives.getActiveAttempt(targetSessionRef)
  // Held rather than returned on: the decline needs the pending set and the
  // session, and both are read below. See `declineForInFlightAttempt`.
  let inFlight: HrcMailDriveAttempt | undefined
  if (attempt !== undefined) {
    await replayHeldBatchReceipts(server, attempt)
    const observation = observeAttempt(server, attempt)
    if (observation === 'waiting') inFlight = attempt
    if (observation === 'finished') attempt = undefined
  }
  // Broker-submitted slot-less attempts hold no slot, so nothing above finds
  // them. HRC-held batches are intentionally excluded: no input exists yet and
  // only a boundary flush or local terminal-member drop may advance them.
  for (const queued of server.db.mailDrives.listUnfinishedAttempts(targetSessionRef)) {
    if (isQueuedAttempt(queued) && queued.state !== 'held') observeAttempt(server, queued)
  }

  let session = server.findTargetSession(targetSessionRef) ?? undefined
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
    // drive, which is a reason to do nothing, never a reason to guess.
    server.log(
      error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
      'wrkq.kicker.pending_view_failed',
      { targetSessionRef, wakeReason, error: errorText(error) }
    )
    return
  }
  const batch = isolatedDeliveryBatch(actionable)
  actionable = batch.selected
  if (batch.deferredCount > 0) {
    // The current target operation will observe this on its next drain-loop
    // iteration. No timer or polling is introduced; this preserves the same
    // wake while giving each hold its own admission decision.
    server.wake(targetSessionRef, wakeReason)
  }

  const seat =
    session === undefined
      ? ({ state: 'absent' } as const)
      : await observeBrokerSeat(server, session)

  if (inFlight !== undefined) {
    await declineForInFlightAttempt(
      server,
      targetSessionRef,
      inFlight,
      session,
      actionable,
      wakeReason,
      seat,
      { via: 'active-attempt', observation: 'waiting' }
    )
    return
  }

  if (attempt === undefined) {
    const held = server.db.mailDrives.getHeldAttempt(targetSessionRef)

    // A hold is an isolated interruption decision even when ordinary queue mail
    // is already waiting for a boundary. It never joins or flushes that batch.
    const selectedIsHold = actionable[0]?.envelope.delivery === 'hold'
    if (session !== undefined && seat.state === 'turn-active') {
      if (selectedIsHold) {
        await presentHoldIntoBusyTarget(
          server,
          targetSessionRef,
          session,
          seat.turnId,
          actionable,
          wakeReason
        )
      } else {
        holdQueueForBusyTarget(server, targetSessionRef, session, seat, actionable, wakeReason)
      }
      return
    }

    if (held !== undefined && !selectedIsHold) {
      if (session === undefined || !seatCanDispatch(seat)) {
        server.log('INFO', 'wrkq.kicker.queue_batch_boundary_wait', {
          targetSessionRef,
          driveAttemptId: held.driveAttemptId,
          wakeReason,
          observedSeatState: seat.state,
        })
        return
      }
      const prepared = await prepareHeldBatchForBoundary(
        server,
        targetSessionRef,
        session,
        held,
        actionable,
        wakeReason,
        (currentSession) => observeBrokerSeat(server, currentSession)
      )
      if (prepared === undefined) return
      attempt = prepared.attempt
      actionable = prepared.actionable
    } else if (session !== undefined && !seatCanDispatch(seat)) {
      server.log('INFO', 'wrkq.kicker.seat_not_dispatchable', {
        targetSessionRef,
        wakeReason,
        observedSeatState: seat.state,
      })
      return
    } else if (!selectedIsHold) {
      actionable = presentationBatch(actionable)
    }

    // A non-summoning envelope (a legacy `fyi`) is presented into a live
    // generation if there is one, and otherwise waits. It is never the reason a
    // session is born, so a wake set holding nothing else stops here rather
    // than at the summon gate. `notify` DOES summon (T-07746) and so never
    // reaches this return.
    if (session === undefined && !actionable.some((item) => summonsATurn(item.envelope))) return
    if (attempt === undefined) {
      const directives = actionableDirectives(actionable)
      const claim = server.db.mailDrives.claim(targetSessionRef, wakeReason, {
        envelopeIds: actionable.map((item) => item.envelope.id),
        ...(() => {
          const intent = server.resolveRuntimeIntent(
            parseSessionRef(targetSessionRef).scopeRef,
            directives
          )
          return intent === undefined ? {} : { materializationIntent: intent }
        })(),
      })
      if (claim.outcome === 'clear') return
      attempt = claim.attempt
      if (claim.outcome === 'active') {
        // The CLAIM race (T-07644 C-16642): `getActiveAttempt` saw no attempt at
        // the top of this function, and the claim CAS then found the slot already
        // held — two wakes racing for one scope. This tests the identical
        // condition as the top branch, so it must answer identically. It used to
        // be a bare `return` that subsumed BOTH live observations: `waiting`, the
        // very state this task exists to instrument, and `finished`, which the
        // top of this function deliberately treats as re-drivable.
        const observation = observeAttempt(server, attempt)
        if (observation === 'finished') {
          // `observeAttempt` has just completed it and released the slot, so the
          // wake is still live work rather than something to drop. Re-enter, the
          // way the top branch re-drives a finished attempt.
          //
          // Bounded at one: the second pass sees a released slot by construction,
          // and retrying a state that did not change is a spin, not a fix.
          if (redriveDepth > 0) {
            server.log('WARN', 'wrkq.kicker.claim_redrive_exhausted', {
              targetSessionRef,
              wakeReason,
              driveAttemptId: attempt.driveAttemptId,
            })
            return
          }
          return driveMailTargetOnce(server, targetSessionRef, wakeReason, redriveDepth + 1)
        }
        if (observation !== 'dispatch') {
          await declineForInFlightAttempt(
            server,
            targetSessionRef,
            attempt,
            session,
            actionable,
            wakeReason,
            seat,
            { via: 'claim', observation }
          )
          return
        }
      } else {
        try {
          await server.afterClaim?.(attempt)
        } catch (error) {
          const message = errorText(error)
          const attemptState = failDriveAfterThrow(server, attempt, message)
          server.log('WARN', 'wrkq.kicker.after_claim_failed', {
            targetSessionRef,
            driveAttemptId: attempt.driveAttemptId,
            runId: attempt.runId,
            attemptState,
            error: message,
          })
          return
        }
      }
    }
  }

  // T-07671: the drive is now committed — the slot is held and this daemon owns
  // it. Every later outcome (presented, dispatched, no-op, failed) carries the
  // same `driveAttemptId`, so this line is the head of a timeline that
  // `grep <scope>` reconstructs without opening `state.sqlite`. It is emitted
  // for a re-driven pre-existing attempt as well as a fresh claim, because the
  // question it answers — "did this daemon start driving this mail at all" —
  // is the same one in both shapes.
  server.log('INFO', 'wrkq.kicker.drive_claimed', {
    targetSessionRef,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    wakeReason,
    envelopeIds: actionable.map((item) => item.envelope.id),
    // Whether a seat already existed, and what it was doing. A drive that has
    // to summon first behaves nothing like one into a live seat, and the two
    // were previously indistinguishable in the log.
    seated: session !== undefined,
    ...(session === undefined ? {} : { activeRunId: activeRunIdFor(server, session) }),
  })

  let birthAttempted = false
  let birthEstablished = false
  try {
    // T-07206: session intent is reusable authority because fresh broker starts
    // commit it only after controller.start succeeds; rejected candidates never
    // outrank the drive's own materialization intent here.
    const materializationIntent = session?.lastAppliedIntentJson ?? attempt.materializationIntent
    if (materializationIntent === undefined) {
      // Placement is HRC's, so a missing intent means this node could not find
      // the target agent's profile — not that the sender forgot something.
      //
      // The attempt must be FINISHED, not merely annotated. `recordError` alone
      // leaves it `claimed`, and a claimed attempt owns the scope's slot: the
      // target is then permanently undrivable by this daemon, silently, for as
      // long as the row exists. Observed live — a smoketest scope this node
      // cannot place held its slot for 80 minutes.
      const reason = `no runtime intent for ${targetSessionRef}: this node cannot resolve the agent's placement`
      server.db.mailDrives.failWithoutStart(attempt.driveAttemptId, reason)
      server.log('WARN', 'wrkq.kicker.placement_unresolvable', {
        targetSessionRef,
        driveAttemptId: attempt.driveAttemptId,
        wakeReason,
      })
      return
    }

    if (session === undefined) {
      // This is the only message-traffic provisioning path. ensureTargetSession
      // enters the normal summon/placement gate before it mints anything, so a
      // scope this node does not home is refused here rather than pre-filtered.
      birthAttempted = true
      session = await server.ensureTargetSession(
        targetSessionRef,
        materializationIntent,
        // The drive carries this candidate explicitly until dispatch succeeds.
        // A rejected cold birth must leave no never-materialized session authority.
        { persistIntent: false }
      )
      birthEstablished = true
    }
    const runtimeId = presentationRuntimeIdFor(server, session)
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId,
    })

    // The local receipt is written FIRST, then the ledger is told with the same
    // attempt id. A kill in between replays into an exactly-once `present`.
    const envelopeIds = server.db.mailDrives.presentForAttempt(
      attempt.driveAttemptId,
      actionable.map((item) => item.envelope.id)
    )
    if (envelopeIds.length === 0) {
      server.db.mailDrives.completeNoOp(attempt.driveAttemptId)
      // T-07671: an attempt that ends here wrote no receipts and dispatched no
      // turn. Silent, it is indistinguishable from a kicker that never ran.
      server.log('WARN', 'wrkq.kicker.drive_no_op', {
        targetSessionRef,
        driveAttemptId: attempt.driveAttemptId,
        runId: attempt.runId,
        wakeReason,
        reason: 'already_presented',
        envelopeIds: actionable.map((item) => item.envelope.id),
        note: 'this attempt had already recorded its presentations; no turn dispatched',
      })
      return
    }

    const byId = new Map(actionable.map((item) => [item.envelope.id, item]))
    const ordered = envelopeIds
      .map((id) => byId.get(id))
      .filter((item): item is ActionableEnvelope => item !== undefined)
    const presentables = await recordPresentations(server, ordered, attempt, session, runtimeId)
    const { prompt, autoReplyCandidate } = composePresentation(ordered, presentables)
    server.db.mailDrives.recordPresentation(attempt.driveAttemptId, prompt, presentables.length)
    server.db.mailDrives.recordAutoReplyCandidate(attempt.driveAttemptId, autoReplyCandidate)
    attempt = server.db.mailDrives.getAttempt(attempt.driveAttemptId) ?? attempt

    const body = await server.dispatchTurn(
      session,
      session.lastAppliedIntentJson ?? materializationIntent,
      attempt.prompt,
      {
        runId: attempt.runId,
        waitForCompletion: false,
        submissionDoor: 'enqueue',
        ttlMs: KICKER_SUBMISSION_TTL_MS,
        submissionOrigin: {
          principalRef: ordered[0]?.envelope.from.principalRef ?? 'system:hrc-kicker',
          ...(ordered[0]?.envelope.from.scopeRef === undefined
            ? {}
            : { scopeRef: ordered[0].envelope.from.scopeRef }),
          ...(ordered[0] === undefined ? {} : { envelopeId: ordered[0].envelope.id }),
        },
        // A summons that finds no broker seat is the first user turn of a
        // launch-primed interactive birth. The interactive route verifies the
        // selected profile before putting it on launch; every other route
        // ignores this hint and keeps promptless boot + broker admission.
        launchPromptOnColdBirth: seat.state === 'absent',
        // An idle seat has nothing to preempt; even a stored hold starts by enqueue.
      }
    )
    const inputId = body.inputId ?? server.db.runs.getByRunId(body.runId)?.dispatchedInputId
    // T-07693: `inputId` is optional on the receipt contract — "when the
    // delivery class has one" — and a COLD birth's class has none: the prompt
    // rides the runtime's `initialPrompt`, so there is no invocation input to
    // name. Requiring one here booked every cold ledger-tail birth as
    // `drive_failed` (15 of 15 in the live log, all `wakeReason:"insert"`),
    // which released the drive slot and left the envelope pending for the next
    // wake to redeliver — the second wake that then raced the birth (T-07688).
    // A started turn is a started turn; only the STATUS is load-bearing.
    if (body.status !== 'started') {
      throw new Error(`mail dispatch did not start a turn (status=${body.status})`)
    }
    const committedRuntimeId =
      body.runtimeId ?? presentationRuntimeIdFor(server, session) ?? runtimeId
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: body.hostSessionId,
      generation: body.generation,
      runtimeId: committedRuntimeId,
    })
    server.log('INFO', 'wrkq.kicker.turn_dispatched', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      presentedCount: presentables.length,
      // T-07671: WHICH envelopes rode this turn, and WHERE it landed. A count
      // cannot answer "was EN-00823 delivered", and without the seat identity
      // the dispatch cannot be joined to the ledger's own receipt.
      envelopeIds: presentables.map((presentable) => presentable.envelope.id),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
      inputId,
      wakeReason,
    })
    await commitPresentations(server, presentables, attempt, session, committedRuntimeId, inputId)
    // The reminder is bound to the attempt that carried it: D5 reads this row
    // back when that attempt's own turn ends, and it is what stops a second
    // reminder ever being armed for the same (envelope, runtime).
    for (const item of ordered) {
      if (item.reminder === undefined) continue
      server.db.mailDrives.markReminderDelivered(
        item.reminder.envelopeId,
        item.reminder.runtimeId,
        attempt.driveAttemptId
      )
    }
    // T-07671: this line belongs at COMMIT, where the ledger now holds the
    // receipt. `inputId` joins it to the broker's input.accepted event.
    server.log('INFO', 'wrkq.kicker.presented', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      inputId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      ...(committedRuntimeId === undefined ? {} : { runtimeId: committedRuntimeId }),
      envelopes: presentables.map((presentable) => ({
        id: presentable.envelope.id,
        obligation: presentable.envelope.obligation,
        form: presentable.form ?? 'full',
      })),
    })
    observeAttempt(server, attempt)
  } catch (error) {
    // A birth deferral is not a failed drive. It is this node correctly
    // declining to take a birth the collective designated elsewhere, and
    // reporting it as `drive_failed` is precisely what made the pre-T-07655
    // race look like breakage on every node that lost it.
    const deferral = birthDeferralFor(error)
    if (deferral !== undefined && scopeRef !== undefined) {
      deferBirthForTarget(server, targetSessionRef, scopeRef, attempt, deferral, wakeReason)
      return
    }
    const message = errorText(error)
    const attemptState = failDriveAfterThrow(server, attempt, message)
    server.log('WARN', 'wrkq.kicker.drive_failed', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      wakeReason,
      attemptState,
      error: message,
    })
    const failed = server.db.mailDrives.getAttempt(attempt.driveAttemptId)
    if (
      birthAttempted &&
      !birthEstablished &&
      failed?.state === 'failed' &&
      failed.hostSessionId === undefined
    ) {
      return { outcome: 'birth-refused', driveAttemptId: failed.driveAttemptId }
    }
  }
}
import type { HrcMailDriveAttempt, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { KICKER_SUBMISSION_TTL_MS, errorText, parseSessionRef } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { deliverFailureNotices } from '../terminal/failure-notices.js'
import { activeRunIdFor, observeAttempt, observeBrokerSeat } from './attempt-lifecycle.js'
import {
  birthDeferralFor,
  deferBirthForTarget,
  failDriveAfterThrow,
  kickerScopeRefFor,
  presentationRuntimeIdFor,
  skipForeignHomedTarget,
} from './authority.js'
import {
  prepareHeldBatchForBoundary,
  replayHeldBatchReceipts,
  seatCanDispatch,
} from './held-batch-flush.js'
import { holdQueueForBusyTarget } from './held-batch.js'
import { declineForInFlightAttempt, presentHoldIntoBusyTarget } from './live-seat-delivery.js'
import type { ActionableEnvelope } from './presentation.js'
import {
  actionableDirectives,
  commitPresentations,
  composePresentation,
  isolatedDeliveryBatch,
  presentationBatch,
  readActionableEnvelopes,
  recordPresentations,
  summonsATurn,
} from './presentation.js'
