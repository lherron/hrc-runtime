/**
 * T-08363 — the ask-bracket predicate must stay bounded to ONE invocation.
 *
 * `hasOpenAskBracket` states its cost model in its own doc comment: filtering on
 * the indexed `invocation_id` before the `json_extract` keeps the scan bounded
 * to one invocation's events. That was an unenforced comment, and it silently
 * stopped being true when `0050_prune_candidate_indexes` added a standalone
 * `(type)` index: the planner switched to it and began scanning every
 * `tool.call.started` row in the ledger, running `json_extract` on each. On the
 * 11GB production store that was 327ms per call against 3ms for the intended
 * plan, with logged peaks of 22s.
 *
 * These tests fail if the planner ever again chooses a table-wide access path,
 * so the invariant is checked rather than described.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

let dir: string
let db: HrcDatabase

/**
 * Enough invocations that a `type`-wide scan is dramatically worse than an
 * invocation-bounded one, and enough rows overall that ANALYZE has something
 * honest to say. A handful of rows would let any plan look fine and the test
 * would pass for the wrong reason.
 */
const INVOCATIONS = 60
const EVENTS_PER_INVOCATION = 40

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-ask-bracket-plan-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))

  const insert = db.sqlite.prepare(
    `INSERT INTO broker_invocation_events
       (invocation_id, seq, time, type, run_id, runtime_id, broker_event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  db.sqlite.exec('BEGIN')
  for (let i = 0; i < INVOCATIONS; i += 1) {
    for (let seq = 0; seq < EVENTS_PER_INVOCATION; seq += 1) {
      insert.run(
        `inv-${i}`,
        seq,
        '2026-09-10T00:00:00.000Z',
        'tool.call.started',
        `run-${i}`,
        `rt-${i}`,
        JSON.stringify({ name: 'Bash', toolCallId: `tc-${seq}` }),
        '2026-09-10T00:00:00.000Z'
      )
    }
  }
  db.sqlite.exec('COMMIT')
  // No ANALYZE, deliberately. This is the PRODUCTION condition and the whole
  // point of the test: the live store reached 11GB having never been analyzed,
  // so the planner chose blind and picked the ledger-wide (type) index. Given
  // real stats the planner finds the bounded path on its own and this test would
  // pass even with the fix reverted -- i.e. for the wrong reason.
  expect(
    db.sqlite.query("SELECT count(*) AS c FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()
  ).toEqual({ c: 0 })
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

/** The exact predicate shape hasOpenAskBracket issues, as a plan probe. */
function askBracketPlan(): string {
  const rows = db.sqlite
    .query<{ detail: string }, [string, string]>(
      `EXPLAIN QUERY PLAN
       SELECT 1 AS one
         FROM broker_invocation_events st
        WHERE st.invocation_id = ?
          AND st.run_id = ?
          AND st.type = 'tool.call.started'
          AND json_extract(st.broker_event_json, '$.name') IN ('AskUserQuestion')
          AND NOT EXISTS (
                SELECT 1 FROM broker_invocation_events cl
                 WHERE cl.invocation_id = st.invocation_id
                   AND cl.seq > st.seq
                   AND cl.type IN ('tool.call.completed', 'tool.call.failed'))
          AND NOT EXISTS (
                SELECT 1 FROM broker_invocation_events tm
                 WHERE tm.invocation_id = st.invocation_id
                   AND tm.run_id IS st.run_id
                   AND tm.seq > st.seq
                   AND tm.type IN ('turn.completed', 'turn.failed', 'turn.interrupted'))
        LIMIT 1`
    )
    .all('inv-1', 'run-1')
  return rows.map((row) => row.detail).join('\n')
}

describe('ask-bracket predicate stays invocation-bounded', () => {
  it('drives the outer scan from an invocation_id-leading index', () => {
    const plan = askBracketPlan()
    // The outer term is what decides how many rows get json_extract'd.
    const outer = plan.split('\n')[0] ?? ''
    expect(outer).toContain('broker_invocation_events')
    // Assert on the CONSTRAINT the plan applies, not the index name: every index
    // on this table has "invocation" in its name, so a name match would also
    // accept the ledger-wide (type) scan this test exists to reject.
    expect(outer).toContain('invocation_id=?')
  })

  it('never selects the retention-discovery (type) index for the outer scan', () => {
    const outer = askBracketPlan().split('\n')[0] ?? ''
    // idx_broker_invocation_events_type exists for retention candidate discovery
    // (T-07200). Using it here means a ledger-wide scan.
    expect(outer).not.toContain('idx_broker_invocation_events_type')
  })

  it('never falls back to a full table scan', () => {
    expect(askBracketPlan()).not.toContain('SCAN broker_invocation_events')
  })

  it('keeps both correlated NOT EXISTS subqueries on an indexed seq range', () => {
    const plan = askBracketPlan()
    const searches = plan.split('\n').filter((line) => line.includes('seq>'))
    expect(searches.length).toBe(2)
  })
})
