import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  completeRun,
  installDeterministicStart,
  installMailKickerAgentHome,
  startedRunId,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07704 (T-07612 rev 5.1) — the four RATIFIED SCENARIOS, and D3 over every
 * terminal runtime status.
 *
 * These are the spec's own gates (§9), transcribed from the scenario ledger on
 * T-07702 (C-17055) rather than invented here, so a change to the semantics has
 * to argue with the ratified text and not with a test author's reading of it.
 *
 * The four D3 fixtures exist because the terminal vocabulary is the one place
 * this design can silently half-work: `terminated`, `crashed`, `dead` and
 * `stale` are written by four different mechanisms, and a rule keyed on one
 * event name would pass three of these and lose real mail on the fourth. Each
 * observes THE SAME failed row, which is the actual claim — the predicate is
 * the status column, not the event.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07704/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07704'
const SENDER = 'mable@hrc-runtime:T-07704'
const SENDER_TARGET = 'agent:mable:project:hrc-runtime:task:T-07704/lane:main'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-rev51-')
  ledger = new FakeWrkqLedger()
  const home = await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')
  restoreAgentHome = home.restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: SENDER,
    roomKey: 'T-07704',
    ...overrides,
  })
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // The sweep is driven explicitly; a background one would race the asserts.
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  return server
}

/**
 * The daemon-internal surface these scenarios drive.
 *
 * Returned as an OBJECT and called through it, never destructured: every
 * kicker entry point is a `this`-bound method on the server instance, and
 * pulling one off the object silently strips the receiver.
 */
function internals() {
  return server as unknown as {
    db: HrcDatabase
    requestMailKickerWake: (target: string, reason: string) => void
    drainMailKickerTarget: (target: string) => Promise<void>
    runMailKickerSweep: () => Promise<void>
    runWrkqLedgerTail: () => Promise<void>
  }
}

/** The kicker's own store, for the durable assertions. */
function serverDb(): HrcDatabase {
  return internals().db
}

/** Expire one armed reminder's hold, keeping the production `remind_at <= now`. */
function dueNow(db: HrcDatabase, envelopeId: string): void {
  db.sqlite
    .query('UPDATE hrcmail_envelope_reminders SET remind_at = ? WHERE envelope_id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), envelopeId)
}

function holdingRuntimeId(envelopeId: string): string {
  const runtimeId = ledger.envelopes.get(envelopeId)?.presentedTo.at(-1)?.runtimeId
  if (runtimeId === undefined) throw new Error(`no receipt runtime for ${envelopeId}`)
  return runtimeId
}

describe('rev 5.1 scenario 1 — control', () => {
  it('summons a cold seat, presents the FULL form, and the reply acks it', async () => {
    say({ body: 'the control body' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const hrc = internals()
    const db = serverDb()

    hrc.requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'cold summon')
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)

    const prompt = deterministic.prompts()[0] ?? ''
    expect(prompt).toContain(`[T-07704 · ${SENDER} → you · reply required]`)
    expect(prompt).toContain('the control body')
    expect(prompt).toContain(`reply: wrkc say T-07704 --to ${SENDER} - <<'EOF'`)
    expect(prompt).toContain('defer: wrkc defer EN-')

    const [envelope] = [...ledger.envelopes.values()]
    ledger.ack(envelope?.id as string)
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    await Bun.sleep(60)
    // A replied obligation costs nothing: no reminder, no failure.
    expect(ledger.failRequests).toEqual([])
    expect(db.mailDrives.listDueReminders(TARGET, farFuture())).toEqual([])
  })
})

describe('rev 5.1 scenario 2 — rotation lapse (EN-01165 replayed)', () => {
  it('fails the obligation when its runtime terminates, tells the sender, and injects NOTHING into the next runtime', async () => {
    const first = say({ body: 'the body that outlived its runtime' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const hrc = internals()
    const db = serverDb()
    // The sender is seated here, so this node is the one that owes the notice.
    await fixture.resolveSession('agent:mable:project:hrc-runtime:task:T-07704')
    // The tail cursor must predate the failure: `envelope.failed` rides the
    // same cursor as `envelope.created`, and a first tail starts at the end.
    await hrc.runWrkqLedgerTail()

    hrc.requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'full-form drive')
    await waitUntil(() => ledger.envelopes.get(first.id)?.state === 'presented', 'receipt')
    const rtA = holdingRuntimeId(first.id)

    // The turn ends undisposed AND the runtime terminates.
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    db.runtimes.updateStatus(rtA, 'terminated', timestamp())
    await hrc.runMailKickerSweep()
    await waitUntil(() => ledger.envelopes.get(first.id)?.state === 'failed', 'D3 lapse')
    expect(ledger.envelopes.get(first.id)?.failureReason).toBe('runtime_terminated')

    // §5: the sender is told, from the ledger row and not from the payload.
    await hrc.runWrkqLedgerTail()
    await waitUntil(
      () => db.mailDrives.listUndeliveredFailureNotices(SENDER_TARGET).length === 1,
      'sender notice'
    )
    const notice = db.mailDrives.listUndeliveredFailureNotices(SENDER_TARGET)[0]?.notice ?? ''
    expect(notice).toContain(`your ${first.id}`)
    expect(notice).toContain('failed: runtime_terminated')
    expect(notice).toContain(rtA)

    // D2: a new runtime is born and gets NOTHING. The obligation died with the
    // runtime that held it; the sender decides, not the next reader.
    deterministic.rotateRuntime()
    const drivesBefore = deterministic.calls()
    hrc.requestMailKickerWake(TARGET, 'periodic')
    await hrc.drainMailKickerTarget(TARGET)
    await Bun.sleep(60)
    expect(deterministic.calls()).toBe(drivesBefore)

    // The sender RESENDS: a new envelope, full form, and the history cue now
    // carries the failed one too.
    const resent = say({ body: 'the resend' })
    hrc.requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === drivesBefore + 1, 'resend delivered')
    const prompt = deterministic.prompts().at(-1) ?? ''
    expect(prompt).toContain('the resend')
    expect(prompt).toContain('history: wrkc log T-07704')
    ledger.ack(resent.id)
    expect(ledger.envelopes.get(resent.id)?.state).toBe('acked')
  })
})

describe('rev 5.1 scenario 3 — ignored', () => {
  it('reminds once in pointer form, then fails as ignored when the reminder turn ends undisposed', async () => {
    const mail = say({ body: 'the body the reader never answered' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const hrc = internals()
    const db = serverDb()

    hrc.requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first delivery, full form')
    expect(deterministic.prompts()[0]).toContain('the body the reader never answered')

    // Turn A ends undisposed: strike one is a REMINDER, held for a minute.
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    await waitUntil(() => db.mailDrives.listDueReminders(TARGET, farFuture()).length === 1, 'armed')
    expect(ledger.failRequests).toEqual([])

    dueNow(db, mail.id)
    hrc.requestMailKickerWake(TARGET, 'periodic')
    await waitUntil(() => deterministic.calls() === 2, 'reminder delivered')
    const reminder = deterministic.prompts().at(-1) ?? ''
    expect(reminder).toContain(`read: wrkc show ${mail.id}`)
    expect(reminder).toContain('still owed — your turn ended')
    expect(reminder).not.toContain('the body the reader never answered')

    // The reminder's OWN turn starts and ends undisposed: strike two.
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 1))
    await waitUntil(() => ledger.envelopes.get(mail.id)?.state === 'failed', 'strike-out')
    expect(ledger.envelopes.get(mail.id)?.failureReason).toBe('ignored')
    // At most one reminder ever, so nothing can drive it a third time.
    hrc.requestMailKickerWake(TARGET, 'periodic')
    await hrc.drainMailKickerTarget(TARGET)
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(2)
  })
})

describe('rev 5.1 scenario 4 — defer across rotation', () => {
  it("survives the runtime that took it, and retries in POINTER form carrying the reader's reason", async () => {
    const mail = say({ body: 'the body deferred mid-restart' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const hrc = internals()
    const db = serverDb()

    hrc.requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'full form into rt-X')
    await waitUntil(() => ledger.envelopes.get(mail.id)?.state === 'presented', 'receipt')
    const rtX = holdingRuntimeId(mail.id)
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    await waitUntil(() => db.mailDrives.listDueReminders(TARGET, farFuture()).length === 1, 'armed')

    // The reader DEFERS with a reason and a retry time.
    ledger.defer(mail.id, 'mid-restart drain, back in 10')

    // rt-X /quits. D3 finds no `presented` obligation on it: a deferral is a
    // reader commitment, not a delivery, so nothing fails.
    db.runtimes.updateStatus(rtX, 'terminated', timestamp())
    await hrc.runMailKickerSweep()
    await Bun.sleep(60)
    expect(ledger.envelopes.get(mail.id)?.state).toBe('deferred')
    expect(ledger.failRequests).toEqual([])

    // The retry promise fires: back to `pending` with `presented_to` intact.
    ledger.repend(mail.id)
    deterministic.rotateRuntime()
    hrc.requestMailKickerWake(TARGET, 'periodic')
    await waitUntil(() => deterministic.calls() === 2, 'defer retry into rt-Y')
    const retry = deterministic.prompts().at(-1) ?? ''
    expect(retry).toContain('you deferred this: "mid-restart drain, back in 10"')
    expect(retry).toContain(`read: wrkc show ${mail.id}`)
    // The body is pushed ONCE per envelope; this is the pointer.
    expect(retry).not.toContain('the body deferred mid-restart')
    expect(ledger.envelopes.get(mail.id)?.state).toBe('presented')
    expect(holdingRuntimeId(mail.id)).not.toBe(rtX)

    ledger.ack(mail.id)
    expect(ledger.envelopes.get(mail.id)?.state).toBe('acked')
  })
})

/**
 * D3 over the whole terminal vocabulary.
 *
 * The four statuses arrive from four different writers, and every one of them
 * must produce THE SAME failed row. That identity is the fixture's whole point:
 * it is what makes "the status column is the authority" a testable claim rather
 * than a comment.
 */
describe('rev 5.1 D3 — every terminal runtime status lapses the obligation', () => {
  for (const status of ['terminated', 'crashed', 'dead', 'stale'] as const) {
    it(`fails a presented obligation when its runtime goes ${status}`, async () => {
      const mail = say({ body: `held by a runtime that went ${status}` })
      await startServer()
      const deterministic = installDeterministicStart(server as HrcServer)
      const hrc = internals()
      const db = serverDb()

      hrc.requestMailKickerWake(TARGET, 'insert')
      await waitUntil(() => deterministic.calls() === 1, 'delivery')
      await waitUntil(() => ledger.envelopes.get(mail.id)?.state === 'presented', 'receipt')
      const runtimeId = holdingRuntimeId(mail.id)

      db.runtimes.updateStatus(runtimeId, status, timestamp())
      await hrc.runMailKickerSweep()
      await waitUntil(() => ledger.envelopes.get(mail.id)?.state === 'failed', `lapse on ${status}`)

      const failed = ledger.envelopes.get(mail.id)
      expect(failed?.failureReason).toBe('runtime_terminated')
      expect(failed?.terminal).toBe(true)
      // One reason for all four: HRC reports that the runtime is gone, not
      // which of the four names its departure happened to be recorded under.
      expect(ledger.failRequests.at(-1)).toMatchObject({
        reason: 'runtime_terminated',
        runtime: runtimeId,
      })
    })
  }
})

function farFuture(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString()
}
