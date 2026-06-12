import type { Database, SQLQueryBindings } from 'bun:sqlite'

export type HrcMigration = {
  id: string
  apply(db: Database): void
}

export function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}
