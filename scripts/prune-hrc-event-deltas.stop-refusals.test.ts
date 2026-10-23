import { expect, test } from 'bun:test'
import {
  Database,
  createRetentionPlans,
  deleteSelectedBatch,
  makeProductStore,
  pruneOptions,
  pruneStateRetention,
  selectEligibleBatch,
} from './prune-hrc-event-deltas.fixture'

const now = new Date('2026-10-23T12:00:00.000Z')
const cutoff = '2026-10-09T12:00:00.000Z'
const old = '2026-10-09T11:59:59.999Z'

function seed(db: Database, id: string, status: string | null, updatedAt = old) {
  db.query(
    `INSERT OR IGNORE INTO sessions (host_session_id, scope_ref, lane_ref, generation, status, created_at, updated_at) VALUES ('session', 'scope', 'main', 1, 'active', ?, ?)`
  ).run(old, old)
  if (status !== null) {
    db.query(`INSERT INTO runtimes (
      runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, supports_inflight_input, status, created_at, updated_at
    ) VALUES (?, 'session', 'scope', 'main', 1, 'test', 0, ?, ?, ?)`).run(id, status, old, old)
  }
  db.query(`INSERT INTO hrcmail_stop_refusals (
    runtime_id, target_session_ref, observed_envelope_seq, refusal_count,
    total_refusal_count, created_at, updated_at
  ) VALUES (?, 'scope', 1, 3, 50, ?, ?)`).run(id, old, updatedAt)
}

test('stop refusal retention requires terminated runtime and strictly more than 14 days', async () => {
  const { path, db } = makeProductStore()
  seed(db.sqlite, 'expired', 'terminated')
  seed(db.sqlite, 'boundary', 'terminated', cutoff)
  seed(db.sqlite, 'recent', 'terminated', '2026-10-09T12:00:00.001Z')
  seed(db.sqlite, 'invalid', 'terminated', 'unknown')
  for (const status of ['ready', 'busy', 'stale', 'crashed', 'dead', 'failed']) {
    seed(db.sqlite, status, status)
  }
  seed(db.sqlite, 'orphan', null)
  db.close()
  const options = { ...pruneOptions(path, false), now, tables: ['hrcmail_stop_refusals'] as const }
  expect((await pruneStateRetention(options)).eligibleCount).toBe(1)
  const result = await pruneStateRetention({ ...options, apply: true })
  expect(result.tables.hrcmail_stop_refusals.deleted).toBe(1)
  expect(result.tables.hrcmail_stop_refusals.remainingEligibleCount).toBe(0)
  const verify = new Database(path)
  try {
    expect(
      verify.query('SELECT runtime_id FROM hrcmail_stop_refusals ORDER BY runtime_id').all()
    ).toEqual(
      [
        'boundary',
        'busy',
        'crashed',
        'dead',
        'failed',
        'invalid',
        'orphan',
        'ready',
        'recent',
        'stale',
      ].map((runtime_id) => ({ runtime_id }))
    )
    expect(verify.query('SELECT COUNT(*) n FROM runtimes').get()).toEqual({ n: 10 })
  } finally {
    verify.close()
  }
})

test('stop refusal delete rechecks runtime status and refusal refresh after discovery', () => {
  const { db } = makeProductStore()
  try {
    seed(db.sqlite, 'revived', 'terminated')
    seed(db.sqlite, 'refreshed', 'terminated')
    const plan = createRetentionPlans(cutoff, cutoff).find(
      (p) => p.table === 'hrcmail_stop_refusals'
    )
    if (!plan) throw new Error('missing stop refusal retention plan')
    const selected = selectEligibleBatch(db.sqlite, plan, 250)
    expect(selected).toHaveLength(2)
    db.sqlite.exec("UPDATE runtimes SET status = 'ready' WHERE runtime_id = 'revived'")
    db.sqlite
      .query('UPDATE hrcmail_stop_refusals SET updated_at = ? WHERE runtime_id = ?')
      .run(cutoff, 'refreshed')
    expect(deleteSelectedBatch(db.sqlite, plan, selected)).toBe(0)
  } finally {
    db.close()
  }
})
