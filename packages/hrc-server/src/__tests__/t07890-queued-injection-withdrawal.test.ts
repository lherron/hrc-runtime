import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDeliveryDoor } from 'hrc-store-sqlite'

import { runWrkqLedgerTail } from 'hrc-mail-kicker'
import { writeServerLog } from '../server-log.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { captureServerLog } from './fixtures/mail-kicker-harness.js'

/**
 * T-07890, carried into T-08094 — an envelope acked before its submission lands.
 *
 * The reader answered from inside their own turn, so the body the harness is
 * still holding is stale. Recalling it is the ONE thing HRC does on an
 * `envelope.acked` off the tail, and the whole predicate is now the OPEN
 * DELIVERY INTENT: it is the durable record that this daemon submitted the
 * envelope and has not seen it land.
 *
 * That replaced three heuristics — a claimed attempt row, `input.accepted`
 * evidence, and `queue.enqueued` evidence — which existed only because the
 * drive attempt could not say by itself whether a submission was outstanding.
 * The intent can: it exists exactly between the door call and the landing.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07890/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07890'
const RUNTIME_ID = 'rt-t07890-busy'
const SUBMISSION_ID = 'sub-t07890-queued'

type WithdrawOutcome =
  | { outcome: 'withdrawn' }
  | { outcome: 'not_held'; state: 'accepted' | 'terminal' }
  | { outcome: 'unknown' }

type TailServer = {
  enabled: boolean
  stopping: boolean
  wrkqLedgerTailInFlight: Promise<void> | undefined
  mailKickerColdStartCatchupPending: boolean
  db: HrcDatabase
  ledger: FakeWrkqLedger
  broker: {
    withdraw(input: {
      runtimeId: string
      envelopeId: string
      reason: string
    }): Promise<{ ok: true; response: WithdrawOutcome }>
  }
  wake(target: string, reason: string): void
  log(level: string, event: string, detail: Record<string, unknown>): void
}

describe('T-07890 — an acked envelope recalls the submission still in flight', () => {
  let dir: string
  let db: HrcDatabase
  let ledger: FakeWrkqLedger
  let withdrawOutcome: WithdrawOutcome
  let withdrawCalls: Array<{ runtimeId: string; envelopeId: string; reason: string }>
  let wakes: Array<{ target: string; reason: string }>
  let server: TailServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 't07890-kicker-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    ledger = new FakeWrkqLedger()
    withdrawOutcome = { outcome: 'withdrawn' }
    withdrawCalls = []
    wakes = []
    server = {
      enabled: true,
      stopping: false,
      wrkqLedgerTailInFlight: undefined,
      // The tail's cursor is already established, so this run is the ack page
      // and nothing else.
      mailKickerColdStartCatchupPending: false,
      db,
      ledger,
      broker: {
        withdraw: async (input) => {
          withdrawCalls.push(input)
          return { ok: true as const, response: withdrawOutcome }
        },
      },
      wake: (target, reason) => wakes.push({ target, reason }),
      log: writeServerLog,
    }
    db.wrkqLedgerCursors.advance(ledger.events.length)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function runTail(): Promise<void> {
    await runWrkqLedgerTail.call(server as never)
  }

  function seedOutstanding(door: HrcMailDeliveryDoor = 'enqueue'): string {
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromScopeRef: 'mable@hcs:fixall',
      roomKey: 'T-07890',
    })
    const intent = db.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef: TARGET,
      door,
      form: 'full',
      presentationId: `present-${envelope.id}`,
      runtimeId: RUNTIME_ID,
      submittedHrcSeq: 0,
    })
    if (intent === undefined) throw new Error('failed to seed the outstanding intent')
    if (door !== 'launch') {
      db.mailDelivery.attachAdmission(envelope.id, { submissionId: SUBMISSION_ID })
    }
    // Past the `envelope.created` this seeding wrote: the page under test is
    // the ACK, so an insert wake for the same row would be noise the assertion
    // on `wakes` could not tell apart from a wake the withdrawal caused.
    db.wrkqLedgerCursors.advance(ledger.events.length)
    return envelope.id
  }

  it('withdraws the exact outstanding submission and retains a terminal fence', async () => {
    const envelopeId = seedOutstanding()
    ledger.ack(envelopeId)

    await runTail()

    expect(withdrawCalls).toEqual([
      {
        runtimeId: RUNTIME_ID,
        submissionId: SUBMISSION_ID,
        reason: 'envelope_terminal_before_injection',
      },
    ])
    expect(db.mailDelivery.getIntent(envelopeId)?.terminalEnvelopeCause).toBe('envelope.acked')
    expect(wakes).toEqual([])
  })

  it('leaves the intent open when the broker has already applied the body', async () => {
    const envelopeId = seedOutstanding()
    withdrawOutcome = { outcome: 'not_held', state: 'accepted' }
    ledger.ack(envelopeId)

    const { lines } = await captureServerLog(async () => {
      await runTail()
    })

    expect(withdrawCalls).toHaveLength(1)
    // `not_held` means the landing is on its way. Clearing the intent here
    // would let a second delivery race that landing, which is exactly what the
    // write-ahead record exists to make impossible.
    expect(db.mailDelivery.getIntent(envelopeId)?.submissionId).toBe(SUBMISSION_ID)
    expect(
      lines.filter((line) => line.includes('wrkq.kicker.queued_injection_withdraw_skipped'))
    ).toHaveLength(1)
  })

  it('never withdraws an envelope this node has no submission outstanding for', async () => {
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromScopeRef: 'mable@hcs:fixall',
      roomKey: 'T-07890',
    })
    ledger.ack(envelope.id)

    await runTail()

    expect(withdrawCalls).toEqual([])
  })

  it('never withdraws a launch-carried body: there is no submission to recall', async () => {
    const envelopeId = seedOutstanding('launch')
    ledger.ack(envelopeId)

    await runTail()

    expect(withdrawCalls).toEqual([])
    expect(db.mailDelivery.getIntent(envelopeId)).toBeDefined()
  })

  it('leaves a fyi acked by its own presentation alone', async () => {
    const envelopeId = seedOutstanding()
    // A legacy fyi/notify is terminalized BY its presentation. That automatic
    // ack is not a reader disposal, and the addressee is still owed the one
    // delivery already in flight.
    ledger.ack(envelopeId, 'fyi_presented')

    await runTail()

    expect(withdrawCalls).toEqual([])
    expect(db.mailDelivery.getIntent(envelopeId)).toBeDefined()
  })
})
