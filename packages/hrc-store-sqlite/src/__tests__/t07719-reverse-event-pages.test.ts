import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../database.js'
import { HrcEventLedgerIncarnationMismatchError } from '../repositories/event-repositories.js'

type Db = ReturnType<typeof openHrcDatabase>

function appendEvent(
  db: Db,
  eventKind: string,
  overrides: { hostSessionId?: string; generation?: number } = {}
): number {
  return db.hrcEvents.append({
    ts: new Date().toISOString(),
    hostSessionId: overrides.hostSessionId ?? 'hsid-a',
    scopeRef: 'agent:test:project:hrc-runtime:task:T-07719',
    laneRef: 'default',
    generation: overrides.generation ?? 1,
    category: 'turn',
    eventKind,
    payload: { eventKind },
  }).hrcSeq
}

type CountingStatement = { all: (...values: unknown[]) => unknown[] }
type CountingDatabase = { query: (sql: string) => CountingStatement }

/**
 * Wrap `Database.query` so a single repository call reports how many rows it
 * actually materialized. This is the limit-plus-one bound observed from the
 * outside — the rows SQLite handed back — rather than re-derived from the SQL
 * text the repository happens to build.
 */
function recordMaterializedRows(db: Db): { counts: number[]; restore: () => void } {
  const counts: number[] = []
  const sqlite = db.sqlite as unknown as CountingDatabase
  const original = sqlite.query.bind(sqlite)
  const patched: CountingStatement[] = []
  sqlite.query = (sql: string) => {
    const statement = original(sql)
    const all = statement.all.bind(statement)
    statement.all = (...values: unknown[]) => {
      const rows = all(...values)
      if (sql.includes('FROM hrc_events')) counts.push(rows.length)
      return rows
    }
    patched.push(statement)
    return statement
  }
  return {
    counts,
    restore: () => {
      sqlite.query = original
      // bun:sqlite caches prepared statements; drop the shadowing own property.
      for (const statement of patched) {
        Reflect.deleteProperty(statement, 'all')
      }
    },
  }
}

describe('T-07719 exclusive-before reverse lifecycle-event pages', () => {
  test('a newest page and its exclusive-before predecessor page do not overlap', () => {
    const db = openHrcDatabase(':memory:')
    try {
      for (const kind of ['e1', 'e2', 'e3', 'e4', 'e5']) appendEvent(db, kind)

      const first = db.hrcEvents.tail(2, { hostSessionId: 'hsid-a' })
      expect(first.events.map((event) => event.eventKind)).toEqual(['e4', 'e5'])
      expect(first.truncated).toBe(true)

      const second = db.hrcEvents.tail(
        2,
        { hostSessionId: 'hsid-a' },
        {
          beforeHrcSeq: first.events[0]!.hrcSeq,
          expectedLedgerIncarnationId: first.ledgerIncarnationId,
        }
      )
      expect(second.events.map((event) => event.eventKind)).toEqual(['e2', 'e3'])
      expect(second.events[0]!.hrcSeq).toBeLessThan(second.events[1]!.hrcSeq)
      expect(second.truncated).toBe(true)
      expect(second.headHrcSeq).toBe(first.headHrcSeq)
      expect(second.ledgerIncarnationId).toBe(first.ledgerIncarnationId)
    } finally {
      db.close()
    }
  })

  test('the before boundary is exclusive of its own sequence', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const seqs = ['e1', 'e2', 'e3'].map((kind) => appendEvent(db, kind))
      const incarnation = db.hrcEvents.ledgerIncarnationId()

      const page = db.hrcEvents.tail(
        10,
        { hostSessionId: 'hsid-a' },
        { beforeHrcSeq: seqs[1]!, expectedLedgerIncarnationId: incarnation }
      )
      expect(page.events.map((event) => event.hrcSeq)).toEqual([seqs[0]!])
    } finally {
      db.close()
    }
  })

  test('a cursor at the start of history returns an empty untruncated page with live head', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const seqs = ['e1', 'e2', 'e3'].map((kind) => appendEvent(db, kind))
      const incarnation = db.hrcEvents.ledgerIncarnationId()

      const page = db.hrcEvents.tail(
        10,
        { hostSessionId: 'hsid-a' },
        { beforeHrcSeq: seqs[0]!, expectedLedgerIncarnationId: incarnation }
      )
      expect(page.events).toEqual([])
      expect(page.truncated).toBe(false)
      expect(page.headHrcSeq).toBe(seqs[2]!)
      expect(page.ledgerIncarnationId).toBe(incarnation)
    } finally {
      db.close()
    }
  })

  test('limit one walks history one row at a time and reports older rows remain', () => {
    const db = openHrcDatabase(':memory:')
    try {
      for (const kind of ['e1', 'e2', 'e3']) appendEvent(db, kind)
      const incarnation = db.hrcEvents.ledgerIncarnationId()

      const walked: string[] = []
      let before: number | undefined
      // Bounded so a tail that ignores the cursor fails the walk instead of spinning.
      for (let step = 0; step < 5; step += 1) {
        const page = db.hrcEvents.tail(
          1,
          { hostSessionId: 'hsid-a' },
          {
            ...(before === undefined ? {} : { beforeHrcSeq: before }),
            expectedLedgerIncarnationId: incarnation,
          }
        )
        expect(page.events.length).toBeLessThanOrEqual(1)
        if (page.events.length === 0) {
          expect(page.truncated).toBe(false)
          break
        }
        walked.push(page.events[0]!.eventKind)
        before = page.events[0]!.hrcSeq
      }
      expect(walked).toEqual(['e3', 'e2', 'e1'])
    } finally {
      db.close()
    }
  })

  test('unrelated sessions and generations never consume reverse page capacity', () => {
    const db = openHrcDatabase(':memory:')
    try {
      appendEvent(db, 'match-1', { hostSessionId: 'hsid-a', generation: 2 })
      appendEvent(db, 'noise-session', { hostSessionId: 'hsid-b', generation: 2 })
      appendEvent(db, 'noise-generation', { hostSessionId: 'hsid-a', generation: 1 })
      appendEvent(db, 'match-2', { hostSessionId: 'hsid-a', generation: 2 })
      appendEvent(db, 'noise-session-2', { hostSessionId: 'hsid-b', generation: 2 })
      appendEvent(db, 'match-3', { hostSessionId: 'hsid-a', generation: 2 })
      const head = appendEvent(db, 'match-4', { hostSessionId: 'hsid-a', generation: 2 })
      const incarnation = db.hrcEvents.ledgerIncarnationId()

      const page = db.hrcEvents.tail(
        2,
        { hostSessionId: 'hsid-a', generation: 2 },
        { beforeHrcSeq: head, expectedLedgerIncarnationId: incarnation }
      )
      expect(page.events.map((event) => event.eventKind)).toEqual(['match-2', 'match-3'])
      expect(page.truncated).toBe(true)
    } finally {
      db.close()
    }
  })

  test('a replaced ledger rejects the reverse page and returns no events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-t07719-'))
    try {
      const db = openHrcDatabase(join(dir, 'first.sqlite'))
      const replacement = openHrcDatabase(join(dir, 'second.sqlite'))
      try {
        for (const kind of ['e1', 'e2', 'e3']) appendEvent(db, kind)
        const stale = replacement.hrcEvents.ledgerIncarnationId()
        expect(stale).not.toBe(db.hrcEvents.ledgerIncarnationId())

        let thrown: unknown
        try {
          db.hrcEvents.tail(
            2,
            { hostSessionId: 'hsid-a' },
            { beforeHrcSeq: 3, expectedLedgerIncarnationId: stale }
          )
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(HrcEventLedgerIncarnationMismatchError)
        const mismatch = thrown as HrcEventLedgerIncarnationMismatchError
        expect(mismatch.expectedLedgerIncarnationId).toBe(stale)
        expect(mismatch.currentLedgerIncarnationId).toBe(db.hrcEvents.ledgerIncarnationId())
        expect('events' in mismatch).toBe(false)
      } finally {
        db.close()
        replacement.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('head callers that omit the reverse cursor keep the existing tail behavior', () => {
    const db = openHrcDatabase(':memory:')
    try {
      for (const kind of ['e1', 'e2', 'e3']) appendEvent(db, kind)
      const page = db.hrcEvents.tail(2, { hostSessionId: 'hsid-a' })
      expect(page.events.map((event) => event.eventKind)).toEqual(['e2', 'e3'])
      expect(page.headHrcSeq).toBe(3)
      expect(page.truncated).toBe(true)
    } finally {
      db.close()
    }
  })

  test('a 10k-event session with cross-session noise stays index-backed and limit-plus-one bounded', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const MATCHING = 10_000
      const seed = db.sqlite.transaction(() => {
        for (let index = 0; index < MATCHING; index += 1) {
          appendEvent(db, `match-${index}`, { hostSessionId: 'hsid-big', generation: 7 })
          if (index % 10 === 0) {
            appendEvent(db, `noise-${index}`, { hostSessionId: 'hsid-noise', generation: 7 })
            appendEvent(db, `gen-${index}`, { hostSessionId: 'hsid-big', generation: 6 })
          }
        }
      })
      seed()

      const matching = db.sqlite
        .query<{ total: number }, []>(
          `SELECT COUNT(*) AS total FROM hrc_events
            WHERE host_session_id = 'hsid-big' AND generation = 7`
        )
        .get()!
      expect(matching.total).toBe(MATCHING)

      const incarnation = db.hrcEvents.ledgerIncarnationId()
      const first = db.hrcEvents.tail(50, { hostSessionId: 'hsid-big', generation: 7 })
      const recorder = recordMaterializedRows(db)
      let page: ReturnType<typeof db.hrcEvents.tail>
      try {
        page = db.hrcEvents.tail(
          50,
          { hostSessionId: 'hsid-big', generation: 7 },
          { beforeHrcSeq: first.events[0]!.hrcSeq, expectedLedgerIncarnationId: incarnation }
        )
      } finally {
        recorder.restore()
      }

      expect(page.events.length).toBe(50)
      expect(page.truncated).toBe(true)
      expect(page.events.every((event) => event.hrcSeq < first.events[0]!.hrcSeq)).toBe(true)
      // limit + 1 and nothing more, from a 10,000-row matching population.
      expect(recorder.counts).toEqual([51])

      const detail = db.sqlite
        .query<{ detail: string }, [string, number, number, number]>(
          `EXPLAIN QUERY PLAN
           SELECT hrc_seq FROM hrc_events
            WHERE host_session_id = ? AND generation = ? AND hrc_seq < ?
            ORDER BY hrc_seq DESC
            LIMIT ?`
        )
        .all('hsid-big', 7, 500_000, 51)
        .map((row) => row.detail)
        .join('\n')
      expect(detail).toContain('idx_hrc_events_host_session_generation_seq')
      expect(detail).not.toMatch(/\bSCAN hrc_events\b/)
      expect(detail).not.toContain('USE TEMP B-TREE')
    } finally {
      db.close()
    }
  })
})
