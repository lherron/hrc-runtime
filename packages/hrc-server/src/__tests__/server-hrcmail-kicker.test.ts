import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'
import type { MailKicker } from 'hrc-mail-kicker'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDriveAttempt } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { resolveHrcMailKickerEnabled } from '../option-resolvers.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  completeRun,
  installDeterministicStart,
  installMailKickerAgentHome,
  queryCount,
  serverInternals,
  startedRunId,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07615 (T-07612 wave 3) — HRC drives the wrkq collaboration ledger.
 *
 * The spec's §15 bundle-2 consumer half: presented exactly once per
 * driveAttemptId across insert/completion/sweep races and a kill between
 * attempt persistence and dispatch; `fyi` never births an unseated scope but
 * is delivered into an existing generation; `reply_required` summons through
 * the summon gate; the `history:` cue is keyed to the runtime.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07615/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07615'
const SENDER = 'mable@hrc-runtime:T-07615'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let crashChild: ReturnType<typeof Bun.spawn> | undefined
let agentsRoot: string
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-kicker-')
  ledger = new FakeWrkqLedger()
  const home = await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')
  agentsRoot = home.agentsRoot
  restoreAgentHome = home.restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  if (crashChild !== undefined) {
    crashChild.kill(9)
    await crashChild.exited.catch(() => undefined)
    crashChild = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, ...overrides })
}

const kicker = (): MailKicker => (server as any).mailKicker

function farFuture(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString()
}

async function startServer(options: Record<string, unknown> = {}): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      ...options,
    })
  )
  return server
}

/**
 * T-07612 rev 4: a busy seat is presented slot-less with the route's queue
 * policy. The double answers like the route does for a queued input: a run
 * row in `accepted`, `status:'started'`, an inputId.
 */
function installQueuedDispatch(serverInstance: HrcServer): { calls: () => number } {
  let calls = 0
  ;(serverInstance as any).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: unknown,
    _prompt: string
  ): Promise<Response> => {
    calls += 1
    const db = (serverInstance as any).db as HrcDatabase
    const runtime = db.runtimes.listByHostSessionId(session.hostSessionId).at(-1)
    const runId = `run-queued-${calls}`
    const now = timestamp()
    db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime?.runtimeId ?? 'rt-busy-v1',
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })
    return Response.json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime?.runtimeId ?? 'rt-busy-v1',
      transport: 'headless',
      status: 'started',
      inputId: `input-${runId}`,
      supportsInFlightInput: false,
    })
  }
  return { calls: () => calls }
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

  it('presents exactly once per driveAttemptId across racing insert/completion/sweep wakes', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    kicker().wake(TARGET, 'turn_completion')
    await Promise.all([kicker().runSweepOnce(), kicker().runSweepOnce()])
    await waitUntil(() => deterministic.calls() === 1, 'one dispatched drive')

    const db = (server as any).db as HrcDatabase
    const attempts = db.mailDrives.listAttempts(TARGET)
    expect(attempts).toHaveLength(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)

    await Promise.all([kicker().runSweepOnce(), kicker().runSweepOnce()])
    expect(deterministic.calls()).toBe(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  it('mints the canonical completed-turn response through the full server path', async () => {
    const envelope = say({ body: 'answer this without a manual say' })
    await startServer()
    installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')

    const db = serverInternals(server as HrcServer).db
    const runId = await startedRunId(db, TARGET, 0)
    const run = db.runs.getByRunId(runId)
    if (run === null) throw new Error(`missing started run ${runId}`)
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

    await waitUntil(() => ledger.roomSayRequests.length === 1, 'auto reply minted')
    expect(ledger.roomSayRequests[0]).toMatchObject({
      ref: envelope.roomKey,
      body: 'server-path final response',
      to: [SENDER],
      idempotencyKey: expect.stringMatching(/^auto-reply:drive-/),
      meta: { auto: 'turn_final' },
      principalRef: 'agent:kicker-proof',
      scopeRef: 'kicker-proof@hrc-runtime:T-07615',
    })
    expect(db.mailDrives.listPendingAutoReplyIntents()).toEqual([])
    expect(db.mailDrives.listAttempts(TARGET)[0]?.state).toBe('completed')
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
    expect(prompt).not.toContain('reply: wrkc say')
    // rev 5.1: the id is no longer internal. The defer line has to name the row
    // the reader is being asked to defer. A completed driven turn replies via
    // the auto-minted canonical response, so no manual reply hint is injected.
    expect(prompt).toContain(`defer: wrkc defer ${envelope.id} --reason …`)
    // No room history is ever injected; the first message in a room has no cue.
    expect(prompt).not.toContain('history:')
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

    expect(deterministic.submissionDoors()).toEqual(['enqueue'])
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
    expect(ledger.envelopes.get(live.id)?.presentedTo).toHaveLength(1)
    expect(ledger.envelopes.get(expired.id)?.presentedTo).toEqual([])
    expect(ledger.envelopes.get(withdrawn.id)?.presentedTo).toEqual([])
  })

  it('cues history per RUNTIME: cold on arrival, silent when warm, cold again after a /quit', async () => {
    await startServer()
    // A session that already exists and already has a runtime, so the cue
    // decision is about the runtime and not about a birth.
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
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

    // Two messages already in the room, so there IS history to cue.
    const first = say({ body: 'first' })
    say({ body: 'second' })
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first drive')
    expect(deterministic.prompts()[0]).toContain('history: wrkc log T-07615')

    ledger.ack(first.id)
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))

    // Same WARM runtime, another message: it has seen this room, so no cue.
    say({ body: 'third' })
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 2, 'second drive')
    expect(deterministic.prompts()[1]).not.toContain('history:')

    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 1))

    // /quit clears continuation WITHOUT rotating the generation, so the next
    // runtime reads cold and the cue comes back. That is the whole reason wrkq
    // keys this on runtimeId rather than generation.
    deterministic.rotateRuntime()
    say({ body: 'fourth' })
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 3, 'third drive')
    expect(deterministic.prompts()[2]).toContain('history: wrkc log T-07615')
  })

  it('previews and dispatches a fyi into an idle seat, then commits it with the accepted input', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
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
    const db = (server as any).db as HrcDatabase
    expect(deterministic.calls()).toBe(0)
    expect(queryCount(db, 'sessions')).toBe(0)
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(0)
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
    await Bun.sleep(50)

    const db = (server as any).db as HrcDatabase
    // A seat was actually born. Under the pre-T-07746 filter every one of
    // these is 0, which is exactly the defect this proves is gone.
    expect(deterministic.calls()).toBe(1)
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
    expect(ledger.presentRequests.length).toBeGreaterThan(0)
  })

  it('summons a reply_required target through the gate and arms ONE reminder on a bare turn', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    await kicker().runTailOnce()
    const envelope = say()

    await kicker().runTailOnce()
    await waitUntil(() => deterministic.calls() === 1, 'tail-triggered summon')

    const db = (server as any).db as HrcDatabase
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)

    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    await waitUntil(
      () => db.mailDrives.listDueReminders(TARGET, farFuture()).length === 1,
      'D4 reminder armed for the undisposed envelope'
    )
    const [reminder] = db.mailDrives.listDueReminders(TARGET, farFuture())
    expect(reminder?.envelopeId).toBe(envelope.id)
    // A DELAY, not a backoff: one minute from the turn that left it undisposed.
    expect(Date.parse(reminder?.remindAt ?? '') - Date.now()).toBeGreaterThan(30_000)
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
    const db = (server as any).db as HrcDatabase
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    await Bun.sleep(80)
    expect(db.mailDrives.listDueReminders(TARGET, farFuture())).toEqual([])
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
    const db = (server as any).db as HrcDatabase
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(0)
  })

  it('tails the ledger from a persisted cursor and never replays it', async () => {
    // Traffic that predates this daemon. Replaying it would re-drive every
    // historical envelope, which is the no-cursor leak T-07620 names; the sweep,
    // not the tail, is what covers a backlog.
    say({ body: 'from before this daemon existed' })
    say({ body: 'also from before' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const db = (server as any).db as HrcDatabase

    await kicker().runTailOnce()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(0)
    const afterFirst = db.wrkqLedgerCursors.get() as number
    expect(afterFirst).toBeGreaterThan(0)

    say({ body: 'arrived while the daemon was up' })
    await kicker().runTailOnce()
    await waitUntil(() => deterministic.calls() === 1, 'tail woke the new envelope')
    expect(db.wrkqLedgerCursors.get()).toBeGreaterThan(afterFirst)

    // A second tail over the same ground finds nothing new.
    await kicker().runTailOnce()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(1)
  })

  it('resumes the tail from the persisted cursor rather than sweeping for a cold scope', async () => {
    await startServer()
    await kicker().runTailOnce()
    const db = (server as any).db as HrcDatabase
    const cursorBefore = db.wrkqLedgerCursors.get() as number
    await (server as unknown as HrcServer).stop()
    server = undefined

    // The envelope arrives while this node is DOWN. Nothing local knows the
    // scope, so the sweep -- which only covers seated scopes -- cannot find it.
    say()

    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const reopened = (server as any).db as HrcDatabase
    expect(reopened.wrkqLedgerCursors.get()).toBe(cursorBefore)

    await kicker().runTailOnce()
    await waitUntil(() => deterministic.calls() === 1, 'tail replayed the downtime gap')
  })

  it('sweeps only the scopes this node is seating, plus attempts in flight', async () => {
    await startServer()
    const db = (server as any).db as HrcDatabase
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

  it('does not infer a busy seat for fyi delivery from an HRC run row', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-busy-v1',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: 'run-busy-v1',
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: 'run-busy-v1',
      hostSessionId: resolved.hostSessionId,
      runtimeId: 'rt-busy-v1',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const queued = installQueuedDispatch(server as HrcServer)

    const envelope = say({
      obligation: 'fyi',
      body: 'do not wait for the active turn to finish',
    })
    kicker().wake(TARGET, 'insert')
    // T-07891: this fixture has no broker controller/turn observation. Its HRC
    // run row therefore cannot classify the seat as busy; this is an ordinary
    // slot-owning drive, and the fyi auto-acks on commit as before.
    await waitUntil(() => queued.calls() === 1, 'ordinary fyi delivery')
    await waitUntil(() => ledger.envelopes.get(envelope.id)?.state === 'acked', 'fyi commit')
    expect(db.mailDrives.getActiveAttempt(TARGET)).toBeDefined()
    expect(
      ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    ).toHaveLength(2)
  })

  // rev 5.1 D2, replacing rev 4's redelivery floor entirely. The floor existed
  // to slow a re-presentation down; there is no re-presentation to slow. The
  // four RATIFIED SCENARIOS and the D3 terminal-status matrix live in
  // `t07704-rev51-obligation-lifetime.test.ts`; what stays here is the kicker's
  // own unit behaviour.
  it('never re-presents a presented envelope, floor or no floor', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first drive')

    const db = (server as any).db as HrcDatabase
    await completeRun(server as HrcServer, await startedRunId(db, TARGET, 0))
    await waitUntil(
      () => db.mailDrives.listDueReminders(TARGET, farFuture()).length === 1,
      'reminder armed'
    )

    // Age the receipt by an hour: under rev 4 that alone bought a redelivery.
    const aged = ledger.envelopes.get(envelope.id)
    const receipt = aged?.presentedTo[aged.presentedTo.length - 1]
    if (receipt !== undefined) {
      receipt.presentedAt = new Date(Date.now() - 60 * 60_000).toISOString()
    }
    kicker().wake(TARGET, 'periodic')
    await kicker().drainTarget(TARGET)
    await Bun.sleep(50)
    // Still exactly one drive: the only thing that surfaces it again is its own
    // DUE reminder, and that one is held for a minute.
    expect(deterministic.calls()).toBe(1)
  })

  it('delivers a first presentation immediately — there is nothing to hold back', async () => {
    say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first delivery is immediate')
  })

  it('does not commit when dispatch throws after preview', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-preview-then-throw',
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
    ;(server as any).dispatchTurnForSession = async (): Promise<Response> => {
      throw new Error('dispatch rejected after preview')
    }
    const envelope = say({ obligation: 'fyi', body: 'must stay pending' })
    kicker().wake(TARGET, 'insert')
    await kicker().drainTarget(TARGET)

    const requests = ledger.presentRequests.filter((request) => request.envelope === envelope.id)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ preview: true })
    expect(ledger.envelopes.get(envelope.id)).toMatchObject({
      state: 'pending',
      terminal: false,
    })
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    expect(db.mailDrives.listAttempts(TARGET)[0]?.state).toBe('failed')
  })

  it('never treats a run row alone as observed busy-seat state', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-busy-visible',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: 'run-busy-visible',
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: 'run-busy-visible',
      hostSessionId: resolved.hostSessionId,
      runtimeId: 'rt-busy-visible',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const queued = installQueuedDispatch(server as HrcServer)

    const held = say()
    const captured = await captureServerLog(async () => {
      kicker().wake(TARGET, 'insert')
      await kicker().drainTarget(TARGET)
    })
    // T-07891: status/activeRunId are not busy authority. With no broker seat
    // observation this follows the ordinary slot-owning drive path.
    expect(queued.calls()).toBe(1)
    expect(captured.lines.some((line) => line.includes('wrkq.kicker.drive_claimed'))).toBe(true)
    expect(captured.lines.some((line) => line.includes('queue_batch_held'))).toBe(false)
    expect(captured.lines.some((line) => line.includes('queued_into_busy_target'))).toBe(false)
    expect(ledger.envelopes.get(held.id)?.presentedTo).toHaveLength(1)
  })

  it('releases the scope slot when this node cannot resolve the target placement', async () => {
    const stranded = 'agent:not-an-agent-here:project:wrkq:task:T-00001'
    const strandedTarget = `${stranded}/lane:main`
    await startServer()
    ledger.say({ toScopeRef: stranded, fromScopeRef: SENDER })

    const captured = await captureServerLog(async () => {
      kicker().wake(strandedTarget, 'insert')
      await kicker().drainTarget(strandedTarget)
    })
    expect(captured.lines.some((line) => line.includes('wrkq.kicker.placement_unresolvable'))).toBe(
      true
    )

    // The attempt must be FINISHED, not merely annotated: a `claimed` attempt
    // owns the slot, and the scope would be undrivable for as long as it lives.
    const db = (server as any).db as HrcDatabase
    expect(db.mailDrives.getSlot(strandedTarget)?.activeDriveAttemptId).toBeUndefined()
    expect(db.mailDrives.listInFlightTargets()).not.toContain(strandedTarget)
    const attempts = db.mailDrives.listAttempts(strandedTarget)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.state).toBe('failed')
  })

  it('B2.1: a daemon kill after the slot CAS recovers one attempt and one START', async () => {
    const markerPath = join(fixture.tmpDir, 'claimed.json')
    const serverEntry = resolve(import.meta.dir, '..', 'index.ts')
    const ledgerEntry = resolve(import.meta.dir, 'fixtures', 'fake-wrkq-ledger.ts')
    const childOptions = {
      runtimeRoot: fixture.runtimeRoot,
      stateRoot: fixture.stateRoot,
      socketPath: fixture.socketPath,
      lockPath: fixture.lockPath,
      spoolDir: fixture.spoolDir,
      dbPath: fixture.dbPath,
      tmuxSocketPath: fixture.tmuxSocketPath,
      otelListenerEnabled: false,
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
    }
    // The child seeds the SAME envelope id the parent will see, so the crash
    // boundary is the only difference between the two processes' ledgers.
    const childSource = `
        import { createHrcServer } from ${JSON.stringify(serverEntry)};
        import { FakeWrkqLedger } from ${JSON.stringify(ledgerEntry)};
        const options = JSON.parse(process.env.HRC_MAIL_CRASH_OPTIONS);
        const markerPath = process.env.HRC_MAIL_CRASH_MARKER;
        const ledger = new FakeWrkqLedger();
        ledger.say({ toScopeRef: ${JSON.stringify(SCOPE)}, fromScopeRef: ${JSON.stringify(SENDER)} });
        const server = await createHrcServer({
          ...options,
          wrkqLedger: ledger,
          hrcMailKickerAfterClaim: async (attempt) => {
            await Bun.write(markerPath, JSON.stringify(attempt));
            await new Promise(() => undefined);
          },
        });
        server.mailKicker.wake(${JSON.stringify(TARGET)}, 'insert');
        await new Promise(() => undefined);
      `
    crashChild = Bun.spawn({
      cmd: [process.execPath, '-e', childSource],
      env: {
        ...process.env,
        HRC_MAIL_CRASH_OPTIONS: JSON.stringify(childOptions),
        HRC_MAIL_CRASH_MARKER: markerPath,
        ASP_AGENTS_ROOT: agentsRoot,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    await waitUntil(async () => {
      try {
        await access(markerPath)
        return true
      } catch {
        return false
      }
    }, 'slot-persist crash marker')
    const claimed = JSON.parse(await readFile(markerPath, 'utf8')) as HrcMailDriveAttempt

    const beforeKill = openHrcDatabase(fixture.dbPath)
    try {
      expect(beforeKill.mailDrives.getSlot(TARGET)).toMatchObject({
        activeDriveAttemptId: claimed.driveAttemptId,
      })
      expect(beforeKill.mailDrives.listAttempts(TARGET)).toHaveLength(1)
      expect(beforeKill.runs.getByRunId(claimed.runId)).toBeNull()
      expect(queryCount(beforeKill, 'sessions')).toBe(0)
      expect(queryCount(beforeKill, 'runtimes')).toBe(0)
    } finally {
      beforeKill.close()
    }

    crashChild.kill(9)
    await crashChild.exited
    crashChild = undefined

    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    kicker().wake(TARGET, 'insert')
    kicker().wake(TARGET, 'turn_completion')
    await Promise.all([kicker().runSweepOnce(), kicker().runSweepOnce()])

    const db = (server as any).db as HrcDatabase
    const recovered = db.mailDrives.getAttempt(claimed.driveAttemptId)
    expect(recovered).toMatchObject({
      driveAttemptId: claimed.driveAttemptId,
      runId: claimed.runId,
      state: 'started',
      presentedCount: 1,
    })
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)
    expect(deterministic.calls()).toBe(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    expect(
      db.hrcEvents.listByRun(claimed.runId).filter((event) => event.eventKind === 'turn.started')
    ).toHaveLength(1)

    await Promise.all([kicker().runSweepOnce(), kicker().runSweepOnce()])
    expect(deterministic.calls()).toBe(1)

    ledger.ack(envelope.id)
    await completeRun(server as HrcServer, claimed.runId)
    await kicker().runSweepOnce()

    expect(db.mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(db.mailDrives.getAttempt(claimed.driveAttemptId)?.state).toBe('completed')
    expect(deterministic.calls()).toBe(1)
  }, 20_000)

  /**
   * T-07671 — RCA-grade logging.
   *
   * The RCA that produced this task had three `presented`+`acked` fyi
   * envelopes in the wrkq ledger, each stamped with a runId and a
   * driveAttemptId, and ZERO server-log lines for either drive. The only way to
   * learn that no turn was ever dispatched was to read `hrcmail_drive_attempts`
   * in `state.sqlite` by hand. These tests pin the lines that make that
   * reconstruction a `grep <scope>` instead.
   */
  it('leaves a full drive_claimed → turn_dispatched → presented trail for a fyi-only drive', async () => {
    await startServer()
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-fyi-trail',
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
    const envelope = say({
      obligation: 'fyi',
      body: 'for your information only',
    })

    const captured = await captureServerLog(async () => {
      kicker().wake(TARGET, 'insert')
      await kicker().drainTarget(TARGET)
      await waitUntil(
        () => ledger.envelopes.get(envelope.id)?.state === 'acked',
        'fyi presented and auto-acked'
      )
    })
    expect(deterministic.calls()).toBe(1)

    const kindLine = (kind: string): string => {
      const lines = captured.lines.filter((line) => line.includes(`wrkq.kicker.${kind}`))
      expect(lines).not.toHaveLength(0)
      return lines[lines.length - 1] as string
    }

    // Head of the timeline: the drive is committed and this daemon owns it.
    const claimed = kindLine('drive_claimed')
    expect(claimed).toContain(TARGET)
    expect(claimed).toContain(envelope.id)
    expect(claimed).toContain('"seated":true')

    const dispatched = kindLine('turn_dispatched')
    expect(dispatched).toContain(envelope.id)
    expect(dispatched).toContain(deterministic.inputIds()[0] as string)

    // The receipt the ledger holds is logged only after the accepted dispatch,
    // with the broker input that joins the two records.
    const presented = kindLine('presented')
    expect(presented).toContain(envelope.id)
    expect(presented).toContain('"obligation":"fyi"')
    expect(presented).toContain(resolved.hostSessionId)
    expect(presented).toContain(deterministic.inputIds()[0] as string)
    expect(captured.lines.some((line) => line.includes('"reason":"fyi_only"'))).toBe(false)
    expect(captured.lines.indexOf(dispatched)).toBeLessThan(captured.lines.indexOf(presented))
  })

  it('names the envelopes and the seat on the turn_dispatched line of a reply_required drive', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const envelope = say()

    const captured = await captureServerLog(async () => {
      kicker().wake(TARGET, 'insert')
      await waitUntil(() => deterministic.calls() === 1, 'drive dispatched')
    })

    const dispatched = captured.lines.filter((line) => line.includes('wrkq.kicker.turn_dispatched'))
    expect(dispatched).not.toHaveLength(0)
    const line = dispatched[dispatched.length - 1] as string
    expect(line).toContain(TARGET)
    expect(line).toContain(envelope.id)
    expect(line).toContain('"hostSessionId"')
    expect(line).toContain('"generation"')

    // The same driveAttemptId threads claim → presentation → dispatch, so one
    // grep of the scope reconstructs the drive in order.
    const db = (server as any).db as HrcDatabase
    const attempt = db.mailDrives.listAttempts(TARGET)[0] as HrcMailDriveAttempt
    for (const kind of ['drive_claimed', 'presented', 'turn_dispatched']) {
      const kindLines = captured.lines.filter((entry) => entry.includes(`wrkq.kicker.${kind}`))
      expect(kindLines).not.toHaveLength(0)
      expect(kindLines[kindLines.length - 1]).toContain(attempt.driveAttemptId)
    }
  })
})
