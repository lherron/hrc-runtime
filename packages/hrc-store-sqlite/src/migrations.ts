import type { Database } from 'bun:sqlite'

import { brokerMigrations } from './migrations/broker-migrations.js'
import { schemaMigrations } from './migrations/schema-migrations.js'
import { type HrcMigration, execute } from './migrations/types.js'

export type { HrcMigration } from './migrations/types.js'

export const phase1Migrations: readonly HrcMigration[] = [...schemaMigrations, ...brokerMigrations]

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hrc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
}

export function listAppliedMigrations(db: Database): string[] {
  ensureMigrationTable(db)

  const rows = db.query<{ id: string }, []>('SELECT id FROM hrc_migrations ORDER BY id ASC').all()

  return rows.map((row) => row.id)
}

export function runMigrations(db: Database): void {
  ensureMigrationTable(db)

  const applied = new Set(listAppliedMigrations(db))
  const pending = phase1Migrations.filter((migration) => !applied.has(migration.id))
  if (pending.length === 0) {
    return
  }

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
  })

  applyPending.immediate(pending)
}
