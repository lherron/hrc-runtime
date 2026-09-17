/** T-08566 C1/C5/C6/C19/C22: exact-release reader admission and failures. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import {
  type ReaderMode,
  capturedReaderResponse,
  makeOfflineReaderDouble,
  seedOfflineRuntime,
} from './fixtures/t08566-offline-reader-double'

let fixture: HrcServerTestFixture
let server: HrcServer
beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-reader-')
  server = await createHrcServer(fixture.serverOpts())
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

async function recover(mode: ReaderMode, lastProjectedSeq = 0) {
  const seeded = await seedOfflineRuntime(fixture, mode, { lastProjectedSeq })
  const response = await fixture.postJson('/v1/capture/recover', {
    runtimeId: seeded.runtimeId,
    yes: true,
  })
  const text = await response.text()
  return {
    response,
    seeded,
    body: text.trimStart().startsWith('{')
      ? (JSON.parse(text) as Record<string, unknown>)
      : { raw: text },
  }
}

function projectionState(invocationId: string) {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.sqlite
      .query<
        {
          last_projected_seq: number
          retained_projected_through_seq: number | null
          retained_hrc_events: number
          retained_broker_events: number
        },
        [string, string]
      >(
        `SELECT bi.last_projected_seq,
                bi.retained_projected_through_seq,
                (SELECT COUNT(*) FROM hrc_events WHERE evidence_origin = 'retained') AS retained_hrc_events,
                (SELECT COUNT(*) FROM broker_invocation_events WHERE invocation_id = ? AND evidence_origin = 'retained') AS retained_broker_events
           FROM broker_invocations bi
          WHERE bi.invocation_id = ?`
      )
      .get(invocationId, invocationId)
  } finally {
    db.close()
  }
}

async function installPagedTornReader(
  seeded: Awaited<ReturnType<typeof seedOfflineRuntime>>
): Promise<void> {
  const full = await capturedReaderResponse('full.stdout.json')
  const torn = await capturedReaderResponse('torn.stdout.json')
  const fullResult = full['result'] as { events: Array<{ seq: number }> }
  const tornResult = torn['result'] as Record<string, unknown>
  const release = seeded.reader.release as {
    releaseId: string
    sourceCommit: string
    builtAt: string
  }
  const responsePath = `${seeded.reader.root}/torn-pages.json`
  await writeFile(
    responsePath,
    JSON.stringify({
      ...torn,
      release: {
        releaseId: release.releaseId,
        sourceCommit: release.sourceCommit,
        builtAt: release.builtAt,
      },
      result: {
        ...tornResult,
        events: fullResult.events.filter((event) => event.seq <= 60),
        currentSeq: 60,
      },
    })
  )
  await writeFile(
    seeded.reader.executable,
    `#!/usr/bin/env bun
const request = JSON.parse(await new Response(Bun.stdin.stream()).text())
const response = JSON.parse(await Bun.file(${JSON.stringify(responsePath)}).text())
const afterSeq = Number(request.afterSeq ?? 0)
const events = response.result.events
  .filter((event) => event.seq > afterSeq)
  .slice(0, 18)
  .map((event) => ({ ...event, invocationId: request.invocationId }))
const nextAfterSeq = events.at(-1)?.seq ?? afterSeq
response.result.events = events
response.hasMore = nextAfterSeq < response.result.currentSeq
response.nextAfterSeq = nextAfterSeq
process.stdout.write(JSON.stringify(response))
`
  )
  await chmod(seeded.reader.executable, 0o755)
}

describe('T-08566 exact immutable reader release', () => {
  test('compiled-response reader double executes and records the real invocation seam', async () => {
    const reader = await makeOfflineReaderDouble(fixture.tmpDir, 'full')
    const proc = Bun.spawn([reader.executable, 'evidence-read', '--event-ledger', '/ledger'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    proc.stdin.write(
      JSON.stringify({
        schema: 'harness-broker.offline-evidence/v1',
        operation: 'eventsSince',
        invocationId: 'inv-positive-control',
        afterSeq: 0,
        limit: 500,
        maxBytes: 4 * 1024 * 1024,
      })
    )
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const response = JSON.parse(stdout) as { ok: boolean; result: { events: unknown[] } }
    expect(response.ok).toBe(true)
    expect(response.result.events.length).toBeGreaterThan(0)
    const record = JSON.parse(await readFile(reader.recordPath, 'utf8')) as {
      argv: string[]
      stdin: string
    }
    expect(record.argv).toEqual(['evidence-read', '--event-ledger', '/ledger'])
    expect(JSON.parse(record.stdin)).toMatchObject({ invocationId: 'inv-positive-control' })
  })

  test('existing lifecycle event HTTP surface is live (positive control)', async () => {
    const response = await fixture.fetchSocket('/v1/events?after=0')
    expect(response.status).toBe(200)
  })

  test('unbound, incapable, and unavailable releases refuse before reader spawn', async () => {
    const incapable = await seedOfflineRuntime(fixture, 'full', { capability: false })
    const incapableResponse = await fixture.postJson('/v1/capture/recover', {
      runtimeId: incapable.runtimeId,
      yes: true,
    })
    expect(incapableResponse.status).toBe(200)
    expect(await incapableResponse.json()).toMatchObject({ outcome: 'offline_reader_unsupported' })
    expect(existsSync(incapable.reader.recordPath)).toBe(false)

    const unbound = await seedOfflineRuntime(fixture, 'full')
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(unbound.runtimeId)!
      const state = Object.fromEntries(
        Object.entries(runtime.runtimeStateJson ?? {}).filter(([key]) => key !== 'executionRelease')
      )
      db.runtimes.update(unbound.runtimeId, { runtimeStateJson: state, updatedAt: fixture.now() })
    } finally {
      db.close()
    }
    const unboundResponse = await fixture.postJson('/v1/capture/recover', {
      runtimeId: unbound.runtimeId,
      yes: true,
    })
    expect(unboundResponse.status).toBe(200)
    expect(await unboundResponse.json()).toMatchObject({
      outcome: 'offline_reader_unsupported_unbound_release',
    })
    expect(existsSync(unbound.reader.recordPath)).toBe(false)

    const unavailable = await seedOfflineRuntime(fixture, 'full')
    await rm(unavailable.reader.root, { recursive: true, force: true })
    const unavailableResponse = await fixture.postJson('/v1/capture/recover', {
      runtimeId: unavailable.runtimeId,
      yes: true,
    })
    expect(unavailableResponse.status).toBe(200)
    expect(await unavailableResponse.json()).toMatchObject({ outcome: 'release_unavailable' })
    expect(existsSync(unavailable.reader.recordPath)).toBe(false)
  })

  test('revivable statuses never spawn an offline reader or move the cursor', async () => {
    for (const status of ['crashed', 'dead', 'stale', 'detached']) {
      const seeded = await seedOfflineRuntime(fixture, 'full', { status })
      const response = await fixture.postJson('/v1/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ outcome: 'offline_read_runtime_revivable' })
      expect(existsSync(seeded.reader.recordPath)).toBe(false)
    }
  })

  for (const [mode, outcome] of [
    ['release-mismatch', 'reader_release_mismatch'],
    ['overflow', 'reader_contract_violation'],
    ['corrupt', 'ledger_corrupt'],
    ['duplicate', 'ledger_conflicting_duplicate'],
    ['oversize', 'offline_record_too_large'],
    ['below-floor', 'replay_below_floor'],
  ] as const) {
    test(`${mode} projects nothing and records ${outcome}`, async () => {
      const { response, body } = await recover(mode)
      expect(response.status).toBe(200)
      expect(body).toMatchObject({ outcome, class: 'incomplete', projectedThroughSeq: 0 })
    })
  }

  test('exit-one records reader_failed retryable with no projection or cursor movement', async () => {
    const { response, body, seeded } = await recover('exit-one')
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      outcome: 'reader_failed',
      class: 'retryable',
      held: true,
      attempts: 1,
      projectedThroughSeq: 0,
    })
    expect(projectionState(seeded.invocationId)).toEqual({
      last_projected_seq: 0,
      retained_projected_through_seq: null,
      retained_hrc_events: 0,
      retained_broker_events: 0,
    })
  })

  test('timeout records reader_timeout retryable with no projection or cursor movement', async () => {
    const { response, body, seeded } = await recover('timeout')
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      outcome: 'reader_timeout',
      class: 'retryable',
      held: true,
      attempts: 1,
      projectedThroughSeq: 0,
    })
    expect(projectionState(seeded.invocationId)).toEqual({
      last_projected_seq: 0,
      retained_projected_through_seq: null,
      retained_hrc_events: 0,
      retained_broker_events: 0,
    })
  })

  test('torn tail projects every intact row through seq 60 and preserves integrity detail', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'torn')
    await installPagedTornReader(seeded)
    const response = await fixture.postJson('/v1/capture/recover', {
      runtimeId: seeded.runtimeId,
      yes: true,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      outcome: 'recovered_torn_tail',
      class: 'incomplete',
      held: true,
      projectedThroughSeq: 60,
      currentSeq: 60,
      detail: {
        integrity: {
          status: 'torn_tail',
          lastIntact: { invocationId: seeded.invocationId, seq: 60 },
        },
      },
    })
    const projected = projectionState(seeded.invocationId)
    expect(projected?.last_projected_seq).toBe(60)
    expect(projected?.retained_projected_through_seq).toBe(60)
    expect(projected?.retained_hrc_events).toBeGreaterThan(0)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(
        db.sqlite
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM hrc_events WHERE evidence_origin = 'retained' AND event_kind = 'turn.completed'"
          )
          .get()?.count
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  test('cursor above currentSeq is held as reader_contract_violation with exact detail', async () => {
    for (const testReader of [
      { mode: 'unknown-invocation' as const, requestedAfterSeq: 7 },
      { mode: 'after-beyond-current' as const, requestedAfterSeq: 100 },
    ]) {
      const { response, body, seeded } = await recover(
        testReader.mode,
        testReader.requestedAfterSeq
      )
      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        outcome: 'reader_contract_violation',
        class: 'incomplete',
        held: true,
        detail: { requestedAfterSeq: testReader.requestedAfterSeq },
      })
      const db = openHrcDatabase(fixture.dbPath)
      try {
        const row = db.sqlite
          .query<
            { last_projected_seq: number; retained_projected_through_seq: number | null },
            [string]
          >(
            'SELECT last_projected_seq, retained_projected_through_seq FROM broker_invocations WHERE invocation_id=?'
          )
          .get(seeded.invocationId)
        expect(row).toEqual({
          last_projected_seq: testReader.requestedAfterSeq,
          retained_projected_through_seq: null,
        })
      } finally {
        db.close()
      }
    }
  })

  test('an intact empty response at cursor zero is recovered (negative guard)', async () => {
    const { response, body, seeded } = await recover('unknown-invocation', 0)
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ outcome: 'recovered', class: 'complete', projectedThroughSeq: 0 })
    expect(await readFile(seeded.ledgerPath)).toEqual(Buffer.alloc(0))
    expect(await readFile(seeded.indexPath, 'utf8')).toBe('t08566-index-sentinel')
    const invocation = JSON.parse(await readFile(seeded.reader.recordPath, 'utf8')) as {
      argv: string[]
      stdin: string
    }
    expect(invocation.argv).toEqual([
      'evidence-read',
      '--event-ledger',
      seeded.ledgerPath,
      '--index',
      expect.stringContaining('ledger-index.db'),
    ])
    expect(JSON.parse(invocation.stdin)).toMatchObject({
      invocationId: seeded.invocationId,
      afterSeq: 0,
      limit: 500,
      maxBytes: 4 * 1024 * 1024,
    })
    const environment = await readFile(`${seeded.reader.recordPath}.env`, 'utf8')
    expect(environment).not.toMatch(/^(?:HARNESS_BROKER_|HRC_SOCKET)/m)
  })
})
