import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * SQLite >= 3.53 re-checks every view during ALTER TABLE ... RENAME, so a
 * rebuild that renames `<t>_new` over a dropped `<t>` while a view still names
 * `<t>` fails a fresh migrate ("no such table: main.<t>"). 0046 and 0074 do
 * exactly that and opt into legacy rename semantics for themselves only.
 * macOS's system SQLite (3.51) never sees it; Bun on Linux bundles 3.53, and
 * so will macOS eventually. This drives a real fresh migrate on a modern
 * SQLite: Bun's own on Linux, Homebrew's (or HRC_TEST_MODERN_SQLITE) on macOS,
 * loaded in a child process because setCustomSQLite must precede any open.
 */
const HOMEBREW_SQLITE = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'
const DATABASE_MODULE = join(import.meta.dir, '..', 'database.ts')

const CHILD = `
import { Database } from 'bun:sqlite'
const [dylib, dbPath, moduleUrl] = process.argv.slice(1)
if (dylib) Database.setCustomSQLite(dylib)
const { openHrcDatabase } = await import(moduleUrl)
const db = openHrcDatabase(dbPath)
const version = db.sqlite.query('select sqlite_version() as v').get().v
const legacy = db.sqlite.query('pragma legacy_alter_table').get().legacy_alter_table
db.close()
console.log(JSON.stringify({ version, legacy }))
`

function modernSqliteDylib(): string {
  if (process.platform !== 'darwin') return ''
  const dylib = process.env['HRC_TEST_MODERN_SQLITE'] ?? HOMEBREW_SQLITE
  if (!existsSync(dylib)) {
    throw new Error(
      `no SQLite >= 3.53 to test against: ${dylib} is missing (brew install sqlite, or set HRC_TEST_MODERN_SQLITE)`
    )
  }
  return dylib
}

describe('fresh migrate on a modern SQLite', () => {
  it('applies every migration on SQLite >= 3.53 and leaves legacy_alter_table off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrc-modern-sqlite-'))
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          CHILD,
          modernSqliteDylib(),
          join(dir, 'state.sqlite'),
          DATABASE_MODULE,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const stderr = result.stderr.toString()
      expect(result.exitCode, stderr).toBe(0)
      const lines = result.stdout.toString().trim().split('\n')
      const { version, legacy } = JSON.parse(lines.at(-1) ?? '{}')
      const [major, minor] = String(version).split('.').map(Number)
      expect(major * 1000 + minor, `ran on SQLite ${version}`).toBeGreaterThanOrEqual(3053)
      expect(legacy).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
