import { describe, expect, test } from 'bun:test'

import { openHrcDatabase } from '../database.js'

type PlanRow = { detail: string }

function plan(sql: string, ...bindings: Array<string | number>): string {
  const db = openHrcDatabase(':memory:')
  try {
    return db.sqlite
      .query<PlanRow, Array<string | number>>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...bindings)
      .map((row) => row.detail)
      .join('\n')
  } finally {
    db.close()
  }
}

function expectIndexedSearch(
  table: 'events' | 'hrc_events' | 'broker_invocation_events',
  sql: string,
  bindings: Array<string | number>,
  expectedIndex?: string
): void {
  const detail = plan(sql, ...bindings)
  expect(detail).not.toMatch(new RegExp(`\\bSCAN ${table}\\b`))
  expect(detail).toMatch(new RegExp(`\\bSEARCH ${table}\\b`))
  if (expectedIndex) expect(detail).toContain(expectedIndex)
}

describe('event repository query plans', () => {
  test('events predicates select an index', () => {
    const cases: Array<[string, Array<string | number>, string | undefined]> = [
      ['SELECT seq FROM events WHERE seq >= ? ORDER BY seq', [1], undefined],
      [
        'SELECT seq FROM events WHERE host_session_id = ? ORDER BY seq',
        ['host'],
        'idx_events_host_session_seq',
      ],
      [
        'SELECT seq FROM events WHERE generation = ? ORDER BY seq',
        [1],
        'idx_events_generation_seq',
      ],
      [
        'SELECT seq FROM events WHERE runtime_id = ? ORDER BY seq',
        ['runtime'],
        'idx_events_runtime_seq',
      ],
      ['SELECT seq FROM events WHERE run_id = ? ORDER BY seq', ['run'], 'idx_events_run_seq'],
    ]
    for (const [sql, bindings, index] of cases) {
      expectIndexedSearch('events', sql, bindings, index)
    }
  })

  test('hrc_events equality predicates select an index', () => {
    const cases: Array<[string, Array<string | number>, string | undefined]> = [
      ['SELECT hrc_seq FROM hrc_events WHERE hrc_seq >= ? ORDER BY hrc_seq', [1], undefined],
      [
        'SELECT hrc_seq FROM hrc_events WHERE stream_seq >= ? ORDER BY stream_seq',
        [1],
        'sqlite_autoindex_hrc_events_1',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE host_session_id = ? ORDER BY hrc_seq',
        ['host'],
        'idx_hrc_events_host_session_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE source_ref = ? ORDER BY hrc_seq',
        ['source'],
        'idx_hrc_events_source_ref_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE source_ref IS NULL AND hrc_seq >= ? ORDER BY hrc_seq',
        [1],
        'idx_hrc_events_source_ref_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE generation = ? ORDER BY hrc_seq',
        [1],
        'idx_hrc_events_generation_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE scope_ref = ? ORDER BY hrc_seq',
        ['scope'],
        'idx_hrc_events_scope_ref_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE lane_ref = ? ORDER BY hrc_seq',
        ['lane'],
        'idx_hrc_events_lane_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE runtime_id = ? ORDER BY hrc_seq',
        ['runtime'],
        'idx_hrc_events_runtime_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE run_id = ? ORDER BY hrc_seq',
        ['run'],
        'idx_hrc_events_run_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE launch_id = ? ORDER BY hrc_seq',
        ['launch'],
        'idx_hrc_events_launch_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE event_kind = ? ORDER BY hrc_seq',
        ['kind'],
        'idx_hrc_events_kind_seq',
      ],
      [
        'SELECT hrc_seq FROM hrc_events WHERE category = ? ORDER BY hrc_seq',
        ['category'],
        'idx_hrc_events_category_seq',
      ],
    ]
    for (const [sql, bindings, index] of cases) {
      expectIndexedSearch('hrc_events', sql, bindings, index)
    }
  })

  test('broker event repository predicates and ordering select covering indexes', () => {
    const runtimePlan = plan(
      `SELECT id FROM broker_invocation_events
        WHERE runtime_id = ?
        ORDER BY time, invocation_id, seq`,
      'runtime'
    )
    expect(runtimePlan).toContain(
      'idx_broker_invocation_events_runtime_time_invocation_seq (runtime_id=?)'
    )
    expect(runtimePlan).not.toContain('USE TEMP B-TREE')

    const cases: Array<[string, Array<string | number>, string | undefined]> = [
      [
        'SELECT id FROM broker_invocation_events WHERE source_ref = ? AND origin_seq = ?',
        ['source', 1],
        'idx_broker_invocation_events_source_origin',
      ],
      [
        'SELECT id FROM broker_invocation_events WHERE source_ref = ? ORDER BY origin_seq',
        ['source'],
        'idx_broker_invocation_events_source_origin',
      ],
      [
        'SELECT id FROM broker_invocation_events WHERE source_ref IS NULL AND id > ? ORDER BY id LIMIT ?',
        [0, 100],
        undefined,
      ],
      [
        'SELECT id FROM broker_invocation_events WHERE invocation_id = ? AND seq = ?',
        ['invocation', 1],
        undefined,
      ],
      [
        'SELECT MAX(seq) FROM broker_invocation_events WHERE invocation_id = ?',
        ['invocation'],
        'idx_broker_invocation_events_invocation_seq',
      ],
      [
        `SELECT id FROM broker_invocation_events
          WHERE invocation_id = ? AND run_id = ? AND runtime_id = ? AND seq > ?
          ORDER BY seq`,
        ['invocation', 'run', 'runtime', 1],
        'idx_broker_invocation_events_invocation_seq',
      ],
    ]
    for (const [sql, bindings, index] of cases) {
      expectIndexedSearch('broker_invocation_events', sql, bindings, index)
    }
  })
})
