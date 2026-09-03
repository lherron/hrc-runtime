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
  ;(instance as any).getHarnessBrokerController = () => ({
    seatProbe: async () => ({
      ok: true as const,
      response: {
        invocationId: 'inv-kicker-live',
        seat: { state: 'turn-active' as const, turnId: 'turn-kicker-live', policy: 'open' },
        brokerHeldDepth: 0,
      },
    }),
    turnManifest: async () => ({
      ok: true as const,
      response: {
        invocationId: 'inv-kicker-live',
        turnId: 'turn-kicker-live',
        policy: 'open' as const,
        submissionIds: [],
      },
    }),
  })
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

  it('does not infer a busy seat from the claim-race run row', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await holdTheSlotViaClaim('started')

    const mail = say({ body: 'mail through the claim race' })
    const lines = await withServerLog(async (captured) => {
      ;(server as any).mailKicker.wake(TARGET, 'insert')
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.drive_in_flight')),
        'claim-route decline logged'
      )
    })

    expect(calls().filter((call) => call.phase === 'enqueue')).toHaveLength(0)
    expect(ledger.envelopes.get(mail.id)?.presentedTo).toEqual([])

    // The discriminators are what make the two routes tellable apart in a log.
    const inFlight = lines.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).toContain('"via":"claim"')
    expect(inFlight[0]).toContain('"observation":"waiting"')
    expect(inFlight[0]).toContain('"observedSeatState":"absent"')
    expect(inFlight[0]).not.toContain('heldOrPreemptedDelivery')
  })

  it('re-drives a finished attempt found by the claim, instead of dropping the wake', async () => {
    await startServer()
    const calls = installShapeOneDispatch('accept')
    await holdTheSlotViaClaim('completed')

    say({ body: 'work that must not be dropped by the race' })
    ;(server as any).mailKicker.wake(TARGET, 'insert')
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
