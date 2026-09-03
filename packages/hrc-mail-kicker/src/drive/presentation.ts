import type { HrcSessionRecord } from 'hrc-core'
import type { HrcMailDriveAttempt } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { EnvelopePresentationForm, PresentableEnvelope } from '../ledger/presentation.js'
import { formatEnvelopePresentations } from '../ledger/presentation.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import { newestPresentationReceipt, obligationSummons } from '../ledger/types.js'
import { autoReplyCandidateFor, presentationKeyFor } from './batching.js'
import type { HeldBatchActionableEnvelope } from './held-batch.js'
import { MAX_PRESENTED_PER_ATTEMPT } from './held-batch.js'

export type ActionableEnvelope = HeldBatchActionableEnvelope

/**
 * A stored hold is an interruption request and therefore owns one admission
 * decision. It can never inherit another envelope's origin by being batched,
 * nor lend its hold intent to ordinary queue mail.
 */
export function isolatedDeliveryBatch(actionable: readonly ActionableEnvelope[]): {
  selected: ActionableEnvelope[]
  deferredCount: number
} {
  const hold = actionable.find((item) => item.envelope.delivery === 'hold')
  if (hold === undefined) return { selected: [...actionable], deferredCount: 0 }
  return { selected: [hold], deferredCount: actionable.length - 1 }
}

/** Select the oldest envelope's exact auto-reply counterparty group. */
export function presentationBatch(actionable: readonly ActionableEnvelope[]): ActionableEnvelope[] {
  const first = actionable[0]
  if (first === undefined) return []
  const presentationKey = presentationKeyFor(first.envelope)
  if (presentationKey === undefined) return [first]
  return actionable
    .filter((item) => presentationKeyFor(item.envelope) === presentationKey)
    .slice(0, MAX_PRESENTED_PER_ATTEMPT)
}

/**
 * Ask wrkq what stands against one target, and in what form.
 *
 * `pendingView` is the wake set and the stop-hook predicate in one read, and its
 * sweep re-pends due deferrals — so calling it here IS the periodic-sweep half
 * of §5's wake routing.
 *
 * REV 5.1 D2 lives here, and it is a subtraction rather than a gate. A
 * `presented` envelope is simply not deliverable: it is bound to the runtime in
 * its newest receipt, and the only thing that can surface it again is that same
 * runtime's own due reminder. Everything else this returns is `pending` — first
 * delivery (empty `presented_to`, full form) or a defer retry (non-empty,
 * pointer form carrying the reader's own reason). The redelivery floor that
 * used to hold a presented envelope back for 1/2/4/8/16 minutes is gone with
 * the re-presentation it was throttling.
 */
export async function readActionableEnvelopes(
  server: MailKickerContext,
  targetSessionRef: string
): Promise<ActionableEnvelope[]> {
  const view = await server.ledger.pendingView({
    scopes: [targetSessionRef],
    // T-07627: fyi rows ride the same read. They never summon (§5) and never
    // block a turn end, but a seated addressee should still be shown them.
    includeFyi: true,
  })
  if (view.repended > 0) {
    server.log('INFO', 'wrkq.kicker.deferrals_repended', {
      targetSessionRef,
      repended: view.repended,
    })
  }
  const due = new Map(
    server.db.mailDrives
      .listDueReminders(targetSessionRef, new Date().toISOString())
      .map((reminder) => [reminder.envelopeId, reminder] as const)
  )
  const actionable: ActionableEnvelope[] = []
  const claimedReminders = new Set<string>()
  for (const envelope of view.items) {
    if (envelope.state === 'pending') {
      // D1 vs D6: `presented_to` non-empty means the body has already been
      // pushed once, so this is a defer retry and takes the pointer form.
      const form: EnvelopePresentationForm =
        envelope.presentedTo.length === 0 ? 'full' : 'defer-retry'
      actionable.push({ envelope, form })
      continue
    }
    if (envelope.state !== 'presented') continue
    const reminder = due.get(envelope.id)
    if (reminder === undefined) continue
    // The reminder is bound to ONE runtime. If the newest receipt has moved on,
    // this reminder is stale evidence about a delivery that no longer stands.
    if (newestPresentationReceipt(envelope)?.runtimeId !== reminder.runtimeId) continue
    claimedReminders.add(reminder.envelopeId)
    actionable.push({ envelope, form: 'reminder', reminder })
  }
  // Every due reminder this read did NOT claim is one whose obligation has
  // stopped standing on that runtime — replied, deferred, lapsed by D3, or
  // superseded. Retire it here, where the wake set that decided so is in hand.
  // Left armed it stays due forever and puts this scope in every later sweep's
  // candidate set for nothing.
  for (const reminder of due.values()) {
    if (claimedReminders.has(reminder.envelopeId)) continue
    if (!server.db.mailDrives.retireReminder(reminder.envelopeId, reminder.runtimeId)) continue
    server.log('INFO', 'wrkq.kicker.reminder_retired', {
      targetSessionRef,
      envelope: reminder.envelopeId,
      runtimeId: reminder.runtimeId,
    })
  }
  return actionable
}

/**
 * The single prompt-composition seam for every kicker presentation.
 *
 * A multi-envelope input without one auto-reply candidate would make the
 * runtime's final text unattributable. Fail before broker submission instead
 * of silently reintroducing cross-counterparty batching.
 */
export function composePresentation(
  actionable: readonly ActionableEnvelope[],
  presentables: readonly PresentableEnvelope[]
): {
  prompt: string
  autoReplyCandidate: ReturnType<typeof autoReplyCandidateFor>
} {
  const autoReplyCandidate = autoReplyCandidateFor(actionable.map((item) => item.envelope))
  if (actionable.length > 1 && autoReplyCandidate === undefined) {
    throw new Error('multi-envelope kicker presentation has no auto-reply candidate')
  }
  return {
    prompt: formatEnvelopePresentations(presentables),
    autoReplyCandidate,
  }
}

/**
 * May this envelope birth a previously unseated target?
 *
 * T-07746 separated summoning from reply debt. Both `reply_required` and the
 * default `notify` birth and wake; only `reply_required` goes on to owe a
 * reply. T-07612 §5 tied the two together, but what §5 was protecting was the
 * DEBT — an unborn seat must not be conscripted into owing an answer — not the
 * birth. Waking a seat to read something it owes nothing on is a different act.
 *
 * A legacy `fyi` still does NOT summon: those rows were written under the old
 * rule and never could, so honoring them here keeps history truthful.
 */
export function summonsATurn(envelope: WrkqEnvelope): boolean {
  return obligationSummons(envelope.obligation)
}

/**
 * The birth directive block the ledger carried, if any envelope carried one.
 *
 * wrkq stores it VERBATIM (`+node=svc`) and never parses it — that vocabulary
 * is HRC's. It is a string, not an intent: the intent is assembled at kick time
 * from the target agent's own profile on this node.
 */
export function actionableDirectives(
  actionable: readonly ActionableEnvelope[]
): string | undefined {
  for (const { envelope } of actionable) {
    const raw = envelope.materializationIntent?.trim()
    if (raw !== undefined && raw.length > 0) return raw
  }
  return undefined
}

/**
 * Ask wrkq what each presentation would contain, without writing a receipt.
 *
 * The ledger remains the sole authority for the §7 history cue, but a preview
 * neither marks the runtime warm nor auto-acks a fyi. Delivery is committed
 * only after the broker accepts the prompt below.
 */
export async function recordPresentations(
  server: MailKickerContext,
  actionable: readonly ActionableEnvelope[],
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord,
  runtimeId: string | undefined
): Promise<PresentableEnvelope[]> {
  const presentables: PresentableEnvelope[] = []
  for (const item of actionable) {
    const result = await server.ledger.present({
      envelope: item.envelope.id,
      preview: true,
      node: server.nodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      runId: attempt.runId,
      driveAttemptId: attempt.driveAttemptId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
    presentables.push({
      envelope: result.envelope,
      delivery: result.envelope.delivery,
      // A pointer form carries no body and therefore no history cue: the cue
      // exists to orient a cold reader at first contact, and every pointer
      // goes to a reader who has already had one.
      historyHint: item.form === 'full' && result.historyHint,
      messageCount: result.messageCount,
      ...(result.lastMessageAt === undefined ? {} : { lastMessageAt: result.lastMessageAt }),
      form: item.form,
      ...(item.reminder === undefined ? {} : { turnEndedAt: item.reminder.turnEndedAt }),
      ...senderGenerationFor(server, result.envelope),
    })
  }
  return presentables
}

/** Commit receipts only after an ordinary dispatch accepted the composed prompt. */
export async function commitPresentations(
  server: MailKickerContext,
  presentables: readonly PresentableEnvelope[],
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord,
  runtimeId: string | undefined,
  /**
   * Absent for a cold birth: the prompt rode the runtime's `initialPrompt`, so
   * that delivery class has no invocation input to name (T-07693). The receipt
   * contract already declares this field optional for exactly that reason.
   */
  inputId: string | undefined
): Promise<void> {
  for (const presentable of presentables) {
    await server.ledger.present({
      envelope: presentable.envelope.id,
      node: server.nodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      runId: attempt.runId,
      ...(inputId === undefined ? {} : { inputId }),
      driveAttemptId: attempt.driveAttemptId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
  }
}

/**
 * The sender's generation, when this node homes the sender.
 *
 * It is execution state, so it comes from HRC and never from the ledger — and
 * it is omitted rather than guessed when the sender lives on another node.
 */
export function senderGenerationFor(
  server: MailKickerContext,
  envelope: WrkqEnvelope
): { senderGeneration?: number } {
  const scopeRef = envelope.from.scopeRef
  if (scopeRef === undefined) return {}
  const sessionRef = targetSessionRefForLedgerScope(scopeRef)
  if (sessionRef === undefined) return {}
  const session = server.findTargetSession(sessionRef)
  return session === undefined ? {} : { senderGeneration: session.generation }
}
