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
import { LEDGER_TAIL_PAGE_LIMIT, errorText, isRecord } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type { WrkqEnvelopeCreatedPayload, WrkqMonitorEvent } from '../ledger/types.js'
import { obligationSummons } from '../ledger/types.js'
import { queueFailureNotice } from '../terminal/failure-notices.js'
import { runMailKickerColdStartCatchup } from './cold-start.js'

const QUEUED_INJECTION_WITHDRAW_REASON = 'envelope_terminal_before_injection'

export async function withdrawAckedQueuedInjection(
  server: MailKickerContext,
  event: WrkqMonitorEvent
): Promise<void> {
  if (event.payload !== undefined) {
    try {
      const payload: unknown = JSON.parse(event.payload)
      // A legacy fyi/notify is terminalized by its OWN presentation. Its held
      // input still owes the addressee one delivery, so that automatic ack is
      // not a reader disposal and must never revoke the submission.
      if (isRecord(payload) && payload['reason'] === 'fyi_presented') return
    } catch {
      // An unreadable additive payload must not change the pre-existing ack
      // behavior. The envelope/receipt and broker ledger remain authoritative.
    }
  }

  const envelopeId = event.resourceId
  if (envelopeId === undefined) return

  // The OPEN INTENT is the proof that HRC submitted this envelope and has not
  // seen it land. Nothing else is consulted: under T-08094 an envelope with no
  // open intent either never went to a door or has already landed, and in both
  // shapes there is nothing to recall.
  const intent = server.db.mailDelivery.getIntent(envelopeId)
  if (intent === undefined || intent.runtimeId === undefined || intent.door === 'launch') return

  // This is a broker-held queue cleanup only.  It is not a native harness
  // removal and neither an error nor `not_held` proves that the body was not
  // already applied.  Terminalize the durable fence before asking the broker.
  server.db.mailDelivery.markTerminalEnvelope(envelopeId, event.eventType)
  const withdrawal = await server.broker.withdraw(
    intent.submissionId === undefined
      ? { runtimeId: intent.runtimeId, envelopeId, reason: QUEUED_INJECTION_WITHDRAW_REASON }
      : {
          runtimeId: intent.runtimeId,
          submissionId: intent.submissionId,
          reason: QUEUED_INJECTION_WITHDRAW_REASON,
        }
  )
  if (!withdrawal.ok) {
    server.db.mailDelivery.recordTerminalCleanup(envelopeId, 'unsupported_or_error')
    server.log('WARN', 'wrkq.kicker.queued_injection_withdraw_failed', {
      envelopeId,
      runtimeId: intent.runtimeId,
      ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
      reason: QUEUED_INJECTION_WITHDRAW_REASON,
      error: withdrawal.error.message,
    })
    return
  }

  if (withdrawal.response.outcome === 'withdrawn') {
    server.db.mailDelivery.recordTerminalCleanup(envelopeId, 'withdrawn')
    server.log('INFO', 'wrkq.kicker.queued_injection_withdrawn', {
      envelopeId,
      runtimeId: intent.runtimeId,
      ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
      door: intent.door,
      reason: QUEUED_INJECTION_WITHDRAW_REASON,
    })
    return
  }

  // `not_held`/`unknown` are not a no-write proof.  The terminal intent stays
  // held and a late landing is audit-only; no receipt or reinjection follows.
  server.db.mailDelivery.recordTerminalCleanup(envelopeId, withdrawal.response.outcome)
  server.log('INFO', 'wrkq.kicker.queued_injection_withdraw_skipped', {
    envelopeId,
    runtimeId: intent.runtimeId,
    door: intent.door,
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
          await withdrawAckedQueuedInjection(this, event)
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
