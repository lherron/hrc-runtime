import type { Database, SQLQueryBindings } from 'bun:sqlite'

/** Store diagnostics are owned by the caller; the store has no server dependency. */
export type HrcStoreLogger = {
  info(event: string, data: Record<string, unknown>): void
}

export type HrcMigration = {
  id: string
  apply(db: Database, logger?: HrcStoreLogger | undefined): void
  /** SQLite table rebuilds with incoming foreign keys need an isolated lane. */
  requiresForeignKeysDisabled?: boolean | undefined
  /**
   * Runs with `PRAGMA legacy_alter_table = ON`, in its own lane. Only for an
   * already-shipped rebuild that renames `<t>_new` over a dropped `<t>` while a
   * view still names `<t>`: SQLite >= 3.53 re-checks views during that rename
   * and refuses it. Legacy RENAME does not rewrite references in views and
   * triggers, so new migrations must not opt in; drop and recreate the view.
   */
  requiresLegacyAlterTable?: boolean | undefined
}

export function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}
