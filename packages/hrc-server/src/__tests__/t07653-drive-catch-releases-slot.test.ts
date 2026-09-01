import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDriveAttempt } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  installDeterministicStart,
  installMailKickerAgentHome,
  serverInternals,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07653 (1) — `recordError` must never be the last write on a terminating
 * path.
 *
 * Both generic catches in the drive body annotated the attempt and returned.
 * `recordError` does not FINISH an attempt, and a `claimed` attempt owns its
 * scope's drive slot for as long as the row exists — so any throw at all left
 * the target permanently undrivable by this daemon, silently. Seven such rows
 * were found live on max3, the oldest holding its slot for ninety minutes
 * (T-07653 C-16724). T-07650 removed the most common producer of the throw;
 * it did not touch the amplifier, which is these two catches.
 *
 * The third case is the boundary the fix must NOT cross: an attempt that
 * already reached `started` proved a dispatch. Its slot belongs to the live
 * turn and its envelopes are already presented under that attempt id, so a
 * catch that finished it would release a held slot and re-present the same
 * envelopes under a new attempt. That one is annotated and left to the run's
 * terminal event.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07653/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07653'
const SENDER = 'mable@hrc-runtime:T-07653'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07653-catch-')
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
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07653', ...overrides })
}

async function startServer(options: Record<string, unknown> = {}): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // Only an explicit sweep drives anything: the proof is about one drive,
      // not about whichever timer happened to fire.
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      ...options,
    })
  )
  return server
}

function serverDb(): HrcDatabase {
  return serverInternals(server as HrcServer).db
}

/** Bind the scope to this node, so the drive reaches the body under test. */
function homeScopeHere(): void {
  createPlacementLedgerRepository(serverDb().sqlite).installActive({
    scopeRef: SCOPE,
    homeNodeId: (server as unknown as { federationNodeId: string }).federationNodeId,
    updatedAt: timestamp(),
  })
}

/**
 * A live local seat for the scope, so the sweep's candidate set names it.
 *
 * Seeded AFTER start: startup reconciliation marks a headless runtime with no
 * live process `stale`, and a stale seat is not in `listLiveSessionRefs()`.
 */
function seedLiveSeat(): void {
  const now = timestamp()
  serverDb().sessions.insert({
    hostSessionId: 'hs-t07653',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  serverDb().runtimes.insert({
    runtimeId: 'rt-t07653',
    runtimeKind: 'harness',
    hostSessionId: 'hs-t07653',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
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
}

async function sweep(): Promise<void> {
  await (server as unknown as { runMailKickerSweep: () => Promise<void> }).runMailKickerSweep()
}

function onlyAttempt(): HrcMailDriveAttempt {
  const attempts = serverDb().mailDrives.listAttempts(TARGET)
  expect(attempts).toHaveLength(1)
  return attempts[0] as HrcMailDriveAttempt
}

const TERMINAL_STATES = ['completed', 'failed', 'no_op']

describe('T-07653 — a thrown drive releases the scope drive slot', () => {
  it('finishes the attempt when the after-claim hook throws', async () => {
    say({ body: 'the after-claim hook is about to throw' })
    await startServer({
      hrcMailKickerAfterClaim: () => {
        throw new Error('after-claim exploded')
      },
    })
    homeScopeHere()
    seedLiveSeat()
    installDeterministicStart(server as HrcServer)

    const { lines } = await captureServerLog(async () => {
      await sweep()
    })

    expect(lines.filter((line) => line.includes('wrkq.kicker.after_claim_failed'))).toHaveLength(1)
    const attempt = onlyAttempt()
    expect(TERMINAL_STATES).toContain(attempt.state)
    expect(attempt.lastError).toContain('after-claim exploded')
    // The whole point: the slot is free, so the scope is drivable again.
    expect(serverDb().mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(serverDb().mailDrives.listInFlightTargets()).not.toContain(TARGET)
  })

  it('finishes the attempt when the drive body throws before any dispatch', async () => {
    say({ body: 'the drive body is about to throw' })
    await startServer()
    homeScopeHere()
    seedLiveSeat()
    serverInternals(server as HrcServer).dispatchTurnForSession = () => {
      throw new Error('dispatch exploded')
    }

    const { lines } = await captureServerLog(async () => {
      await sweep()
    })

    expect(lines.filter((line) => line.includes('wrkq.kicker.drive_failed'))).toHaveLength(1)
    const attempt = onlyAttempt()
    expect(TERMINAL_STATES).toContain(attempt.state)
    expect(attempt.lastError).toContain('dispatch exploded')
    expect(serverDb().mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(serverDb().mailDrives.listInFlightTargets()).not.toContain(TARGET)
  })

  it('is drivable again on the next wake, instead of wedged behind the dead attempt', async () => {
    say({ body: 'first drive throws' })
    await startServer()
    homeScopeHere()
    seedLiveSeat()
    let throwOnce = true
    const deterministic = installDeterministicStart(server as HrcServer)
    const realDispatch = serverInternals(server as HrcServer).dispatchTurnForSession
    serverInternals(server as HrcServer).dispatchTurnForSession = async (...args) => {
      if (throwOnce) {
        throwOnce = false
        throw new Error('one transient dispatch failure')
      }
      return realDispatch(...args)
    }

    await sweep()
    expect(deterministic.calls()).toBe(0)

    // A NEW envelope, because under rev 5.1 D2 the thrown one may already be
    // `presented` and therefore bound to that runtime rather than re-drivable.
    // What the wedge cost was never one envelope: a held slot made the scope
    // undrivable for EVERYTHING that arrived afterwards.
    say({ body: 'arrives after the failure and must still be delivered' })
    await sweep()
    await waitUntil(() => deterministic.calls() === 1, 'the next sweep drove the target')
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(2)
  })

  it('leaves a STARTED attempt holding its slot: the run terminal closes that one', async () => {
    say({ body: 'the throw lands after the turn is already before the harness' })
    await startServer()
    homeScopeHere()
    seedLiveSeat()
    const deterministic = installDeterministicStart(server as HrcServer)
    const realDispatch = serverInternals(server as HrcServer).dispatchTurnForSession
    // The live shape of this window: dispatch emits `turn.started` (which marks
    // the attempt `started`) and THEN something in the tail throws.
    serverInternals(server as HrcServer).dispatchTurnForSession = async (...args) => {
      await realDispatch(...args)
      throw new Error('threw after the turn started')
    }

    await sweep()

    expect(deterministic.calls()).toBe(1)
    const attempt = onlyAttempt()
    expect(attempt.state).toBe('started')
    expect(attempt.lastError).toContain('threw after the turn started')
    // Held on purpose: the turn owns it, and finishing it here would re-present
    // the same envelopes under a second attempt id.
    expect(serverDb().mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBe(attempt.driveAttemptId)
  })

  /**
   * T-07653 (2), end to end: the OTHER half of "held on purpose".
   *
   * Leaving a `started` attempt to its run's terminal event is only safe if
   * something eventually produces that terminal event. When the runtime lets go
   * of the run without one, the reconciler is what closes it — and the kicker,
   * a pure reader of the run row, picks the release up on its next sweep. This
   * is the live wedge from C-16724 assembled end to end: T-07615 held its slot
   * for thirteen hours in exactly this state.
   */
  it('releases the slot once the reconciler terminalizes the run behind it', async () => {
    say({ body: 'the turn ends without its run row ever learning' })
    await startServer()
    homeScopeHere()
    seedLiveSeat()
    installDeterministicStart(server as HrcServer)

    await sweep()
    const attempt = onlyAttempt()
    expect(attempt.state).toBe('started')
    const runtimeId = serverDb().runs.getByRunId(attempt.runId)?.runtimeId as string

    // The wedge: the runtime quietly stops owning the run, and no terminal
    // event is ever written. Everything is backdated past the reconciler's
    // quiescence cutoff, which is what a thirteen-hour-old row looks like.
    const stale = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    serverDb().runtimes.updateRunId(runtimeId, undefined, stale)
    serverDb().sqlite.run(
      `UPDATE runtimes SET status = 'ready', last_activity_at = ?, updated_at = ? WHERE runtime_id = ?`,
      [stale, stale, runtimeId]
    )
    serverDb().sqlite.run('UPDATE runs SET started_at = ?, updated_at = ? WHERE run_id = ?', [
      stale,
      stale,
      attempt.runId,
    ])
    serverDb().sqlite.run('UPDATE hrc_events SET ts = ? WHERE run_id = ?', [stale, attempt.runId])

    // Before: the slot is still held, and the sweep can only say so.
    const { lines: before } = await captureServerLog(async () => {
      await sweep()
    })
    expect(before.filter((line) => line.includes('wrkq.kicker.drive_in_flight'))).not.toHaveLength(
      0
    )
    expect(serverDb().mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBe(attempt.driveAttemptId)

    const response = await fixture.postJson('/v1/runs/reconcile-active', { olderThan: '30m' })
    expect(response.status).toBe(200)
    expect(serverDb().runs.getByRunId(attempt.runId)?.status).toBe('failed')

    await sweep()
    expect(TERMINAL_STATES).toContain(onlyAttempt().state)
    expect(serverDb().mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(serverDb().mailDrives.listInFlightTargets()).not.toContain(TARGET)
  })

  /**
   * The other residue behind the same wedge (T-07616 C-16776): a run row that
   * carries a terminal `completed_at` while its `status` was never moved off
   * `running`. 346 such rows on max3 and 18 on svc as of 2026-08-28, reaching
   * back to July.
   *
   * The reconciler is right to leave them alone — `completed_at` is the terminal
   * marker its whole query family uses, and the rows are a defect in whoever
   * stamped it without the status. But the kicker READ them wrong:
   * `isDurablyActiveRun` tested `status` only, and `observeAttempt` consults it
   * BEFORE it ever looks at `completedAt`, so a finished run reported `'waiting'`
   * forever and its scope's drive slot was never released. Reading the row
   * correctly is the reader's job; repairing the row is not.
   */
  it('reads a run with completed_at as finished even when its status still says running', async () => {
    say({ body: 'the run finishes but its status row is left behind' })
    await startServer()
    homeScopeHere()
    seedLiveSeat()
    installDeterministicStart(server as HrcServer)

    await sweep()
    const attempt = onlyAttempt()
    expect(attempt.state).toBe('started')

    // Exactly the live shape: completed_at stamped, status left at 'running',
    // and NO terminal lifecycle event for the kicker to key on.
    const done = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    serverDb().sqlite.run(
      "UPDATE runs SET status = 'running', completed_at = ?, updated_at = ? WHERE run_id = ?",
      [done, done, attempt.runId]
    )
    const run = serverDb().runs.getByRunId(attempt.runId)
    expect(run?.status).toBe('running')
    expect(run?.completedAt).toBeDefined()

    await sweep()

    expect(TERMINAL_STATES).toContain(onlyAttempt().state)
    expect(serverDb().mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(serverDb().mailDrives.listInFlightTargets()).not.toContain(TARGET)
  })
})
