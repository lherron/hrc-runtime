import { describe, expect, test } from 'bun:test'

import {
  BUFFER_BOUNDARY,
  type Database,
  EVENT_BOUNDARY,
  OLD,
  createPurgePlans,
  createRetentionPlans,
  deleteSelectedBatch,
  deleteSelectedBatchSql,
  insertBuffer,
  makeProductStore,
  makeStore,
  seedTerminalAuthority,
  selectEligibleBatch,
  selectEligibleBatchSql,
} from './prune-hrc-event-deltas.fixture'

type PlanRow = { detail: string }

function explain(db: Database, sql: string, ...bindings: Array<string | number>): string {
  return db
    .query<PlanRow, Array<string | number>>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...bindings)
    .map((row) => row.detail)
    .join('\n')
}

describe('T-07200 bounded prune candidate plans', () => {
  test('all six read-only discovery plans lead from their predicate indexes', () => {
    const { db: product } = makeProductStore()
    try {
      const db = product.sqlite
      const cases = [
        [createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY)[0], 'idx_events_retention_ts'],
        [createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY)[1], 'idx_hrc_events_retention_ts'],
        [
          createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY)[2],
          'idx_broker_invocation_events_retention_time',
        ],
        [
          createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY)[3],
          'idx_runtime_buffers_retention_created',
        ],
        [createPurgePlans()[0], 'idx_events_broker_kind_nocase'],
        [createPurgePlans()[1], 'idx_broker_invocation_events_type'],
      ] as const

      for (const [plan, expectedIndex] of cases) {
        if (plan === undefined) throw new Error(`missing plan for ${expectedIndex}`)
        const detail = explain(db, selectEligibleBatchSql(plan), plan.predicateValue, 250)
        expect(detail).toContain(expectedIndex)
        expect(detail).toMatch(/\bSEARCH e\b/)
        expect(detail).not.toMatch(/\bSCAN e\b/)
      }
    } finally {
      product.close()
    }
  })

  test('all six writer rechecks search only the bounded primary-key set', () => {
    const { db: product } = makeProductStore()
    try {
      for (const plan of [
        ...createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY),
        ...createPurgePlans(),
      ]) {
        const detail = explain(
          product.sqlite,
          deleteSelectedBatchSql(plan),
          JSON.stringify([1, 2, 3]),
          plan.predicateValue
        )
        expect(detail).toMatch(/\bSEARCH e\b[^\n]*\browid=\?/)
        expect(detail).not.toMatch(/\bSCAN e\b/)
        expect(detail).toContain('SCAN json_each VIRTUAL TABLE')
      }
    } finally {
      product.close()
    }
  })

  test('writer recheck preserves a row whose authority becomes live after discovery', () => {
    const { db } = makeStore()
    const authority = seedTerminalAuthority(db)
    insertBuffer(db, authority.runtimeId, authority.runId, 1)
    const plan = createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY).find(
      (candidate) => candidate.table === 'runtime_buffers'
    )
    if (plan === undefined) throw new Error('missing runtime_buffers retention plan')

    const selected = selectEligibleBatch(db, plan, 10)
    expect(selected).toHaveLength(1)

    db.prepare('UPDATE runtimes SET status = ?, active_run_id = ? WHERE runtime_id = ?').run(
      'busy',
      authority.runId,
      authority.runtimeId
    )
    expect(deleteSelectedBatch(db, plan, selected)).toBe(0)
    expect(
      db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_buffers').get()?.count
    ).toBe(1)
    db.close()
  })

  test('old ineligible prefixes are traversed before the writer and do not widen its key set', () => {
    const { db } = makeStore()
    db.exec(`
      INSERT INTO runtimes (runtime_id, status, active_run_id)
        VALUES ('runtime-live-prefix', 'busy', 'run-live-prefix');
      INSERT INTO runs (run_id, status) VALUES ('run-live-prefix', 'running');
    `)
    for (let index = 0; index < 500; index += 1) {
      insertBuffer(db, 'runtime-live-prefix', 'run-live-prefix', index + 1, OLD)
    }
    const authority = seedTerminalAuthority(db, 'after-prefix')
    insertBuffer(db, authority.runtimeId, authority.runId, 1, OLD)
    const plan = createRetentionPlans(EVENT_BOUNDARY, BUFFER_BOUNDARY).find(
      (candidate) => candidate.table === 'runtime_buffers'
    )
    if (plan === undefined) throw new Error('missing runtime_buffers retention plan')

    const selected = selectEligibleBatch(db, plan, 10)
    expect(selected).toHaveLength(1)
    expect(deleteSelectedBatch(db, plan, selected)).toBe(1)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_buffers WHERE runtime_id = 'runtime-live-prefix'"
        )
        .get()?.count
    ).toBe(500)
    db.close()
  })
})
