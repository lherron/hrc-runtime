import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../database'
import {
  appliedMigrationIds,
  pendingMigrationIds,
  releaseSchemaVersion,
  resolveMigrationActor,
  resolveReleaseId,
  runMigrations,
} from '../migrations'
import { HrcStoreSchemaBehindError, readStoreSchemaState } from '../schema-guard'

/**
 * T-08118. `openHrcDatabase` used to call `runMigrations` unconditionally, so
 * any hrc command run from a freshly installed release migrated the live store
 * out from under the daemon still running the previous one. The daemon owns the
 * schema; every other open refuses.
 *
 * `0036_event_repository_query_indexes` is the lever throughout: its `apply` is
 * `CREATE INDEX IF NOT EXISTS` only, so deleting its ledger row produces a store
 * that is genuinely "behind this binary" and can be brought forward again
 * without fighting DDL that is not replayable.
 */
const REPLAYABLE_MIGRATION = '0036_event_repository_query_indexes'

const dirs: string[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-t08118-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function currentStore(): string {
  const dbPath = join(scratchDir(), 'state.sqlite')
  openHrcDatabase(dbPath).close()
  return dbPath
}

function behindStore(): string {
  const dbPath = currentStore()
  const raw = new Database(dbPath)
  raw.exec(`DELETE FROM hrc_migrations WHERE id = '${REPLAYABLE_MIGRATION}'`)
  raw.close()
  return dbPath
}

function storeMigrationIds(dbPath: string): string[] {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return appliedMigrationIds(raw)
  } finally {
    raw.close()
  }
}

function storeMigratedEvents(dbPath: string): Array<Record<string, unknown>> {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return raw
      .query<{ payload_json: string }, []>(
        `SELECT payload_json FROM hrc_events WHERE event_kind = 'store.migrated' ORDER BY hrc_seq`
      )
      .all()
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
  } finally {
    raw.close()
  }
}

describe('T-08118 non-owning opens never migrate', () => {
  it('opens normally when the store is at this release schema', () => {
    const dbPath = currentStore()
    const db = openHrcDatabase(dbPath, { migrate: false })
    try {
      expect(db.migrations.applied).toContain(REPLAYABLE_MIGRATION)
    } finally {
      db.close()
    }
  })

  it('refuses, and leaves the store untouched, when the store is behind', () => {
    const dbPath = behindStore()
    const before = storeMigrationIds(dbPath)

    let thrown: unknown
    try {
      openHrcDatabase(dbPath, { migrate: false })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HrcStoreSchemaBehindError)
    const error = thrown as HrcStoreSchemaBehindError
    expect(error.pending).toEqual([REPLAYABLE_MIGRATION])
    expect(error.releaseVersion).toBe(releaseSchemaVersion())
    expect(error.message).toContain('the daemon has not been restarted since install')
    expect(error.message).toContain('hrc server restart')
    // The refusal is the whole point: the schema ledger must be byte-identical.
    expect(storeMigrationIds(dbPath)).toEqual(before)
  })

  it('does not create the migration table on a store that has none', () => {
    const dbPath = join(scratchDir(), 'state.sqlite')
    writeFileSync(dbPath, '')

    expect(() => openHrcDatabase(dbPath, { migrate: false })).toThrow(HrcStoreSchemaBehindError)

    const raw = new Database(dbPath, { readonly: true })
    try {
      const table = raw
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hrc_migrations'`
        )
        .get()
      expect(table).toBeNull()
    } finally {
      raw.close()
    }
  })

  it('still migrates for the owner (migrate: true) and for the creating open', () => {
    const dbPath = behindStore()
    const db = openHrcDatabase(dbPath, { migrate: true })
    try {
      expect(db.migrations.applied).toContain(REPLAYABLE_MIGRATION)
    } finally {
      db.close()
    }
    expect(pendingMigrationIdsFor(dbPath)).toEqual([])
  })
})

function pendingMigrationIdsFor(dbPath: string): string[] {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return pendingMigrationIds(raw)
  } finally {
    raw.close()
  }
}

describe('T-08118 migration attribution', () => {
  it('records one store.migrated row naming pid/argv0/release/uid per application', () => {
    const dbPath = behindStore()
    expect(storeMigratedEvents(dbPath)).toEqual([])

    const db = openHrcDatabase(dbPath, { migrate: true })
    db.close()

    const events = storeMigratedEvents(dbPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      version: REPLAYABLE_MIGRATION,
      applied: [REPLAYABLE_MIGRATION],
      pid: process.pid,
      argv0: process.argv[1] ?? process.argv0,
      command: resolveMigrationActor().command,
      release: resolveReleaseId(),
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    })
  })

  it('does not attribute the creation of a brand-new store', () => {
    // A creation cannot be the T-08118 hazard: there is no running daemon
    // holding an older schema on a store that does not exist yet.
    const dbPath = currentStore()
    expect(storeMigratedEvents(dbPath)).toEqual([])
  })

  it('attributes a direct runMigrations call, not just openHrcDatabase', () => {
    const dbPath = behindStore()
    const raw = new Database(dbPath)
    try {
      runMigrations(raw)
    } finally {
      raw.close()
    }
    expect(storeMigratedEvents(dbPath)).toHaveLength(1)
  })
})

describe('T-08118 readStoreSchemaState', () => {
  it('reports schemaAhead with the pending set while the store is behind', () => {
    const state = readStoreSchemaState(behindStore())
    expect(state.readable).toBe(true)
    expect(state.schemaAhead).toBe(true)
    expect(state.pending).toEqual([REPLAYABLE_MIGRATION])
    expect(state.releaseVersion).toBe(releaseSchemaVersion())
  })

  it('reports schemaAhead false once the store matches the release', () => {
    const state = readStoreSchemaState(currentStore())
    expect(state.readable).toBe(true)
    expect(state.schemaAhead).toBe(false)
    expect(state.pending).toEqual([])
    expect(state.storeVersion).toBe(releaseSchemaVersion())
  })

  it('reports unreadable — never a false negative — for a store it cannot open', () => {
    const state = readStoreSchemaState(join(scratchDir(), 'absent.sqlite'))
    expect(state.readable).toBe(false)
    expect(state.schemaAhead).toBe(false)
    expect(state.error).toContain('store not found')
  })
})

describe('T-08118 release attribution', () => {
  it('names the atomic release directory that owns the running code', () => {
    expect(
      resolveReleaseId('/x/hrc-runtime-releases/release-20260906145346824-23314/packages/hrc-cli')
    ).toBe('release-20260906145346824-23314')
  })

  it('reports unmanaged for a source checkout', () => {
    expect(resolveReleaseId('/Users/dev/praesidium/hrc-runtime/packages/hrc-cli/src')).toBe(
      'unmanaged'
    )
  })
})

describe('T-08118 migration actor identity', () => {
  it('names the subcommand, because every hrc process shares one entry script', () => {
    const argv = process.argv
    try {
      process.argv = ['bun', '/releases/r/packages/hrc-cli/src/cli.ts', 'server', 'serve', '--json']
      const actor = resolveMigrationActor()
      expect(actor.argv0).toBe('/releases/r/packages/hrc-cli/src/cli.ts')
      expect(actor.command).toBe('server serve')
    } finally {
      process.argv = argv
    }
  })

  it('keeps only leading non-flag tokens, so a prompt body never reaches the ledger', () => {
    const argv = process.argv
    try {
      process.argv = ['bun', '/x/cli.ts', 'turn', 'clod@p:primary', '--message', 'secret body']
      expect(resolveMigrationActor().command).toBe('turn clod@p:primary')
    } finally {
      process.argv = argv
    }
  })
})
