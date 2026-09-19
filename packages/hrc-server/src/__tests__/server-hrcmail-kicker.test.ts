import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { MailKicker } from 'hrc-mail-kicker'
import { appendHrcEvent } from '../hrc-event-helper.js'
import type { HrcServer } from '../index.js'
import { resolveHrcMailKickerEnabled } from '../option-resolvers.js'
import { timestamp } from '../server-util.js'
import type { AspdObservationDouble } from './fixtures/aspd-observation-doubles.js'
import type { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  completeRun,
  installDeterministicStart,
  queryCount,
  serverInternals,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'
import {
  SCOPE,
  TARGET,
  buildKickerServer,
  farFuture,
  kickerStateDb,
  sayToLedger,
  setupKickerPreamble,
  teardownKickerPreamble,
} from './server-hrcmail-kicker.setup.js'

/**
 * T-07615 (T-07612 wave 3) — HRC drives the wrkq collaboration ledger (part 1).
 * Shared fixture lives in `./server-hrcmail-kicker.setup.js`; part 2 is
 * `server-hrcmail-kicker-2.test.ts`. Split by the 1000-line test-size gate;
 * case count is unchanged.
 */

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void
let aspdDouble: AspdObservationDouble | undefined
let savedAspdSocket: string | undefined

beforeEach(async () => {
  ;({ fixture, ledger, restoreAgentHome, aspdDouble, savedAspdSocket } =
    await setupKickerPreamble())
})

afterEach(async () => {
  await teardownKickerPreamble({ server, fixture, aspdDouble, savedAspdSocket, restoreAgentHome })
  server = undefined
  aspdDouble = undefined
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return sayToLedger(ledger, overrides)
}

const kicker = (): MailKicker => (server as any).mailKicker

async function startServer(options: Record<string, unknown> = {}): Promise<HrcServer> {
  server = await buildKickerServer(fixture, ledger, options)
  return server
}

describe('T-07615 — HRC drives the wrkq collaboration ledger', () => {
  it('is dark by default', () => {
    const originalEnabled = process.env['HRC_MAIL_KICKER_ENABLED']
    try {
      Reflect.deleteProperty(process.env, 'HRC_MAIL_KICKER_ENABLED')
      expect(resolveHrcMailKickerEnabled({} as never)).toBe(false)
      process.env['HRC_MAIL_KICKER_ENABLED'] = '1'
      expect(resolveHrcMailKickerEnabled({} as never)).toBe(true)
    } finally {
      if (originalEnabled === undefined) {
        Reflect.deleteProperty(process.env, 'HRC_MAIL_KICKER_ENABLED')
      } else {
        process.env['HRC_MAIL_KICKER_ENABLED'] = originalEnabled
      }
    }
  })

  it('presents exactly once across racing insert/completion/sweep wakes', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    kicker().wake(TARGET, 'turn_completion')
    await Promise.all([kicker().runSweepOnce(), kicker().runSweepOnce()])
    await waitUntil(() => deterministic.calls() === 1, 'one dispatched drive')

    const db = kickerStateDb(server as HrcServer)
    // T-08094: the fence is the WRITE-AHEAD INTENT, whose primary key refuses a
    // second submission for the same envelope. One landing, one receipt.
    await waitUntil(
      () => db.mailDelivery.presentationsForTarget(TARGET).length === 1,
      'exactly one landing'
    )
    expect(db.mailDelivery.listOpenIntents(TARGET)).toHaveLength(0)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)

    await Promise.all([kicker().runSweepOnce(), kicker().runSweepOnce()])
    expect(deterministic.calls()).toBe(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  // T-08093 / spec T-08092 A1, in unit form: the same full-path test that used
  // to assert the mint, now asserting its absence.
  it('mints NOTHING when a driven turn completes with a final response', async () => {
    const envelope = say({ body: 'answer this without a manual say' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')

    const db = kickerStateDb(server as HrcServer)
    await waitUntil(() => deterministic.runIds().length === 1, 'the drive dispatched')
    const runId = deterministic.runIds()[0] as string
    const run = db.runs.getByRunId(runId)
    if (run === null) throw new Error(`missing started run ${runId}`)
    await waitUntil(
      () => db.mailDelivery.presentationsForTarget(TARGET).length === 1,
      'presentation before terminal turn'
    )
    const message = appendHrcEvent(db, 'turn.message', {
      ts: timestamp(),
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
      runtimeId: run.runtimeId,
      runId,
      transport: 'headless',
      payload: { message: { role: 'assistant', content: 'server-path final response' } },
    })
    serverInternals(server as HrcServer).notifyEvent(message)
    await completeRun(server as HrcServer, runId)

    // The turn produced a perfectly good final response and HRC said nothing
    // with it — on implementer seats that text was narration ("I'll start by
    // reading the task…") being posted as the seat's own reply.
    await waitUntil(
      () => db.mailDelivery.listDueReminders(TARGET, farFuture()).length === 1,
      'reminder armed instead of a reply'
    )
    expect(ledger.roomSayRequests).toEqual([])
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('presented')
  })

  it('injects the §4 full form, not an inbox pointer', async () => {
    const envelope = say({ body: 'the body that must be injected verbatim' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'drive dispatched')

    const prompt = deterministic.prompts()[0] ?? ''
    expect(prompt).toContain('[T-07615 · mable@hrc-runtime:T-07615 → you · reply required]')
    expect(prompt).toContain('the body that must be injected verbatim')
    // rev 5.1: the id is no longer internal — the reply line names the row the
    // reader must answer, and it rides first contact. Since T-08093 it is the
    // ONLY way the obligation is discharged.
    expect(prompt).toContain(`reply: wrkc say ${envelope.id} --to mable@hrc-runtime:T-07615`)
    expect(prompt).not.toContain('wrkc defer')
    // No room history is ever injected; the first message in a room has no cue.
    expect(prompt).not.toContain('history:')
    await waitUntil(
      () =>
        ledger.presentRequests.filter((request) => request.envelope === envelope.id).length === 2,
      'presentation receipt'
    )
    const requests = ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ preview: true })
    expect(requests[0]?.inputId).toBeUndefined()
    expect(requests[1]?.preview).toBeUndefined()
    expect(requests[1]?.inputId).toBe(deterministic.inputIds()[0])
    expect(ledger.envelopes.get(envelope.id)?.presentedTo[0]?.inputId).toBe(
      deterministic.inputIds()[0]
    )
  })

  it('delivers a hold to an idle seat by enqueue and round-trips delivery plus expiresAt', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const envelope = say({ body: 'idle hold', delivery: 'hold', expiresAt })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'idle hold dispatched')

    // Spec T-08092 D2: an ABSENT seat is a cold birth through the invoke door;
    // a stored hold has nothing to preempt there and starts like any other.
    expect(deterministic.submissionDoors()).toEqual(['invoke'])
    expect(deterministic.turnPolicies()).toEqual([undefined])
    expect(deterministic.prompts()[0]).toContain('reply required · preempt]')
    expect(ledger.envelopes.get(envelope.id)).toMatchObject({ delivery: 'hold', expiresAt })
  })

  it('never presents expired or withdrawn ledger rows', async () => {
    const expired = say({ body: 'expired body', delivery: 'hold' })
    const withdrawn = say({ body: 'withdrawn body' })
    const live = say({ body: 'live body' })
    const expiredRow = ledger.envelopes.get(expired.id)
    const withdrawnRow = ledger.envelopes.get(withdrawn.id)
    if (expiredRow === undefined || withdrawnRow === undefined) throw new Error('missing rows')
    expiredRow.state = 'expired'
    expiredRow.terminal = true
    withdrawnRow.state = 'withdrawn'
    withdrawnRow.terminal = true

    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'live row dispatched')

    expect(deterministic.prompts()[0]).toContain('live body')
    expect(deterministic.prompts()[0]).not.toContain('expired body')
    expect(deterministic.prompts()[0]).not.toContain('withdrawn body')
    await waitUntil(
      () => ledger.envelopes.get(live.id)?.presentedTo.length === 1,
      'live presentation receipt'
    )
    expect(ledger.envelopes.get(live.id)?.presentedTo).toHaveLength(1)
    expect(ledger.envelopes.get(expired.id)?.presentedTo).toEqual([])
    expect(ledger.envelopes.get(withdrawn.id)?.presentedTo).toEqual([])
  })

  it('cues history per RUNTIME: cold on arrival, silent when warm, cold again after a /quit', async () => {
    await startServer()
    // A session that already exists and already has a runtime, so the cue
    // decision is about the runtime and not about a birth.
    const resolved = await fixture.resolveSession(SCOPE)
    const db = kickerStateDb(server as HrcServer)
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: `rt-${resolved.hostSessionId}-0`,
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server as HrcServer)

    // Two messages already in the room, so there IS history to cue. T-08094
    // delivers ONE ENVELOPE PER SUBMISSION, so the call count is the envelope
    // count and each prompt carries exactly one body.
    const first = say({ body: 'first' })
    say({ body: 'second' })
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 2, 'first drive')
    expect(deterministic.prompts()[0]).toContain('history: wrkc log T-07615')

    ledger.ack(first.id)
    await completeRun(server as HrcServer, deterministic.runIds()[0] as string)

    // Same WARM runtime, another message: it has seen this room, so no cue.
    say({ body: 'third' })
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 3, 'second drive')
    expect(deterministic.prompts()[2]).not.toContain('history:')

    await completeRun(server as HrcServer, deterministic.runIds()[2] as string)

    // /quit clears continuation WITHOUT rotating the generation, so the next
    // runtime reads cold and the cue comes back. That is the whole reason wrkq
    // keys this on runtimeId rather than generation.
    deterministic.rotateRuntime()
    say({ body: 'fourth' })
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 4, 'third drive')
    expect(deterministic.prompts()[3]).toContain('history: wrkc log T-07615')
  })

  it('previews and dispatches a fyi into an idle seat, then commits it with the accepted input', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = kickerStateDb(server as HrcServer)
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-fyi-seat',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server as HrcServer)
    // Make the target runtime cold to this already-active room, so the preview
    // must preserve the ledger-owned history cue in the dispatched prompt.
    say({
      toScopeRef: 'agent:other:project:hrc-runtime:task:T-07615',
      body: 'earlier room mail',
    })
    const envelope = say({
      obligation: 'fyi',
      body: 'for your information only',
    })

    await kicker().runSweepOnce()
    await waitUntil(
      () => ledger.envelopes.get(envelope.id)?.state === 'acked',
      'fyi presented and auto-acked'
    )
    expect(deterministic.calls()).toBe(1)
    expect(deterministic.prompts()[0]).toContain('for your information only')
    expect(deterministic.prompts()[0]).toContain('history: wrkc log T-07615')
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    const requests = ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ preview: true })
    expect(requests[1]).toMatchObject({ inputId: deterministic.inputIds()[0] })
    expect(ledger.envelopes.get(envelope.id)?.presentedTo[0]?.inputId).toBe(
      deterministic.inputIds()[0]
    )
  })

  it('never summons for a fyi, and completes the attempt as a no-op', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    // Establish the cursor first: a virgin daemon starts at "now", so anything
    // written before its first tail belongs to the sweep, not the tail.
    await kicker().runTailOnce()
    say({ obligation: 'fyi', body: 'for your information only' })

    // A fyi to an UNSEATED scope is not a wake: the tail skips it, so nothing
    // is provisioned. (A seated addressee is woken — see the next test.)
    await kicker().runTailOnce()
    // And a SWEEP that finds only a fyi for an unseated scope must not birth
    // one either — §5 says a fyi never summons, full stop.
    await kicker().runSweepOnce()
    await Bun.sleep(50)
    const db = kickerStateDb(server as HrcServer)
    expect(deterministic.calls()).toBe(0)
    expect(queryCount(db, 'sessions')).toBe(0)
    expect(db.mailDelivery.listOpenIntents(TARGET)).toHaveLength(0)
    expect(db.mailDelivery.presentationsForTarget(TARGET)).toHaveLength(0)
    expect(ledger.presentRequests).toEqual([])
  })

  // T-07746 acceptance 2 — the whole point of the change, and the bar the
  // design was rejected over twice. `notify` is the DEFAULT addressed say and
  // it MUST birth an unseated scope, exactly like reply_required, while owing
  // nothing back. This is the mirror of the fyi never-summons test above: same
  // setup, opposite verdict, so the pair pins both halves of the axis.
  it('SUMMONS an unseated target for a notify, though it owes nothing', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    // Establish the cursor first, as the fyi case does: anything written
    // before the first tail belongs to the sweep, not the tail.
    await kicker().runTailOnce()
    say({ obligation: 'notify', body: 'no reply owed, but wake up' })

    // The tail must treat this as a wake — the gate that used to read
    // `obligation !== 'reply_required'` and drop it.
    await kicker().runTailOnce()
    await waitUntil(() => deterministic.calls() === 1, 'notify delivery dispatched')

    const db = kickerStateDb(server as HrcServer)
    // A seat was actually born. Under the pre-T-07746 filter every one of
    // these is 0, which is exactly the defect this proves is gone.
    expect(deterministic.calls()).toBe(1)
    await waitUntil(
      () => db.mailDelivery.presentationsForTarget(TARGET).length === 1,
      'the summoned seat received the body'
    )
    expect(ledger.presentRequests.length).toBeGreaterThan(0)
  })

  it('summons a reply_required target through the gate and arms ONE reminder on a bare turn', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    await kicker().runTailOnce()
    const envelope = say()

    await kicker().runTailOnce()
    await waitUntil(() => deterministic.calls() === 1, 'tail-triggered summon')

    const db = kickerStateDb(server as HrcServer)
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)

    await waitUntil(
      () => db.mailDelivery.presentationsForTarget(TARGET).length === 1,
      'summoned presentation receipt'
    )

    await completeRun(server as HrcServer, deterministic.runIds()[0] as string)
    await waitUntil(
      () => db.mailDelivery.listDueReminders(TARGET, farFuture()).length === 1,
      'D4 reminder armed for the undisposed envelope'
    )
    const [reminder] = db.mailDelivery.listDueReminders(TARGET, farFuture())
    expect(reminder?.envelopeId).toBe(envelope.id)
    // A DELAY, not a backoff: one minute from the turn that left it undisposed.
    expect(Date.parse(reminder?.reminderDueAt ?? '') - Date.now()).toBeGreaterThan(30_000)
    // rev 5.1 D2: nothing re-presents it in the meantime.
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('presented')
    expect(ledger.failRequests).toEqual([])
  })

  it('arms no reminder for a turn that answered the envelope', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'drive dispatched')

    // The reply IS the ack; by the time the turn ends the obligation is gone.
    ledger.ack(envelope.id)
    const db = kickerStateDb(server as HrcServer)
    await completeRun(server as HrcServer, deterministic.runIds()[0] as string)
    await Bun.sleep(80)
    expect(db.mailDelivery.listDueReminders(TARGET, farFuture())).toEqual([])
  })

  it('declines to drive at all while wrkq is unreachable', async () => {
    say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    ledger.unavailable = true
    kicker().wake(TARGET, 'insert')
    await kicker().runSweepOnce()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(0)
    const db = kickerStateDb(server as HrcServer)
    expect(db.mailDelivery.listOpenIntents(TARGET)).toHaveLength(0)
  })

  it('tails the ledger from a persisted cursor and never replays it', async () => {
    // Traffic that predates this daemon. Replaying it would re-drive every
    // historical envelope, which is the no-cursor leak T-07620 names; the sweep,
    // not the tail, is what covers a backlog.
    say({ body: 'from before this daemon existed' })
    say({ body: 'also from before' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const db = kickerStateDb(server as HrcServer)

    await kicker().runTailOnce()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(0)
    const afterFirst = db.wrkqLedgerCursors.get() as number
    expect(afterFirst).toBeGreaterThan(0)

    say({ body: 'arrived while the daemon was up' })
    await kicker().runTailOnce()
    // The wake reads the whole PENDING view, and one envelope per submission
    // means all three backlog rows go out as three submissions. What the cursor
    // proves is that the tail did not REPLAY them as three wakes.
    await waitUntil(() => deterministic.calls() === 3, 'tail woke the new envelope')
    expect(db.wrkqLedgerCursors.get()).toBeGreaterThan(afterFirst)

    // A second tail over the same ground finds nothing new.
    await kicker().runTailOnce()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(3)
  })

  it('resumes the tail from the persisted cursor rather than sweeping for a cold scope', async () => {
    await startServer()
    await kicker().runTailOnce()
    const db = kickerStateDb(server as HrcServer)
    const cursorBefore = db.wrkqLedgerCursors.get() as number
    await (server as unknown as HrcServer).stop()
    server = undefined

    // The envelope arrives while this node is DOWN. Nothing local knows the
    // scope, so the sweep -- which only covers seated scopes -- cannot find it.
    say()

    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const reopened = kickerStateDb(server as HrcServer)
    expect(reopened.wrkqLedgerCursors.get()).toBe(cursorBefore)

    await kicker().runTailOnce()
    await waitUntil(() => deterministic.calls() === 1, 'tail replayed the downtime gap')
  })

  it('sweeps only the scopes this node is seating, plus attempts in flight', async () => {
    await startServer()
    const db = kickerStateDb(server as HrcServer)
    const scopes: string[][] = []
    const realPendingView = ledger.pendingView.bind(ledger)
    ledger.pendingView = async (params) => {
      if (params.scopes !== undefined) scopes.push(params.scopes)
      return realPendingView(params)
    }

    // A pending envelope for a scope with no seat here: the sweep must not go
    // looking for it, because a sweep that widens with history is a load bug.
    say()
    await kicker().runSweepOnce()
    expect(scopes.flat()).not.toContain(TARGET)

    const resolved = await fixture.resolveSession(SCOPE)
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-seated',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server as HrcServer)
    await kicker().runSweepOnce()
    await waitUntil(() => deterministic.calls() === 1, 'seated scope swept')
  })
})
