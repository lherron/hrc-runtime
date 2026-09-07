import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcDatabase } from 'hrc-store-sqlite'
import type { MailKickerContext } from '../context.js'
import { observeBrokerLanding } from '../drive/landing.js'
import { readActionableEnvelopes } from '../drive/presentation.js'
import { reconcileOpenIntents } from '../drive/reconcile.js'
import type { ObservedBrokerSeat } from '../drive/seat.js'
import { KICKER_SUBMISSION_TTL_MS } from '../internal.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import type { FakeLedger, T08094Harness } from './t08094-harness.js'
import {
  RUNTIME_ID as RUNTIME,
  TARGET_REF as TARGET,
  brokerRecord,
  createT08094Harness,
  deliverOneTo,
  destroyT08094Harness,
  seatIn,
} from './t08094-harness.js'

/**
 * T-08094 — the redelivery loop is BOUNDED, and the bound is ONE rule.
 *
 * The counter is per (envelope, runtime) and it counts NON-LANDING OUTCOMES.
 * A TTL expiry is one kind. A refusal that arrives AFTER the body reached the
 * pane is another, and it is a full strike because the reader has already read
 * the message. A refusal BEFORE any write is neither — nothing was shown, so
 * nothing is charged — but a continuous run of them spanning one TTL window
 * earns exactly one strike, so a seat that never accepts still converges.
 *
 * Every one of these was written against a live failure, not an imagined one:
 * an envelope was presented to a real reader three times in three minutes while
 * its ledger row said `pending` (finding 5, 2026-09-06).
 */

let harness: T08094Harness
let db: HrcDatabase
let ledger: FakeLedger
let context: MailKickerContext

beforeEach(async () => {
  harness = await createT08094Harness()
  ;({ db, ledger, context } = harness)
})

afterEach(async () => {
  await destroyT08094Harness(harness)
})

async function deliverOne(seat: ObservedBrokerSeat, envelope: WrkqEnvelope) {
  return deliverOneTo(harness, seat, envelope)
}

describe('D2 — the redelivery loop is bounded per (envelope, runtime)', () => {
  /**
   * The redelivery loop is BOUNDED (chief ruling 2026-09-06, addendum to
   * T-08092 §D2 step 5). A seat that cannot land is not a slow seat, and
   * retrying it every TTL forever tells the sender nothing while the envelope
   * sits pending — the observed case ran over twelve hours that way.
   */
  it('holds the envelope after a TTL with no landing proof', async () => {
    const envelope = ledger.say()
    const age = () =>
      db.sqlite
        .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
        .run(new Date(Date.now() - KICKER_SUBMISSION_TTL_MS - 1_000).toISOString(), envelope.id)

    await deliverOne(seatIn('turn-active'), envelope)
    age()
    expect(await reconcileOpenIntents(context, { reason: 'periodic' })).toMatchObject({ open: 1 })
    expect(db.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('ttl_without_landing')
    expect(ledger.failRequests).toEqual([])
    expect(
      (await readActionableEnvelopes(context, TARGET)).map((item) => item.envelope.id)
    ).not.toContain(envelope.id)
  })

  /**
   * Chief's ruling, 2026-09-06: the bound counts NON-LANDING OUTCOMES, and a
   * refusal that arrives AFTER the body reached the pane is one of them.
   *
   * This replays the live specimen (T-08094 finding 5). The broker credited each
   * observed turn to a STALE pending submission and settled the one that
   * actually caused it `merged-into-foreign-turn` — so the body landed in the
   * pane, drove a turn, and was refused anyway. Unbounded, that cost the reader
   * a whole turn per cycle: three presentations of one envelope in three
   * minutes, with the ledger still saying `pending`.
   */
  async function refuseAfterTheWriteLanded(reason: string): Promise<void> {
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-t08094',
      seq: 200,
      time: new Date().toISOString(),
      type: 'input.accepted',
      runtimeId: RUNTIME,
      payload: { inputId: 'sub-1', disposition: 'started' },
    })
    await observeBrokerLanding(
      context,
      brokerRecord('submission.cancelled', { submissionId: 'sub-1', reason })
    )
  }

  it('holds the envelope after a post-write refusal', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    await refuseAfterTheWriteLanded('merged-into-foreign-turn')
    expect(db.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('merged-into-foreign-turn')
    expect(ledger.failRequests).toEqual([])
    const actionable = await readActionableEnvelopes(context, TARGET)
    expect(actionable.map((item) => item.envelope.id)).not.toContain(envelope.id)
  })

  /**
   * The discriminator, in the direction that is easy to get wrong.
   *
   * If a pre-write refusal struck, the bound would silently become "three
   * refusals of any kind" and the paced backoff would stop meaning anything: a
   * seat that is merely busy would be declared undeliverable in three ticks.
   * Nothing was written, so the reader has been shown nothing, so nothing is
   * owed.
   */
  it('does NOT strike for a refusal that arrived before anything was written', async () => {
    const envelope = ledger.say()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await deliverOne(seatIn('turn-active'), envelope)
      await observeBrokerLanding(
        context,
        brokerRecord('input.rejected', {
          inputId: 'sub-1',
          reason: 'pane_not_quiescent',
          deliveryEvidence: 'not_written',
        })
      )
      expect(db.mailDelivery.nonLandingStrikes(envelope.id, RUNTIME)).toBe(0)
    }
    expect(ledger.failRequests).toEqual([])
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    const actionable = await readActionableEnvelopes(context, TARGET)
    expect(actionable.map((item) => item.envelope.id)).toContain(envelope.id)
  })

  /**
   * ...but a seat that refuses before writing FOREVER must still converge, or
   * the backoff is just a slower version of the loop the bound exists to end.
   * One continuous run of pre-write refusals spanning one TTL window is worth
   * exactly one strike, so both kinds of unlandable seat finish in three
   * windows.
   */
  it('permits a retry only after a pre-write refusal', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('input.rejected', {
        inputId: 'sub-1',
        reason: 'pane_not_quiescent',
        deliveryEvidence: 'not_written',
      })
    )
    expect(db.mailDelivery.nonLandingStrikes(envelope.id, RUNTIME)).toBe(0)
    expect(db.mailDelivery.getIntent(envelope.id)).toBeUndefined()
    expect(
      (await readActionableEnvelopes(context, TARGET)).map((item) => item.envelope.id)
    ).toContain(envelope.id)
    expect(ledger.failRequests).toEqual([])
  })

  it('retains the fence when a rejection has no correlated no-write proof', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    await observeBrokerLanding(
      context,
      brokerRecord('input.rejected', { inputId: 'sub-1', reason: 'transport_lost' })
    )
    expect(db.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('transport_lost')
    expect(
      (await readActionableEnvelopes(context, TARGET)).map((item) => item.envelope.id)
    ).not.toContain(envelope.id)
  })

  it('keeps uncertainty scoped to the original envelope and runtime', async () => {
    const envelope = ledger.say()
    await deliverOne(seatIn('turn-active'), envelope)
    db.sqlite
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - KICKER_SUBMISSION_TTL_MS - 1_000).toISOString(), envelope.id)
    await reconcileOpenIntents(context, { reason: 'periodic' })
    expect(db.mailDelivery.getIntent(envelope.id)?.uncertainCause).toBe('ttl_without_landing')

    // A different runtime is a different row: rotation and restart give the next
    // seat its full allowance without anyone having to remember a reset rule.
    expect(db.mailDelivery.nonLandingStrikes(envelope.id, 'rt-rotated')).toBe(0)

    expect(db.mailDelivery.nonLandingStrikes(envelope.id, RUNTIME)).toBe(0)
  })
})
