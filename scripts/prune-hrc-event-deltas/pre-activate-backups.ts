/**
 * Age out the store backups `hrc-owner.sh activate` writes (T-12695). The rule
 * and its reasons are in docs/state-retention.md. Missing evidence never
 * authorizes deletion: anything this cannot read stays and says why.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Database } from 'bun:sqlite'

import { appliedMigrationIds } from '../../packages/hrc-store-sqlite/src/migrations.ts'
import { MILLISECONDS_PER_DAY, PRE_ACTIVATE_BACKUP_RETENTION_DAYS } from './constants.ts'

export type PreActivateBackupEntry = {
  name: string
  bytes: number
  ageDays?: number
  action: 'kept' | 'would-remove' | 'removed' | 'remove-failed'
  reason?:
    | 'inside-window'
    | 'unreadable-name'
    | 'rollback'
    | 'backup-unreadable'
    | 'store-unreadable'
}

export type PreActivateBackupsResult = {
  dir: string
  retentionDays: number
  entries: PreActivateBackupEntry[]
  error?: string
}

const BACKUP_NAME = /^pre-activate-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-\d+\.sqlite$/

function stampOf(name: string): number | undefined {
  const match = BACKUP_NAME.exec(name)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match
  const at = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
  return Number.isNaN(at) ? undefined : at
}

function migrationsOf(open: () => Database): Set<string> | undefined {
  try {
    const db = open()
    try {
      const ids = appliedMigrationIds(db)
      return ids.length > 0 ? new Set(ids) : undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

function isStrictlyPast(store: Set<string>, backup: Set<string>): boolean {
  return store.size > backup.size && [...backup].every((id) => store.has(id))
}

export function agePreActivateBackups(options: {
  dbPath: string
  apply: boolean
  now: Date
}): PreActivateBackupsResult {
  const dir = join(dirname(options.dbPath), 'backups')
  const result: PreActivateBackupsResult = {
    dir,
    retentionDays: PRE_ACTIVATE_BACKUP_RETENTION_DAYS,
    entries: [],
  }
  try {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
      throw error
    }
    let store: Set<string> | undefined
    let storeRead = false
    for (const name of names.sort()) {
      if (!name.startsWith('pre-activate-') || !name.endsWith('.sqlite')) continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (!stat.isFile()) continue
      const entry: PreActivateBackupEntry = { name, bytes: stat.size, action: 'kept' }
      result.entries.push(entry)

      const stamp = stampOf(name)
      if (stamp === undefined) {
        entry.reason = 'unreadable-name'
        continue
      }
      // The later of the two: a restored or copied file can carry either one old.
      const age = options.now.getTime() - Math.max(stamp, stat.mtimeMs)
      entry.ageDays = Math.round((age / MILLISECONDS_PER_DAY) * 100) / 100
      if (age < PRE_ACTIVATE_BACKUP_RETENTION_DAYS * MILLISECONDS_PER_DAY) {
        entry.reason = 'inside-window'
        continue
      }

      if (!storeRead) {
        store = migrationsOf(() => new Database(options.dbPath, { readonly: true }))
        storeRead = true
      }
      if (store === undefined) {
        entry.reason = 'store-unreadable'
        continue
      }
      // immutable: a backup taken from a WAL store is itself in WAL mode, and an
      // ordinary read-only open would leave -shm and -wal files beside it.
      const backup = migrationsOf(
        () => new Database(`${pathToFileURL(path).href}?immutable=1`, { readonly: true })
      )
      if (backup === undefined) {
        entry.reason = 'backup-unreadable'
        continue
      }
      if (!isStrictlyPast(store, backup)) {
        entry.reason = 'rollback'
        continue
      }

      if (!options.apply) {
        entry.action = 'would-remove'
        continue
      }
      try {
        rmSync(path)
        entry.action = 'removed'
        for (const suffix of ['-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true })
      } catch {
        if (entry.action !== 'removed') entry.action = 'remove-failed'
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}
