import type { Database } from 'bun:sqlite'

import { brokerMigrations } from './migrations/broker-migrations.js'
import { schemaMigrations } from './migrations/schema-migrations.js'
import { sessionTitleCascadeMigrations } from './migrations/session-title-cascade-migrations.js'
import { sessionTitleMigrations } from './migrations/session-title-migrations.js'
import { type HrcMigration, execute } from './migrations/types.js'

export type { HrcMigration } from './migrations/types.js'

export const phase1Migrations: readonly HrcMigration[] = [
  ...schemaMigrations,
  ...brokerMigrations,
  ...sessionTitleMigrations,
  ...sessionTitleCascadeMigrations,
]

/**
 * Migration ids carry a numeric prefix but the prefix is NOT unique across the
 * four arrays above (`0054_hrcmail_hint_decision` and `0054_broker_turn_attributions`
 * both exist). "Version" is therefore only ever a label for a human-readable
 * message: the authoritative behaviour question is always "is anything pending",
 * never "is max(applied) < max(release)".
 */
export function releaseSchemaVersion(): string {
  return (
    [...phase1Migrations]
      .map((migration) => migration.id)
      .sort()
      .at(-1) ?? ''
  )
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
}

/** True when `hrc_migrations` already exists. Reads only — never creates it. */
export function migrationTableExists(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hrc_migrations'`
    )
    .get()
  return row !== null && row !== undefined
}

export function listAppliedMigrations(db: Database): string[] {
  ensureMigrationTable(db)

  const rows = db.query<{ id: string }, []>('SELECT id FROM hrc_migrations ORDER BY id ASC').all()

  return rows.map((row) => row.id)
}

/**
 * Applied ids without the `CREATE TABLE IF NOT EXISTS` that {@link listAppliedMigrations}
 * performs. A non-migrating (CLI) open must not write DDL to a store owned by a
 * running daemon, so it reads through here.
 */
export function appliedMigrationIds(db: Database): string[] {
  if (!migrationTableExists(db)) return []
  return db
    .query<{ id: string }, []>('SELECT id FROM hrc_migrations ORDER BY id ASC')
    .all()
    .map((row) => row.id)
}

/** Migrations this binary carries that the store has not applied. Reads only. */
export function pendingMigrationIds(db: Database): string[] {
  const applied = new Set(appliedMigrationIds(db))
  return phase1Migrations
    .filter((migration) => !applied.has(migration.id))
    .map((migration) => migration.id)
}

/** Highest applied id, or undefined for a store with no migration table yet. */
export function storeSchemaVersion(db: Database): string | undefined {
  return appliedMigrationIds(db).at(-1)
}

export type MigrationActor = {
  pid: number
  argv0: string
  release: string
  uid: number
}

/**
 * Identify the process applying a migration. `process.argv0` is always the
 * interpreter (`bun`), which names nobody; the entry script is what separates
 * `hrc-server` from a CLI, so that is what `argv0` carries when it is known.
 */
export function resolveMigrationActor(): MigrationActor {
  const entry = process.argv[1]
  return {
    pid: process.pid,
    argv0: entry !== undefined && entry !== '' ? entry : process.argv0,
    release: resolveReleaseId(),
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  }
}

const RELEASE_DIR_PATTERN = /^release-[A-Za-z0-9._-]+$/

/**
 * The atomic install lays releases out as `<root>/hrc-runtime-releases/release-<id>/…`,
 * so the release that owns this module is readable from its own path. A source or
 * worktree checkout has no release directory and reports `unmanaged` — the same
 * word `hrc server status` uses for a daemon outside an atomic release.
 */
export function resolveReleaseId(fromPath: string = import.meta.dir): string {
  const segments = fromPath.split('/')
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const segment = segments[index]
    if (
      segment !== undefined &&
      RELEASE_DIR_PATTERN.test(segment) &&
      segments[index - 1] === 'hrc-runtime-releases'
    ) {
      return segment
    }
  }
  return 'unmanaged'
}

/**
 * Attribution for a migration applied to a store that already had one. A fresh
 * store (tests, `:memory:`, first daemon boot) is a *creation*, not an upgrade
 * under a running daemon, so it is deliberately not recorded: the hazard this
 * row exists to attribute — T-08118, a migration applied to the live store by a
 * process that does not own it — can only happen to a store that already exists.
 */
/**
 * Attribution rows are written from inside a migration, so the cursor they
 * allocate from may not be the only writer the store has seen: a backfill
 * migration (0009, 0041) inserts hrc_events rows with explicit `stream_seq`
 * without advancing `event_stream_cursor`. Take the head of both and repair the
 * cursor forward, so the attribution row can never collide with a row the
 * migration itself just wrote.
 */
function allocateStoreEventStreamSeq(db: Database): number {
  const cursor = db
    .query<{ next_seq: number }, []>('SELECT next_seq FROM event_stream_cursor WHERE id = 1')
    .get()
  const head = db
    .query<{ max_seq: number | null }, []>('SELECT MAX(stream_seq) AS max_seq FROM hrc_events')
    .get()
  const allocated = Math.max(cursor?.next_seq ?? 1, (head?.max_seq ?? 0) + 1)
  execute(db, 'UPDATE event_stream_cursor SET next_seq = ? WHERE id = 1', allocated + 1)
  return allocated
}

function recordMigrationApplication(db: Database, appliedIds: readonly string[]): void {
  const actor = resolveMigrationActor()
  execute(
    db,
    `
      INSERT INTO hrc_events (
        stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
        category, event_kind, replayed, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `,
    allocateStoreEventStreamSeq(db),
    new Date().toISOString(),
    STORE_EVENT_HOST_SESSION_ID,
    STORE_EVENT_SCOPE_REF,
    STORE_EVENT_LANE_REF,
    0,
    'store',
    'store.migrated',
    JSON.stringify({
      // One row per APPLICATION, not per migration: the question a sighting asks
      // is "which process moved this store, and to what", and a 70-migration
      // upgrade answering it 70 times buries the answer in its own ledger.
      version: appliedIds.at(-1) ?? '',
      applied: [...appliedIds],
      pid: actor.pid,
      argv0: actor.argv0,
      release: actor.release,
      uid: actor.uid,
    })
  )
}

/**
 * The ledger requires a session/scope/lane on every row. A migration belongs to
 * the store itself, not to any seat, so these sentinels keep `store.migrated`
 * out of every scope-filtered monitor view while leaving it in the unfiltered
 * firehose where an operator looks for it.
 */
export const STORE_EVENT_HOST_SESSION_ID = 'hrc-store'
export const STORE_EVENT_SCOPE_REF = 'store:sqlite'
export const STORE_EVENT_LANE_REF = 'main'

export function runMigrations(db: Database): void {
  ensureMigrationTable(db)

  const applied = new Set(listAppliedMigrations(db))
  const pending = phase1Migrations.filter((migration) => !applied.has(migration.id))
  if (pending.length === 0) {
    return
  }
  const upgradingExistingStore = applied.size > 0

  const applyPending = db.transaction((migrations: readonly HrcMigration[]) => {
    for (const migration of migrations) {
      migration.apply(db)
      execute(
        db,
        'INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)',
        migration.id,
        new Date().toISOString()
      )
    }
    // Written inside the same transaction as the schema change so attribution
    // and the migration it attributes land together or not at all. Safe here
    // because the full pending set has been applied: hrc_events is at its
    // final shape for this release.
    if (upgradingExistingStore) {
      recordMigrationApplication(
        db,
        migrations.map((migration) => migration.id)
      )
    }
  })

  applyPending.immediate(pending)

  if (upgradingExistingStore) {
    const actor = resolveMigrationActor()
    process.stderr.write(
      `hrc-store: store.migrated applied=${pending.length} version=${pending.at(-1)?.id ?? ''} ` +
        `pid=${actor.pid} argv0=${actor.argv0} release=${actor.release} uid=${actor.uid}\n`
    )
  }
}
