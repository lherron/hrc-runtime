/**
 * T-08566 stage 2 H1 — the directory hold is one runtime-wide predicate, not a
 * terminal-only recovery side effect. These tests deliberately aggregate the
 * status/outcome matrix so a first mismatch cannot hide later consumer drift.
 *
 * The stale -> adopt -> terminate release path is not represented here: the
 * repository fixture has no honest live-broker adoption handshake. That path
 * remains an isolated-rig proof; synthesizing an `adopted` row would not test
 * the authority crossing that the acceptance row requires.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RUNTIME_STATUS_LEVEL_BY_STATUS, TERMINAL_RUNTIME_STATUSES } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { retainedEvidenceHold, retainedEvidencePassCandidates } from '../broker/offline-evidence'
import { type HrcServer, createHrcServer } from '../index'
import { sweepOrphanedBrokerTmuxLeases } from '../startup-reconcile/lease-identity'
import { evaluatePruneDisposition } from '../sweep-helpers'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

const STATUSES = Object.keys(RUNTIME_STATUS_LEVEL_BY_STATUS)
const REVIVABLE = new Set(['crashed', 'dead', 'stale', 'detached'])
const LIVE_OR_TRANSITIONAL = [
  'ready',
  'idle',
  'busy',
  'awaiting_input',
  'starting',
  'stopping',
  'adopted',
] as const
const DISPOSABLE = [...TERMINAL_RUNTIME_STATUSES, 'detached']
const OUTCOMES = [
  { key: 'absent', outcome: undefined, outcomeClass: undefined, holds: true },
  { key: 'recovered', outcome: 'recovered', outcomeClass: 'complete', holds: false },
  {
    key: 'operator-disposed',
    outcome: 'operator_disposed',
    outcomeClass: 'disposed',
    holds: false,
  },
  {
    key: 'incomplete',
    outcome: 'recovered_torn_tail',
    outcomeClass: 'incomplete',
    holds: true,
  },
  { key: 'retryable', outcome: 'reader_timeout', outcomeClass: 'retryable', holds: true },
  {
    key: 'paused',
    outcome: 'paused_needs_disposition',
    // Production persists a paused outcome with the repository's retryable class;
    // the semantic paused class is derived from the outcome string.
    outcomeClass: 'retryable',
    holds: true,
  },
] as const

const OLD = '2026-01-01T00:00:00.000Z'

type OutcomeCase = (typeof OUTCOMES)[number]
type Seeded = {
  runtimeId: string
  invocationIds: string[]
  ledgerPath: string
  ledgerBytes: Buffer
}

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-hold-predicate-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function releaseFor(suffix: string) {
  return {
    source: 'aspd',
    releaseId: `asp-h1-${suffix}`,
    sourceCommit: 'f450dc9999240000000000000000000000000000',
    builtAt: '2026-09-17T05:40:56.000Z',
    releaseRoot: join(fixture.tmpDir, `release-${suffix}`),
    worker: {
      protocol: 'harness-broker/0.2',
      executable: join(fixture.tmpDir, `release-${suffix}`, 'harness-broker'),
      argvPrefix: [],
    },
  }
}

async function seedBoundRuntime(
  suffix: string,
  status: string,
  outcome: OutcomeCase = OUTCOMES[0],
  options: {
    invocations?: number
    activeRunId?: string
    external?: boolean
    privateLease?: boolean
  } = {}
): Promise<Seeded> {
  const runtimeId = `rt-h1-${suffix}`
  const hostSessionId = `hsid-h1-${suffix}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-08566-${suffix}`
  const ledgerPath = join(fixture.runtimeRoot, 'bipc', suffix, 'events.ndjson')
  const ledgerBytes = Buffer.from(`{"runtimeId":"${runtimeId}","sentinel":"h1"}\n`)
  const release = releaseFor(suffix)
  await mkdir(dirname(ledgerPath), { recursive: true })
  await writeFile(ledgerPath, ledgerBytes)
  await mkdir(release.releaseRoot, { recursive: true })
  await writeFile(
    join(release.releaseRoot, 'release.json'),
    JSON.stringify({
      releaseId: release.releaseId,
      sourceCommit: release.sourceCommit,
      builtAt: release.builtAt,
      capabilities: ['harness-broker.offline-evidence/v1'],
    })
  )

  fixture.seedSession(hostSessionId, scopeRef)
  fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, { status })
  const db = openHrcDatabase(fixture.dbPath)
  const invocationIds = Array.from(
    { length: options.invocations ?? 1 },
    (_, index) => `inv-h1-${suffix}-${index + 1}`
  )
  try {
    db.runtimes.update(runtimeId, {
      transport: 'headless',
      controllerKind: 'harness-broker',
      activeInvocationId: invocationIds.at(-1),
      ...(options.activeRunId ? { activeRunId: options.activeRunId } : {}),
      ...(options.privateLease
        ? {
            tmuxJson: {
              kind: 'broker-tmux-allocation',
              socketPath: join(fixture.runtimeRoot, 'btmux', `${suffix}.sock`),
              paneId: '%fixture-must-not-probe',
              sessionName: `hrc-${suffix}`,
              windowName: 'tui',
            },
          }
        : {}),
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId,
        hostSessionId,
        generation: 1,
        status,
        ...(options.external ? { lifecycleOwner: 'external' } : {}),
        executionRelease: release,
        broker: { eventLedgerPath: ledgerPath },
      },
      lastActivityAt: OLD,
      updatedAt: OLD,
    })
    for (const [index, invocationId] of invocationIds.entries()) {
      db.brokerInvocations.insert({
        invocationId: invocationId as never,
        operationId: `op-h1-${suffix}-${index + 1}`,
        runtimeId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'codex-app-server',
        invocationState: 'exited',
        capabilitiesJson: JSON.stringify({ offlineEvidence: true }),
        specHash: `sha256:h1-spec-${suffix}-${index + 1}`,
        startRequestHash: `sha256:h1-start-${suffix}-${index + 1}`,
        selectedProfileHash: `sha256:h1-profile-${suffix}-${index + 1}`,
        lastProjectedSeq: 0,
        createdAt: OLD,
        updatedAt: OLD,
      })
      if (outcome.outcome && outcome.outcomeClass) {
        db.retainedEvidenceOutcomes.append({
          runtimeId,
          invocationId,
          recordedAt: OLD,
          outcome: outcome.outcome,
          outcomeClass: outcome.outcomeClass,
          trigger: 'operator',
          attempts: outcome.outcome === 'reader_timeout' ? 1 : 0,
          detail: {
            schema: 'hrc.offline-evidence/v1',
            outcome: outcome.outcome,
            class: outcome.key,
          },
        })
      }
    }
  } finally {
    db.close()
  }
  return { runtimeId, invocationIds, ledgerPath, ledgerBytes }
}

function expectedHeld(status: string, outcome: OutcomeCase): boolean {
  return REVIVABLE.has(status) || outcome.holds
}

function sweepOptions(now = Date.now() + 365 * 24 * 60 * 60 * 1000) {
  return {
    graceMs: 0,
    terminalLeaseTtlMs: 0,
    now,
    removeDeadSocketFiles: true,
    killLiveLeaseServers: true,
    listBrokerProcessCommands: async () => [],
  }
}

function runtimeEventCount(runtimeId: string): number {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listByKind('runtime.terminated')
      .filter((event) => event.runtimeId === runtimeId).length
  } finally {
    db.close()
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 7_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(25)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('T-08566 H1 single hold predicate', () => {
  test('all statuses and outcome classes agree across predicate, API, prune and startup selection', async () => {
    const rows: Array<{
      status: string
      outcome: OutcomeCase
      seeded: Seeded
      expected: boolean
    }> = []
    for (const status of STATUSES) {
      for (const outcome of OUTCOMES) {
        const seeded = await seedBoundRuntime(`${status}-${outcome.key}`, status, outcome)
        rows.push({ status, outcome, seeded, expected: expectedHeld(status, outcome) })
      }
    }

    const predicateMismatches: string[] = []
    const apiMismatches: string[] = []
    const pruneMismatches: string[] = []
    const db = openHrcDatabase(fixture.dbPath)
    try {
      for (const row of rows) {
        const runtime = db.runtimes.getByRuntimeId(row.seeded.runtimeId)
        expect(runtime).toBeDefined()
        const held = retainedEvidenceHold(db, runtime!).held
        if (held !== row.expected) {
          predicateMismatches.push(
            `${row.status}/${row.outcome.key}: expected ${row.expected}, got ${held}`
          )
        }

        const response = await fixture.postJson('/v1/capture/recover', {
          runtimeId: row.seeded.runtimeId,
          dryRun: true,
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { held?: boolean }
        if (body.held !== row.expected) {
          apiMismatches.push(
            `${row.status}/${row.outcome.key}: expected ${row.expected}, got ${String(body.held)}`
          )
        }

        const disposition = await evaluatePruneDisposition(runtime!, {} as never, db)
        const reportsHold = disposition.reason === 'offline_evidence_held'
        if (reportsHold !== row.expected) {
          pruneMismatches.push(
            `${row.status}/${row.outcome.key}: expected hold reason ${row.expected}, got ${disposition.reason ?? 'prunable'}`
          )
        }
      }

      const candidates = retainedEvidencePassCandidates(db, 20)
      const expectedCandidates = rows
        .filter(
          (row) =>
            (row.status === 'terminated' || row.status === 'failed') &&
            (row.outcome.key === 'absent' || row.outcome.key === 'retryable')
        )
        .map((row) => row.seeded.runtimeId)
        .sort()
      expect(candidates.runtimeIds.toSorted()).toEqual(expectedCandidates)
      expect(candidates.eligible).toBe(expectedCandidates.length)
    } finally {
      db.close()
    }

    expect({ predicateMismatches, apiMismatches, pruneMismatches }).toEqual({
      predicateMismatches: [],
      apiMismatches: [],
      pruneMismatches: [],
    })
  }, 20_000)

  test('the actual IPC sweep keeps held terminal evidence and removes released evidence', async () => {
    // `sweepOrphanedBrokerIpcDirs` is private. Its actual effect is isolated here
    // on old `terminated` rows: the live-lease reference loop is neutralized by
    // terminalLeaseTtlMs=0, leaving retainedEvidenceHold as the discriminator.
    const held = await seedBoundRuntime('sweep-held', 'terminated', OUTCOMES[3])
    const released = await seedBoundRuntime('sweep-released', 'terminated', OUTCOMES[1])

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(retainedEvidenceHold(db, db.runtimes.getByRuntimeId(held.runtimeId)!).held).toBe(true)
      expect(retainedEvidenceHold(db, db.runtimes.getByRuntimeId(released.runtimeId)!).held).toBe(
        false
      )
      const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())
      expect(result.removedBrokerIpcDirs).toBe(1)
    } finally {
      db.close()
    }
    expect(existsSync(dirname(held.ledgerPath))).toBe(true)
    expect(existsSync(dirname(released.ledgerPath))).toBe(false)
  })

  test('API held is recomputed from the post-attempt runtime predicate', async () => {
    const busy = await seedBoundRuntime('api-busy', 'busy')
    const busyResponse = await fixture.postJson('/v1/capture/recover', {
      runtimeId: busy.runtimeId,
      yes: true,
    })
    expect(busyResponse.status).toBe(200)
    expect(await busyResponse.json()).toMatchObject({
      recorded: false,
      held: true,
      outcome: 'offline_read_runtime_revivable',
    })

    const recovered = await seedBoundRuntime('api-recovered', 'terminated', OUTCOMES[1])
    const recoveredResponse = await fixture.postJson('/v1/capture/recover', {
      runtimeId: recovered.runtimeId,
      dryRun: true,
    })
    expect(recoveredResponse.status).toBe(200)
    expect(await recoveredResponse.json()).toMatchObject({
      recorded: false,
      held: false,
      outcome: 'recovered',
    })
  })
})

describe('T-08566 H1 disposition admission', () => {
  test('live and transitional statuses refuse before probe or mutation', async () => {
    await server.stop()
    let probeCalls = 0
    server = await createHrcServer(
      fixture.serverOpts({
        brokerTmuxManagerFactory: () => {
          probeCalls += 1
          throw new Error('status admission must run before the lease probe')
        },
      } as never)
    )
    const seeded = await Promise.all(
      LIVE_OR_TRANSITIONAL.map((status) =>
        seedBoundRuntime(`refuse-${status}`, status, OUTCOMES[0], { privateLease: true })
      )
    )
    const mismatches: string[] = []
    for (const [index, status] of LIVE_OR_TRANSITIONAL.entries()) {
      const row = seeded[index]!
      const before = await readFile(row.ledgerPath)
      const response = await fixture.postJson('/v1/runtimes/prune', {
        runtimeIds: [row.runtimeId],
        disposeRetainedEvidence: true,
        reason: 'H1 status admission',
        yes: true,
      })
      if (response.status !== 200) {
        mismatches.push(`${status}: HTTP ${response.status}`)
      } else {
        const body = (await response.json()) as {
          results?: Array<{ status?: string; reason?: string }>
        }
        const result = body.results?.[0]
        if (result?.status !== 'skipped' || result.reason !== `status_not_disposable:${status}`) {
          mismatches.push(`${status}: ${JSON.stringify(result)}`)
        }
      }
      const db = openHrcDatabase(fixture.dbPath)
      try {
        expect(db.runtimes.getByRuntimeId(row.runtimeId)).toBeDefined()
        expect(db.retainedEvidenceOutcomes.listByRuntime(row.runtimeId)).toEqual([])
      } finally {
        db.close()
      }
      expect(await readFile(row.ledgerPath)).toEqual(before)
    }
    expect(probeCalls).toBe(0)
    expect(mismatches).toEqual([])
  })

  test('every non-live status disposes every held invocation transactionally', async () => {
    const rows = await Promise.all(
      DISPOSABLE.map((status) =>
        seedBoundRuntime(`dispose-${status}`, status, OUTCOMES[0], { invocations: 2 })
      )
    )
    const mismatches: string[] = []
    for (const [index, status] of DISPOSABLE.entries()) {
      const row = rows[index]!
      const response = await fixture.postJson('/v1/runtimes/prune', {
        runtimeIds: [row.runtimeId],
        disposeRetainedEvidence: true,
        reason: `dispose ${status}`,
        yes: true,
      })
      if (response.status !== 200) {
        mismatches.push(`${status}: HTTP ${response.status} ${await response.text()}`)
        const db = openHrcDatabase(fixture.dbPath)
        try {
          expect(db.runtimes.getByRuntimeId(row.runtimeId)).toBeDefined()
          expect(db.retainedEvidenceOutcomes.listByRuntime(row.runtimeId)).toEqual([])
        } finally {
          db.close()
        }
        expect(await readFile(row.ledgerPath)).toEqual(row.ledgerBytes)
        continue
      }
      const body = (await response.json()) as {
        results?: Array<{ status?: string; reason?: string }>
      }
      if (
        body.results?.[0]?.status !== 'pruned' ||
        body.results[0].reason !== 'operator_disposed'
      ) {
        mismatches.push(`${status}: ${JSON.stringify(body.results?.[0])}`)
      }
      const db = openHrcDatabase(fixture.dbPath)
      try {
        expect(db.runtimes.getByRuntimeId(row.runtimeId)).toBeNull()
        const outcomes = db.retainedEvidenceOutcomes.listByRuntime(row.runtimeId)
        expect(outcomes.map((entry) => entry.outcome)).toEqual([
          'operator_disposed',
          'operator_disposed',
        ])
      } finally {
        db.close()
      }
    }
    expect(mismatches).toEqual([])
  })

  test('external detached ownership remains a higher refusal than disposition', async () => {
    const row = await seedBoundRuntime('external-detached', 'detached', OUTCOMES[0], {
      external: true,
    })
    const response = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [row.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'must not cross external authority',
      yes: true,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      results: [
        { runtimeId: row.runtimeId, status: 'skipped', reason: 'external_lifecycle_owner' },
      ],
    })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId(row.runtimeId)).toBeDefined()
      expect(db.retainedEvidenceOutcomes.listByRuntime(row.runtimeId)).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('T-08566 H1 reachable releases', () => {
  test('stale direct termination refuses unchanged, while disposition releases and sweep reclaims', async () => {
    const row = await seedBoundRuntime('stale-release', 'stale')
    const dbBefore = openHrcDatabase(fixture.dbPath)
    const runtimeBefore = dbBefore.runtimes.getByRuntimeId(row.runtimeId)
    const holdBefore = retainedEvidenceHold(dbBefore, runtimeBefore!)
    dbBefore.close()
    expect(holdBefore).toMatchObject({ held: true, reason: 'revivable' })

    const terminate = await fixture.postJson('/v1/terminate', {
      runtimeId: row.runtimeId,
      dropContinuation: false,
      reason: 'operator_reap',
      source: 'h1-negative-control',
    })
    expect(terminate.status).toBe(503)
    expect(await terminate.json()).toMatchObject({ error: { code: 'runtime_unavailable' } })
    const dbAfterRefusal = openHrcDatabase(fixture.dbPath)
    try {
      expect(dbAfterRefusal.runtimes.getByRuntimeId(row.runtimeId)).toEqual(runtimeBefore)
      expect(retainedEvidenceHold(dbAfterRefusal, runtimeBefore!)).toEqual(holdBefore)
      expect(dbAfterRefusal.retainedEvidenceOutcomes.listByRuntime(row.runtimeId)).toEqual([])
    } finally {
      dbAfterRefusal.close()
    }
    expect(runtimeEventCount(row.runtimeId)).toBe(0)

    const disposition = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [row.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'release stale evidence',
      yes: true,
    })
    expect(disposition.status).toBe(200)
    expect(await disposition.json()).toMatchObject({
      results: [{ runtimeId: row.runtimeId, status: 'pruned', reason: 'operator_disposed' }],
    })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(
        db.retainedEvidenceOutcomes.listByRuntime(row.runtimeId).map((entry) => entry.outcome)
      ).toEqual(['operator_disposed'])
      await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())
    } finally {
      db.close()
    }
    expect(existsSync(dirname(row.ledgerPath))).toBe(false)
  })

  test('failed paused and stopped absent evidence both have a disposition release', async () => {
    const failed = await seedBoundRuntime('failed-paused', 'failed', OUTCOMES[5])
    const stopped = await seedBoundRuntime('stopped-absent', 'stopped')
    const mismatches: string[] = []
    for (const row of [failed, stopped]) {
      const response = await fixture.postJson('/v1/runtimes/prune', {
        runtimeIds: [row.runtimeId],
        disposeRetainedEvidence: true,
        reason: 'H1 reachable disposition',
        yes: true,
      })
      if (response.status !== 200) {
        mismatches.push(`${row.runtimeId}: HTTP ${response.status}`)
        continue
      }
      const body = (await response.json()) as { results?: Array<{ reason?: string }> }
      if (body.results?.[0]?.reason !== 'operator_disposed') {
        mismatches.push(`${row.runtimeId}: ${JSON.stringify(body.results?.[0])}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  test('disposed active run is guarded, then terminate plus O2 recovery releases it', async () => {
    const row = await seedOfflineRuntime(fixture, 'small-bytes', { status: 'disposed' })
    const runId = `run-${row.runtimeId}`
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runs.insert({
        runId,
        hostSessionId: row.hostSessionId,
        runtimeId: row.runtimeId,
        scopeRef: row.scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        status: 'running',
        acceptedAt: OLD,
        startedAt: OLD,
        updatedAt: OLD,
      })
      db.runtimes.update(row.runtimeId, {
        status: 'disposed',
        activeRunId: runId,
        updatedAt: OLD,
      })
    } finally {
      db.close()
    }

    const refused = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [row.runtimeId],
      disposeRetainedEvidence: true,
      reason: 'active run must terminate first',
      yes: true,
    })
    const refusalMismatches: string[] = []
    if (refused.status !== 200) {
      refusalMismatches.push(`expected HTTP 200 active_run refusal, got ${refused.status}`)
    } else {
      const body = (await refused.json()) as {
        results?: Array<{ runtimeId?: string; status?: string; reason?: string }>
      }
      const result = body.results?.[0]
      if (
        result?.runtimeId !== row.runtimeId ||
        result.status !== 'skipped' ||
        result.reason !== 'active_run'
      ) {
        refusalMismatches.push(`unexpected refusal body: ${JSON.stringify(body)}`)
      }
    }
    const afterRefusal = openHrcDatabase(fixture.dbPath)
    try {
      expect(afterRefusal.runtimes.getByRuntimeId(row.runtimeId)?.activeRunId).toBe(runId)
      expect(afterRefusal.retainedEvidenceOutcomes.listByRuntime(row.runtimeId)).toEqual([])
    } finally {
      afterRefusal.close()
    }

    const terminate = await fixture.postJson('/v1/terminate', {
      runtimeId: row.runtimeId,
      dropContinuation: false,
      reason: 'operator_reap',
      source: 'h1-release-path',
    })
    expect(terminate.status).toBe(200)
    expect(runtimeEventCount(row.runtimeId)).toBe(1)
    const recovered = await waitFor(() => {
      const observed = openHrcDatabase(fixture.dbPath)
      try {
        const latest = observed.retainedEvidenceOutcomes.latest(row.runtimeId, row.invocationId)
        return latest?.outcome === 'recovered' ? latest : undefined
      } finally {
        observed.close()
      }
    })
    expect(recovered).toMatchObject({ outcome: 'recovered', trigger: 'terminal' })

    const after = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = after.runtimes.getByRuntimeId(row.runtimeId)
      expect(runtime).toMatchObject({ status: 'terminated' })
      expect(runtime?.activeRunId).toBeUndefined()
      expect(retainedEvidenceHold(after, runtime!).held).toBe(false)
      await sweepOrphanedBrokerTmuxLeases(after, fixture.runtimeRoot, sweepOptions())
    } finally {
      after.close()
    }
    expect(existsSync(dirname(row.ledgerPath))).toBe(false)
    expect(refusalMismatches).toEqual([])
  }, 15_000)
})
