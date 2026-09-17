/**
 * T-08576 RED contract: store-level app scope classification and run-handle ownership.
 *
 * These tests deliberately use only the pre-existing HrcDatabase repository surface. The
 * in-memory reservation API is a green-phase addition, so the red can observe the durable
 * app-run ownership rule but cannot manufacture a reservation by calling a missing method.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcDatabase } from '../index'
import { openHrcDatabase } from '../index'

const NOW = '2026-09-17T06:45:00.000Z'
const APP_SCOPE = 'app:t08576'
const APP_LANE = 'assistant'
const APP_HOST = 'hsid-t08576-app'

let dir: string
let db: HrcDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08576-store-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function seedSession(
  hostSessionId: string,
  scopeRef: string,
  laneRef = 'default',
  generation = 1
): void {
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef,
    generation,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
}

function seedRuntime(input: {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef?: string
  activeRunId?: string
  activeOperationId?: string
}): void {
  db.runtimes.insert({
    runtimeId: input.runtimeId,
    hostSessionId: input.hostSessionId,
    scopeRef: input.scopeRef,
    laneRef: input.laneRef ?? 'default',
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    ...(input.activeRunId === undefined ? {} : { activeRunId: input.activeRunId }),
    ...(input.activeOperationId === undefined
      ? {}
      : { activeOperationId: input.activeOperationId }),
    supportsInflightInput: true,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function seedAppRun(runId: string): void {
  seedSession(APP_HOST, APP_SCOPE, APP_LANE)
  db.runs.insert({
    runId,
    hostSessionId: APP_HOST,
    scopeRef: APP_SCOPE,
    laneRef: APP_LANE,
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: NOW,
    updatedAt: NOW,
  })
}

function outcome(fn: () => void): { ok: boolean; errorName?: string } {
  try {
    fn()
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      errorName: error instanceof Error ? error.constructor.name : String(error),
    }
  }
}

describe('T-08576 app-session store scope', () => {
  it('R-S1 maps app continuity without admitting app scope to agent grammar', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)

    let sessionRef: string | undefined
    let errorName: string | undefined
    try {
      sessionRef = db.continuities.upsert({
        scopeRef: APP_SCOPE,
        laneRef: APP_LANE,
        activeHostSessionId: APP_HOST,
        updatedAt: NOW,
      }).sessionRef
    } catch (error) {
      errorName = error instanceof Error ? error.constructor.name : String(error)
    }

    expect({ sessionRef, errorName }).toEqual({
      sessionRef: `${APP_SCOPE}/lane:${APP_LANE}`,
      errorName: undefined,
    })
  })

  it('R-S1 control keeps agent continuity unchanged and system scope rejected', () => {
    seedSession('hsid-agent', 'agent:smokey:project:hrc-runtime', 'main')
    expect(
      db.continuities.upsert({
        scopeRef: 'agent:smokey:project:hrc-runtime',
        laneRef: 'main',
        activeHostSessionId: 'hsid-agent',
        updatedAt: NOW,
      }).sessionRef
    ).toBe('agent:smokey:project:hrc-runtime/lane:main')

    seedSession('hsid-system', 'system:hrc', 'sweep')
    expect(() =>
      db.continuities.upsert({
        scopeRef: 'system:hrc',
        laneRef: 'sweep',
        activeHostSessionId: 'hsid-system',
        updatedAt: NOW,
      })
    ).toThrow()
  })

  it('R-S2 exposes only agent-addressable live runtime refs', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
    seedSession('hsid-agent', 'agent:smokey:project:hrc-runtime', 'main')
    seedRuntime({
      runtimeId: 'rt-app',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
    })
    seedRuntime({
      runtimeId: 'rt-agent',
      hostSessionId: 'hsid-agent',
      scopeRef: 'agent:smokey:project:hrc-runtime',
      laneRef: 'main',
    })

    expect(db.runtimes.listLiveSessionRefs()).toEqual([
      'agent:smokey:project:hrc-runtime/lane:main',
    ])
  })

  it('R-S3 does not serve or facet app rows while retaining their projection', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
    seedSession('hsid-agent', 'agent:smokey:project:hrc-runtime', 'main')
    db.continuities.upsert({
      scopeRef: 'agent:smokey:project:hrc-runtime',
      laneRef: 'main',
      activeHostSessionId: 'hsid-agent',
      updatedAt: NOW,
    })
    db.sqlite.run(
      `INSERT INTO continuities
         (scope_ref, lane_ref, active_host_session_id, updated_at)
       VALUES (?, ?, ?, ?)`,
      [APP_SCOPE, APP_LANE, APP_HOST, NOW]
    )

    expect({
      appProjection: db.sqlite
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM session_index WHERE scope_ref LIKE 'app:%'"
        )
        .get()?.count,
      agentProjection: db.sqlite
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM session_index WHERE host_session_id = ?'
        )
        .get('hsid-agent')?.count,
    }).toEqual({ appProjection: 1, agentProjection: 1 })

    const page = db.sessionIndex.listPage({ limit: 20 })
    const facets = db.sessionIndex.facets()
    expect({
      items: page.items.map((item) => item.scopeRef),
      total: facets.total,
      byAgentId: facets.byAgentId,
    }).toEqual({
      items: ['agent:smokey:project:hrc-runtime'],
      total: 1,
      byAgentId: { smokey: 1 },
    })
  })
})

describe('T-08576 R-B7(p) durable app-run handle ownership', () => {
  it('refuses a foreign RuntimeRepository.insert naming an existing app run', () => {
    seedAppRun('run-app-owned-insert')
    seedSession('hsid-foreign', 'agent:other:project:hrc-runtime')

    const attempted = outcome(() =>
      seedRuntime({
        runtimeId: 'rt-foreign-insert',
        hostSessionId: 'hsid-foreign',
        scopeRef: 'agent:other:project:hrc-runtime',
        activeRunId: 'run-app-owned-insert',
      })
    )

    expect(attempted).toEqual({ ok: false, errorName: 'RunIdOwnershipError' })
    expect(db.runtimes.getByRuntimeId('rt-foreign-insert')).toBeNull()
  })

  it('refuses foreign RuntimeRepository.update and updateRunId handle writes', () => {
    seedAppRun('run-app-owned-update')
    seedSession('hsid-foreign', 'agent:other:project:hrc-runtime')
    seedRuntime({
      runtimeId: 'rt-foreign-update',
      hostSessionId: 'hsid-foreign',
      scopeRef: 'agent:other:project:hrc-runtime',
    })

    const update = outcome(() => {
      db.runtimes.update('rt-foreign-update', {
        activeRunId: 'run-app-owned-update',
        updatedAt: NOW,
      })
    })
    const updateRunId = outcome(() => {
      db.runtimes.updateRunId('rt-foreign-update', 'run-app-owned-update', NOW)
    })

    expect(update).toEqual({ ok: false, errorName: 'RunIdOwnershipError' })
    expect(updateRunId).toEqual({ ok: false, errorName: 'RunIdOwnershipError' })
    expect(db.runtimes.getByRuntimeId('rt-foreign-update')?.activeRunId).toBeUndefined()
  })

  it('refuses both steer-contribution writers from a foreign host', () => {
    seedAppRun('run-app-owned-steer')
    seedSession('hsid-foreign', 'agent:other:project:hrc-runtime')
    seedRuntime({
      runtimeId: 'rt-foreign-steer',
      hostSessionId: 'hsid-foreign',
      scopeRef: 'agent:other:project:hrc-runtime',
    })

    const insert = outcome(() =>
      db.steerContributions.insertAttempting({
        contributionId: 'contrib-foreign-insert',
        hostSessionId: 'hsid-foreign',
        runtimeId: 'rt-foreign-steer',
        invocationId: 'inv-foreign',
        activeRunId: 'run-app-owned-steer',
        inputId: 'input-foreign',
        now: NOW,
      })
    )

    db.steerContributions.insertAttempting({
      contributionId: 'contrib-foreign-update',
      hostSessionId: 'hsid-foreign',
      runtimeId: 'rt-foreign-steer',
      invocationId: 'inv-foreign',
      activeRunId: 'run-agent-provisional',
      inputId: 'input-foreign-update',
      now: NOW,
    })
    const update = outcome(() => {
      db.steerContributions.updateAttemptingRunPointer('contrib-foreign-update', {
        activeRunId: 'run-app-owned-steer',
        runtimeId: 'rt-foreign-steer',
        invocationId: 'inv-foreign',
        now: NOW,
      })
    })

    expect(insert).toEqual({ ok: false, errorName: 'RunIdOwnershipError' })
    expect(update).toEqual({ ok: false, errorName: 'RunIdOwnershipError' })
    expect(db.steerContributions.getById('contrib-foreign-insert')).toBeNull()
    expect(db.steerContributions.getById('contrib-foreign-update')?.activeRunId).toBe(
      'run-agent-provisional'
    )
  })

  it('refuses same-host runtimes unless they are the app run bound runtime and operation', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
    seedRuntime({
      runtimeId: 'rt-app-bound',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      activeOperationId: 'op-app-bound',
    })
    db.runs.insert({
      runId: 'run-app-bound',
      hostSessionId: APP_HOST,
      runtimeId: 'rt-app-bound',
      operationId: 'op-app-bound',
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      generation: 1,
      transport: 'tmux',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    db.runtimes.updateRunId('rt-app-bound', 'run-app-bound', NOW)

    const differentRuntime = outcome(() =>
      seedRuntime({
        runtimeId: 'rt-app-same-host-wrong-runtime',
        hostSessionId: APP_HOST,
        scopeRef: APP_SCOPE,
        laneRef: APP_LANE,
        activeRunId: 'run-app-bound',
      })
    )
    const wrongOperation = outcome(() =>
      db.runtimes.update('rt-app-bound', {
        activeRunId: 'run-app-bound',
        activeOperationId: 'op-app-wrong',
        updatedAt: NOW,
      })
    )

    expect({
      exactHandle: db.runtimes.getByRuntimeId('rt-app-bound')?.activeRunId,
      differentRuntime,
      differentRuntimeRow: db.runtimes.getByRuntimeId('rt-app-same-host-wrong-runtime'),
      wrongOperation,
      operation: db.runtimes.getByRuntimeId('rt-app-bound')?.activeOperationId,
    }).toEqual({
      exactHandle: 'run-app-bound',
      differentRuntime: { ok: false, errorName: 'RunIdOwnershipError' },
      differentRuntimeRow: null,
      wrongOperation: { ok: false, errorName: 'RunIdOwnershipError' },
      operation: 'op-app-bound',
    })
  })

  it('keeps app run binding columns write-once through update and claimQueued', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
    seedRuntime({
      runtimeId: 'rt-app-write-once',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      activeOperationId: 'op-app-write-once',
    })
    db.runs.insert({
      runId: 'run-app-write-once',
      hostSessionId: APP_HOST,
      runtimeId: 'rt-app-write-once',
      operationId: 'op-app-write-once',
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      generation: 1,
      transport: 'tmux',
      status: 'queued',
      acceptedAt: NOW,
      updatedAt: NOW,
    })

    const runtime = outcome(() => {
      db.runs.update('run-app-write-once', { runtimeId: 'rt-app-other', updatedAt: NOW })
    })
    const operation = outcome(() => {
      db.runs.update('run-app-write-once', { operationId: 'op-app-other', updatedAt: NOW })
    })
    const host = outcome(() => {
      db.runs.update('run-app-write-once', { hostSessionId: 'hsid-other', updatedAt: NOW })
    })
    const generation = outcome(() => {
      db.runs.update('run-app-write-once', { generation: 2, updatedAt: NOW })
    })
    const claim = outcome(() => {
      db.runs.claimQueued('run-app-write-once', {
        runtimeId: 'rt-app-other',
        operationId: 'op-app-other',
        invocationId: 'inv-app-other',
        dispatchedInputId: 'input-app-other',
        updatedAt: NOW,
      })
    })

    expect({
      runtime,
      operation,
      host,
      generation,
      claim,
      row: db.runs.getByRunId('run-app-write-once'),
    }).toEqual({
      runtime: { ok: false, errorName: 'RunIdOwnershipError' },
      operation: { ok: false, errorName: 'RunIdOwnershipError' },
      host: { ok: false, errorName: 'RunIdOwnershipError' },
      generation: { ok: false, errorName: 'RunIdOwnershipError' },
      claim: { ok: false, errorName: 'RunIdOwnershipError' },
      row: expect.objectContaining({
        hostSessionId: APP_HOST,
        generation: 1,
        runtimeId: 'rt-app-write-once',
        operationId: 'op-app-write-once',
        status: 'queued',
      }),
    })
  })

  it('refuses same-host steer contributions from naming an app run', () => {
    seedAppRun('run-app-steer-same-host')
    seedRuntime({
      runtimeId: 'rt-app-steer-same-host',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
    })
    const attempted = outcome(() =>
      db.steerContributions.insertAttempting({
        contributionId: 'contrib-app-same-host',
        hostSessionId: APP_HOST,
        runtimeId: 'rt-app-steer-same-host',
        invocationId: 'inv-app-same-host',
        activeRunId: 'run-app-steer-same-host',
        inputId: 'input-app-same-host',
        now: NOW,
      })
    )
    expect({ attempted, row: db.steerContributions.getById('contrib-app-same-host') }).toEqual({
      attempted: { ok: false, errorName: 'RunIdOwnershipError' },
      row: null,
    })
  })

  it('R-B7(p) [green-phase registry seam] binds a reservation only to its token and tuple', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
    const runId = 'run-app-reserved-token'
    const token = 'token-app-reserved'
    const tokens = new Map([[runId, token]])
    db.runIdOwnership.setReservationTokenReader((candidate) => tokens.get(candidate))
    expect(db.runIdOwnership.reserveRunId(runId, token, APP_HOST, 1)).toBe('reserved')
    expect(db.runIdOwnership.reserveRunId(runId, 'token-other', APP_HOST, 1)).toBe(
      'reserved-by-other'
    )

    tokens.clear()
    const withoutToken = outcome(() =>
      seedRuntime({
        runtimeId: 'rt-app-reserved-no-token',
        hostSessionId: APP_HOST,
        scopeRef: APP_SCOPE,
        laneRef: APP_LANE,
        activeRunId: runId,
      })
    )
    tokens.set(runId, token)
    seedRuntime({
      runtimeId: 'rt-app-reserved-bound',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      activeRunId: runId,
      activeOperationId: 'op-app-reserved-bound',
    })
    db.runs.insert({
      runId,
      hostSessionId: APP_HOST,
      runtimeId: 'rt-app-reserved-bound',
      operationId: 'op-app-reserved-bound',
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      generation: 1,
      transport: 'tmux',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    db.runIdOwnership.releaseRunId(runId, token)
    tokens.clear()

    expect({
      withoutToken,
      row: db.runs.getByRunId(runId),
      handle: db.runtimes.getByRuntimeId('rt-app-reserved-bound')?.activeRunId,
      reserveAfterSeal: db.runIdOwnership.reserveRunId(runId, 'token-after', APP_HOST, 1),
    }).toEqual({
      withoutToken: { ok: false, errorName: 'RunIdReservedError' },
      row: expect.objectContaining({
        runtimeId: 'rt-app-reserved-bound',
        operationId: 'op-app-reserved-bound',
      }),
      handle: runId,
      reserveAfterSeal: 'exists',
    })
  })

  it('R-B7(p) [green-phase registry seam] treats runtime and contribution handles as named ids', () => {
    seedSession('hsid-agent-handles', 'agent:smokey:project:hrc-runtime', 'handles')
    seedRuntime({
      runtimeId: 'rt-agent-handle-only',
      hostSessionId: 'hsid-agent-handles',
      scopeRef: 'agent:smokey:project:hrc-runtime',
      laneRef: 'handles',
      activeRunId: 'run-runtime-handle-only',
    })
    db.steerContributions.insertAttempting({
      contributionId: 'contrib-handle-only',
      hostSessionId: 'hsid-agent-handles',
      runtimeId: 'rt-agent-handle-only',
      invocationId: 'inv-agent-handle-only',
      activeRunId: 'run-contribution-handle-only',
      inputId: 'input-agent-handle-only',
      now: NOW,
    })

    expect({
      runtime: db.runIdOwnership.reserveRunId(
        'run-runtime-handle-only',
        'token-runtime',
        APP_HOST,
        1
      ),
      contribution: db.runIdOwnership.reserveRunId(
        'run-contribution-handle-only',
        'token-contribution',
        APP_HOST,
        1
      ),
    }).toEqual({ runtime: 'exists', contribution: 'exists' })
  })

  it('control allows the app host and preserves agent-to-agent handle writes', () => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
    const operationId = 'op-app-own-host'
    seedRuntime({
      runtimeId: 'rt-app-own-host',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      activeOperationId: operationId,
    })
    db.runs.insert({
      runId: 'run-app-own-host',
      hostSessionId: APP_HOST,
      runtimeId: 'rt-app-own-host',
      operationId,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: NOW,
      updatedAt: NOW,
    })
    db.runtimes.updateRunId('rt-app-own-host', 'run-app-own-host', NOW)

    seedSession('hsid-agent-owner', 'agent:one:project:hrc-runtime')
    seedSession('hsid-agent-foreign', 'agent:two:project:hrc-runtime')
    db.runs.insert({
      runId: 'run-agent-cross-host',
      hostSessionId: 'hsid-agent-owner',
      scopeRef: 'agent:one:project:hrc-runtime',
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: NOW,
      updatedAt: NOW,
    })
    seedRuntime({
      runtimeId: 'rt-agent-cross-host',
      hostSessionId: 'hsid-agent-foreign',
      scopeRef: 'agent:two:project:hrc-runtime',
      activeRunId: 'run-agent-cross-host',
    })

    expect(db.runtimes.getByRuntimeId('rt-app-own-host')?.activeRunId).toBe('run-app-own-host')
    expect(db.runtimes.getByRuntimeId('rt-agent-cross-host')?.activeRunId).toBe(
      'run-agent-cross-host'
    )
  })
})

type ReservationHarness = {
  tokens: Map<string, string>
  reserve(runId: string, token?: string): string
  setToken(runId: string, token: string | undefined): void
}

function reservationHarness(): ReservationHarness {
  const tokens = new Map<string, string>()
  db.runIdOwnership.setReservationTokenReader((runId) => tokens.get(runId))
  return {
    tokens,
    reserve(runId, token = `token-${runId}`) {
      tokens.set(runId, token)
      const result = db.runIdOwnership.reserveRunId(runId, token, APP_HOST, 1)
      if (result !== 'reserved') throw new Error(`failed to reserve ${runId}: ${result}`)
      db.runs.insert({
        runId,
        hostSessionId: APP_HOST,
        scopeRef: APP_SCOPE,
        laneRef: APP_LANE,
        generation: 1,
        transport: 'tmux',
        status: 'queued',
        acceptedAt: NOW,
        updatedAt: NOW,
      })
      return token
    },
    setToken(runId, token) {
      if (token === undefined) tokens.delete(runId)
      else tokens.set(runId, token)
    },
  }
}

const authorityErrorName = expect.stringMatching(/^RunId(?:Ownership|Reserved)Error$/)

describe('T-08576 G1 reserved-run tuple binding authority', () => {
  beforeEach(() => {
    seedSession(APP_HOST, APP_SCOPE, APP_LANE)
  })

  it('G1a [green-phase registry seam] refuses a tokenless first operation binding', () => {
    const reservations = reservationHarness()
    const runId = 'run-g1a-tokenless-operation'
    reservations.reserve(runId)
    reservations.setToken(runId, undefined)

    const attempted = outcome(() => {
      db.runs.update(runId, { operationId: 'op-g1a-foreign', updatedAt: NOW })
    })

    expect({ attempted, operationId: db.runs.getByRunId(runId)?.operationId }).toEqual({
      attempted: { ok: false, errorName: authorityErrorName },
      operationId: undefined,
    })
  })

  it('G1b [green-phase registry seam] refuses a wrong-token first operation binding', () => {
    const reservations = reservationHarness()
    const runId = 'run-g1b-wrong-token-operation'
    reservations.reserve(runId)
    reservations.setToken(runId, 'token-not-the-holder')

    const attempted = outcome(() => {
      db.runs.update(runId, { operationId: 'op-g1b-foreign', updatedAt: NOW })
    })

    expect({ attempted, operationId: db.runs.getByRunId(runId)?.operationId }).toEqual({
      attempted: { ok: false, errorName: authorityErrorName },
      operationId: undefined,
    })
  })

  it('G1c [green-phase registry seam] lets only the holder establish an operation tuple', () => {
    const reservations = reservationHarness()
    const runId = 'run-g1c-holder-operation'
    reservations.reserve(runId)

    const first = outcome(() => {
      db.runs.update(runId, { operationId: 'op-g1c-holder', updatedAt: NOW })
    })
    const idempotent = outcome(() => {
      db.runs.update(runId, { operationId: 'op-g1c-holder', updatedAt: NOW })
    })
    const different = outcome(() => {
      db.runs.update(runId, { operationId: 'op-g1c-other', updatedAt: NOW })
    })

    expect({
      first,
      idempotent,
      different,
      operationId: db.runs.getByRunId(runId)?.operationId,
    }).toEqual({
      first: { ok: true },
      idempotent: { ok: true },
      different: { ok: false, errorName: 'RunIdOwnershipError' },
      operationId: 'op-g1c-holder',
    })
  })

  it('G1d [green-phase registry seam] lets claimQueued seal the exact holder tuple', () => {
    const reservations = reservationHarness()
    const runId = 'run-g1d-holder-claim'
    reservations.reserve(runId)
    seedRuntime({
      runtimeId: 'rt-g1d-holder',
      hostSessionId: APP_HOST,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      activeOperationId: 'op-g1d-holder',
    })

    const claimed = db.runs.claimQueued(runId, {
      runtimeId: 'rt-g1d-holder',
      operationId: 'op-g1d-holder',
      invocationId: undefined,
      dispatchedInputId: 'input-g1d-holder',
      updatedAt: NOW,
    })

    expect({ claimed, row: db.runs.getByRunId(runId) }).toEqual({
      claimed: true,
      row: expect.objectContaining({
        status: 'accepted',
        hostSessionId: APP_HOST,
        generation: 1,
        runtimeId: 'rt-g1d-holder',
        operationId: 'op-g1d-holder',
      }),
    })
  })

  it('G1e [green-phase registry seam] gates every first reserved tuple-column binding', () => {
    const reservations = reservationHarness()
    const runIds = {
      runtimeUpdate: 'run-g1e-runtime-update',
      runtimeClaim: 'run-g1e-runtime-claim',
      operationUpdate: 'run-g1e-operation-update',
      operationClaim: 'run-g1e-operation-claim',
      host: 'run-g1e-host',
      generation: 'run-g1e-generation',
      same: 'run-g1e-same-values',
    }
    for (const runId of Object.values(runIds)) {
      reservations.reserve(runId)
      reservations.setToken(runId, undefined)
    }

    const runtimeUpdate = outcome(() => {
      db.runs.update(runIds.runtimeUpdate, { runtimeId: 'rt-g1e-update', updatedAt: NOW })
    })
    const runtimeClaim = outcome(() => {
      db.runs.claimQueued(runIds.runtimeClaim, {
        runtimeId: 'rt-g1e-claim',
        operationId: undefined,
        invocationId: 'inv-g1e-runtime-claim',
        dispatchedInputId: 'input-g1e-runtime-claim',
        updatedAt: NOW,
      })
    })
    const operationUpdate = outcome(() => {
      db.runs.update(runIds.operationUpdate, {
        operationId: 'op-g1e-update',
        updatedAt: NOW,
      })
    })
    const operationClaim = outcome(() => {
      db.runs.claimQueued(runIds.operationClaim, {
        runtimeId: undefined,
        operationId: 'op-g1e-claim',
        invocationId: 'inv-g1e-operation-claim',
        dispatchedInputId: 'input-g1e-operation-claim',
        updatedAt: NOW,
      })
    })
    const host = outcome(() => {
      db.runs.update(runIds.host, { hostSessionId: 'hsid-g1e-other', updatedAt: NOW })
    })
    const generation = outcome(() => {
      db.runs.update(runIds.generation, { generation: 2, updatedAt: NOW })
    })
    const same = outcome(() => {
      db.runs.update(runIds.same, {
        hostSessionId: APP_HOST,
        generation: 1,
        updatedAt: NOW,
      })
    })

    expect({
      runtimeUpdate,
      runtimeClaim,
      operationUpdate,
      operationClaim,
      host,
      generation,
      same,
      rows: Object.fromEntries(
        Object.entries(runIds).map(([key, runId]) => [
          key,
          db.runs.getByRunId(runId) === null
            ? null
            : {
                hostSessionId: db.runs.getByRunId(runId)?.hostSessionId,
                generation: db.runs.getByRunId(runId)?.generation,
                runtimeId: db.runs.getByRunId(runId)?.runtimeId,
                operationId: db.runs.getByRunId(runId)?.operationId,
                status: db.runs.getByRunId(runId)?.status,
              },
        ])
      ),
    }).toEqual({
      runtimeUpdate: { ok: false, errorName: authorityErrorName },
      runtimeClaim: { ok: false, errorName: authorityErrorName },
      operationUpdate: { ok: false, errorName: authorityErrorName },
      operationClaim: { ok: false, errorName: authorityErrorName },
      host: { ok: false, errorName: 'RunIdOwnershipError' },
      generation: { ok: false, errorName: 'RunIdOwnershipError' },
      same: { ok: true },
      rows: {
        runtimeUpdate: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
        runtimeClaim: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
        operationUpdate: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
        operationClaim: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
        host: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
        generation: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
        same: {
          hostSessionId: APP_HOST,
          generation: 1,
          runtimeId: undefined,
          operationId: undefined,
          status: 'queued',
        },
      },
    })
  })

  it('G1f control keeps ordinary unreserved run tuple binding unchanged', () => {
    const agentHost = 'hsid-g1f-agent'
    const agentScope = 'agent:smokey:project:hrc-runtime:task:T-08576'
    seedSession(agentHost, agentScope, 'g1f')
    seedRuntime({
      runtimeId: 'rt-g1f-update',
      hostSessionId: agentHost,
      scopeRef: agentScope,
      laneRef: 'g1f',
      activeOperationId: 'op-g1f-update',
    })
    seedRuntime({
      runtimeId: 'rt-g1f-claim',
      hostSessionId: agentHost,
      scopeRef: agentScope,
      laneRef: 'g1f',
      activeOperationId: 'op-g1f-claim',
    })
    for (const runId of ['run-g1f-update', 'run-g1f-claim']) {
      db.runs.insert({
        runId,
        hostSessionId: agentHost,
        scopeRef: agentScope,
        laneRef: 'g1f',
        generation: 1,
        transport: 'tmux',
        status: 'queued',
        acceptedAt: NOW,
        updatedAt: NOW,
      })
    }

    const updated = db.runs.update('run-g1f-update', {
      runtimeId: 'rt-g1f-update',
      operationId: 'op-g1f-update',
      updatedAt: NOW,
    })
    const claimed = db.runs.claimQueued('run-g1f-claim', {
      runtimeId: 'rt-g1f-claim',
      operationId: 'op-g1f-claim',
      invocationId: undefined,
      dispatchedInputId: 'input-g1f-claim',
      updatedAt: NOW,
    })

    expect({ updated, claimed, claimedRow: db.runs.getByRunId('run-g1f-claim') }).toEqual({
      updated: expect.objectContaining({
        runtimeId: 'rt-g1f-update',
        operationId: 'op-g1f-update',
        status: 'queued',
      }),
      claimed: true,
      claimedRow: expect.objectContaining({
        runtimeId: 'rt-g1f-claim',
        operationId: 'op-g1f-claim',
        status: 'accepted',
      }),
    })
  })
})
