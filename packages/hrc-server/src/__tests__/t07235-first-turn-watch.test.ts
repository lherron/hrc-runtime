/**
 * T-07235 — `first_turn_missing` provision-liveness watchdog: arm / clear /
 * disarm / detect / trip.
 *
 * The invariant under test: a runtime generation that has had a prompt
 * dispatched and never produced `turn.started` must trip a durable,
 * reason-coded liveness failure at its STORED deadline — and only then.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT,
  HRC_FIRST_TURN_MISSING_EVENT,
  HrcErrorCode,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { runFirstTurnEvaluationOnce } from '../first-turn-eval'
import {
  DEFAULT_FIRST_TURN_TIMEOUT_MS,
  armFirstTurnWatch,
  disarmFirstTurnWatch,
  noteFirstTurnStarted,
  resolveFirstTurnEvalIntervalSeconds,
  resolveFirstTurnTimeoutMs,
} from '../first-turn-watch'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

type Fixture = {
  db: ReturnType<typeof openHrcDatabase>
  dir: string
  runtimeRoot: string
  cleanup: () => Promise<void>
}

const HOST_SESSION_ID = 'hsid-t07235'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07235'
const LANE_REF = 'default'
const RUNTIME_ID = 'rt-t07235'
const RUN_ID = 'run-t07235'
const INVOCATION_ID = 'inv-t07235'

function iso(offsetMs: number): string {
  return new Date(Date.UTC(2026, 7, 14, 12, 0, 0) + offsetMs).toISOString()
}

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-first-turn-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  const runtimeRoot = join(dir, 'run')
  const now = iso(0)

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'starting',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeInvocationId: INVOCATION_ID,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    invocationId: INVOCATION_ID,
  })

  return {
    db,
    dir,
    runtimeRoot,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function fakeServer(fixture: Fixture, notified: unknown[] = []): HrcServerInstanceForHandlers {
  return {
    db: fixture.db,
    options: { runtimeRoot: fixture.runtimeRoot },
    capturedRelease: { mode: 'unmanaged' },
    notifyEvent: (event: unknown) => {
      notified.push(event)
    },
  } as unknown as HrcServerInstanceForHandlers
}

function armDefault(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof armFirstTurnWatch>[1]> = {}
): void {
  armFirstTurnWatch(fixture.db, {
    runtimeId: RUNTIME_ID,
    generation: 1,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    transport: 'headless',
    primingDispatchedAt: iso(0),
    ...overrides,
  })
}

let fixture: Fixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('arm', () => {
  it('stamps an absolute deadline from the priming dispatch plus the global default', () => {
    armDefault(fixture)
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.primingDispatchedAt).toBe(iso(0))
    expect(watch?.firstTurnDeadlineAt).toBe(iso(DEFAULT_FIRST_TURN_TIMEOUT_MS))
    expect(watch?.firstTurnAt).toBeUndefined()
    expect(watch?.firstTurnMissingTrippedAt).toBeUndefined()
  })

  it('consumes the per-request override at arm time and stores the resulting deadline', () => {
    armDefault(fixture, { timeoutMsOverride: 5_000 })
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.firstTurnDeadlineAt).toBe(iso(5_000))
  })

  it('is idempotent: a second dispatch origin cannot move an armed deadline', () => {
    armDefault(fixture, { timeoutMsOverride: 5_000 })
    armDefault(fixture, { timeoutMsOverride: 900_000, primingDispatchedAt: iso(1_000) })
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.firstTurnDeadlineAt).toBe(iso(5_000))
    expect(watch?.primingDispatchedAt).toBe(iso(0))
  })

  it('never re-arms a generation that already had its first turn', () => {
    armDefault(fixture, { timeoutMsOverride: 5_000 })
    noteFirstTurnStarted(fixture.db, RUNTIME_ID, 1, iso(1_000))
    armDefault(fixture, { timeoutMsOverride: 5_000, primingDispatchedAt: iso(2_000) })
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.firstTurnAt).toBe(iso(1_000))
    expect(watch?.primingDispatchedAt).toBe(iso(0))
  })

  it('never arms a generation that already ran a turn before the watchdog existed', () => {
    // The pre-existing fleet has NO watch row, so `firstTurnAt is null` is
    // true for every long-lived runtime. Run history is what actually answers
    // "has this generation had its first turn" — otherwise the first DM after
    // activation would start a clock on 43 live runtimes at once, and any DM
    // that queues behind an active turn would blow it through no fault of the
    // harness.
    fixture.db.runs.insert({
      runId: 'run-earlier',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'headless',
      status: 'completed',
      acceptedAt: iso(0),
      startedAt: iso(10),
      completedAt: iso(20),
      updatedAt: iso(20),
    })

    armDefault(fixture, { runId: 'run-later', primingDispatchedAt: iso(30) })
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)).toBeNull()
  })

  it('still arms a SUCCESSOR generation whose own history is empty', () => {
    fixture.db.runs.insert({
      runId: 'run-gen1',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'headless',
      status: 'completed',
      acceptedAt: iso(0),
      startedAt: iso(10),
      completedAt: iso(20),
      updatedAt: iso(20),
    })

    // Generation scoping: the predecessor's turn history says nothing about
    // whether the successor's harness ever came up.
    armDefault(fixture, { generation: 2, timeoutMsOverride: 5_000, primingDispatchedAt: iso(30) })
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 2)?.firstTurnDeadlineAt).toBe(iso(5_030))
  })

  it('an accepted-but-never-started run does not count as a prior turn', () => {
    // Only `started_at` proves a turn happened. An accepted run that never
    // started is exactly the failure this watchdog exists to catch.
    fixture.db.runs.insert({
      runId: 'run-accepted-only',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: iso(0),
      updatedAt: iso(0),
    })
    armDefault(fixture, { timeoutMsOverride: 5_000 })
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.firstTurnDeadlineAt).toBe(iso(5_000))
  })

  it('scopes state by generation: a rotation arms a fresh, independent row', () => {
    armDefault(fixture, { timeoutMsOverride: 5_000 })
    armDefault(fixture, {
      generation: 2,
      timeoutMsOverride: 60_000,
      primingDispatchedAt: iso(10_000),
    })
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.firstTurnDeadlineAt).toBe(iso(5_000))
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 2)?.firstTurnDeadlineAt).toBe(iso(70_000))
  })

  it('re-arms after a force-restart rotation even when the predecessor tripped', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    await runFirstTurnEvaluationOnce(fakeServer(fixture))
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.firstTurnMissingTrippedAt).toBeDefined()

    // Successor generation: stale predecessor state must not suppress the arm,
    // and the predecessor's trip must not follow the successor.
    armDefault(fixture, {
      generation: 2,
      timeoutMsOverride: 60_000,
      primingDispatchedAt: iso(10_000),
    })
    const successor = fixture.db.firstTurnWatch.get(RUNTIME_ID, 2)
    expect(successor?.firstTurnDeadlineAt).toBe(iso(70_000))
    expect(successor?.firstTurnMissingTrippedAt).toBeUndefined()
  })
})

describe('clear and disarm', () => {
  it('turn.started satisfies the invariant so the row never trips', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    noteFirstTurnStarted(fixture.db, RUNTIME_ID, 1, iso(10))
    const summary = await runFirstTurnEvaluationOnce(fakeServer(fixture))
    expect(summary.scanned).toBe(0)
    expect(summary.tripped).toBe(0)
    expect(fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.firstTurnMissingTrippedAt).toBeUndefined()
  })

  it('an exit-path disarm keeps the exit reason authoritative — no liveness trip', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    disarmFirstTurnWatch(fixture.db, RUNTIME_ID, 1, 'invocation_exited:process-exit', iso(10))
    const summary = await runFirstTurnEvaluationOnce(fakeServer(fixture))
    expect(summary.tripped).toBe(0)
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.disarmReason).toBe('invocation_exited:process-exit')
    expect(watch?.firstTurnMissingTrippedAt).toBeUndefined()
  })
})

describe('detect', () => {
  it('runs on its own cadence, not the 300s zombie sweep', () => {
    // The whole point of the dedicated pass: 300s cannot honor a 120s deadline.
    expect(resolveFirstTurnEvalIntervalSeconds()).toBe(30)
    expect(resolveFirstTurnEvalIntervalSeconds() * 1000).toBeLessThan(
      resolveFirstTurnTimeoutMs(undefined)
    )
  })

  it('does not trip an armed row before its deadline', async () => {
    armDefault(fixture, { timeoutMsOverride: 10 * 60 * 1000, primingDispatchedAt: iso(0) })
    // Arm times are in the fixture's fixed past, so a far-future deadline is
    // still in the future relative to wall-clock now only if we recompute it.
    fixture.db.firstTurnWatch.arm({
      runtimeId: 'rt-future',
      generation: 1,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      primingDispatchedAt: new Date().toISOString(),
      firstTurnDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const due = fixture.db.firstTurnWatch.listArmedDue(new Date().toISOString())
    expect(due.map((row) => row.runtimeId)).not.toContain('rt-future')
  })
})

describe('trip', () => {
  it('records the reason-coded fact, the stamp, and the run terminal together', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    const notified: unknown[] = []
    const summary = await runFirstTurnEvaluationOnce(fakeServer(fixture, notified))

    expect(summary.tripped).toBe(1)
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.firstTurnMissingTrippedAt).toBeDefined()
    expect(watch?.tripEventSeq).toBeDefined()

    const tripEvent = fixture.db.hrcEvents.listByKind(HRC_FIRST_TURN_MISSING_EVENT)[0]
    expect(tripEvent).toBeDefined()
    expect(tripEvent?.errorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)
    expect(tripEvent?.hrcSeq).toBe(watch?.tripEventSeq as number)

    const run = fixture.db.runs.getByRunId(RUN_ID)
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)
    // Every waiter error carries the trip id so the bundle is reachable.
    expect(run?.errorMessage).toContain(`hrc runtime diagnostics ${watch?.tripEventSeq}`)
  })

  it('trips exactly once even if the pass runs again', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    await runFirstTurnEvaluationOnce(fakeServer(fixture))
    const second = await runFirstTurnEvaluationOnce(fakeServer(fixture))
    expect(second.scanned).toBe(0)
    expect(second.tripped).toBe(0)
    const tripEvents = fixture.db.hrcEvents.listByKind(HRC_FIRST_TURN_MISSING_EVENT)
    expect(tripEvents).toHaveLength(1)
  })

  it('leaves runtime status live — the trip is observe-only', async () => {
    fixture.db.runtimes.update(RUNTIME_ID, { status: 'busy', updatedAt: iso(0) })
    armDefault(fixture, { timeoutMsOverride: 0 })
    await runFirstTurnEvaluationOnce(fakeServer(fixture))
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')
  })

  it('publishes a bundle plus a linking event whose failure map is explicit', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    await runFirstTurnEvaluationOnce(fakeServer(fixture))

    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.bundleDir).toBeDefined()
    expect(watch?.diagnosticsEventSeq).toBeDefined()

    const manifest = JSON.parse(
      await readFile(join(watch?.bundleDir as string, 'manifest.json'), 'utf8')
    ) as {
      correlation: { runtimeId: string; generation: number }
      failures: Record<string, string>
    }
    expect(manifest.correlation.runtimeId).toBe(RUNTIME_ID)
    expect(manifest.correlation.generation).toBe(1)
    // The fixture has no broker spec projection, so the launch shape must be
    // reported as a NAMED failure rather than going silently absent.
    expect(manifest.failures['launchShape']).toBe('spec_projection_unavailable')

    const linking = fixture.db.hrcEvents.listByKind(HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT)[0]
    expect(linking).toBeDefined()
    const payload = linking?.payload as { tripEventSeq: number; bundleDir: string }
    expect(payload.tripEventSeq).toBe(watch?.tripEventSeq as number)
    expect(payload.bundleDir).toBe(watch?.bundleDir as string)

    // The artifact row exists so retention has a deletion handle.
    const artifact = fixture.db.runtimeArtifacts.getByArtifactId(
      `first-turn-missing-${watch?.tripEventSeq}`
    )
    expect(artifact?.artifactPath).toBe(watch?.bundleDir as string)
  })

  it('keeps the primary fact when bundle assembly cannot write its directory', async () => {
    armDefault(fixture, { timeoutMsOverride: 0 })
    // Point the artifact root at a REGULAR FILE: mkdir below it fails with
    // ENOTDIR on every platform, so assembly throws and detection must survive.
    const blockedRoot = join(fixture.dir, 'blocked-root')
    await writeFile(blockedRoot, 'not a directory')
    const server = fakeServer(fixture)
    ;(server as unknown as { options: { runtimeRoot: string } }).options.runtimeRoot = blockedRoot

    const summary = await runFirstTurnEvaluationOnce(server)
    expect(summary.tripped).toBe(1)
    expect(summary.errors).toBe(0)

    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.firstTurnMissingTrippedAt).toBeDefined()
    expect(watch?.bundleDir).toBeUndefined()
    expect(fixture.db.runs.getByRunId(RUN_ID)?.errorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)

    // The linking event still lands, carrying the failure rather than nothing.
    const linking = fixture.db.hrcEvents.listByKind(HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT)[0]
    expect(linking).toBeDefined()
    const failures = (linking?.payload as { failures: Record<string, string> }).failures
    expect(Object.keys(failures).length).toBeGreaterThan(0)
  })
})

describe('deadline durability across restart', () => {
  it('trips at the STORED deadline, not the global default, after a reopen', async () => {
    const dbPath = join(fixture.dir, 'state.sqlite')
    armDefault(fixture, { timeoutMsOverride: 250 })
    const stored = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.firstTurnDeadlineAt
    fixture.db.close()

    // Reopen: nothing in memory survives, and no request-policy value is
    // available to recover — the accepted deadline IS the durable fact.
    const reopened = openHrcDatabase(dbPath)
    fixture.db = reopened
    const watch = reopened.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.firstTurnDeadlineAt).toBe(stored as string)
    expect(watch?.firstTurnDeadlineAt).not.toBe(iso(DEFAULT_FIRST_TURN_TIMEOUT_MS))

    const summary = await runFirstTurnEvaluationOnce(fakeServer(fixture))
    expect(summary.tripped).toBe(1)
  })
})
