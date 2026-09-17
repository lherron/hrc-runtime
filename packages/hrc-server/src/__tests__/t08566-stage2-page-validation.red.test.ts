/**
 * T-08566 G1: the retained reader must validate the whole response envelope and
 * page coherence before projecting any row. The response mutations below are
 * applied to the real compiled f450dc99 captures by the executable double.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, writeFile } from 'node:fs/promises'
import { validateOfflineEvidencePage } from '../broker/offline-evidence'
import type { HrcServer } from '../index'
import { createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import {
  type OfflineRuntime,
  type ReaderMode,
  type ReaderResponseMutation,
  capturedReaderResponse,
  seedOfflineRuntime,
} from './fixtures/t08566-offline-reader-double'

const FIXTURE_RELEASE = {
  releaseId: 'asp-f450dc999924-g1-validation',
  sourceCommit: 'f450dc9999240000000000000000000000000000',
  builtAt: '2026-09-17T05:40:56.000Z',
}

function set(path: string[], value: unknown, when?: 'after-first-page'): ReaderResponseMutation {
  return { path, operation: 'set', value, ...(when === undefined ? {} : { when }) }
}

function remove(path: string[], when?: 'after-first-page'): ReaderResponseMutation {
  return { path, operation: 'delete', ...(when === undefined ? {} : { when }) }
}

function stampRelease(response: Record<string, unknown>): Record<string, unknown> {
  response['release'] = { ...FIXTURE_RELEASE }
  return response
}

function invocationIdOf(response: Record<string, unknown>): string {
  const events = (response['result'] as { events?: Array<{ invocationId?: unknown }> })?.events
  const invocationId = events?.[0]?.invocationId
  return typeof invocationId === 'string' ? invocationId : 'inv-g1-empty-control'
}

function mutate(
  source: Record<string, unknown>,
  ...mutations: ReaderResponseMutation[]
): Record<string, unknown> {
  const copy = structuredClone(source)
  for (const mutation of mutations) {
    let target: Record<string, unknown> | undefined = copy
    for (const key of mutation.path.slice(0, -1)) {
      const next = target[key]
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        target = undefined
        break
      }
      target = next as Record<string, unknown>
    }
    if (target === undefined) continue
    const key = mutation.path.at(-1)
    if (key === undefined) continue
    if (mutation.operation === 'delete') Reflect.deleteProperty(target, key)
    else target[key] = mutation.value
  }
  return copy
}

type DurableState = {
  lastProjectedSeq: number
  retainedMarker: number | null
  brokerRows: number
  maxBrokerSeq: number | null
  hrcRows: number
}

function durableState(fixture: HrcServerTestFixture, seeded: OfflineRuntime): DurableState {
  const db = new Database(fixture.dbPath, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    const invocation = db
      .query<
        { last_projected_seq: number; retained_projected_through_seq: number | null },
        [string]
      >(
        `SELECT last_projected_seq, retained_projected_through_seq
           FROM broker_invocations
          WHERE invocation_id = ?`
      )
      .get(seeded.invocationId)!
    const broker = db
      .query<{ count: number; max_seq: number | null }, [string]>(
        `SELECT COUNT(*) AS count, MAX(seq) AS max_seq
           FROM broker_invocation_events
          WHERE invocation_id = ?`
      )
      .get(seeded.invocationId)!
    const hrc = db
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM hrc_events WHERE runtime_id = ?'
      )
      .get(seeded.runtimeId)!
    return {
      lastProjectedSeq: invocation.last_projected_seq,
      retainedMarker: invocation.retained_projected_through_seq,
      brokerRows: broker.count,
      maxBrokerSeq: broker.max_seq,
      hrcRows: hrc.count,
    }
  } finally {
    db.close()
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

async function installPagedTornReader(seeded: OfflineRuntime): Promise<void> {
  const full = await capturedReaderResponse('full.stdout.json')
  const torn = await capturedReaderResponse('torn.stdout.json')
  const events = (full['result'] as { events: Array<{ seq: number }> }).events.filter(
    (event) => event.seq <= 60
  )
  const responsePath = `${seeded.reader.root}/g1-torn-pages.json`
  await writeFile(
    responsePath,
    JSON.stringify({
      ...torn,
      release: {
        releaseId: seeded.reader.release['releaseId'],
        sourceCommit: seeded.reader.release['sourceCommit'],
        builtAt: seeded.reader.release['builtAt'],
      },
      result: { ...(torn['result'] as object), events, currentSeq: 60 },
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
response.result.events = events
response.hasMore = (events.at(-1)?.seq ?? afterSeq) < response.result.currentSeq
response.nextAfterSeq = events.at(-1)?.seq ?? afterSeq
if (response.integrity?.lastIntact) response.integrity.lastIntact.invocationId = request.invocationId
process.stdout.write(JSON.stringify(response))
`
  )
  await chmod(seeded.reader.executable, 0o755)
}

describe('T-08566 G1 whole-page validation', () => {
  test('unit rejects every malformed success response before exposing a valid page', async () => {
    const full = stampRelease(await capturedReaderResponse('full.stdout.json'))
    const torn = stampRelease(await capturedReaderResponse('torn.stdout.json'))
    const fullEvents = (full['result'] as { events: unknown[] }).events
    const cases: Array<{
      name: string
      response: Record<string, unknown>
      afterSeq?: number
    }> = [
      { name: 'ok-false', response: mutate(full, set(['ok'], false)) },
      { name: 'ok-missing', response: mutate(full, remove(['ok'])) },
      {
        name: 'operation-wrong',
        response: mutate(full, set(['operation'], 'providerObservations')),
      },
      { name: 'operation-missing', response: mutate(full, remove(['operation'])) },
      { name: 'schema-wrong', response: mutate(full, set(['schema'], 'wrong')) },
      { name: 'integrity-missing', response: mutate(full, remove(['integrity'])) },
      {
        name: 'integrity-status-unknown',
        response: mutate(full, set(['integrity', 'status'], 'x')),
      },
      {
        name: 'intact-byteLength-missing',
        response: mutate(full, remove(['integrity', 'byteLength'])),
      },
      {
        name: 'torn-byteLength-missing',
        response: mutate(torn, remove(['integrity', 'byteLength'])),
      },
      {
        name: 'torn-lastIntactByteOffset-missing',
        response: mutate(torn, remove(['integrity', 'lastIntactByteOffset'])),
      },
      {
        name: 'torn-trailingBytes-missing',
        response: mutate(torn, remove(['integrity', 'trailingBytes'])),
      },
      { name: 'snapshot-missing', response: mutate(full, remove(['snapshot'])) },
      {
        name: 'snapshot-ledger-ino-missing',
        response: mutate(full, remove(['snapshot', 'ledger', 'ino'])),
      },
      {
        name: 'snapshot-ledger-size-missing',
        response: mutate(full, remove(['snapshot', 'ledger', 'size'])),
      },
      {
        name: 'snapshot-ledger-mtime-missing',
        response: mutate(full, remove(['snapshot', 'ledger', 'mtimeMs'])),
      },
      {
        name: 'snapshot-index-db-missing',
        response: mutate(full, remove(['snapshot', 'index', 'db'])),
      },
      {
        name: 'snapshot-index-db-ino-missing',
        response: mutate(full, remove(['snapshot', 'index', 'db', 'ino'])),
      },
      {
        name: 'snapshot-index-db-size-missing',
        response: mutate(full, remove(['snapshot', 'index', 'db', 'size'])),
      },
      {
        name: 'snapshot-index-db-mtime-missing',
        response: mutate(full, remove(['snapshot', 'index', 'db', 'mtimeMs'])),
      },
      {
        name: 'retention-floor-missing',
        response: mutate(full, remove(['result', 'retentionFloorSeq'])),
      },
      {
        name: 'retention-floor-non-integer',
        response: mutate(full, set(['result', 'retentionFloorSeq'], 0.5)),
      },
      {
        name: 'current-below-floor',
        response: mutate(full, set(['result', 'retentionFloorSeq'], 62)),
      },
      {
        name: 'request-below-retention-floor',
        response: mutate(full, set(['result', 'retentionFloorSeq'], 10)),
      },
      {
        name: 'astra-current-zero-with-events',
        response: mutate(full, set(['result', 'currentSeq'], 0), set(['hasMore'], false)),
      },
      {
        name: 'final-next-does-not-equal-current',
        response: mutate(
          full,
          set(['result', 'events'], fullEvents.slice(0, 60)),
          set(['hasMore'], false),
          set(['nextAfterSeq'], 60)
        ),
      },
      {
        name: 'has-more-with-empty-events',
        response: mutate(
          full,
          set(['result', 'events'], []),
          set(['hasMore'], true),
          set(['nextAfterSeq'], 0)
        ),
      },
      {
        name: 'has-more-next-equals-current',
        response: mutate(full, set(['hasMore'], true)),
      },
      {
        name: 'event-beyond-current',
        response: mutate(full, set(['result', 'currentSeq'], 60)),
      },
    ]

    const accepted: string[] = []
    const wrongOutcome: string[] = []
    const unnamedViolation: string[] = []
    for (const candidate of cases) {
      const verdict = validateOfflineEvidencePage(
        candidate.response,
        FIXTURE_RELEASE,
        invocationIdOf(candidate.response),
        candidate.afterSeq ?? 0
      )
      if (verdict.ok) accepted.push(candidate.name)
      else {
        if (verdict.outcome !== 'reader_contract_violation') wrongOutcome.push(candidate.name)
        if (typeof verdict.detail['violation'] !== 'string') unnamedViolation.push(candidate.name)
      }
    }
    expect({ accepted, wrongOutcome, unnamedViolation }).toEqual({
      accepted: [],
      wrongOutcome: [],
      unnamedViolation: [],
    })
  })

  test('unit accepts genuine compiled pages and preserves the C22 cursor guard', async () => {
    for (const [name, afterSeq] of [
      ['full', 0],
      ['page1-limit5', 0],
      ['small-bytes', 0],
      ['tail-empty', 61],
      ['wrong-invocation', 0],
      ['torn', 0],
    ] as const) {
      const response = stampRelease(await capturedReaderResponse(`${name}.stdout.json`))
      const verdict = validateOfflineEvidencePage(
        response,
        FIXTURE_RELEASE,
        invocationIdOf(response),
        afterSeq
      )
      expect({ name, verdict }).toMatchObject({ name, verdict: { ok: true } })
    }

    const tornWithoutLastIntact = stampRelease(await capturedReaderResponse('torn.stdout.json'))
    Reflect.deleteProperty(
      tornWithoutLastIntact['integrity'] as Record<string, unknown>,
      'lastIntact'
    )
    expect(
      validateOfflineEvidencePage(
        tornWithoutLastIntact,
        FIXTURE_RELEASE,
        invocationIdOf(tornWithoutLastIntact),
        0
      )
    ).toMatchObject({ ok: true })

    const fullWithoutWal = stampRelease(await capturedReaderResponse('full.stdout.json'))
    Reflect.deleteProperty(
      (fullWithoutWal['snapshot'] as { index: Record<string, unknown> }).index,
      'wal'
    )
    expect(
      validateOfflineEvidencePage(
        fullWithoutWal,
        FIXTURE_RELEASE,
        invocationIdOf(fullWithoutWal),
        0
      )
    ).toMatchObject({ ok: true })

    const beyond = stampRelease(await capturedReaderResponse('after-beyond-current.stdout.json'))
    expect(validateOfflineEvidencePage(beyond, FIXTURE_RELEASE, 'inv-c22', 100)).toMatchObject({
      ok: false,
      outcome: 'reader_contract_violation',
      detail: {
        violation: 'cursor_above_current_seq',
        requestedAfterSeq: 100,
        currentSeq: 61,
        nextAfterSeq: 100,
      },
    })
  })
})

describe('T-08566 G1 recovery-path validation', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08566-g1-page-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  async function recover(
    mode: ReaderMode,
    options: {
      lastProjectedSeq?: number
      exitCode?: 0 | 2
      responseMutations?: ReaderResponseMutation[]
    } = {}
  ) {
    const seeded = await seedOfflineRuntime(fixture, mode, options)
    const before = durableState(fixture, seeded)
    const response = await fixture.postJson('/v1/capture/recover', {
      runtimeId: seeded.runtimeId,
      yes: true,
    })
    return {
      seeded,
      before,
      after: durableState(fixture, seeded),
      body: await responseBody(response),
    }
  }

  test('exit-code/response-arm mismatches and foreign typed codes are held violations', async () => {
    const cases: Array<{
      name: string
      mode: ReaderMode
      exitCode?: 0 | 2
      responseMutations: ReaderResponseMutation[]
    }> = [
      {
        name: 'typed-recovered',
        mode: 'corrupt',
        responseMutations: [set(['error', 'code'], 'recovered')],
      },
      {
        name: 'typed-operator-disposed',
        mode: 'corrupt',
        responseMutations: [set(['error', 'code'], 'operator_disposed')],
      },
      {
        name: 'typed-unbound',
        mode: 'corrupt',
        responseMutations: [set(['error', 'code'], 'offline_reader_unsupported_unbound_release')],
      },
      {
        name: 'typed-in-progress',
        mode: 'corrupt',
        responseMutations: [set(['error', 'code'], 'in_progress')],
      },
      {
        name: 'typed-unknown',
        mode: 'corrupt',
        responseMutations: [set(['error', 'code'], 'not_a_code')],
      },
      {
        name: 'typed-provider-code',
        mode: 'corrupt',
        responseMutations: [set(['error', 'code'], 'provider_artifact_not_found')],
      },
      {
        name: 'typed-provider-operation',
        mode: 'corrupt',
        responseMutations: [set(['operation'], 'providerObservations')],
      },
      { name: 'typed-ok-true', mode: 'corrupt', responseMutations: [set(['ok'], true)] },
      {
        name: 'typed-message-missing',
        mode: 'corrupt',
        responseMutations: [remove(['error', 'message'])],
      },
      {
        name: 'exit-zero-ok-false',
        mode: 'full',
        exitCode: 0,
        responseMutations: [set(['ok'], false)],
      },
    ]
    const failures: Array<Record<string, unknown>> = []
    for (const candidate of cases) {
      const observed = await recover(candidate.mode, candidate)
      const detail = observed.body['detail'] as Record<string, unknown> | undefined
      const summary = {
        outcome: observed.body['outcome'],
        class: observed.body['class'],
        held: observed.body['held'],
        violation: detail?.['violation'],
      }
      if (
        summary.outcome !== 'reader_contract_violation' ||
        summary.class !== 'incomplete' ||
        summary.held !== true ||
        typeof summary.violation !== 'string'
      ) {
        failures.push({ name: candidate.name, ...summary })
      }
    }
    expect(failures).toEqual([])
  })

  test('genuine exit-2 captures keep their eventsSince outcomes and detail', async () => {
    for (const [mode, outcome] of [
      ['corrupt', 'ledger_corrupt'],
      ['duplicate', 'ledger_conflicting_duplicate'],
      ['oversize', 'offline_record_too_large'],
      ['below-floor', 'replay_below_floor'],
      ['checkout-exec', 'offline_schema_unsupported'],
    ] as const) {
      const observed = await recover(mode)
      expect({ mode, body: observed.body }).toMatchObject({
        mode,
        body: {
          outcome,
          detail: {
            errorCode: outcome,
            errorData: { code: outcome, message: expect.any(String) },
          },
        },
      })
    }
  })

  test('malformed first success page writes no projection, cursor, or marker', async () => {
    const cases = [
      { name: 'integrity-missing', mutations: [remove(['integrity'])] },
      {
        name: 'final-current-zero',
        mutations: [set(['result', 'currentSeq'], 0), set(['hasMore'], false)],
      },
      { name: 'wrong-operation', mutations: [set(['operation'], 'providerObservations')] },
    ]
    const failures: Array<Record<string, unknown>> = []
    for (const candidate of cases) {
      const observed = await recover('full', { responseMutations: candidate.mutations })
      const summary = {
        outcome: observed.body['outcome'],
        class: observed.body['class'],
        held: observed.body['held'],
        stateUnchanged: JSON.stringify(observed.after) === JSON.stringify(observed.before),
        after: observed.after,
      }
      if (
        summary.outcome !== 'reader_contract_violation' ||
        summary.class !== 'incomplete' ||
        summary.held !== true ||
        !summary.stateUnchanged
      ) {
        failures.push({ name: candidate.name, ...summary })
      }
    }
    expect(failures).toEqual([])
  })

  test('malformed page two preserves exactly the committed page-one prefix', async () => {
    const observed = await recover('small-bytes', {
      responseMutations: [remove(['integrity'], 'after-first-page')],
    })
    expect({ body: observed.body, state: observed.after }).toMatchObject({
      body: { outcome: 'reader_contract_violation', class: 'incomplete', held: true },
      state: {
        lastProjectedSeq: 18,
        retainedMarker: 18,
        brokerRows: 18,
        maxBrokerSeq: 18,
      },
    })
  })

  test('intact, torn-tail, and empty-tail recovery controls remain accepted', async () => {
    const intact = await recover('full')
    expect(intact.body).toMatchObject({ outcome: 'recovered', complete: true })

    const tornSeed = await seedOfflineRuntime(fixture, 'torn')
    await installPagedTornReader(tornSeed)
    const tornResponse = await fixture.postJson('/v1/capture/recover', {
      runtimeId: tornSeed.runtimeId,
      yes: true,
    })
    expect(await responseBody(tornResponse)).toMatchObject({
      outcome: 'recovered_torn_tail',
      complete: false,
      projectedThroughSeq: 60,
    })

    const empty = await recover('tail-empty', { lastProjectedSeq: 61 })
    expect(empty.body).toMatchObject({
      outcome: 'recovered',
      complete: true,
      projectedThroughSeq: 61,
    })
    expect(empty.after.brokerRows).toBe(0)
    expect(empty.after.hrcRows).toBe(0)
  })
})
