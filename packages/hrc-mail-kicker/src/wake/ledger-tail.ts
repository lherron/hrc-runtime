/**
 * Follow wrkq's event ledger for envelope lifecycle changes, from a PERSISTED cursor.
 *
 * Always explicit: a read with no cursor replays the whole log (T-07620). The
 * first tail on a virgin store resolves "now" from row identity via `lastN`
 * rather than by arithmetic on a high-water mark — and then hands to the
 * one-time cold-start catch-up, because starting at "now" is exactly what makes
 * an already-pending envelope unreachable (T-07643).
 */
import type { MailKickerContext } from '../context.js'
import { logAttemptTerminal } from '../diagnostics/attempt-log.js'
import { dropAckedHeldMember } from '../drive/held-batch.js'
import { LEDGER_TAIL_PAGE_LIMIT, errorText, isRecord } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type { WrkqEnvelopeCreatedPayload, WrkqMonitorEvent } from '../ledger/types.js'
import { obligationSummons } from '../ledger/types.js'
import { queueFailureNotice } from '../terminal/failure-notices.js'
import { runMailKickerColdStartCatchup } from './cold-start.js'

const QUEUED_INJECTION_WITHDRAW_REASON = 'envelope_acked_before_injection'

export async function withdrawAckedQueuedInjection(
  server: MailKickerContext,
  event: WrkqMonitorEvent
): Promise<void> {
  if (event.payload !== undefined) {
    try {
      const payload: unknown = JSON.parse(event.payload)
      // A legacy fyi/notify is terminalized by its OWN presentation. Its held
      // input still owes the addressee one delivery, so that automatic ack is
      // not a reader disposal and must never revoke the input.
      if (isRecord(payload) && payload['reason'] === 'fyi_presented') return
    } catch {
      // An unreadable additive payload must not change the pre-existing ack
      // behavior. The envelope/receipt and broker ledger remain authoritative.
    }
  }

  const envelopeId = event.resourceId
  if (envelopeId === undefined) return

  // T-07891: no broker submission and no ledger receipt exist while an
  // ordinary queue member is HRC-held. An in-turn reader ack is therefore a
  // pure local subtraction; calling submission.withdraw would invent work the
  // broker never received.
  if (dropAckedHeldMember(server, envelopeId, QUEUED_INJECTION_WITHDRAW_REASON)) return

  const attempt = server.db.mailDrives.getClaimedAttemptForEnvelope(envelopeId)
  if (attempt === undefined) return

  // The wrkq receipt is the durable join to the broker input. Do not infer an
  // input from the queued run: old receipts can legitimately lack inputId, and
  // the broker's envelope selector exists precisely for that mixed history.
  const envelope = await server.ledger.envelopeShow({ envelope: envelopeId })
  const receipt = envelope.presentedTo
    .filter((candidate) => candidate.driveAttemptId === attempt.driveAttemptId)
    .at(-1)
  const inputId = receipt?.inputId
  const runtimeId = receipt?.runtimeId ?? attempt.runtimeId
  if (inputId === undefined || runtimeId === undefined) return

  // Once input.accepted is durable, the harness owns the input. The accepted
  // race is deliberately left to the normal one-turn lifecycle.
  if (server.db.brokerInvocationEvents.hasInputAccepted(runtimeId, inputId)) return

  // A typed interactive turn is visible to the broker but does not mint an
  // HRC run row. In that shape the kicker initially owns an ordinary claimed
  // attempt even though the broker queued its input. Require the broker's own
  // queue evidence here: it admits that real shape without ever withdrawing
  // an idle-path presentation.
  if (!server.db.brokerInvocationEvents.hasQueueEnqueued(runtimeId, inputId)) return

  const withdrawal = await server.broker.withdraw({
    runtimeId,
    envelopeId,
    reason: QUEUED_INJECTION_WITHDRAW_REASON,
  })
  if (!withdrawal.ok) {
    server.log('WARN', 'wrkq.kicker.queued_injection_withdraw_failed', {
      envelopeId,
      runtimeId,
      inputId,
      reason: QUEUED_INJECTION_WITHDRAW_REASON,
      error: withdrawal.error.message,
    })
    return
  }

  if (withdrawal.response.outcome === 'withdrawn') {
    const withdrawn = server.db.mailDrives.markClaimedAttemptWithdrawn(
      attempt.driveAttemptId,
      QUEUED_INJECTION_WITHDRAW_REASON
    )
    logAttemptTerminal(server, withdrawn, {
      reason: QUEUED_INJECTION_WITHDRAW_REASON,
      presentedEnvelopeIds: server.db.mailDrives.presentationEnvelopeIds(withdrawn.driveAttemptId),
    })
    server.log('INFO', 'wrkq.kicker.queued_injection_withdrawn', {
      envelopeId,
      runtimeId,
      inputId,
      reason: QUEUED_INJECTION_WITHDRAW_REASON,
    })
    return
  }

  server.log('INFO', 'wrkq.kicker.queued_injection_withdraw_skipped', {
    envelopeId,
    runtimeId,
    inputId,
    reason: QUEUED_INJECTION_WITHDRAW_REASON,
    outcome: withdrawal.response.outcome,
    ...('state' in withdrawal.response ? { state: withdrawal.response.state } : {}),
  })
}

export async function runWrkqLedgerTail(this: MailKickerContext): Promise<void> {
  if (!this.enabled || this.stopping) return
  if (this.wrkqLedgerTailInFlight !== undefined) return this.wrkqLedgerTailInFlight

  const tail = (async () => {
    try {
      let cursor = this.db.wrkqLedgerCursors.get()
      if (cursor === undefined) {
        cursor = this.db.wrkqLedgerCursors.advance(await resolveTailStartCursor(this))
        // Armed BEFORE the catch-up runs and cleared only when one completes,
        // so a wrkq outage on the first tick costs a retry rather than the
        // whole backlog: the cursor is already persisted and this condition
        // will never be true again in this store.
        this.mailKickerColdStartCatchupPending = true
        this.log('INFO', 'wrkq.kicker.tail_started', { cursor })
      }
      if (this.mailKickerColdStartCatchupPending) {
        await runMailKickerColdStartCatchup(this)
        this.mailKickerColdStartCatchupPending = false
      }
      const page = await this.ledger.eventsView({
        cursor,
        // Failure notices and queued-injection withdrawal ride the SAME cursor
        // as creation. Widening this filter must never move the virgin-store
        // start point above: tail_started and cold catch-up remain unchanged.
        eventTypes: ['envelope.created', 'envelope.failed', 'envelope.acked'],
        limit: LEDGER_TAIL_PAGE_LIMIT,
      })
      // Resolved lazily and once per page: a fyi wakes only a target this node
      // is currently seating, and the tail must not pay a runtimes query on
      // every empty tick.
      let seated: Set<string> | undefined
      for (const event of page.items) {
        if (event.eventType === 'envelope.acked') {
          await withdrawAckedQueuedInjection(this, event)
          continue
        }
        if (event.eventType === 'envelope.failed') {
          await queueFailureNotice(this, event).catch((error: unknown) => {
            this.log('WARN', 'wrkq.kicker.failure_notice_queue_failed', {
              envelope: event.resourceId,
              error: errorText(error),
            })
          })
          continue
        }
        seated ??= new Set(this.db.runtimes.listLiveSessionRefs())
        const target = wakeTargetForEvent(event, seated)
        if (target === undefined) continue
        this.wake(target, 'insert')
      }
      if (page.highWater > cursor) this.db.wrkqLedgerCursors.advance(page.highWater)
    } catch (error) {
      this.log(
        error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
        'wrkq.kicker.tail_failed',
        { error: errorText(error) }
      )
    }
  })().finally(() => {
    if (this.wrkqLedgerTailInFlight === tail) this.wrkqLedgerTailInFlight = undefined
  })
  this.wrkqLedgerTailInFlight = tail
  return tail
}

/**
 * "Now", resolved from row identity rather than arithmetic.
 *
 * A daemon that has never tailed must start at the CURRENT end of the log:
 * replaying it would re-drive every historical envelope, and guessing a cursor
 * would skip whatever arrived in the gap. `lastN` resolves the row just before
 * the newest one, and one bounded page past it reports that newest row's id as
 * its high water — which is exactly the end. An empty ledger stays at 0, so the
 * very first envelope ever written is still seen.
 *
 * An empty ledger was the ONLY case that covered, and a first start against a
 * non-empty one is the common case, not the rare one — every already-pending
 * envelope sits before this cursor. What makes those reachable is the
 * cold-start catch-up the caller runs immediately after persisting this mark,
 * never this function widening its start.
 */
export async function resolveTailStartCursor(server: MailKickerContext): Promise<number> {
  const beforeLast = await server.ledger.eventsView({ cursor: 0, lastN: 1 })
  const start = Math.max(beforeLast.highWater, 0)
  const end = await server.ledger.eventsView({ cursor: start, limit: 1 })
  return Math.max(end.highWater, start)
}

/**
 * The target an `envelope.created` wakes, or undefined for one that never kicks.
 *
 * `reply_required` and `notify` both wake (T-07746), seated or not: they summon.
 * A `fyi` never summons — an unseated addressee is not born for it — but it IS
 * injected into a seated addressee (the `wrkc say --fyi` contract), and before
 * this branch the only path to that injection was the thirty-tick sweep, so a
 * fyi to an idle seat landed up to thirty seconds after it was sent (observed
 * at 29s on mable@hcs:primary, 2026-09-02 12:03Z). The drain path already
 * refuses to birth on a fyi-only wake set, so waking a seated target here costs
 * nothing new; the seated check exists only so the tail does not wake the
 * drain for scopes nothing can be presented into. A scope-less addressee (a
 * human principal) is never kicked either — ACP presents those.
 */
export function wakeTargetForEvent(
  event: WrkqMonitorEvent,
  seatedSessionRefs: ReadonlySet<string>
): string | undefined {
  if (event.eventType !== 'envelope.created' || event.payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(event.payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const payload = parsed as WrkqEnvelopeCreatedPayload
  const scopeRef = payload.to_scope_ref
  if (typeof scopeRef !== 'string') return undefined
  const target = targetSessionRefForLedgerScope(scopeRef)
  if (target === undefined) return undefined
  if (obligationSummons(payload.obligation)) return target
  return seatedSessionRefs.has(target) ? target : undefined
}
