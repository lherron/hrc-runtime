import type { HrcMailPresentation } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { EnvelopePresentationForm } from '../ledger/presentation.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import { newestPresentationReceipt, obligationSummons } from '../ledger/types.js'

/** One envelope the kicker may deliver, with the form its body will take. */
export type ActionableEnvelope = {
  envelope: WrkqEnvelope
  form: EnvelopePresentationForm
  /** The landed presentation a due reminder is pointing back at. */
  presentation?: HrcMailPresentation | undefined
}

/**
 * Ask wrkq what stands against one target, and in what form.
 *
 * `pendingView` is the wake set and the stop-hook predicate in one read, and its
 * sweep re-pends due deferrals — so calling it here IS the periodic-sweep half
 * of §5's wake routing.
 *
 * Two subtractions, and they are subtractions rather than gates:
 *
 *  - a `presented` envelope is bound to the runtime in its newest receipt, and
 *    the only thing that can surface it again is that same runtime's own due
 *    reminder (rev 5.1 D2);
 *  - an envelope with an OPEN DELIVERY INTENT is never actionable (T-08094 D2
 *    step 1). A submission may already be in flight for it, and the intent — not
 *    HRC's memory of this pass — is what makes a second delivery impossible
 *    across a crash, a restart, or two wakes racing for one scope.
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
  const outstanding = new Set(
    server.db.mailDelivery.listOpenIntents(targetSessionRef).map((intent) => intent.envelopeId)
  )
  const due = new Map(
    server.db.mailDelivery
      .listDueReminders(targetSessionRef, new Date().toISOString())
      .map((presentation) => [presentation.envelopeId, presentation] as const)
  )
  const actionable: ActionableEnvelope[] = []
  const claimedReminders = new Set<string>()
  for (const envelope of view.items) {
    if (outstanding.has(envelope.id)) continue
    if (envelope.state === 'pending') {
      // D1 vs D6: `presented_to` non-empty means the body has already been
      // pushed once, so this is a defer retry and takes the pointer form.
      const form: EnvelopePresentationForm =
        envelope.presentedTo.length === 0 ? 'full' : 'defer-retry'
      actionable.push({ envelope, form })
      continue
    }
    if (envelope.state !== 'presented') continue
    const presentation = due.get(envelope.id)
    if (presentation === undefined) continue
    // The reminder is bound to ONE runtime. If the newest receipt has moved on,
    // this reminder is stale evidence about a delivery that no longer stands.
    if (newestPresentationReceipt(envelope)?.runtimeId !== presentation.runtimeId) continue
    claimedReminders.add(presentation.envelopeId)
    actionable.push({ envelope, form: 'reminder', presentation })
  }
  // Every due reminder this read did NOT claim is one whose obligation has
  // stopped standing on that runtime — replied, deferred, lapsed by D3, or
  // superseded. Retire it here, where the wake set that decided so is in hand.
  // Left armed it stays due forever and puts this scope in every later sweep's
  // candidate set for nothing.
  for (const presentation of due.values()) {
    if (claimedReminders.has(presentation.envelopeId)) continue
    if (outstanding.has(presentation.envelopeId)) continue
    if (!server.db.mailDelivery.retireReminder(presentation.envelopeId, presentation.runtimeId)) {
      continue
    }
    server.log('INFO', 'wrkq.kicker.reminder_retired', {
      targetSessionRef,
      envelope: presentation.envelopeId,
      runtimeId: presentation.runtimeId,
    })
  }
  return actionable
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
