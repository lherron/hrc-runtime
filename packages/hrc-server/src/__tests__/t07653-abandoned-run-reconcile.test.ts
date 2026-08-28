import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-07653 (2) — a run whose runtime already let go of it must be terminalized
 * on the reconciler's interval, not only at the next daemon start.
 *
 * `listActiveRunReconcileCandidates` gates every existing branch on
 * `runtime.activeRunId === run.runId`, so a run the runtime has ALREADY
 * released is invisible to all of them and stays `running` with no
 * `completed_at` for the rest of the daemon's uptime. Startup reconcile clears
 * these at boot — which is why a restart "fixed" it — and nothing did on the
 * interval.
 *
 * Live consequence (T-07653 C-16724): the mail kicker reads the run row to
 * decide whether a scope's drive slot is in flight, so one fossil row held
 * `agent:clod:project:hrc-runtime:task:T-07615/lane:main` undrivable for
 * thirteen hours with `EN-00209` pending and an empty `presentedTo`.
 *
 * Ruled to the reconciler (C-16727): it owns the run row; the kicker is a
 * reader. Bounded by EVIDENCE — the runtime owns no run at all — with the
 * reconciler's ordinary quiescence cutoff kept only as a race guard against
 * the dispatch window, where the run row exists a moment before the runtime
 * is stamped with it.
 */

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07653-abandoned-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

type SeedOptions = {
  runId: string
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  /** What the runtime believes it is running. `undefined` is the defect. */
  runtimeActiveRunId?: string | undefined
  runtimeStatus?: string | undefined
  /** Minutes since the run and the runtime last did anything. */
  quietForMinutes?: number | undefined
  runtimeQuietForMinutes?: number | undefined
}

/**
 * The live shape: a `running` run row with no `completed_at`, over a runtime
 * that is `ready` and owns nothing. The turn ended; the row never learned.
 */
function seedAbandonedRun(options: SeedOptions): void {
  const scopeRef = `agent:${options.scopeRef}`
  fixture.seedSession(options.hostSessionId, options.scopeRef)
  const runTs = isoMinutesAgo(options.quietForMinutes ?? 60)
  const runtimeTs = isoMinutesAgo(options.runtimeQuietForMinutes ?? options.quietForMinutes ?? 60)
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: options.runtimeStatus ?? 'ready',
      controllerKind: 'harness-broker',
      ...(options.runtimeActiveRunId === undefined
        ? {}
        : { activeRunId: options.runtimeActiveRunId }),
      supportsInflightInput: true,
      adopted: false,
      lastActivityAt: runtimeTs,
      createdAt: runtimeTs,
      updatedAt: runtimeTs,
    })
    db.runs.insert({
      runId: options.runId,
      hostSessionId: options.hostSessionId,
      runtimeId: options.runtimeId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'running',
      acceptedAt: runTs,
      startedAt: runTs,
      updatedAt: runTs,
    })
  } finally {
    db.close()
  }
}

function getRun(runId: string): HrcRunRecord | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.getByRunId(runId)
  } finally {
    db.close()
  }
}

function getRuntime(runtimeId: string): HrcRuntimeSnapshot | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function eventsForRun(runId: string): string[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listByRun(runId).map((event) => event.eventKind)
  } finally {
    db.close()
  }
}

async function reconcile(
  body: ReconcileActiveRunsRequest = {}
): Promise<ReconcileActiveRunsResponse> {
  const res = await fixture.postJson('/v1/runs/reconcile-active', body)
  expect(res.status).toBe(200)
  return (await res.json()) as ReconcileActiveRunsResponse
}

describe('T-07653 — the reconciler terminalizes a run its runtime already released', () => {
  it('finalizes a running row over a runtime that owns no run, and says why', async () => {
    seedAbandonedRun({
      runId: 'run-abandoned',
      runtimeId: 'rt-abandoned',
      hostSessionId: 'hsid-abandoned',
      scopeRef: 't07653-abandoned',
    })

    const body = await reconcile({ olderThan: '30m' })

    const result = body.results.find((entry) => entry.runId === 'run-abandoned')
    expect(result?.status).toBe('repaired')
    expect(result?.reason).toBe('run_abandoned_by_runtime')
    expect(result?.finalizedRunStatus).toBe('failed')

    const run = getRun('run-abandoned')
    expect(run?.status).toBe('failed')
    expect(run?.completedAt).toBeDefined()
    // The kicker keys on a terminal event for the run; without one the drive
    // attempt is still `waiting` however the row reads.
    expect(eventsForRun('run-abandoned')).toContain('turn.reaped')
  })

  it('leaves a run its runtime still owns to the branches that already handle it', async () => {
    seedAbandonedRun({
      runId: 'run-owned',
      runtimeId: 'rt-owned',
      hostSessionId: 'hsid-owned',
      scopeRef: 't07653-owned',
      runtimeActiveRunId: 'run-owned',
    })

    const body = await reconcile({ olderThan: '30m' })

    expect(
      body.results.filter(
        (entry) => entry.runId === 'run-owned' && entry.reason === 'run_abandoned_by_runtime'
      )
    ).toHaveLength(0)
  })

  it('never touches a run inside the dispatch window: a busy runtime is not evidence', async () => {
    // The race this cutoff exists for — the run row is inserted moments BEFORE
    // `active_run_id` is stamped on the runtime, and a queued prompt takes
    // ownership only when the run ahead of it clears. Both look exactly like
    // the defect for a few hundred milliseconds.
    seedAbandonedRun({
      runId: 'run-dispatching',
      runtimeId: 'rt-dispatching',
      hostSessionId: 'hsid-dispatching',
      scopeRef: 't07653-dispatching',
      quietForMinutes: 0,
      runtimeStatus: 'busy',
    })

    await reconcile({ olderThan: '30m' })

    expect(getRun('run-dispatching')?.status).toBe('running')
    expect(getRun('run-dispatching')?.completedAt).toBeUndefined()
  })

  it('waits for the RUNTIME to be quiescent too, not just the run', async () => {
    // A long turn ends and clears `active_run_id`; the prompt queued behind it
    // has been sitting quiet for an hour and is about to be picked up. The run
    // clock alone would condemn it — the runtime clock is what saves it.
    seedAbandonedRun({
      runId: 'run-queued-behind',
      runtimeId: 'rt-queued-behind',
      hostSessionId: 'hsid-queued-behind',
      scopeRef: 't07653-queued-behind',
      quietForMinutes: 90,
      runtimeQuietForMinutes: 0,
    })

    await reconcile({ olderThan: '30m' })

    expect(getRun('run-queued-behind')?.status).toBe('running')
  })

  it('reports without mutating under dryRun', async () => {
    seedAbandonedRun({
      runId: 'run-dry',
      runtimeId: 'rt-dry',
      hostSessionId: 'hsid-dry',
      scopeRef: 't07653-dry',
    })

    const body = await reconcile({ olderThan: '30m', dryRun: true })

    expect(
      body.results.find((entry) => entry.runId === 'run-dry' && entry.status === 'matched')?.reason
    ).toBe('run_abandoned_by_runtime')
    expect(getRun('run-dry')?.status).toBe('running')
    expect(getRuntime('rt-dry')?.activeRunId).toBeUndefined()
  })
})
