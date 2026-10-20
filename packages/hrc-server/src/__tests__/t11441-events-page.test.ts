/**
 * T-11441 gate 0 — `GET /v1/events/page`, the ascending covering ledger page
 * (hrc-runtime.rust-migration §4.2).
 *
 * The page is what a `LedgerSource` over the HTTP API reads, so the claims
 * pinned here are the ones a source must state: rows ascend by `hrc_seq`, every
 * existing row in `(afterSeq, scannedThrough]` is present (interior holes are
 * deletions, not omissions), a spilled payload comes back as its stored stub
 * rather than being dropped or hydrated, `head` is the allocated high-water
 * from `sqlite_sequence` (a deleted tail does not regress it), and a supplied
 * incarnation that no longer matches refuses `cursor_invalid`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { type HrcEventPage, readToolResultSpillDescriptor } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-11441:page'

let fixture: HrcServerTestFixture
let server: HrcServer

function withDb<T>(read: (db: HrcDatabase) => T): T {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function appendEvents(count: number, payload: (n: number) => unknown = (n) => ({ n })): number[] {
  return withDb((db) =>
    Array.from({ length: count }, (_, n) =>
      db.hrcEvents.append({
        ts: fixture.now(),
        hostSessionId: 'hsid-11441-page',
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-11441-page',
        category: 'turn',
        eventKind: 'turn.tool_result',
        transport: 'tmux',
        payload: payload(n),
      } as Parameters<HrcDatabase['hrcEvents']['append']>[0])
    ).map((event) => event.hrcSeq)
  )
}

function deleteSeqs(seqs: number[]): void {
  withDb((db) => {
    for (const seq of seqs) db.sqlite.run('DELETE FROM hrc_events WHERE hrc_seq = ?', [seq])
  })
}

async function page(params: Record<string, string | number>): Promise<HrcEventPage> {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)])
  )
  const res = await fixture.fetchSocket(`/v1/events/page?${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as HrcEventPage
}

/** Every row a sequence of pages returns, walking from `afterSeq` to the head. */
async function walk(afterSeq: number, limit: number, incarnation: string): Promise<number[]> {
  const seen: number[] = []
  let cursor = afterSeq
  for (;;) {
    const next = await page({ afterSeq: cursor, limit, ledgerIncarnationId: incarnation })
    seen.push(...next.rows.map((row) => row.hrcSeq))
    expect(next.scannedThrough).toBeGreaterThanOrEqual(cursor)
    if (next.scannedThrough === cursor) return seen
    cursor = next.scannedThrough
    if (cursor >= next.head && next.rows.length < limit) return seen
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t11441-page-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

describe('GET /v1/events/page', () => {
  it('discovers the incarnation and head without one, and requires afterSeq and limit', async () => {
    const seqs = appendEvents(3)
    const discovered = await page({ afterSeq: 0, limit: 1 })
    const incarnation = withDb((db) => db.hrcEvents.ledgerIncarnationId())

    expect(discovered.ledgerIncarnationId).toBe(incarnation)
    expect(discovered.head).toBe(seqs.at(-1)!)
    expect(discovered.rows).toHaveLength(1)
    expect(discovered.scannedThrough).toBe(discovered.rows[0]!.hrcSeq)

    for (const query of ['limit=10', 'afterSeq=0', 'afterSeq=0&limit=0', 'afterSeq=-1&limit=1']) {
      const res = await fixture.fetchSocket(`/v1/events/page?${query}`)
      expect(res.status).toBe(400)
    }
  })

  it('covers (afterSeq, scannedThrough] ascending across interior holes', async () => {
    const seqs = appendEvents(12)
    // Interior holes, including a run of adjacent deletions.
    const holes = [seqs[2]!, seqs[5]!, seqs[6]!, seqs[7]!, seqs[10]!]
    deleteSeqs(holes)
    const expected = seqs.filter((seq) => !holes.includes(seq))
    const incarnation = withDb((db) => db.hrcEvents.ledgerIncarnationId())
    const afterSeq = seqs[0]! - 1

    for (const limit of [1, 2, 3, 100]) {
      const rows = await walk(afterSeq, limit, incarnation)
      expect(rows).toEqual(expected)
    }

    // A full page ends at its last row; the next page resumes after it.
    const first = await page({ afterSeq, limit: 3, ledgerIncarnationId: incarnation })
    expect(first.rows.map((row) => row.hrcSeq)).toEqual(expected.slice(0, 3))
    expect(first.scannedThrough).toBe(expected[2]!)

    // A short page scans through head, even past the hole run.
    const short = await page({ afterSeq: seqs[4]!, limit: 100, ledgerIncarnationId: incarnation })
    expect(short.rows.map((row) => row.hrcSeq)).toEqual([seqs[8]!, seqs[9]!, seqs[11]!])
    expect(short.scannedThrough).toBe(short.head)
  })

  it('keeps head at the allocated high-water when the tail row is deleted', async () => {
    const seqs = appendEvents(4)
    const incarnation = withDb((db) => db.hrcEvents.ledgerIncarnationId())
    deleteSeqs([seqs[3]!])

    const tail = await page({ afterSeq: seqs[2]!, limit: 10, ledgerIncarnationId: incarnation })
    // max(hrc_seq) would now be seqs[2]; the head never regresses.
    expect(tail.head).toBe(seqs[3]!)
    expect(tail.rows).toEqual([])
    expect(tail.scannedThrough).toBe(seqs[3]!)
  })

  it('returns a spilled payload as its stored stub and omits no row for its size', async () => {
    const body = `page-spill-marker:${'x'.repeat(200_000)}`
    const seqs = appendEvents(3, (n) =>
      n === 1
        ? { toolUseId: 'tool-11441-spill', toolName: 'exec', result: body }
        : { toolUseId: `tool-11441-${n}`, toolName: 'exec', result: 'small' }
    )
    const incarnation = withDb((db) => db.hrcEvents.ledgerIncarnationId())

    const result = await page({
      afterSeq: seqs[0]! - 1,
      limit: 10,
      ledgerIncarnationId: incarnation,
    })

    expect(result.rows.map((row) => row.hrcSeq)).toEqual(seqs)
    const spilled = result.rows[1]!.payload as { result: unknown }
    expect(readToolResultSpillDescriptor(spilled.result)).toBeDefined()
    // The stub carries a bounded preview, not the 200 KB body.
    expect(JSON.stringify(spilled).length).toBeLessThan(body.length / 4)
    // The ledger itself still hydrates it: the page is "as stored", not lossy storage.
    const hydrated = withDb((db) => db.hrcEvents.listFromHrcSeq(seqs[1]!, { limit: 1 }))[0]!
      .payload as { result: unknown }
    expect(hydrated.result).toBe(body)
  })

  it('refuses cursor_invalid on an incarnation mismatch, and after a replacement', async () => {
    appendEvents(2)
    const stale = await fixture.fetchSocket(
      '/v1/events/page?afterSeq=0&limit=10&ledgerIncarnationId=not-this-ledger'
    )
    expect(stale.status).toBe(409)
    expect(await stale.text()).toContain('cursor_invalid')

    const before = withDb((db) => db.hrcEvents.ledgerIncarnationId())
    withDb((db) =>
      db.sqlite.run(
        "UPDATE hrc_event_ledger_metadata SET ledger_incarnation_id = 'replaced-11441' WHERE id = 1"
      )
    )
    const replaced = await fixture.fetchSocket(
      `/v1/events/page?afterSeq=0&limit=10&ledgerIncarnationId=${before}`
    )
    expect(replaced.status).toBe(409)
    const body = (await replaced.json()) as { error: { code: string; detail: unknown } }
    expect(JSON.stringify(body)).toContain('replaced-11441')

    const rediscovered = await page({ afterSeq: 0, limit: 10 })
    expect(rediscovered.ledgerIncarnationId).toBe('replaced-11441')
  })
})
