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
 * T-07644 — broker-held enqueue remains reachable for a seat the kicker summoned.
 *
 * There are two disjoint busy shapes and delivery was dead in only one:
 *
 *  - SHAPE 1, a seat busy on an in-flight kicker drive attempt. `observeAttempt`
 *    returns `'waiting'` and the old code returned there, bare and unlogged —
 *    above the delivery, which sits inside `if (attempt === undefined)`. Unreachable,
 *    not merely skipped. This is the defect.
 *  - SHAPE 2, a seat busy on its OWN dispatch with no kicker attempt. The
 *    enqueue branch has always worked. Covered by t07616.
 *
 * Which makes the obvious test for this feature a FALSE PASS: a seat you happen
 * to notice is busy is usually shape 2, where the steer fires and the defect
 * ships anyway. So every case here builds shape 1 the way production does — the
 * kicker summons the seat with ordinary mail, and only then does the next
 * envelope arrive — and asserts POSITIVELY that enqueue was reached. The old
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

type Dispatch = {
  phase: 'enqueue' | 'drive'
  prompt: string
  runId?: string | undefined
  submissionDoor?: string | undefined
  turnPolicy?: string | undefined
  envelopeId?: string | undefined
}

/**
 * A dispatch that answers both halves of shape 1.
 *
 * The DRIVE call mints a real runtime, a durably active run and the
 * `turn.started` the attempt records its start from — that is what makes
 * `observeAttempt` report `'waiting'`, which is the whole precondition. The
 * ENQUEUE call is distinguished by the absent drive run id, so delivery is
 * observable rather than inferred from a body appearing somewhere.
 */
function installShapeOneDispatch(enqueueOutcome: 'accept' | 'throw'): () => Dispatch[] {
  const instance = server as HrcServer
  const calls: Dispatch[] = []
  let driveRunId: string | undefined
  let queuedRuns = 0
  serverInternals(instance).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    prompt: string,
    options: {
      runId?: string | undefined
      submissionDoor?: string | undefined
      ttlMs?: number | undefined
      turnPolicy?: string | undefined
      submissionOrigin?: { envelopeId?: string | undefined } | undefined
    }
  ): Promise<Response> => {
    // A slot-less mid-turn delivery carries no runId; the ordinary drive
    // carries the attempt's. Both select enqueue explicitly with a TTL.
    const phase = options.runId === undefined ? 'enqueue' : 'drive'
    calls.push({
      phase,
      prompt,
      runId: options.runId,
      submissionDoor: options.submissionDoor,
      turnPolicy: options.turnPolicy,
      envelopeId: options.submissionOrigin?.envelopeId,
    })
    if (phase === 'drive') expect(options.submissionDoor).toBe('enqueue')
    expect(options.ttlMs).toBeGreaterThan(0)
    if (phase === 'enqueue') {
      if (enqueueOutcome === 'throw') throw new Error('broker refused the input')
      // The route writes an `accepted` run row for a queued input; its
      // turn.started arrives only if the harness runs it as its own turn.
      const db = serverInternals(instance).db
      const now = timestamp()
      queuedRuns += 1
      const queuedRunId = queuedRuns === 1 ? 'run-queued' : `run-queued-${queuedRuns}`
      {
        const liveRuntime = db.runtimes.listByHostSessionId(session.hostSessionId).at(-1)
        db.runs.insert({
          runId: queuedRunId,
          hostSessionId: session.hostSessionId,
          runtimeId: liveRuntime?.runtimeId ?? `rt-${session.hostSessionId}`,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          status: 'accepted',
          acceptedAt: now,
          updatedAt: now,
        })
      }
      return Response.json({
        runId: queuedRunId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: `rt-${session.hostSessionId}`,
        transport: 'headless',
        status: 'started',
        inputId: `input-${queuedRunId}`,
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
      controllerKind: 'harness-broker',
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
      activeInvocationId: 'inv-kicker-live',
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
async function summonIntoKickerTurn(calls: () => Dispatch[]): Promise<string> {
  const driving = say({ body: 'the ordinary work that started the turn' })
  ;(server as any).requestMailKickerWake(TARGET, 'insert')
  await waitUntil(() => calls().length === 1, 'kicker summoned the seat')
  const db = serverInternals(server as HrcServer).db
  await waitUntil(
    () => db.mailDrives.getActiveAttempt(TARGET)?.state === 'started',
    'drive attempt in flight'
  )
  return driving.id
}

function installLiveManifest(envelopeId: string, principalRef = 'agent:mable'): void {
  const instance = server as HrcServer
  const db = serverInternals(instance).db
  const runtime = db.sqlite
    .query<{ runtime_id: string }, []>(
      "SELECT runtime_id FROM runtimes WHERE active_invocation_id = 'inv-kicker-live' LIMIT 1"
    )
    .get()
  if (runtime === null) throw new Error('live kicker runtime missing')
  db.brokerInvocationEvents.appendEvent({
    invocationId: 'inv-kicker-live',
    seq: db.brokerInvocationEvents.maxBrokerSeq('inv-kicker-live') + 1,
    time: timestamp(),
    type: 'admission.requested',
    runtimeId: runtime.runtime_id,
    payload: {
      submissionId: `sub-${envelopeId}`,
      class: 'queue',
      origin: { principalRef, envelopeId },
      turnPolicy: 'guarded',
    },
  })
  ;(instance as any).getHarnessBrokerController = () => ({
    seatProbe: async () => ({
      ok: true,
      response: {
        invocationId: 'inv-kicker-live',
        seat: { state: 'turn-active', turnId: 'turn-kicker-live' },
        brokerHeldDepth: 0,
      },
    }),
    turnManifest: async () => ({
      ok: true,
      response: {
        invocationId: 'inv-kicker-live',
        turnId: 'turn-kicker-live',
        policy: 'guarded',
        submissionIds: [`sub-${envelopeId}`],
      },
    }),
  })
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

/**
 * The D4 reminders armed for one envelope, however far off their hold is.
 *
 * `listDueReminders` is the PRODUCTION predicate and takes a `now`; passing an
 * hour ahead asks "is one armed at all" without reaching past the repository
 * into its table.
 */
function remindersFor(db: HrcDatabase, envelopeId: string) {
  return db.mailDrives
    .listDueReminders(TARGET, new Date(Date.now() + 3_600_000).toISOString())
    .filter((reminder) => reminder.envelopeId === envelopeId)
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
    const queued = calls().filter((call) => call.phase === 'enqueue')
    expect(queued).toHaveLength(1)
    expect(queued[0]?.prompt ?? '').toContain('the mid-turn body')

    // The ledger carries the receipt, joined to the accepted input, and the
    // redelivery bound did NOT move: a slot-less delivery advances no round.
    const receipts = ledger.envelopes.get(mail.id)?.presentedTo ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.inputId).toBe('input-run-queued')
    expect(receipts[0]?.runId).toBe('run-queued')
    expect(receipts[0]?.deliveryOutcome).toBe('queued_to_live_harness')
    // A delivery is not a disposition: nothing about the obligation has moved.
    expect(ledger.failRequests).toEqual([])

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

  it("owns its disposition by the queued input's OWN turn, not the holder's (rev 4 flaw 1, kept by rev 5.1 D5)", async () => {
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
    // An attempt of its own, owned by the queued input's run, holding no slot.
    const queued = db.mailDrives
      .listUnfinishedAttempts(TARGET)
      .find((attempt) => attempt.runId === 'run-queued')
    expect(queued?.queuedBehindRunId).toBe(holder.runId)
    expect(db.mailDrives.getActiveAttempt(TARGET)?.driveAttemptId).toBe(holder.driveAttemptId)

    // Holder A ends. Headless FIFO: B has not run yet, so B's envelope was not
    // shown-and-ignored — nothing about it may be decided (daedalus, rev 4
    // second rejection). The 15s default grace keeps the merge rule out of this.
    await completeRun(server as HrcServer, holder.runId)
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await Bun.sleep(80)
    expect(remindersFor(db, mail.id)).toEqual([])

    // B starts and ends undisposed: now the round advances.
    const session = await fixture.resolveSession(SCOPE)
    const now = timestamp()
    serverInternals(server as HrcServer).notifyEvent(
      appendHrcEvent(db, 'turn.started', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: session.generation,
        runtimeId: `rt-${session.hostSessionId}`,
        runId: 'run-queued',
        transport: 'headless',
      })
    )
    await completeRun(server as HrcServer, 'run-queued')
    await waitUntil(() => remindersFor(db, mail.id).length === 1, 'reminder armed at B end')
    // ONE reminder, bound to the runtime that held it, and nothing failed yet:
    // strike one, not strike two.
    expect(remindersFor(db, mail.id)[0]?.runtimeId).toBe(
      ledger.envelopes.get(mail.id)?.presentedTo.at(-1)?.runtimeId
    )
    expect(ledger.failRequests).toEqual([])
  })

  it('decides nothing when the queued input never starts a turn, and never holds the slot', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)
    const db = serverInternals(server as HrcServer).db
    const holder = db.mailDrives.getActiveAttempt(TARGET)
    if (holder === undefined) throw new Error('no attempt holds the slot')

    const mail = say({ body: 'merged into the live turn by the harness' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => (ledger.envelopes.get(mail.id)?.presentedTo.length ?? 0) === 1,
      'mid-turn receipt'
    )

    // A ends; B never starts (a TUI that merges typed text mid-turn). HRC
    // cannot tell that from a slow B start and does not guess (daedalus, rev
    // 4 ruling 3): nothing is armed, nothing is struck out, the slot is free.
    // Under rev 5.1 the bound on this case is D3, not a floor.
    await completeRun(server as HrcServer, holder.runId)
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await Bun.sleep(80)
    expect(remindersFor(db, mail.id)).toEqual([])
    expect(db.mailDrives.getActiveAttempt(TARGET)).toBeUndefined()
    const queued = db.mailDrives.listUnfinishedAttempts(TARGET)
    expect(queued.map((attempt) => attempt.runId)).toEqual(['run-queued'])
    // Only the NEW mail rode the queued input: the holder's envelope was
    // already locally presented (its ledger commit may still be in flight).
    expect(db.mailDrives.presentationEnvelopeIds(queued[0]?.driveAttemptId ?? '')).toEqual([
      mail.id,
    ])

    // The seat goes busy again on a later turn A2. Under rev 4 the floor
    // expired here and the envelope was RE-QUEUED into A2 (ruling 4). rev 5.1
    // D2 deletes that outright: a `presented` envelope is bound to the runtime
    // in its newest receipt and is never presented again to anything.
    const owner = queued[0]
    if (owner?.runtimeId === undefined || owner.hostSessionId === undefined) {
      throw new Error('queued attempt has no runtime/session')
    }
    const liveRuntime = db.runtimes.getByRuntimeId(owner.runtimeId)
    if (liveRuntime === null) throw new Error('no runtime')
    const a2 = timestamp()
    db.runs.insert({
      runId: 'run-A2',
      hostSessionId: owner.hostSessionId,
      runtimeId: liveRuntime.runtimeId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: owner.generation ?? 1,
      transport: 'headless',
      status: 'started',
      acceptedAt: a2,
      startedAt: a2,
      updatedAt: a2,
    })
    db.runtimes.update(liveRuntime.runtimeId, {
      status: 'busy',
      activeRunId: 'run-A2',
      statusChangedAt: a2,
      updatedAt: a2,
    })
    const ledgerEnvelope = ledger.envelopes.get(mail.id)
    if (ledgerEnvelope?.presentedTo[0] === undefined) throw new Error('no receipt')
    ledgerEnvelope.presentedTo[0].presentedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await (server as any).drainMailKickerTarget(TARGET)
    await Bun.sleep(60)
    expect(ledger.envelopes.get(mail.id)?.presentedTo).toHaveLength(1)

    // The runtime dies before B ever starts. The attempts are reaped, and the
    // obligation LAPSES (D3) rather than waiting forever on a turn that will
    // never run: the sender is told and decides.
    const runtimeId = queued[0]?.runtimeId
    if (runtimeId === undefined) throw new Error('queued attempt has no runtime')
    const now = timestamp()
    db.runtimes.update(runtimeId, { status: 'terminated', statusChangedAt: now, updatedAt: now })
    const lines = await withServerLog(async () => {
      ;(server as any).requestMailKickerWake(TARGET, 'periodic')
      await (server as any).drainMailKickerTarget(TARGET)
      await (server as any).runMailKickerSweep()
      await waitUntil(
        () => ledger.envelopes.get(mail.id)?.state === 'failed',
        'D3 lapse on the dead runtime'
      )
    })
    expect(db.mailDrives.listUnfinishedAttempts(TARGET)).toHaveLength(0)
    const reaped = db.mailDrives
      .listAttempts(TARGET)
      .filter((attempt) => attempt.driveAttemptId.startsWith('queued-'))
    expect(reaped.map((attempt) => attempt.state)).toEqual(['failed'])
    expect(lines.some((line) => line.includes('wrkq.kicker.queued_attempt_reaped'))).toBe(true)
    expect(ledger.envelopes.get(mail.id)?.failureReason).toBe('runtime_terminated')
  })

  it('replays a ledger receipt lost between the local insert and the commit (ruling 5)', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)
    const db = serverInternals(server as HrcServer).db

    const mail = say({ body: 'accepted by the broker, commit interrupted' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => (ledger.envelopes.get(mail.id)?.presentedTo.length ?? 0) === 1,
      'mid-turn receipt'
    )
    const attempt = db.mailDrives
      .listUnfinishedAttempts(TARGET)
      .find((a) => a.runId === 'run-queued')
    if (attempt === undefined) throw new Error('no queued attempt')

    // The crash: local attempt + local receipt durable, ledger receipt never
    // written. Reproduced by erasing the ledger side only.
    const envelope = ledger.envelopes.get(mail.id)
    if (envelope === undefined) throw new Error('no envelope')
    envelope.presentedTo = []
    envelope.state = 'pending'
    // ...including wrkq's exactly-once marker: the ledger never saw the first
    // `present`, so the replay is the FIRST it records.
    for (const key of [...ledger.attemptReceipts]) {
      if (key.includes(attempt.driveAttemptId)) ledger.attemptReceipts.delete(key)
    }

    const lines = await withServerLog(async () => {
      ;(server as any).requestMailKickerWake(TARGET, 'periodic')
      await waitUntil(
        () => (ledger.envelopes.get(mail.id)?.presentedTo.length ?? 0) === 1,
        'receipt replayed'
      )
    })
    // Same attempt id — a replay, not a second presentation — and no second
    // broker input for it.
    expect(ledger.envelopes.get(mail.id)?.presentedTo[0]?.driveAttemptId).toBe(
      attempt.driveAttemptId
    )
    expect(calls().filter((call) => call.phase === 'enqueue')).toHaveLength(1)
    expect(lines.some((line) => line.includes('wrkq.kicker.queued_receipt_replayed'))).toBe(true)
    expect(ledger.envelopes.get(mail.id)?.state).toBe('presented')
  })

  it('hands the same envelope to the seat at most once per floor window', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)

    say()
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => calls().filter((call) => call.phase === 'enqueue').length === 1,
      'first delivery'
    )
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await Bun.sleep(80)
    expect(calls().filter((call) => call.phase === 'enqueue')).toHaveLength(1)
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

    expect(calls().filter((call) => call.phase === 'enqueue')).toHaveLength(1)
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

  it('authorizes a new busy hold when the live manifest carries another envelope from the same sender', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    const drivingEnvelopeId = await summonIntoKickerTurn(calls)

    const held = say({ body: 'interrupt now', delivery: 'hold' })
    installLiveManifest(drivingEnvelopeId)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => calls().length === 2, 'authorized hold dispatched')

    expect(calls()[1]).toMatchObject({
      phase: 'enqueue',
      submissionDoor: 'preempt',
      turnPolicy: 'guarded',
      envelopeId: held.id,
    })
    expect(ledger.envelopes.get(held.id)?.presentedTo).toHaveLength(1)
  })

  it('degrades an unauthorized busy hold to enqueue and records hold_refused_authority', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    const drivingEnvelopeId = await summonIntoKickerTurn(calls)

    const held = say({
      body: 'not the driving sender',
      delivery: 'hold',
      fromPrincipalRef: 'agent:other',
      fromScopeRef: 'other@hrc-runtime:T-07644',
    })
    installLiveManifest(drivingEnvelopeId)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => (ledger.envelopes.get(held.id)?.presentedTo.length ?? 0) === 1,
      'refused hold receipt'
    )

    expect(calls()[1]).toMatchObject({ submissionDoor: 'enqueue', envelopeId: held.id })
    expect(ledger.envelopes.get(held.id)?.presentedTo[0]?.deliveryOutcome).toBe(
      'hold_refused_authority'
    )
  })

  it('allows the real operator principal to preempt without a manifest match', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)

    const held = say({
      body: 'operator interruption',
      delivery: 'hold',
      fromPrincipalRef: 'agent:lance',
      fromScopeRef: undefined,
    })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => calls().length === 2, 'operator hold dispatched')

    expect(calls()[1]).toMatchObject({
      submissionDoor: 'preempt',
      turnPolicy: 'guarded',
      envelopeId: held.id,
    })
  })

  it('never batches a hold with ordinary mail', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await summonIntoKickerTurn(calls)

    const queued = say({ body: 'ordinary sibling' })
    const held = say({ body: 'isolated hold', delivery: 'hold' })
    installLiveManifest(held.id)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => calls().length === 3, 'isolated hold and follow-up queue dispatched')

    expect(calls()[1]?.envelopeId).toBe(held.id)
    expect(calls()[1]?.prompt).toContain('isolated hold')
    expect(calls()[1]?.prompt).not.toContain('ordinary sibling')
    expect(calls()[2]?.envelopeId).toBe(queued.id)
    expect(calls()[2]?.prompt).toContain('ordinary sibling')
    expect(calls()[2]?.submissionDoor).toBe('enqueue')
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

    const queued = calls().filter((call) => call.phase === 'enqueue')
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
      () => calls().filter((call) => call.phase === 'drive').length === 1,
      'wake re-driven after the finished attempt'
    )
    const db = serverInternals(server as HrcServer).db
    expect(db.mailDrives.listAttempts(TARGET).length).toBeGreaterThan(1)
  })
})
