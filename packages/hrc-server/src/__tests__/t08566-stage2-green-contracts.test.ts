import { Database } from 'bun:sqlite'
/**
 * T-08566 stage 2 — green-phase contracts the reds cannot express before the
 * implementation exists: offline-module closure (A1-2), wire validation against
 * the real compiled-reader captures, idempotent repeat (C4), and the automatic
 * O2 (terminal) and startup triggers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateOfflineEvidencePage } from '../broker/offline-evidence'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { capturedReaderResponse, seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

const CAPTURES = join(import.meta.dir, 'fixtures', 't08566-real-reader-responses')

async function request(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(CAPTURES, `${name}.request.json`), 'utf8'))
}

/** A paging-respecting reader derived from the real 61-event capture. */
async function installPagedFullReader(
  seeded: Awaited<ReturnType<typeof seedOfflineRuntime>>
): Promise<void> {
  const full = await capturedReaderResponse('full.stdout.json')
  const release = seeded.reader.release as {
    releaseId: string
    sourceCommit: string
    builtAt: string
  }
  const responsePath = join(seeded.reader.root, 'paged-full.json')
  await writeFile(
    responsePath,
    JSON.stringify({
      ...full,
      release: {
        releaseId: release.releaseId,
        sourceCommit: release.sourceCommit,
        builtAt: release.builtAt,
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
  .slice(0, 25)
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

/** Read-only probe of a live daemon's store (never a migrating writer open). */
function readStore<T>(dbPath: string, read: (db: Database) => T): T {
  const db = new Database(dbPath, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return read(db)
  } finally {
    db.close()
  }
}

function rowCounts(dbPath: string, runtimeId: string, invocationId: string) {
  return readStore(dbPath, (db) =>
    db
      .query<
        { hrc_events: number; broker_events: number; outcomes: number; cursor: number },
        [string, string, string, string]
      >(
        `SELECT (SELECT COUNT(*) FROM hrc_events WHERE runtime_id = ?) AS hrc_events,
                (SELECT COUNT(*) FROM broker_invocation_events WHERE invocation_id = ?) AS broker_events,
                (SELECT COUNT(*) FROM retained_evidence_outcomes WHERE invocation_id = ?) AS outcomes,
                (SELECT last_projected_seq FROM broker_invocations WHERE invocation_id = ?) AS cursor`
      )
      .get(runtimeId, invocationId, invocationId, invocationId)
  )
}

function latestOutcome(dbPath: string, invocationId: string) {
  return readStore(dbPath, (db) =>
    db
      .query<{ outcome: string; trigger: string }, [string]>(
        `SELECT outcome, trigger FROM retained_evidence_outcomes
          WHERE invocation_id = ? ORDER BY outcome_id DESC LIMIT 1`
      )
      .get(invocationId)
  )
}

async function waitFor<T>(read: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) return null
    await Bun.sleep(25)
  }
}

describe('T-08566 stage-2 green contracts', () => {
  test('A1-2: the offline module holds no ACK, attach, control or provider parsing', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', 'broker', 'offline-evidence.ts'),
      'utf8'
    )
    for (const forbidden of [
      /\.ackEvents\s*\(/,
      /\.attach\s*\(/,
      /permissionRespond/,
      /DurableBrokerClientLike/,
      /\.submit[A-Za-z]*\s*\(/,
      /from 'hrc-events'/,
      /normalize[A-Z][A-Za-z]*(Hook|Otel|Transcript)/,
    ]) {
      expect(source).not.toMatch(forbidden)
    }
    expect(source).toContain('mapper.applyRetained(envelope)')
    expect(source).not.toMatch(/mapper\.apply\(/)
  })

  test('wire: real compiled-reader ok pages validate against their own identity', async () => {
    for (const name of ['full', 'small-bytes', 'page1-limit5', 'tail-empty', 'wrong-invocation']) {
      const response = await capturedReaderResponse(`${name}.stdout.json`)
      const req = await request(name)
      const release = response['release'] as {
        releaseId: string
        sourceCommit: string
        builtAt: string
      }
      const verdict = validateOfflineEvidencePage(
        response,
        release,
        String(req['invocationId']),
        Number(req['afterSeq'])
      )
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: true })
      if (!verdict.ok) continue
      const result = response['result'] as { events: unknown[]; currentSeq: number }
      expect(verdict.page.events.length).toBe(result.events.length)
      expect(verdict.page.currentSeq).toBe(result.currentSeq)
      expect(verdict.page.nextAfterSeq).toBe(response['nextAfterSeq'] as number)
    }
  })

  test('wire: a foreign identity is a release mismatch; the cursor-above case is C22', async () => {
    const full = await capturedReaderResponse('full.stdout.json')
    const req = await request('full')
    const release = full['release'] as { releaseId: string; sourceCommit: string; builtAt: string }
    const mismatch = validateOfflineEvidencePage(
      full,
      { ...release, releaseId: 'asp-other' },
      String(req['invocationId']),
      0
    )
    expect(mismatch).toMatchObject({ ok: false, outcome: 'reader_release_mismatch' })

    const beyond = await capturedReaderResponse('after-beyond-current.stdout.json')
    const beyondReq = await request('after-beyond-current')
    const verdict = validateOfflineEvidencePage(
      beyond,
      beyond['release'] as { releaseId: string; sourceCommit: string; builtAt: string },
      String(beyondReq['invocationId']),
      Number(beyondReq['afterSeq'])
    )
    expect(verdict).toMatchObject({
      ok: false,
      outcome: 'reader_contract_violation',
      detail: { requestedAfterSeq: 100, currentSeq: 61, nextAfterSeq: 100 },
    })
  })
})

describe('T-08566 stage-2 green recovery behaviour', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer
  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08566-green-')
    server = await createHrcServer(fixture.serverOpts())
    await Bun.sleep(50)
  })
  afterEach(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  test('C4: an idempotent repeat adds only one outcome row', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'full')
    await installPagedFullReader(seeded)
    const first = await fixture.postJson('/v1/capture/recover', {
      runtimeId: seeded.runtimeId,
      yes: true,
    })
    expect(await first.json()).toMatchObject({ outcome: 'recovered', projectedThroughSeq: 61 })
    const before = rowCounts(fixture.dbPath, seeded.runtimeId, seeded.invocationId)
    const second = await fixture.postJson('/v1/capture/recover', {
      runtimeId: seeded.runtimeId,
      yes: true,
    })
    expect(await second.json()).toMatchObject({ outcome: 'recovered', class: 'complete' })
    expect(rowCounts(fixture.dbPath, seeded.runtimeId, seeded.invocationId)).toEqual({
      ...before!,
      outcomes: before!.outcomes + 1,
    })
  })

  test('O1: a terminal runtime report reads retained evidence instead of attaching', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'full')
    await installPagedFullReader(seeded)
    const response = await fixture.postJson('/v1/runtimes/broker/inspect', {
      runtimeId: seeded.runtimeId,
      recoverFinalSummary: { timeoutMs: 5_000 },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { finalSummaryRecovery?: unknown }
    // The real capture carries no invocation.summary: the offline read completes
    // and reports why no summary exists, without any controller attach.
    expect(body.finalSummaryRecovery).toEqual({ state: 'unavailable', message: 'recovered' })
    expect(latestOutcome(fixture.dbPath, seeded.invocationId)).toEqual({
      outcome: 'recovered',
      trigger: 'report',
    })
  })

  test('O2: a recorded runtime.terminated schedules one background attempt', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'full')
    await installPagedFullReader(seeded)
    ;(server as unknown as { notifyEvent(event: unknown): void }).notifyEvent({
      hrcSeq: 1,
      streamSeq: 1,
      ts: fixture.now(),
      hostSessionId: seeded.hostSessionId,
      scopeRef: seeded.scopeRef,
      laneRef: 'default',
      generation: 1,
      runtimeId: seeded.runtimeId,
      category: 'runtime',
      eventKind: 'runtime.terminated',
      replayed: false,
      payload: {},
    })
    const outcome = await waitFor(() => latestOutcome(fixture.dbPath, seeded.invocationId), 5_000)
    expect(outcome).toEqual({ outcome: 'recovered', trigger: 'terminal' })
  })
})

describe('T-08566 stage-2 startup pass', () => {
  test('a bound terminal runtime with unattempted evidence is recovered at startup', async () => {
    const fixture = await createHrcTestFixture('t08566-green-startup-')
    const seeded = await seedOfflineRuntime(fixture, 'full')
    await installPagedFullReader(seeded)
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const outcome = await waitFor(() => latestOutcome(fixture.dbPath, seeded.invocationId), 5_000)
      expect(outcome).toEqual({ outcome: 'recovered', trigger: 'startup' })
    } finally {
      await server.stop()
      await fixture.cleanup()
    }
  })
})
