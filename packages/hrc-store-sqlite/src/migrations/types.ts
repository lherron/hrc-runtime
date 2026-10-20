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
}

export function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}
