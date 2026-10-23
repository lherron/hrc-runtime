import { expect, test } from 'bun:test'
import {
  Database,
  createRetentionPlans,
  deleteSelectedBatch,
  makeProductStore,
  parsePruneStateRetentionArgs,
  pruneOptions,
  pruneStateRetention,
  selectEligibleBatch,
} from './prune-hrc-event-deltas.fixture'

const now = new Date('2026-10-23T12:00:00.000Z')
const cutoff = '2026-10-09T12:00:00.000Z'

function seed(db: Database, id: string, state: string, stamp: string, rows = true) {
  db.query(`INSERT INTO broker_invocations (
    invocation_id, operation_id, runtime_id, broker_protocol, broker_driver,
    invocation_state, capabilities_json, spec_hash, start_request_hash,
    selected_profile_hash, created_at, updated_at, last_projected_seq
  ) VALUES (?, 'op', 'runtime', 'test', 'test', ?, '{}', 'spec', 'start', 'profile', ?, ?, 1)`).run(
    id,
    state,
    stamp,
    stamp
  )
  for (const seq of rows ? [1, 3] : []) {
    db.query(`INSERT INTO broker_projection_dispositions VALUES (?, ?, 'hash', 'applied', ?)`).run(
      id,
      seq,
      stamp
    )
  }
}

test('disposition retention keeps live, recent, undated, boundary and unresolved islands', async () => {
  const { path, db } = makeProductStore()
  seed(db.sqlite, 'old', 'exited', '2026-10-01T00:00:00.000Z')
  seed(db.sqlite, 'young', 'failed', '2026-10-22T00:00:00.000Z')
  seed(db.sqlite, 'boundary', 'disposed', cutoff)
  seed(db.sqlite, 'live', 'ready', '2020-01-01T00:00:00.000Z')
  seed(db.sqlite, 'unknown', 'exited', 'unknown')
  db.sqlite.exec(
    "INSERT INTO broker_projection_dispositions VALUES ('orphan', 1, 'hash', 'applied', '2026-10-23T00:00:00Z')"
  )
  db.close()
  const options = {
    ...pruneOptions(path, false),
    now,
    tables: ['broker_projection_dispositions'] as const,
  }
  const report = await pruneStateRetention(options)
  expect(report.eligibleCount).toBe(2)
  const result = await pruneStateRetention({ ...options, apply: true })
  expect(result.deleted).toBe(2)
  const verify = new Database(path)
  try {
    expect(
      verify
        .query('SELECT seq FROM broker_projection_dispositions WHERE invocation_id = ?')
        .all('old')
    ).toEqual([{ seq: 3 }])
    expect(verify.query('SELECT COUNT(*) n FROM broker_projection_dispositions').get()).toEqual({
      n: 9,
    })
    expect(
      verify
        .query('SELECT last_projected_seq FROM broker_invocations WHERE invocation_id = ?')
        .get('old')
    ).toEqual({ last_projected_seq: 1 })
  } finally {
    verify.close()
  }
})

test('writer rechecks revival and newly acquired orphan ownership after discovery', () => {
  const { db } = makeProductStore()
  try {
    seed(db.sqlite, 'old', 'exited', '2026-10-01T00:00:00.000Z')
    db.sqlite.exec(
      "INSERT INTO broker_projection_dispositions VALUES ('orphan', 1, 'hash', 'applied', 'old')"
    )
    const plan = createRetentionPlans(cutoff, cutoff).find(
      (p) => p.table === 'broker_projection_dispositions'
    )
    if (!plan) throw new Error('missing disposition retention plan')
    const selected = selectEligibleBatch(db.sqlite, plan, 250)
    expect(selected.length).toBe(2)
    db.sqlite.exec(
      "UPDATE broker_invocations SET invocation_state='ready' WHERE invocation_id='old'"
    )
    seed(db.sqlite, 'orphan', 'ready', '2020-01-01T00:00:00Z', false)
    expect(deleteSelectedBatch(db.sqlite, plan, selected)).toBe(0)
  } finally {
    db.close()
  }
})

test('nightly default includes disposition metadata without including semantic ledgers', () => {
  expect(parsePruneStateRetentionArgs([], {}).tables).toEqual([
    'runtime_buffers',
    'broker_projection_dispositions',
  ])
})
