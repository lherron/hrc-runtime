/**
 * T-06973 — bounded collective-history queries.
 *
 * Before this, `query()` pushed only `messageId` and `afterSeq` into SQL: every
 * other filter lived in `canonical_record_json`, so a limited query selected
 * every row, parsed every record, ran one observation query per message, then
 * filtered and sorted in JS. These tests pin the bound (rows decoded, JSON
 * parsed, query count) as well as the semantics that must survive it.
 */
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type { HrcMessageFilter, HrcMessageRecord } from 'hrc-core'

import { collectiveHistoryFilterColumnValues } from '../collective-history-columns.js'
import { openHrcDatabase } from '../database.js'

const AGENT = 'agent:clod:project:hrc-runtime/lane:main'
const OTHER = 'agent:cody:project:hrc-runtime/lane:main'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

function tempDbPath(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return join(root, 'state.sqlite')
}

function message(input: Partial<HrcMessageRecord> & { messageId: string }): HrcMessageRecord {
  return {
    messageSeq: 1,
    createdAt: '2026-07-25T10:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: AGENT },
    rootMessageId: input.messageId,
    body: 'body',
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
    ...input,
  }
}

/** Counts statements and captures SQL so bounded work can be asserted, not assumed. */
function instrument(sqlite: Database): {
  sql: string[]
  reset: () => void
  messageSelects: () => string[]
  observationSelects: () => string[]
} {
  type QueryFn = Database['query']
  const sql: string[] = []
  const original: QueryFn = sqlite.query.bind(sqlite)
  const recording = ((text: string) => {
    sql.push(text)
    return original(text)
  }) as QueryFn
  sqlite.query = recording
  return {
    sql,
    reset: () => {
      sql.length = 0
    },
    messageSelects: () => sql.filter((text) => text.includes('FROM collective_history_messages')),
    observationSelects: () =>
      sql.filter((text) => text.includes('FROM collective_history_observations')),
  }
}

/**
 * Bulk corpus straight into SQL. Going through `recordObservation` would add a
 * reload per row; the columns still come from the shared projection so the
 * fixture cannot drift from the write path.
 */
function seedCorpus(
  sqlite: Database,
  count: number,
  shape: (index: number) => HrcMessageRecord
): void {
  const insertMessage = sqlite.prepare(
    `INSERT INTO collective_history_messages (
       message_id, canonical_record_json, canonical_source_node_id,
       canonical_source_role, canonical_created_at, created_at, updated_at,
       from_ref, to_ref, root_message_id, reply_to_message_id,
       kind, phase, host_session_id, run_id, generation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertObservation = sqlite.prepare(
    `INSERT INTO collective_history_observations (
       message_id, source_node_id, source_message_seq, source_role,
       origin_node_id, accepted_destination_node_id, record_json,
       observed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  sqlite.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const record = shape(index)
      const json = JSON.stringify(record)
      insertMessage.run(
        record.messageId,
        json,
        'svc',
        'origin',
        record.createdAt,
        record.createdAt,
        record.createdAt,
        ...collectiveHistoryFilterColumnValues(record)
      )
      insertObservation.run(
        record.messageId,
        'svc',
        record.messageSeq,
        'origin',
        'svc',
        null,
        json,
        record.createdAt,
        record.createdAt
      )
    }
  })()
}

function paddedTimestamp(index: number): string {
  const minute = String(Math.floor(index / 60) % 60).padStart(2, '0')
  const second = String(index % 60).padStart(2, '0')
  const hour = String(Math.floor(index / 3600) % 24).padStart(2, '0')
  return `2026-07-25T${hour}:${minute}:${second}.000Z`
}

function messageId(index: number): string {
  return `msg-${String(index).padStart(12, '0')}`
}

describe('T-06973 limit bounds the work a collective-history query does', () => {
  test('a limited query reads only the page: LIMIT in SQL, one batched observation read', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-bound-'))
    try {
      seedCorpus(db.sqlite, 500, (index) =>
        message({
          messageId: messageId(index),
          messageSeq: index + 1,
          createdAt: paddedTimestamp(index),
        })
      )
      const probe = instrument(db.sqlite)

      const page = db.collectiveHistory.query({ limit: 20 }, 'svc')

      expect(page).toHaveLength(20)
      // The page bound has to reach SQL, or every row is still decoded.
      expect(probe.messageSelects().some((text) => text.includes('LIMIT 20'))).toBe(true)
      // No N+1: one observation read for the whole page, not one per message.
      expect(probe.observationSelects()).toHaveLength(1)
      expect(probe.observationSelects()[0]).toContain('IN (')
      // Whole-corpus scans are what caused the CPU incident.
      expect(probe.messageSelects().some((text) => !text.includes('LIMIT'))).toBe(false)
    } finally {
      db.close()
    }
  })

  test('every message record decoded is a page member, so JSON parsing is bounded too', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-decode-'))
    try {
      seedCorpus(db.sqlite, 400, (index) =>
        message({
          messageId: messageId(index),
          messageSeq: index + 1,
          createdAt: paddedTimestamp(index),
        })
      )
      // A corrupt record outside the page must never be decoded: if the query
      // parsed it, this throws instead of returning a page.
      db.sqlite
        .query(
          `UPDATE collective_history_messages SET canonical_record_json = '{'
            WHERE message_id = ?`
        )
        .run(messageId(399))

      const page = db.collectiveHistory.query({ limit: 10 }, 'svc')
      expect(page.map((record) => record.messageId)).toEqual(
        Array.from({ length: 10 }, (_unused, index) => messageId(index))
      )
    } finally {
      db.close()
    }
  })

  test('a 20k-message corpus answers a limited query with page-sized, not corpus-sized, work', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-corpus-'))
    try {
      seedCorpus(db.sqlite, 20_000, (index) =>
        message({
          messageId: messageId(index),
          messageSeq: index + 1,
          createdAt: paddedTimestamp(index),
        })
      )
      const probe = instrument(db.sqlite)

      const page = db.collectiveHistory.query({ limit: 20, order: 'desc' }, 'svc')

      expect(page).toHaveLength(20)
      // Newest first, and the newest row of a 20k corpus is the last one.
      expect(page[0]?.messageId).toBe(messageId(19_999))
      // Bounded query count regardless of corpus size.
      expect(probe.sql.length).toBeLessThanOrEqual(4)
      expect(probe.observationSelects()).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('T-06973 filters are pushed into indexed SQL', () => {
  const CASES: ReadonlyArray<{
    name: string
    filter: HrcMessageFilter
    column: string
    expected: string[]
  }> = [
    {
      name: 'from',
      filter: { from: { kind: 'session', sessionRef: OTHER } },
      column: 'from_ref = ?',
      expected: ['msg-from'],
    },
    {
      name: 'to',
      filter: { to: { kind: 'session', sessionRef: OTHER } },
      column: 'to_ref = ?',
      expected: ['msg-to'],
    },
    {
      name: 'participant',
      filter: { participant: { kind: 'session', sessionRef: OTHER } },
      column: '(from_ref = ? OR to_ref = ?)',
      expected: ['msg-from', 'msg-to'],
    },
    {
      name: 'thread',
      filter: { thread: { rootMessageId: 'msg-root' } },
      column: 'root_message_id = ?',
      expected: ['msg-root', 'msg-reply'],
    },
    {
      name: 'replyToMessageId',
      filter: { replyToMessageId: 'msg-root' },
      column: 'reply_to_message_id = ?',
      expected: ['msg-reply'],
    },
    {
      name: 'runId',
      filter: { runId: 'run-7' },
      column: 'run_id = ?',
      expected: ['msg-run'],
    },
    {
      name: 'hostSessionId',
      filter: { hostSessionId: 'host-7' },
      column: 'host_session_id = ?',
      expected: ['msg-host'],
    },
    {
      name: 'generation',
      filter: { generation: 9 },
      column: 'generation = ?',
      expected: ['msg-generation'],
    },
    {
      name: 'kinds',
      filter: { kinds: ['broadcast'] },
      column: 'kind IN (?)',
      expected: ['msg-kind'],
    },
    {
      name: 'phases',
      filter: { phases: ['response'] },
      column: 'phase IN (?)',
      // msg-reply is a response too — the filter must return both, not just the
      // one named for the case.
      expected: ['msg-phase', 'msg-reply'],
    },
  ]

  function seedFilterCorpus(db: ReturnType<typeof openHrcDatabase>): void {
    const records: HrcMessageRecord[] = [
      message({ messageId: 'msg-root', createdAt: '2026-07-25T10:00:00.000Z' }),
      message({
        messageId: 'msg-reply',
        rootMessageId: 'msg-root',
        replyToMessageId: 'msg-root',
        phase: 'response',
        createdAt: '2026-07-25T10:00:01.000Z',
      }),
      message({
        messageId: 'msg-from',
        from: { kind: 'session', sessionRef: OTHER },
        createdAt: '2026-07-25T10:00:02.000Z',
      }),
      message({
        messageId: 'msg-to',
        to: { kind: 'session', sessionRef: OTHER },
        createdAt: '2026-07-25T10:00:03.000Z',
      }),
      message({
        messageId: 'msg-run',
        execution: { state: 'completed', runId: 'run-7' },
        createdAt: '2026-07-25T10:00:04.000Z',
      }),
      message({
        messageId: 'msg-host',
        execution: { state: 'completed', hostSessionId: 'host-7' },
        createdAt: '2026-07-25T10:00:05.000Z',
      }),
      message({
        messageId: 'msg-generation',
        execution: { state: 'completed', generation: 9 },
        createdAt: '2026-07-25T10:00:06.000Z',
      }),
      message({ messageId: 'msg-kind', kind: 'broadcast', createdAt: '2026-07-25T10:00:07.000Z' }),
      message({ messageId: 'msg-phase', phase: 'response', createdAt: '2026-07-25T10:00:08.000Z' }),
    ]
    for (const record of records) {
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'svc',
        sourceRole: 'origin',
        originNodeId: 'svc',
        record,
      })
    }
  }

  for (const { name, filter, column, expected } of CASES) {
    test(`${name} narrows in SQL and returns exactly the matching records`, () => {
      const db = openHrcDatabase(tempDbPath(`hrc-t06973-filter-${name}-`))
      try {
        seedFilterCorpus(db)
        const probe = instrument(db.sqlite)

        const found = db.collectiveHistory.query(filter, 'svc')

        expect(found.map((record) => record.messageId).sort()).toEqual([...expected].sort())
        expect(probe.messageSelects().some((text) => text.includes(column))).toBe(true)
      } finally {
        db.close()
      }
    })
  }

  test('the write path keeps the filter columns current when a canonical record is replaced', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-replace-'))
    try {
      const base = message({ messageId: 'msg-replace', messageSeq: 5 })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'max3',
        sourceRole: 'destination',
        originNodeId: 'svc',
        record: base,
      })
      // An origin observation replaces the canonical record; a stale run_id here
      // would make the message invisible to a runId query.
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'svc',
        sourceRole: 'origin',
        originNodeId: 'svc',
        record: { ...base, execution: { state: 'completed', runId: 'run-replaced' } },
      })

      expect(
        db.collectiveHistory.query({ runId: 'run-replaced' }, 'svc').map((r) => r.messageId)
      ).toEqual(['msg-replace'])
    } finally {
      db.close()
    }
  })
})

describe('T-06973 semantics that must survive the bound', () => {
  test('a clock-skewed parent still precedes its reply even when limit would cut it off', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-skew-'))
    try {
      const parent = message({
        messageId: 'msg-parent',
        messageSeq: 800,
        createdAt: '2026-07-24T12:00:10.000Z',
      })
      const child = message({
        messageId: 'msg-child',
        messageSeq: 2,
        phase: 'response',
        replyToMessageId: 'msg-parent',
        rootMessageId: 'msg-parent',
        createdAt: '2026-07-24T12:00:00.000Z',
      })
      for (const record of [parent, child]) {
        db.collectiveHistory.recordObservation({
          sourceNodeId: 'max3',
          sourceRole: 'origin',
          originNodeId: 'max3',
          record,
        })
      }

      // Unbounded: the pinned contract from collective-history.test.ts.
      expect(db.collectiveHistory.query({}, 'svc').map((r) => r.messageId)).toEqual([
        'msg-parent',
        'msg-child',
      ])
      // limit 1 must be the FIRST of that order — the parent — even though the
      // child sorts first by timestamp. A page that trusted the raw sort order
      // would answer msg-child here.
      expect(db.collectiveHistory.query({ limit: 1 }, 'svc').map((r) => r.messageId)).toEqual([
        'msg-parent',
      ])
      expect(db.collectiveHistory.query({ limit: 2 }, 'svc').map((r) => r.messageId)).toEqual([
        'msg-parent',
        'msg-child',
      ])
    } finally {
      db.close()
    }
  })

  test('limited pages agree with the unbounded answer across orders and offsets', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-agree-'))
    try {
      // Deliberately skewed: every 7th message replies to its predecessor with
      // an earlier timestamp, so the topological pass actually has work to do.
      seedCorpus(db.sqlite, 120, (index) => {
        const skewed = index % 7 === 6
        return message({
          messageId: messageId(index),
          messageSeq: index + 1,
          createdAt: paddedTimestamp(skewed ? index - 1 : index),
          ...(skewed
            ? { replyToMessageId: messageId(index - 1), rootMessageId: messageId(index - 1) }
            : {}),
        })
      })

      for (const order of ['asc', 'desc'] as const) {
        const full = db.collectiveHistory.query({ order }, 'svc').map((record) => record.messageId)
        for (const limit of [1, 2, 5, 20, 119, 120, 200]) {
          const page = db.collectiveHistory
            .query({ order, limit }, 'svc')
            .map((record) => record.messageId)
          expect(page).toEqual(full.slice(0, limit))
        }
      }
    } finally {
      db.close()
    }
  })

  test('the collective cursor still means collective_seq, independent of ordering', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-cursor-'))
    try {
      seedCorpus(db.sqlite, 50, (index) =>
        message({
          messageId: messageId(index),
          messageSeq: index + 1,
          createdAt: paddedTimestamp(index),
        })
      )
      const after = db.collectiveHistory.query({ afterSeq: 40, limit: 5 }, 'svc')
      expect(after.map((record) => record.collectiveSeq)).toEqual([41, 42, 43, 44, 45])
      expect(db.collectiveHistory.query({ afterSeq: 50 }, 'svc')).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test('limit 0 returns nothing and reads nothing', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-zero-'))
    try {
      seedCorpus(db.sqlite, 10, (index) =>
        message({
          messageId: messageId(index),
          messageSeq: index + 1,
          createdAt: paddedTimestamp(index),
        })
      )
      const probe = instrument(db.sqlite)
      expect(db.collectiveHistory.query({ limit: 0 }, 'svc')).toEqual([])
      expect(probe.messageSelects()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test('observations are still attached in full, per message, when batched', () => {
    const db = openHrcDatabase(tempDbPath('hrc-t06973-observations-'))
    try {
      const record = message({ messageId: 'msg-multi', messageSeq: 3 })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'svc',
        sourceRole: 'origin',
        originNodeId: 'svc',
        record,
      })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'max3',
        sourceRole: 'destination',
        originNodeId: 'svc',
        acceptedDestinationNodeId: 'max3',
        record: { ...record, messageSeq: 91 },
      })
      const other = message({ messageId: 'msg-single', createdAt: '2026-07-25T11:00:00.000Z' })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'svc',
        sourceRole: 'origin',
        originNodeId: 'svc',
        record: other,
      })

      const page = db.collectiveHistory.query({ limit: 10 }, 'svc')
      const multi = page.find((entry) => entry.messageId === 'msg-multi')
      const single = page.find((entry) => entry.messageId === 'msg-single')
      // Batching must not leak one message's observations onto another.
      expect(multi?.collectiveHistory?.observations.map((o) => o.nodeId)).toEqual(['max3', 'svc'])
      expect(single?.collectiveHistory?.observations.map((o) => o.nodeId)).toEqual(['svc'])
      expect(
        multi?.collectiveHistory?.observations.find((o) => o.nodeId === 'max3')?.messageSeq
      ).toBe(91)
    } finally {
      db.close()
    }
  })
})

describe('T-06973 migration and backfill on a populated database', () => {
  test('backfills filter columns for rows written before the migration', () => {
    const dbPath = tempDbPath('hrc-t06973-backfill-')
    let db = openHrcDatabase(dbPath)
    const records = [
      message({
        messageId: 'msg-legacy-a',
        from: { kind: 'session', sessionRef: OTHER },
        execution: { state: 'completed', runId: 'run-legacy' },
      }),
      message({
        messageId: 'msg-legacy-b',
        rootMessageId: 'msg-legacy-a',
        replyToMessageId: 'msg-legacy-a',
        phase: 'response',
        createdAt: '2026-07-25T10:00:01.000Z',
      }),
    ]
    for (const record of records) {
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'svc',
        sourceRole: 'origin',
        originNodeId: 'svc',
        record,
      })
    }
    db.close()

    // Rewind to the pre-0035 shape on a populated database: drop the indexes,
    // drop the columns, forget the migration.
    const raw = new Database(dbPath)
    for (const index of [
      'idx_collective_history_messages_from',
      'idx_collective_history_messages_to',
      'idx_collective_history_messages_root',
      'idx_collective_history_messages_reply_to',
      'idx_collective_history_messages_kind',
      'idx_collective_history_messages_phase',
      'idx_collective_history_messages_run',
      'idx_collective_history_messages_host_session',
    ]) {
      raw.exec(`DROP INDEX IF EXISTS ${index};`)
    }
    for (const column of [
      'from_ref',
      'to_ref',
      'root_message_id',
      'reply_to_message_id',
      'kind',
      'phase',
      'host_session_id',
      'run_id',
      'generation',
    ]) {
      raw.exec(`ALTER TABLE collective_history_messages DROP COLUMN ${column};`)
    }
    raw.exec("DELETE FROM hrc_migrations WHERE id = '0035_collective_history_filter_columns';")
    // A corrupt row must not make the migration — or the database — unopenable.
    raw
      .query(
        "INSERT INTO collective_history_messages (message_id, canonical_record_json, canonical_source_node_id, canonical_source_role, canonical_created_at, created_at, updated_at) VALUES ('msg-corrupt', '{', 'svc', 'origin', '2026-07-25T09:00:00.000Z', '2026-07-25T09:00:00.000Z', '2026-07-25T09:00:00.000Z')"
      )
      .run()
    raw.close()

    db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0035_collective_history_filter_columns')
      // Backfilled rows are now reachable through the indexed filters.
      expect(
        db.collectiveHistory.query({ runId: 'run-legacy' }, 'svc').map((r) => r.messageId)
      ).toEqual(['msg-legacy-a'])
      expect(
        db.collectiveHistory
          .query({ thread: { rootMessageId: 'msg-legacy-a' } }, 'svc')
          .map((r) => r.messageId)
      ).toEqual(['msg-legacy-a', 'msg-legacy-b'])
      expect(
        db.collectiveHistory
          .query({ from: { kind: 'session', sessionRef: OTHER } }, 'svc')
          .map((r) => r.messageId)
      ).toEqual(['msg-legacy-a'])
      // The corrupt row keeps NULL filter columns rather than aborting the run.
      expect(db.collectiveHistory.count()).toBe(3)
    } finally {
      db.close()
    }
  })
})
