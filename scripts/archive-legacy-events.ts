#!/usr/bin/env bun
/**
 * Archive pre-broker-cutover "legacy" rows out of the hot `events` table into a
 * duplicate `events_legacy` table, online, without starving the live hrc-server's
 * broker writes.
 *
 * "Legacy" == every row whose `source` is NOT an actively-written source. As of
 * 2026-06-11 the only active writers are `broker` (the harness broker mirror) and
 * `tmux` (runtime.dead). Everything else (otel / hrc / hook / agent-spaces /
 * dev-flow-launcher / ghostty / manual) froze at the broker cutover (<= 05-31).
 *
 * Safety model:
 *   - seq-windowed batches, each its own short transaction, with a small yield
 *     between batches so the daemon's WAL writer gets the lock back. This is the
 *     opposite of a single 1.24M-row DELETE that would hold the write lock and
 *     starve live agents (the very contention this whole investigation found).
 *   - busy_timeout so our batches WAIT for the daemon's lock instead of erroring.
 *   - Two phases: COPY everything first (idempotent INSERT OR IGNORE), verify the
 *     archive is complete, THEN delete. The full archive exists before any delete.
 *   - Idempotent + resumable: re-running skips already-copied rows and re-deletes
 *     only what is still present.
 *
 * Usage:
 *   bun scripts/archive-legacy-events.ts --copy      # phase 1 only
 *   bun scripts/archive-legacy-events.ts --delete    # phase 2 only (requires verify)
 *   bun scripts/archive-legacy-events.ts --all       # copy, verify, then delete
 *   bun scripts/archive-legacy-events.ts --status     # counts only, no writes
 *   flags: --step=N (seq window, default 20000)  --sleep=MS (between batches, default 20)
 */
import { Database } from 'bun:sqlite'

const DB_PATH =
  process.env['HRC_DB_PATH'] ?? '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
const ACTIVE_SOURCES = ['broker', 'tmux']
const ACTIVE_LIST = ACTIVE_SOURCES.map((s) => `'${s}'`).join(',')
const LEGACY_PRED = `source NOT IN (${ACTIVE_LIST})`

const argv = process.argv.slice(2)
const hasFlag = (f: string) => argv.includes(f)
const numFlag = (name: string, dflt: number) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : dflt
}

const STEP = numFlag('step', 20_000)
const SLEEP_MS = numFlag('sleep', 20)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function openDb(): Database {
  const db = new Database(DB_PATH)
  db.exec('PRAGMA busy_timeout=10000;')
  db.exec('PRAGMA foreign_keys=OFF;') // archive table has no FKs; deletes from child are FK-safe anyway
  return db
}

function ensureLegacyTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS events_legacy (
    seq INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    host_session_id TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    lane_ref TEXT NOT NULL,
    generation INTEGER NOT NULL,
    run_id TEXT,
    runtime_id TEXT,
    source TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    stream_seq INTEGER
  );`)
}

function legacyBounds(db: Database): { min: number; max: number; total: number } {
  const row = db
    .query(`SELECT MIN(seq) AS mn, MAX(seq) AS mx, COUNT(*) AS n FROM events WHERE ${LEGACY_PRED}`)
    .get() as { mn: number | null; mx: number | null; n: number }
  return { min: row.mn ?? 0, max: row.mx ?? -1, total: row.n }
}

function status(db: Database): void {
  const { total } = legacyBounds(db)
  const archived = (db.query('SELECT COUNT(*) AS n FROM events_legacy').get() as { n: number }).n
  const eventsTotal = (db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  const activeRemaining = (
    db.query(`SELECT COUNT(*) AS n FROM events WHERE source IN (${ACTIVE_LIST})`).get() as {
      n: number
    }
  ).n
  console.log(
    JSON.stringify(
      {
        events_total: eventsTotal,
        legacy_still_in_events: total,
        active_in_events: activeRemaining,
        events_legacy_rows: archived,
      },
      null,
      2
    )
  )
}

async function copyPhase(db: Database): Promise<void> {
  const { min, max, total } = legacyBounds(db)
  console.log(`[copy] legacy rows in events: ${total} (seq ${min}..${max}), step=${STEP}`)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events_legacy
       SELECT seq, ts, host_session_id, scope_ref, lane_ref, generation, run_id,
              runtime_id, source, event_kind, event_json, stream_seq
       FROM events
       WHERE seq >= ? AND seq < ? AND ${LEGACY_PRED}`
  )
  let copied = 0
  let batches = 0
  for (let lo = min; lo <= max; lo += STEP) {
    const hi = lo + STEP
    const tx = db.transaction(() => insert.run(lo, hi))
    const res = tx() as { changes: number }
    copied += res.changes
    batches++
    if (batches % 20 === 0) {
      console.log(`[copy] seq<${hi} copied≈${copied}/${total}`)
    }
    await sleep(SLEEP_MS)
  }
  console.log(`[copy] done: ${copied} inserted across ${batches} batches`)
}

function verify(db: Database): boolean {
  const { total } = legacyBounds(db)
  // every legacy row still in events must now exist in events_legacy
  const missing = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events e
         WHERE ${LEGACY_PRED}
           AND NOT EXISTS (SELECT 1 FROM events_legacy l WHERE l.seq = e.seq)`
      )
      .get() as { n: number }
  ).n
  console.log(`[verify] legacy-in-events=${total}, not-yet-archived=${missing}`)
  return missing === 0
}

async function deletePhase(db: Database): Promise<void> {
  if (!verify(db)) {
    console.error('[delete] ABORT: some legacy rows are not archived yet. Run --copy first.')
    process.exit(1)
  }
  const { min, max, total } = legacyBounds(db)
  console.log(`[delete] removing ${total} archived legacy rows from events (seq ${min}..${max})`)
  // Only delete rows that are provably present in the archive.
  const del = db.prepare(
    `DELETE FROM events
       WHERE seq >= ? AND seq < ? AND ${LEGACY_PRED}
         AND seq IN (SELECT seq FROM events_legacy WHERE seq >= ? AND seq < ?)`
  )
  let removed = 0
  let batches = 0
  for (let lo = min; lo <= max; lo += STEP) {
    const hi = lo + STEP
    const tx = db.transaction(() => del.run(lo, hi, lo, hi))
    const res = tx() as { changes: number }
    removed += res.changes
    batches++
    if (batches % 20 === 0) {
      console.log(`[delete] seq<${hi} removed≈${removed}/${total}`)
    }
    await sleep(SLEEP_MS)
  }
  console.log(`[delete] done: ${removed} removed across ${batches} batches`)
}

async function main(): Promise<void> {
  const db = openDb()
  ensureLegacyTable(db)
  if (hasFlag('--status')) {
    status(db)
    return
  }
  if (hasFlag('--copy') || hasFlag('--all')) {
    await copyPhase(db)
    verify(db)
  }
  if (hasFlag('--delete') || hasFlag('--all')) {
    await deletePhase(db)
  }
  if (!hasFlag('--copy') && !hasFlag('--delete') && !hasFlag('--all')) {
    console.log('no phase flag given; showing status. use --copy | --delete | --all')
    status(db)
    return
  }
  status(db)
  db.close()
}

await main()
