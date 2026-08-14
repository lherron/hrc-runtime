/**
 * T-07235 — retrieval: one durable fact, every surface.
 *
 * The bundle must be reachable without opening sqlite or knowing the
 * filesystem layout. Three surfaces carry the SAME trip event id: the run
 * terminal every waiter reads, the `hrc runtime list` health detail, and the
 * read-only `hrc runtime diagnostics` endpoint.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { GetFirstTurnDiagnosticsResponse, ListFirstTurnDiagnosticsResponse } from 'hrc-core'
import { HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { handleFirstTurnDiagnostics } from '../first-turn-diagnostics-handlers'
import { runFirstTurnEvaluationOnce } from '../first-turn-eval'
import { armFirstTurnWatch } from '../first-turn-watch'
import { createRuntimeListAdoptRoutes } from '../runtime-list-adopt-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const HOST_SESSION_ID = 'hsid-retrieval'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07235'
const LANE_REF = 'default'
const RUNTIME_ID = 'rt-retrieval'
const RUN_ID = 'run-retrieval'
const PAST = '2026-01-01T00:00:00.000Z'

type Fixture = {
  db: ReturnType<typeof openHrcDatabase>
  dir: string
  runtimeRoot: string
  cleanup: () => Promise<void>
}

let fixture: Fixture

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-ft-retrieval-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    status: 'active',
    createdAt: PAST,
    updatedAt: PAST,
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
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: PAST,
    updatedAt: PAST,
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
    acceptedAt: PAST,
    updatedAt: PAST,
  })
  return {
    db,
    dir,
    runtimeRoot: join(dir, 'run'),
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function fakeServer(): HrcServerInstanceForHandlers {
  return {
    db: fixture.db,
    options: { runtimeRoot: fixture.runtimeRoot },
    ghostmux: undefined,
    capturedRelease: { mode: 'unmanaged' },
    notifyEvent: () => undefined,
  } as unknown as HrcServerInstanceForHandlers
}

async function trip(): Promise<number> {
  armFirstTurnWatch(fixture.db, {
    runtimeId: RUNTIME_ID,
    generation: 1,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    runId: RUN_ID,
    transport: 'headless',
    primingDispatchedAt: PAST,
  })
  await runFirstTurnEvaluationOnce(fakeServer())
  return fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)?.tripEventSeq as number
}

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('waiter mapping', () => {
  it('every waiter reads the SAME durable run terminal, not a private timeout', async () => {
    const tripEventSeq = await trip()
    const run = fixture.db.runs.getByRunId(RUN_ID)

    // `hrc start --wait` polls this run row for a terminal status + errorCode;
    // the ACP pending-run path fails its run off the same row. One fact.
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe(HrcErrorCode.FIRST_TURN_MISSING)
    expect(run?.completedAt).toBeDefined()
    expect(run?.errorMessage).toContain(`hrc runtime diagnostics ${tripEventSeq}`)
  })

  it('a run already answered is not reclassified by a second pass', async () => {
    const first = await trip()
    await runFirstTurnEvaluationOnce(fakeServer())
    const run = fixture.db.runs.getByRunId(RUN_ID)
    expect(run?.errorMessage).toContain(`hrc runtime diagnostics ${first}`)
  })
})

describe('runtime list health detail', () => {
  it('flags a tripped runtime and carries the trip event id', async () => {
    const tripEventSeq = await trip()
    const routes = createRuntimeListAdoptRoutes({
      db: fixture.db,
      staleGenerationThresholdSec: 86_400,
      reconcileTmuxRuntimeLiveness: async (runtime) => runtime,
      notifyEvent: () => undefined,
    })
    const listRoute = routes.find(
      (route) => route.method === 'GET' && route.pathname === '/v1/runtimes'
    )
    expect(listRoute).toBeDefined()

    const url = new URL('http://hrc.local/v1/runtimes')
    const response = await listRoute?.handler(new Request(url), url)
    const runtimes = (await response?.json()) as Array<{
      runtimeId: string
      status: string
      health?: { firstTurnMissing: { tripEventSeq: number; retrieval: string } }
    }>
    const row = runtimes.find((runtime) => runtime.runtimeId === RUNTIME_ID)
    expect(row?.health?.firstTurnMissing.tripEventSeq).toBe(tripEventSeq)
    expect(row?.health?.firstTurnMissing.retrieval).toBe(`hrc runtime diagnostics ${tripEventSeq}`)
    // Status stays live: the trip is observe-only, health is where it surfaces.
    expect(row?.status).toBe('busy')
  })

  it('leaves untripped runtimes with no health finding', async () => {
    const routes = createRuntimeListAdoptRoutes({
      db: fixture.db,
      staleGenerationThresholdSec: 86_400,
      reconcileTmuxRuntimeLiveness: async (runtime) => runtime,
      notifyEvent: () => undefined,
    })
    const listRoute = routes.find(
      (route) => route.method === 'GET' && route.pathname === '/v1/runtimes'
    )
    const url = new URL('http://hrc.local/v1/runtimes')
    const response = await listRoute?.handler(new Request(url), url)
    const runtimes = (await response?.json()) as Array<{ health?: unknown }>
    expect(runtimes[0]?.health).toBeUndefined()
  })
})

describe('hrc runtime diagnostics surface', () => {
  it('lists trips newest-first with their bundle availability', async () => {
    const tripEventSeq = await trip()
    const url = new URL('http://hrc.local/v1/runtime-diagnostics')
    const body = (await (
      await handleFirstTurnDiagnostics(fixture.db, url)
    ).json()) as ListFirstTurnDiagnosticsResponse
    expect(body.trips).toHaveLength(1)
    expect(body.trips[0]?.tripEventSeq).toBe(tripEventSeq)
    expect(body.trips[0]?.runtimeId).toBe(RUNTIME_ID)
    expect(body.trips[0]?.bundleAvailable).toBe(true)
  })

  it('filters by runtime', async () => {
    await trip()
    const url = new URL('http://hrc.local/v1/runtime-diagnostics?runtimeId=rt-nobody')
    const body = (await (
      await handleFirstTurnDiagnostics(fixture.db, url)
    ).json()) as ListFirstTurnDiagnosticsResponse
    expect(body.trips).toHaveLength(0)
  })

  it('returns the trip plus its redacted bundle manifest by trip event id', async () => {
    const tripEventSeq = await trip()
    const url = new URL(`http://hrc.local/v1/runtime-diagnostics?trip=${tripEventSeq}`)
    const body = (await (
      await handleFirstTurnDiagnostics(fixture.db, url)
    ).json()) as GetFirstTurnDiagnosticsResponse
    expect(body.trip.tripEventSeq).toBe(tripEventSeq)
    expect(body.trip.runId).toBe(RUN_ID)
    expect(body.bundle?.correlation.runtimeId).toBe(RUNTIME_ID)
    expect(body.bundle?.correlation.generation).toBe(1)
  })

  it('rejects an unknown trip id rather than inventing an empty bundle', async () => {
    const url = new URL('http://hrc.local/v1/runtime-diagnostics?trip=999999')
    await expect(handleFirstTurnDiagnostics(fixture.db, url)).rejects.toBeInstanceOf(
      HrcNotFoundError
    )
  })
})
