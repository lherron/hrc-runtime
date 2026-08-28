import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
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
const PRESENTED_TO_LIVE_HARNESS = {
  code: 'presented_to_live_harness',
  delivery: 'presented',
  deliverySemantics: 'pane_presentation',
  ackSemantics: 'pane_write_only',
} as const

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
function installShapeOneDispatch(steerOutcome: unknown | 'throw'): () => Dispatch[] {
  const instance = server as HrcServer
  const calls: Dispatch[] = []
  let driveRunId: string | undefined
  serverInternals(instance).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    prompt: string,
    options: { runId?: string | undefined; whenBusy?: string | undefined }
  ): Promise<Response> => {
    const whenBusy = options.whenBusy ?? 'reject'
    calls.push({ whenBusy, prompt, runId: options.runId })
    if (whenBusy === 'steer') {
      if (steerOutcome === 'throw') throw new Error('no steerable broker endpoint')
      return Response.json({ runId: driveRunId, delivery: steerOutcome })
    }

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

describe('T-07644 — urgent reaches the steer past an in-flight kicker attempt', () => {
  it('steers an urgent envelope into the turn the kicker itself started', async () => {
    await startServer()
    const calls = installShapeOneDispatch(PRESENTED_TO_LIVE_HARNESS)
    await summonIntoKickerTurn(calls)

    const urgent = say({ urgent: true, body: 'the urgent body' })
    const lines = await withServerLog(async (captured) => {
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'in-flight decline logged'
      )
    })

    // POSITIVE: the steer path was entered. Not "no error appeared" -- the old
    // failure was a bare return, which no absence assertion can distinguish
    // from a working system.
    const steers = calls().filter((call) => call.whenBusy === 'steer')
    expect(steers).toHaveLength(1)
    expect(steers[0]?.prompt ?? '').toContain('the urgent body')

    // The ledger carries the receipt, and the redelivery bound did NOT move:
    // a mid-turn steer is the weakest possible evidence anyone read it.
    expect(ledger.envelopes.get(urgent.id)?.presentedTo).toHaveLength(1)
    expect(ledger.roundEndedCalls).not.toContain(urgent.id)

    const steered = lines.filter((line) => line.includes('wrkq.kicker.urgent_steered'))
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain('presented_to_live_harness')
    // The decline line names the attempt holding the slot, and says a steer
    // landed. Before T-07644 this branch produced no line at all.
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).toContain('"urgentSteered":true')
    expect(inFlight[0]).toContain(TARGET)
  })

  it('declines an ordinary envelope out loud instead of returning silently', async () => {
    await startServer()
    const calls = installShapeOneDispatch(PRESENTED_TO_LIVE_HARNESS)
    await summonIntoKickerTurn(calls)

    const ordinary = say({ body: 'this one can wait for the turn to end' })
    const lines = await withServerLog(async (captured) => {
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'in-flight decline logged'
      )
    })

    // Waiting is correct for ordinary mail; being INVISIBLE while waiting is
    // not. A scope in this shape never reached `target_busy`, so a zero counter
    // read the same as a dead kicker.
    expect(calls().filter((call) => call.whenBusy === 'steer')).toHaveLength(0)
    expect(ledger.envelopes.get(ordinary.id)?.state).toBe('pending')
    expect(ledger.envelopes.get(ordinary.id)?.presentedTo).toEqual([])
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).not.toContain('urgentSteered')
    // The payload names the attempt holding the slot, and is deliberately NOT
    // `target_busy`: "a drive is in flight here" and "the addressee is mid-turn
    // on its own run" are different conditions, and one counter cannot mean
    // both (mable, C-16626).
    expect(inFlight[0]).toContain('"driveAttemptId"')
    expect(inFlight[0]).toContain('"runId"')
    expect(lines.filter((line) => line.includes('wrkq.kicker.target_busy'))).toHaveLength(0)
  })

  it('interrupts the kicker-driven turn at most once for the same envelope', async () => {
    await startServer()
    const calls = installShapeOneDispatch(PRESENTED_TO_LIVE_HARNESS)
    await summonIntoKickerTurn(calls)

    say({ urgent: true })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => calls().filter((call) => call.whenBusy === 'steer').length === 1,
      'first steer'
    )

    // Rounds never advance for a steer, so nothing else bounds this: without
    // the once-per-run gate every later wake would re-interrupt the same turn.
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await Bun.sleep(80)
    expect(calls().filter((call) => call.whenBusy === 'steer')).toHaveLength(1)
  })

  it('records nothing when the steer fails typed, and still says so', async () => {
    await startServer()
    const calls = installShapeOneDispatch('throw')
    await summonIntoKickerTurn(calls)

    const urgent = say({ urgent: true })
    const lines = await withServerLog(async (captured) => {
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'in-flight decline logged'
      )
    })

    expect(calls().filter((call) => call.whenBusy === 'steer')).toHaveLength(1)
    // Nothing honest could be proven, so no receipt: a presentation that did
    // not happen is worse recorded than absent. It stays exactly as pending as
    // it was -- not downgraded to a queue, because the queue is where it is.
    expect(ledger.envelopes.get(urgent.id)?.presentedTo).toEqual([])
    expect(ledger.envelopes.get(urgent.id)?.state).toBe('pending')
    expect(lines.filter((line) => line.includes('wrkq.kicker.urgent_steer_failed'))).toHaveLength(1)
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).not.toContain('urgentSteered')
  })
})
