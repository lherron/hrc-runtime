import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

import {
  appliedMigrationIds,
  pendingMigrationIds,
  releaseSchemaVersion,
  storeSchemaVersion,
} from './migrations.js'

/** The six direct-open commands named in T-08118, for operator-facing warnings. */
export const DIRECT_STORE_OPEN_COMMANDS = [
  'hrc mail inspect',
  'hrc worktree prune',
  'hrc monitor show',
  'hrc monitor watch',
  'hrc monitor wait',
  'hrc run invocation',
] as const

/**
 * A CLI-path open found the store behind the schema this release carries.
 *
 * The window this closes: `just install` replaces the CLI surface, but the
 * daemon keeps running the previous release until `hrc server restart`. A CLI
 * command that opened the live store and migrated it would apply the new
 * release's schema *under* the old daemon — which, when a migration drops or
 * rewrites a column, breaks the running daemon's read path (T-08093).
 */
function buildMessage(
  storeVersion: string | undefined,
  releaseVersion: string,
  pending: readonly string[]
): string {
  // An on-disk store with no migration table at all is not "behind an install":
  // nothing has ever run against it. Saying "restart the daemon" there would
  // send the operator after the wrong thing.
  if (storeVersion === undefined) {
    return `store has no HRC schema (0 of ${pending.length} migrations applied); it is not an HRC store, or no daemon has ever opened it. Refusing to create one from a non-owning open`
  }
  // The id prefixes are not globally ordered, so a store can be missing a
  // migration without its highest id moving. Say what is true in that case
  // rather than printing "X is behind X".
  const behind =
    storeVersion === releaseVersion
      ? `store schema ${releaseVersion} is missing ${pending.length} migration(s) this release carries`
      : `store schema ${storeVersion} is behind this release's ${releaseVersion}`
  return `${behind}; the daemon has not been restarted since install — run \`hrc server restart\` (pending: ${pending.join(', ')})`
}

export class HrcStoreSchemaBehindError extends Error {
  readonly code = 'store_schema_behind'

  constructor(
    readonly storeVersion: string | undefined,
    readonly releaseVersion: string,
    readonly pending: readonly string[]
  ) {
    super(buildMessage(storeVersion, releaseVersion, pending))
    this.name = 'HrcStoreSchemaBehindError'
  }
}

/**
 * Refuse rather than migrate. Called by every non-owning open; the daemon, which
 * owns the store, opens with `migrate: true` and never reaches here.
 */
export function assertStoreSchemaCurrent(db: Database): void {
  const pending = pendingMigrationIds(db)
  if (pending.length === 0) return
  throw new HrcStoreSchemaBehindError(storeSchemaVersion(db), releaseSchemaVersion(), pending)
}

export type StoreSchemaState = {
  /** False when the store could not be read at all; the other fields are then unknown. */
  readable: boolean
  storeVersion?: string | undefined
  releaseVersion: string
  pending: string[]
  /** True only when the store was read AND this release carries migrations it lacks. */
  schemaAhead: boolean
  error?: string | undefined
}

/**
 * Read a store's schema position without opening it through `openHrcDatabase`.
 * Used by `hrc server status` and `just install`, both of which must be able to
 * report the armed window without being the process that closes it.
 *
 * Never throws: an unreadable store reports `readable: false`, which is distinct
 * from `schemaAhead: false` — absence of a reading is not a reading of absence.
 */
export function readStoreSchemaState(dbPath: string): StoreSchemaState {
  const releaseVersion = releaseSchemaVersion()
  if (!existsSync(dbPath)) {
    return {
      readable: false,
      releaseVersion,
      pending: [],
      schemaAhead: false,
      error: `store not found at ${dbPath}`,
    }
  }
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const applied = appliedMigrationIds(db)
    const pending = pendingMigrationIds(db)
    return {
      readable: true,
      ...(applied.at(-1) === undefined ? {} : { storeVersion: applied.at(-1) }),
      releaseVersion,
      pending,
      schemaAhead: pending.length > 0,
    }
  } catch (error) {
    return {
      readable: false,
      releaseVersion,
      pending: [],
      schemaAhead: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    db?.close()
  }
}
