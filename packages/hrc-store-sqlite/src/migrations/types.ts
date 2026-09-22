import type { Database, SQLQueryBindings } from 'bun:sqlite'

export type HrcMigration = {
  id: string
  apply(db: Database): void
  /** SQLite table rebuilds with incoming foreign keys need an isolated lane. */
  requiresForeignKeysDisabled?: boolean | undefined
}

export function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}
