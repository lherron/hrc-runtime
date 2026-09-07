/**
 * One envelope, one submission, write-ahead (spec T-08092 rev 4, D2).
 *
 * Every door — steer, enqueue, preempt, invoke, launch — returns ADMISSION and
 * nothing else; the body is applied asynchronously and the landing is reported
 * later on the committed broker stream. Delivery is therefore ordered so that
 * no landing can precede HRC's own record of having tried:
 *
 *   1. commit the INTENT (envelope, target, door, form, presentation id, seq);
 *   2. call the door, carrying `origin.envelopeId` so the envelope-to-submission
 *      join is reconstructable from the broker's own admission record;
 *   3. fill in what the admission response reported.
 *
 * A crash anywhere in there leaves durable intent rather than nothing, and an
 * envelope with an open intent is never actionable — so the worst case is one
 * reconcile, never a second delivery. Nothing here writes a wrkq receipt: that
 * is `landing.ts`, and only a landing fact earns one.
 */
import { randomUUID } from 'node:crypto'

import type { HrcSessionRecord, PreemptSubmissionRequest } from 'hrc-core'
import type { HrcMailDeliveryDoor, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { KICKER_SUBMISSION_TTL_MS, errorText, parseSessionRef } from '../internal.js'
import { formatEnvelopePresentations } from '../ledger/presentation.js'
import type { PresentableEnvelope } from '../ledger/presentation.js'
import { presentationRuntimeIdFor } from './authority.js'
import { landLaunchIfStarted } from './landing.js'
import type { ActionableEnvelope } from './presentation.js'
import { actionableDirectives, senderGenerationFor } from './presentation.js'
import type { ObservedBrokerSeat } from './seat.js'

export type DeliveryOutcome = 'submitted' | 'refused' | 'skipped'

/**
 * Which door this envelope takes, given what the seat is doing.
 *
 * A stored `hold` is an interruption request and owns its own admission
 * decision; refused authority falls through to the ordinary policy and the
 * eventual receipt says `hold_refused_authority`. Everything else is the rev 4
 * routing rule: steer into a live turn when the driver accepts steering, queue
 * at the boundary when it does not, and enqueue into an idle seat as before.
 */
type SeatDoor = Extract<HrcMailDeliveryDoor, 'steer' | 'enqueue' | 'preempt'>

function doorFor(
  server: MailKickerContext,
  seat: ObservedBrokerSeat,
  isHold: boolean,
  preemptAuthorized: boolean
): { door: SeatDoor; deliveryOutcome?: string | undefined } {
  if (isHold && preemptAuthorized) return { door: 'preempt' }
  if (
    seat.state === 'turn-active' &&
    seat.steerCapable &&
    !server.mailKickerSteerRefused.has(seat.runtimeId)
  ) {
    return isHold ? { door: 'steer', deliveryOutcome: 'hold_refused_authority' } : { door: 'steer' }
  }
  return isHold
    ? { door: 'enqueue', deliveryOutcome: 'hold_refused_authority' }
    : { door: 'enqueue' }
}

/** Compose the body wrkq would show for one envelope, writing no receipt. */
async function previewPresentation(
  server: MailKickerContext,
  item: ActionableEnvelope,
  session: HrcSessionRecord,
  runtimeId: string | undefined
): Promise<PresentableEnvelope> {
  const result = await server.ledger.present({
    envelope: item.envelope.id,
    preview: true,
    node: server.nodeId,
    hostSessionId: session.hostSessionId,
    generation: String(session.generation),
    ...(runtimeId === undefined ? {} : { runtimeId }),
  })
  return {
    envelope: result.envelope,
    delivery: result.envelope.delivery,
    // A pointer form carries no body and therefore no history cue: the cue
    // exists to orient a cold reader at first contact, and every pointer goes
    // to a reader who has already had one.
    historyHint: item.form === 'full' && result.historyHint,
    messageCount: result.messageCount,
    ...(result.lastMessageAt === undefined ? {} : { lastMessageAt: result.lastMessageAt }),
    form: item.form,
    ...(item.presentation?.turnEndedAt === undefined
      ? {}
      : { turnEndedAt: item.presentation.turnEndedAt }),
    ...senderGenerationFor(server, result.envelope),
  }
}

function originFor(item: ActionableEnvelope) {
  return {
    principalRef: item.envelope.from.principalRef,
    ...(item.envelope.from.scopeRef === undefined ? {} : { scopeRef: item.envelope.from.scopeRef }),
    envelopeId: item.envelope.id,
  }
}

/**
 * Deliver ONE envelope into a seat that already exists.
 *
 * Returns `skipped` when another wake already holds this envelope's intent —
 * the primary key refusing a second submission is the whole fence — and
 * `refused` when the door itself would not take it, which leaves the envelope
 * exactly as pending as it was for the next pass.
 */
export async function deliverToSeat(
  server: MailKickerContext,
  targetSessionRef: string,
  session: HrcSessionRecord,
  seat: ObservedBrokerSeat,
  item: ActionableEnvelope,
  wakeReason: HrcMailDriveWakeReason
): Promise<DeliveryOutcome> {
  const runtimeId =
    seat.state === 'absent' ? presentationRuntimeIdFor(server, session) : seat.runtimeId
  const isHold = item.envelope.delivery === 'hold'

  const intentDoorAndOutcome = doorFor(server, seat, isHold, false)
  let door: SeatDoor = intentDoorAndOutcome.door
  let deliveryOutcome = intentDoorAndOutcome.deliveryOutcome

  const runtimeIntent =
    session.lastAppliedIntentJson ??
    server.resolveRuntimeIntent(
      parseSessionRef(targetSessionRef).scopeRef,
      actionableDirectives([item])
    )
  if (runtimeIntent === undefined) {
    server.log('WARN', 'wrkq.kicker.delivery_unavailable', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      reason: 'no_runtime_intent_available',
    })
    return 'refused'
  }

  let presentable: PresentableEnvelope
  try {
    presentable = await previewPresentation(server, item, session, runtimeId)
  } catch (error) {
    server.log('WARN', 'wrkq.kicker.presentation_preview_failed', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      error: errorText(error),
    })
    return 'refused'
  }
  const prompt = formatEnvelopePresentations([presentable])

  // A hold's authority is asked BEFORE the intent is written, because the
  // answer decides which door the intent will name.
  if (isHold) {
    const request: PreemptSubmissionRequest = {
      target: targetSessionRef,
      body: prompt,
      origin: originFor(item),
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      turnPolicy: 'guarded',
    }
    if (await server.preemptAuthorized(session, request)) {
      door = 'preempt'
      deliveryOutcome = undefined
    }
  }

  const presentationId = `present-${randomUUID()}`
  const runtime = runtimeId === undefined ? undefined : server.db.runtimes.getByRuntimeId(runtimeId)
  const invocationId = runtime?.activeInvocationId
  const intent = server.db.mailDelivery.openIntent({
    envelopeId: item.envelope.id,
    targetSessionRef,
    door,
    form: item.form,
    presentationId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(deliveryOutcome === undefined ? {} : { deliveryOutcome }),
    submittedHrcSeq: server.db.hrcEvents.maxHrcSeq(),
    ...(invocationId === undefined
      ? {}
      : {
          invocationId,
          brokerAfterSeq: server.db.brokerInvocationEvents.maxBrokerSeq(invocationId),
        }),
  })
  if (intent === undefined) return 'skipped'

  server.log('INFO', 'wrkq.kicker.delivery_intent', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door,
    form: item.form,
    presentationId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    observedSeatState: seat.state,
    ...(seat.state === 'turn-active'
      ? { turnId: seat.turnId, steerCapable: seat.steerCapable }
      : {}),
  })

  let body: Awaited<ReturnType<MailKickerContext['dispatchTurn']>>
  try {
    body = await server.dispatchTurn(session, runtimeIntent, prompt, {
      waitForCompletion: false,
      submissionDoor: door,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      ...(door === 'preempt' ? { turnPolicy: 'guarded' as const } : {}),
      submissionOrigin: originFor(item),
    })
  } catch (error) {
    // A thrown RPC is not positive proof that the broker did not write.  Keep
    // the pre-minted intent as the no-second-body fence; a later receipt may
    // still arrive for this exact presentation.
    server.db.mailDelivery.markUncertain(item.envelope.id, 'dispatch_error', 'dispatch_error')
    server.log('WARN', 'wrkq.kicker.delivery_failed', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      door,
      error: errorText(error),
    })
    return 'refused'
  }

  const submissionId = body.submissionId ?? body.inputId
  if (body.admission === 'rejected') {
    server.db.mailDelivery.clearIntent(item.envelope.id)
    server.log('WARN', 'wrkq.kicker.landing_refused', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      door,
      reason: body.reason ?? 'no_submission_identity',
      phase: 'admission',
    })
    return 'refused'
  }
  if (submissionId === undefined) {
    server.db.mailDelivery.markUncertain(
      item.envelope.id,
      'missing_submission_identity',
      'admission_response'
    )
    return 'submitted'
  }

  server.db.mailDelivery.attachAdmission(item.envelope.id, {
    submissionId,
    ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
    hostSessionId: body.hostSessionId,
    generation: body.generation,
  })
  server.log('INFO', 'wrkq.kicker.delivery_admitted', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door,
    submissionId,
    ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
  })
  return 'submitted'
}

/**
 * Deliver ONE envelope by BIRTHING the seat (the launch-carried path).
 *
 * This is the one path where the body is not a submission: HRC places it in
 * `spec.launch.initialPrompt` and the born runtime's first turn IS the delivery
 * (`harness-broker-admission-client`). Its landing fact is that runtime's first
 * `turn.started`, which `landing.ts` observes. One launch carries one envelope;
 * further pending mail for the seat is delivered by policy once it is live.
 *
 * The intent is committed before `ensureTargetSession`, so a birth that
 * succeeds and a daemon that dies before recording it are reconciled against
 * the launch this node durably made rather than guessed at.
 */
export async function deliverByColdBirth(
  server: MailKickerContext,
  targetSessionRef: string,
  item: ActionableEnvelope,
  wakeReason: HrcMailDriveWakeReason
): Promise<DeliveryOutcome | 'birth-refused'> {
  const scopeRef = parseSessionRef(targetSessionRef).scopeRef
  const runtimeIntent = server.resolveRuntimeIntent(scopeRef, actionableDirectives([item]))
  if (runtimeIntent === undefined) {
    // Placement is HRC's, so a missing intent means this node could not find
    // the target agent's profile — not that the sender forgot something.
    server.log('WARN', 'wrkq.kicker.placement_unresolvable', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
    })
    return 'refused'
  }

  const presentationId = `present-${randomUUID()}`
  const intent = server.db.mailDelivery.openIntent({
    envelopeId: item.envelope.id,
    targetSessionRef,
    door: 'launch',
    form: item.form,
    presentationId,
    submittedHrcSeq: server.db.hrcEvents.maxHrcSeq(),
  })
  if (intent === undefined) return 'skipped'

  server.log('INFO', 'wrkq.kicker.delivery_intent', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door: 'launch',
    form: item.form,
    presentationId,
    observedSeatState: 'absent',
  })

  let session: HrcSessionRecord
  try {
    // The only message-traffic provisioning path. `ensureTargetSession` enters
    // the normal summon/placement gate before it mints anything, so a scope
    // this node does not home is refused here rather than pre-filtered.
    session = await server.ensureTargetSession(targetSessionRef, runtimeIntent, {
      persistIntent: false,
    })
    // The seat exists, so this node no longer owes the birth. Left open, the
    // refusal keeps the scope in every later sweep's candidate set for nothing.
    server.db.mailDelivery.resolveBirthRefusal(targetSessionRef, 'birth established')
  } catch (error) {
    server.db.mailDelivery.clearIntent(item.envelope.id)
    throw error
  }

  let presentable: PresentableEnvelope
  try {
    presentable = await previewPresentation(
      server,
      item,
      session,
      presentationRuntimeIdFor(server, session)
    )
  } catch (error) {
    server.db.mailDelivery.clearIntent(item.envelope.id)
    server.log('WARN', 'wrkq.kicker.presentation_preview_failed', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      error: errorText(error),
    })
    return 'refused'
  }

  let body: Awaited<ReturnType<MailKickerContext['dispatchTurn']>>
  try {
    body = await server.dispatchTurn(
      session,
      session.lastAppliedIntentJson ?? runtimeIntent,
      formatEnvelopePresentations([presentable]),
      {
        waitForCompletion: false,
        // The spec's cold-birth door. `invoke` is also what marks the run as
        // having supplied the launch prompt, which is how the event mapper
        // attributes the born runtime's first input-less bracket to it.
        submissionDoor: 'invoke',
        ttlMs: KICKER_SUBMISSION_TTL_MS,
        submissionOrigin: originFor(item),
        // A summons that finds no broker seat is the first user turn of a
        // launch-primed interactive birth. The interactive route verifies the
        // selected profile before putting it on launch; every other route
        // ignores this hint and keeps promptless boot + broker admission.
        launchPromptOnColdBirth: true,
      }
    )
  } catch (error) {
    // The invoke/launch RPC may have reached the provider before its response
    // was lost. It is an uncertain delivery, never a new birth opportunity.
    server.db.mailDelivery.markUncertain(item.envelope.id, 'dispatch_error', 'dispatch_error')
    throw error
  }

  const runtimeId = body.runtimeId ?? presentationRuntimeIdFor(server, session)
  const submissionId = body.submissionId ?? body.inputId
  if (submissionId === undefined) {
    // T-07693: a cold birth's delivery class has NO invocation input — the
    // prompt rides the runtime's `initialPrompt`. Its landing fact is the born
    // runtime's first turn start, not a submission disposition.
    server.db.mailDelivery.attachAdmission(item.envelope.id, {
      door: 'launch',
      ...(runtimeId === undefined ? {} : { runtimeId }),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
    })
    server.log('INFO', 'wrkq.kicker.launch_carried', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
    })
    // The born runtime's first turn commonly starts DURING the launch, before
    // this intent knew which runtime the launch produced — so the live observer
    // saw a turn start with no intent to match. Check once here, where the
    // correlation finally exists.
    const current = server.db.mailDelivery.getIntent(item.envelope.id)
    if (current !== undefined) await landLaunchIfStarted(server, current)
    return 'submitted'
  }

  // The birth admitted an ordinary submission instead: this is an invoke, and
  // its landing is a submission disposition like any other door's.
  server.db.mailDelivery.attachAdmission(item.envelope.id, {
    door: 'invoke',
    submissionId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    hostSessionId: body.hostSessionId,
    generation: body.generation,
  })
  server.log('INFO', 'wrkq.kicker.delivery_admitted', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door: 'invoke',
    submissionId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
  })
  return 'submitted'
}
