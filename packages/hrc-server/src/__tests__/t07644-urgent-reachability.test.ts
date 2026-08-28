import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  completeRun,
  installMailKickerAgentHome,
  serverInternals,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07644 — `--urgent` was unreachable for a seat the KICKER summoned.
 *
 * There are two disjoint busy shapes and the steer was dead in only one:
 *
 *  - SHAPE 1, a seat busy on an in-flight kicker drive attempt. `observeAttempt`
 *    returns `'waiting'` and the old code returned there, bare and unlogged —
 *    above the steer, which sits inside `if (attempt === undefined)`. Unreachable,
 *    not merely skipped. This is the defect.
 *  - SHAPE 2, a seat busy on its OWN dispatch with no kicker attempt. The steer
 *    branch runs and `--urgent` has always worked. Covered by t07616.
 *
 * Which makes the obvious test for this feature a FALSE PASS: a seat you happen
 * to notice is busy is usually shape 2, where the steer fires and the defect
 * ships anyway. So every case here builds shape 1 the way production does — the
 * kicker summons the seat with ordinary mail, and only then does the urgent
 * envelope arrive — and asserts POSITIVELY that the steer was reached. The old
 * failure was a silent return, so "no error appeared" passes trivially and
 * proves nothing.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07644/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07644'
const SENDER = 'mable@hrc-runtime:T-07644'

/** One honest T-07203 success class; which one is that contract's business. */

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-urgent-reach-')
  ledger = new FakeWrkqLedger()
  restoreAgentHome = (await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')).restore
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
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07644', ...overrides })
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  return server
}

type Dispatch = { whenBusy: string; prompt: string; runId?: string | undefined }

/**
 * A dispatch that answers both halves of shape 1.
 *
 * The DRIVE call mints a real runtime, a durably active run and the
 * `turn.started` the attempt records its start from — that is what makes
 * `observeAttempt` report `'waiting'`, which is the whole precondition. The
 * STEER call is distinguished by `whenBusy`, so "the steer was reached" is
 * observable rather than inferred from a body appearing somewhere.
 */
function installShapeOneDispatch(steerOutcome: 'accept' | 'throw'): () => Dispatch[] {
  const instance = server as HrcServer
  const calls: Dispatch[] = []
  let driveRunId: string | undefined
  serverInternals(instance).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    prompt: string,
    options: { runId?: string | undefined; whenBusy?: string | undefined }
  ): Promise<Response> => {
    // rev 4: a slot-less mid-turn delivery carries no runId; the ordinary
    // drive carries the attempt's. Neither carries `whenBusy` any more.
    const whenBusy = options.runId === undefined ? 'queued' : 'drive'
    calls.push({ whenBusy, prompt, runId: options.runId })
    expect(options.whenBusy).toBeUndefined()
    if (whenBusy === 'queued') {
      if (steerOutcome === 'throw') throw new Error('broker refused the input')
      return Response.json({
        runId: 'run-queued',
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: `rt-${session.hostSessionId}`,
        transport: 'headless',
        status: 'started',
        inputId: 'input-queued',
        supportsInFlightInput: false,
      })
    }
    void driveRunId

    const db = serverInternals(instance).db
    const runId = options.runId as string
    driveRunId = runId
    const now = timestamp()
    const runtimeId = `rt-${session.hostSessionId}`
    db.runtimes.insert({
      runtimeId,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    serverInternals(instance).notifyEvent(
      appendHrcEvent(db, 'turn.started', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId,
        runId,
        transport: 'headless',
      })
    )
    return Response.json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
    })
  }
  return () => calls
}

/** Drive the target once from ordinary mail, leaving a kicker attempt in flight. */
async function summonIntoKickerTurn(calls: () => Dispatch[]): Promise<void> {
  say({ body: 'the ordinary work that started the turn' })
  ;(server as any).requestMailKickerWake(TARGET, 'insert')
  await waitUntil(() => calls().length === 1, 'kicker summoned the seat')
  const db = serverInternals(server as HrcServer).db
  await waitUntil(
    () => db.mailDrives.getActiveAttempt(TARGET)?.state === 'started',
    'drive attempt in flight'
  )
}

async function withServerLog<T>(run: (lines: string[]) => Promise<T>): Promise<string[]> {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    await run(lines)
  } finally {
    process.stderr.write = original
  }
  return lines
}

describe('T-07644 / rev 4 — mail reaches a seat past an in-flight kicker attempt', () => {
  it('queues a plain envelope into the turn the kicker itself started', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)

    const mail = say({ body: 'the mid-turn body' })
    const lines = await withServerLog(async (captured) => {
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'in-flight line logged'
      )
    })

    // POSITIVE: the delivery path was entered. Not "no error appeared" -- the
    // old failure was a bare return, which no absence assertion can distinguish
    // from a working system.
    const queued = calls().filter((call) => call.whenBusy === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]?.prompt ?? '').toContain('the mid-turn body')

    // The ledger carries the receipt, joined to the accepted input, and the
    // redelivery bound did NOT move: a slot-less delivery advances no round.
    const receipts = ledger.envelopes.get(mail.id)?.presentedTo ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.inputId).toBe('input-queued')
    expect(receipts[0]?.runId).toBe('run-queued')
    expect(receipts[0]?.deliveryOutcome).toBe('queued_to_live_harness')
    expect(ledger.roundEndedCalls).not.toContain(mail.id)

    expect(
      lines.filter((line) => line.includes('wrkq.kicker.queued_into_busy_target'))
    ).toHaveLength(1)
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).toContain('"queuedDelivery":true')
    expect(inFlight[0]).toContain(TARGET)
    expect(inFlight[0]).toContain('"via":"active-attempt"')
    expect(inFlight[0]).toContain('"observation":"waiting"')
    // The slot is still declined -- one kicker drive per scope -- but the mail
    // never waited on it, and nothing was logged as a busy wait.
    expect(inFlight[0]).toContain('"driveAttemptId"')
    expect(lines.filter((line) => line.includes('wrkq.kicker.target_busy'))).toHaveLength(0)
  })

  it('advances the round when the turn it joined ends undisposed (daedalus flaw 1, rev 4)', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)
    const db = serverInternals(server as HrcServer).db
    const holder = db.mailDrives.getActiveAttempt(TARGET)
    if (holder === undefined) throw new Error('no attempt holds the slot')

    const mail = say({ body: 'ignored mid-turn' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => (ledger.envelopes.get(mail.id)?.presentedTo.length ?? 0) === 1,
      'mid-turn receipt'
    )
    // Joined to the attempt holding the slot, not left slot-less: an envelope
    // nobody answers must still exhaust to `dead` (§6).
    expect(db.mailDrives.presentationEnvelopeIds(holder.driveAttemptId)).toContain(mail.id)

    await completeRun(server as HrcServer, holder.runId)
    await waitUntil(() => ledger.roundEndedCalls.includes(mail.id), 'round advanced at turn end')
    expect(ledger.envelopes.get(mail.id)?.roundCount).toBe(1)
  })

  it('hands the same envelope to the seat at most once per floor window', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)

    say()
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => calls().filter((call) => call.whenBusy === 'queued').length === 1,
      'first delivery'
    )
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await Bun.sleep(80)
    expect(calls().filter((call) => call.whenBusy === 'queued')).toHaveLength(1)
  })

  it('records nothing when the broker refuses the input, and still says so', async () => {
    await startServer()
    const calls = installShapeOneDispatch('throw')
    await summonIntoKickerTurn(calls)

    const mail = say()
    const lines = await withServerLog(async (captured) => {
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'in-flight line logged'
      )
    })

    expect(calls().filter((call) => call.whenBusy === 'queued')).toHaveLength(1)
    expect(ledger.envelopes.get(mail.id)?.presentedTo).toEqual([])
    expect(ledger.envelopes.get(mail.id)?.state).toBe('pending')
    expect(lines.filter((line) => line.includes('wrkq.kicker.busy_delivery_failed'))).toHaveLength(
      1
    )
    expect(lines.filter((line) => line.includes('deliveryOutcome'))).toHaveLength(0)
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).not.toContain('queuedDelivery')
  })
})

/**
 * The CLAIM route (T-07644 C-16642).
 *
 * `getActiveAttempt` runs at the top of the drive; the claim CAS runs thirty
 * lines further down. Between them another wake can take the slot, so the claim
 * reports `active` for an attempt the top of the function never saw. That
 * branch used to be a bare `if (observation !== 'dispatch') return`, which
 * subsumed BOTH live observations: `waiting` — the state this whole task exists
 * to instrument, with the steer unreachable behind it exactly as at the old
 * :538 — and `finished`, which the top of the same function deliberately
 * re-drives.
 *
 * The setup below is the real shape rather than a contrived one: an attempt
 * holding the slot over a run row that is still active, while the runtime shows
 * `ready` with no `activeRunId`. That is a state observed live on max3
 * (T-07653), and it is also the only way the claim race is reachable at all —
 * the runtime must look idle, or the drive's ordinary path answers first.
 */
describe('T-07644 — the claim route answers the same way the active-attempt route does', () => {
  /** A slot held by an attempt whose run is active, over a NOT-busy runtime. */
  async function holdTheSlotViaClaim(runStatus: 'started' | 'completed'): Promise<void> {
    const instance = server as HrcServer
    const db = serverInternals(instance).db
    const resolved = await fixture.resolveSession(SCOPE)
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-idle',
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
    const held = say({ body: 'the envelope the racing wake claimed for' })
    const claim = db.mailDrives.claim(TARGET, 'insert', { envelopeIds: [held.id] })
    if (claim.outcome === 'clear') throw new Error('fixture failed to claim the slot')
    db.runs.insert({
      runId: claim.attempt.runId,
      hostSessionId: resolved.hostSessionId,
      runtimeId: 'rt-idle',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    if (runStatus === 'completed') {
      db.runs.markCompleted(claim.attempt.runId, {
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      })
    }
    // The race itself, reproduced exactly: the drive's read at the top of the
    // function misses, and the claim CAS -- which does its own read a moment
    // later -- finds the slot already held. Missing only the FIRST read is what
    // makes this the race rather than a broken repository.
    const realGetActiveAttempt = db.mailDrives.getActiveAttempt.bind(db.mailDrives)
    let missOnce = true
    db.mailDrives.getActiveAttempt = (target: string) => {
      if (missOnce) {
        missOnce = false
        return undefined
      }
      return realGetActiveAttempt(target)
    }
  }

  it('queues an envelope discovered through the claim race into the live turn', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await holdTheSlotViaClaim('started')

    const mail = say({ body: 'mail through the claim race' })
    const lines = await withServerLog(async (captured) => {
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'claim-route decline logged'
      )
    })

    const queued = calls().filter((call) => call.whenBusy === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]?.prompt ?? '').toContain('mail through the claim race')

    const receipts = ledger.envelopes.get(mail.id)?.presentedTo ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.deliveryOutcome).toBe('queued_to_live_harness')

    // The discriminators are what make the two routes tellable apart in a log.
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).toContain('"via":"claim"')
    expect(inFlight[0]).toContain('"observation":"waiting"')
    expect(inFlight[0]).toContain('"queuedDelivery":true')
  })

  it('re-drives a finished attempt found by the claim, instead of dropping the wake', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await holdTheSlotViaClaim('completed')

    say({ body: 'work that must not be dropped by the race' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    // The finished attempt released the slot, so the re-entry claims a fresh
    // one and drives. Dropping the wake here would strand the envelope until
    // some unrelated later traffic happened to wake the scope again.
    await waitUntil(
      () => calls().filter((call) => call.whenBusy === 'drive').length === 1,
      'wake re-driven after the finished attempt'
    )
    const db = serverInternals(server as HrcServer).db
    expect(db.mailDrives.listAttempts(TARGET).length).toBeGreaterThan(1)
  })
})
