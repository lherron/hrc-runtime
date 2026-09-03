/**
 * Present one isolated HOLD into an observed active turn.
 *
 * T-07891 moved ordinary queue mail out of this path: HRC durably coalesces it
 * until a terminal turn event establishes the next boundary. A stored hold is
 * still an interruption request, is never batched, and takes this immediate
 * guarded-preempt path (or its isolated authority-refused enqueue fallback).
 */
import type { DispatchTurnResponse, HrcSessionRecord, PreemptSubmissionRequest } from 'hrc-core'
import type { HrcMailDriveAttempt, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { KICKER_SUBMISSION_TTL_MS, errorText, parseSessionRef } from '../internal.js'
import type { PresentableEnvelope } from '../ledger/presentation.js'
import type { AttemptObservation } from './attempt-lifecycle.js'
import { isQueuedAttempt } from './attempt-lifecycle.js'
import { presentationRuntimeIdFor } from './authority.js'
import type { ObservedBrokerSeat } from './held-batch-flush.js'
import { holdQueueForBusyTarget } from './held-batch.js'
import type { ActionableEnvelope } from './presentation.js'
import { actionableDirectives, composePresentation, senderGenerationFor } from './presentation.js'

type InFlightDeclineRoute = 'active-attempt' | 'claim'

export async function presentHoldIntoBusyTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  session: HrcSessionRecord,
  activeTurnId: string,
  actionable: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason
): Promise<boolean> {
  const activeRunId = activeTurnId
  // The duplicate guard covers exactly the dispatch→commit window and nothing
  // more. An ordinary drive writes its LOCAL receipt before it dispatches and
  // commits the LEDGER receipt only after the broker accepts (T-07672); a wake
  // landing inside that window would re-present the same mail into the same
  // turn. Once the ledger receipt exists the envelope is `presented` and D2
  // takes it out of the wake set entirely: an input the harness merged and
  // never started is not re-queued by anything, and is bounded by D3 instead
  // (rev 5.1 D2/D5 replacing rev 4 ruling 4).
  //
  // And the window always CLOSES (ruling 5): a local receipt whose ledger
  // receipt is missing is replayed here, exactly as an ordinary drive replays
  // after a kill between persisting and dispatching (T-07615) — `present` is
  // exactly-once per driveAttemptId, and a `queued-` attempt exists only after
  // the broker accepted, so the replay claims nothing that did not happen.
  const uncommitted = new Set<string>()
  for (const unfinished of server.db.mailDrives.listUnfinishedAttempts(targetSessionRef)) {
    if (unfinished.state === 'held') continue
    if (!isQueuedAttempt(unfinished)) {
      // An ordinary drive commits its own receipts right after its dispatch;
      // its window is the few ms in between, and it is not replayed here.
      for (const id of server.db.mailDrives.presentationEnvelopeIds(unfinished.driveAttemptId)) {
        const envelope = actionable.find((candidate) => candidate.envelope.id === id)?.envelope
        const committed = envelope?.presentedTo.some(
          (receipt) => receipt.driveAttemptId === unfinished.driveAttemptId
        )
        if (committed !== true) uncommitted.add(id)
      }
      continue
    }
    for (const id of server.db.mailDrives.presentationEnvelopeIds(unfinished.driveAttemptId)) {
      const envelope = actionable.find((candidate) => candidate.envelope.id === id)?.envelope
      if (envelope === undefined) continue
      const committed = envelope.presentedTo.some(
        (receipt) => receipt.driveAttemptId === unfinished.driveAttemptId
      )
      if (committed) continue
      try {
        await server.ledger.present({
          envelope: id,
          node: server.nodeId,
          ...(unfinished.hostSessionId === undefined
            ? {}
            : { hostSessionId: unfinished.hostSessionId }),
          ...(unfinished.generation === undefined
            ? {}
            : { generation: String(unfinished.generation) }),
          driveAttemptId: unfinished.driveAttemptId,
          deliveryOutcome: 'queued_to_live_harness',
          runId: unfinished.runId,
          ...(() => {
            const dispatched = server.db.runs.getByRunId(unfinished.runId)?.dispatchedInputId
            return dispatched === undefined ? {} : { inputId: dispatched }
          })(),
          ...(unfinished.runtimeId === undefined ? {} : { runtimeId: unfinished.runtimeId }),
        })
        server.log('INFO', 'wrkq.kicker.queued_receipt_replayed', {
          targetSessionRef,
          driveAttemptId: unfinished.driveAttemptId,
          runId: unfinished.runId,
          envelope: id,
        })
        // Committed now, so the envelope is `presented` and bound to that
        // runtime: D2 takes it out of every later wake set, this one included.
        uncommitted.add(id)
      } catch (error) {
        server.log('WARN', 'wrkq.kicker.queued_receipt_replay_failed', {
          targetSessionRef,
          driveAttemptId: unfinished.driveAttemptId,
          envelope: id,
          error: errorText(error),
        })
        uncommitted.add(id)
      }
    }
  }
  const envelopes = actionable.filter(
    (item) =>
      !uncommitted.has(item.envelope.id) &&
      // Already handed to this very turn: saying it twice into one turn is noise.
      !item.envelope.presentedTo.some((receipt) => receipt.runId === activeRunId)
  )
  if (envelopes.length === 0) return false

  const intent =
    session.lastAppliedIntentJson ??
    server.resolveRuntimeIntent(
      parseSessionRef(targetSessionRef).scopeRef,
      actionableDirectives(envelopes)
    )
  if (intent === undefined) {
    server.log('WARN', 'wrkq.kicker.busy_delivery_unavailable', {
      targetSessionRef,
      wakeReason,
      reason: 'no_runtime_intent_available',
      envelopes: envelopes.map((item) => item.envelope.id),
    })
    return false
  }

  const presentables: PresentableEnvelope[] = []
  for (const item of envelopes) {
    presentables.push({
      envelope: item.envelope,
      delivery: item.envelope.delivery,
      historyHint: false,
      messageCount: 0,
      form: item.form,
      ...(item.reminder === undefined ? {} : { turnEndedAt: item.reminder.turnEndedAt }),
      ...senderGenerationFor(server, item.envelope),
    })
  }
  const { prompt, autoReplyCandidate } = composePresentation(envelopes, presentables)

  const firstEnvelope = envelopes[0]?.envelope
  const origin = {
    principalRef: firstEnvelope?.from.principalRef ?? 'system:hrc-kicker',
    ...(firstEnvelope?.from.scopeRef === undefined
      ? {}
      : { scopeRef: firstEnvelope.from.scopeRef }),
    ...(firstEnvelope === undefined ? {} : { envelopeId: firstEnvelope.id }),
  }
  let submissionDoor: 'enqueue' | 'preempt' = 'enqueue'
  let holdRefusedAuthority = false
  if (firstEnvelope?.delivery === 'hold') {
    const request: PreemptSubmissionRequest = {
      target: targetSessionRef,
      body: prompt,
      origin,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      turnPolicy: 'guarded',
    }
    if (await server.preemptAuthorized(session, request)) {
      submissionDoor = 'preempt'
    } else {
      holdRefusedAuthority = true
    }
  }

  let body: DispatchTurnResponse & { inputId?: string | undefined }
  try {
    body = await server.dispatchTurn(session, intent, prompt, {
      waitForCompletion: false,
      submissionDoor,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      ...(submissionDoor === 'preempt' ? { turnPolicy: 'guarded' as const } : {}),
      submissionOrigin: origin,
    })
    if (body.status !== 'started') {
      throw new Error(`busy delivery did not start (status=${body.status})`)
    }
  } catch (error) {
    // Nothing honest can be claimed, so nothing is recorded and the envelope
    // stays exactly as pending as it was; the next wake retries.
    server.log('WARN', 'wrkq.kicker.busy_delivery_failed', {
      targetSessionRef,
      wakeReason,
      activeRunId,
      envelopes: envelopes.map((item) => item.envelope.id),
      error: errorText(error),
    })
    return false
  }

  const inputId = body.inputId ?? server.db.runs.getByRunId(body.runId)?.dispatchedInputId
  const runtimeId = body.runtimeId ?? presentationRuntimeIdFor(server, session)
  // The round-completing owner (rev 4): an attempt of its own, owned by the
  // queued input's run and queued behind the holder's, holding no slot. Local
  // receipt first, then the ledger with the same attempt id (the T-07615
  // ordering that survives a kill in between).
  const queuedAttempt = server.db.mailDrives.insertQueuedAttempt({
    targetSessionRef,
    runId: body.runId,
    wakeReason,
    prompt,
    envelopeIds: envelopes.map((item) => item.envelope.id),
    queuedBehindRunId: activeTurnId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(autoReplyCandidate === undefined ? {} : { autoReplyCandidate }),
  })
  for (const item of envelopes) {
    await server.ledger.present({
      envelope: item.envelope.id,
      node: server.nodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      driveAttemptId: queuedAttempt.driveAttemptId,
      // The outcome CLASS goes on the RECEIPT, not only on the log line
      // (C-16526, re-ruled on T-07644 C-16658): a log rotates and is grepped
      // from one node; the receipt travels with the envelope.
      deliveryOutcome: holdRefusedAuthority
        ? 'hold_refused_authority'
        : item.form === 'full'
          ? (body.delivery?.code ??
            (submissionDoor === 'preempt' ? 'preempted_live_harness' : 'queued_to_live_harness'))
          : `${item.form}_queued_to_live_harness`,
      runId: body.runId,
      ...(inputId === undefined ? {} : { inputId }),
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
    if (item.reminder !== undefined) {
      server.db.mailDrives.markReminderDelivered(
        item.reminder.envelopeId,
        item.reminder.runtimeId,
        queuedAttempt.driveAttemptId
      )
    }
  }

  server.log('INFO', 'wrkq.kicker.queued_into_busy_target', {
    targetSessionRef,
    wakeReason,
    driveAttemptId: queuedAttempt.driveAttemptId,
    activeRunId,
    runId: body.runId,
    ...(inputId === undefined ? {} : { inputId }),
    queuedBehindTurnId: activeTurnId,
    envelopes: envelopes.map((item) => item.envelope.id),
    forms: envelopes.map((item) => item.form),
    submissionDoor,
    ...(holdRefusedAuthority ? { deliveryOutcome: 'hold_refused_authority' } : {}),
  })
  return true
}

/**
 * The scope's drive slot is held by a kicker attempt that has not finished yet
 * (T-07644).
 *
 * The SLOT is declined — claiming a second one for a scope already mid-drive
 * would double-drive it. Since T-07891, queue-class MAIL joins one durable
 * HRC-held batch and waits for the broker-observed terminal boundary; it does
 * not enter the live harness. A hold/preempt stays an isolated immediate
 * admission decision and never joins that batch.
 *
 * And it LOGS, unconditionally. The instrumented fall-through below already
 * carries the reason — a silent decline is indistinguishable from a dead kicker
 * — and that lesson shipped directly above a bare unlogged return that declined
 * for a different reason.
 *
 * The kind is `drive_in_flight` and deliberately NOT `target_busy` (mable,
 * T-07644 C-16626). They are different conditions — "a drive is already in
 * flight for this target" versus "the addressee is mid-turn on its own run" —
 * and merging them would destroy the meaning of the counter that ended four
 * wrong root causes. The payload is the reduced one for the same reason: what
 * this line has to name is the attempt holding the slot, because the state it
 * reports can WEDGE. An attempt whose run never reaches a terminal event stays
 * `started` forever, and until this line existed the scope simply went quiet.
 */
export async function declineForInFlightAttempt(
  server: MailKickerContext,
  targetSessionRef: string,
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord | undefined,
  actionable: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason,
  seat: ObservedBrokerSeat,
  route: { via: InFlightDeclineRoute; observation: AttemptObservation }
): Promise<void> {
  // The run row explains why the scope slot is occupied; it never decides
  // whether the seat is busy. Only the broker-observed turn state may do that.
  const delivered =
    session === undefined || seat.state !== 'turn-active'
      ? false
      : actionable[0]?.envelope.delivery === 'hold'
        ? await presentHoldIntoBusyTarget(
            server,
            targetSessionRef,
            session,
            seat.turnId,
            actionable,
            wakeReason
          )
        : holdQueueForBusyTarget(server, targetSessionRef, session, seat, actionable, wakeReason)
  server.log('INFO', 'wrkq.kicker.drive_in_flight', {
    ...(delivered ? { heldOrPreemptedDelivery: true } : {}),
    targetSessionRef,
    wakeReason,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    // Which route found the attempt, and what it observed. Without these the
    // line reproduces one level down the ambiguity it exists to remove: two
    // branches decline for the same reason and a single counter cannot say
    // which, nor tell a `waiting` decline from a `finished` one.
    via: route.via,
    observation: route.observation,
    // T-07671: WHICH envelopes are held behind the in-flight attempt, not just
    // how many. A wedged attempt is reconstructed from the log alone only if
    // the line names the mail that is stuck behind it.
    envelopeIds: actionable.map((item) => item.envelope.id),
    observedSeatState: seat.state,
    ...(seat.state === 'turn-active' ? { observedTurnId: seat.turnId } : {}),
  })
}
