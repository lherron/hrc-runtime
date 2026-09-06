import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../packages/hrc-store-sqlite/src/database.js'
import { schemaArmedWindowLines } from './atomic-install.js'

/**
 * T-08118. `just install` replaces the CLI surface while the daemon keeps
 * running the previous release, so between the cutover and `hrc server restart`
 * the store is behind the installed binaries and the six direct-open commands
 * refuse. The install says so.
 *
 * Both states are asserted deliberately: a warning printed in every state is one
 * operators learn to skip, so the quiet case has to be provably quiet.
 */
const REPLAYABLE_MIGRATION = '0036_event_repository_query_indexes'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function currentStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-t08118-install-'))
  dirs.push(dir)
  const dbPath = join(dir, 'state.sqlite')
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

describe('T-08118 just install armed-window warning', () => {
  it('names the armed window and every command that refuses in it', () => {
    const lines = schemaArmedWindowLines(behindStore()).join('\n')
    expect(lines).toContain('differs from running')
    expect(lines).toContain('1 unapplied migration(s)')
    expect(lines).toContain('hrc server restart')
    for (const command of [
      'hrc mail inspect',
      'hrc admin worktrees prune',
      'hrc monitor show',
      'hrc monitor watch',
      'hrc monitor wait',
      'hrc run export',
      'hrc run annotate',
    ]) {
      expect(lines).toContain(command)
    }
  })

  it('stays quiet when the store already matches the installed release', () => {
    const lines = schemaArmedWindowLines(currentStore())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('matches running')
    expect(lines.join('\n')).not.toContain('hrc server restart')
  })

  it('says unreadable rather than "matches" for a store that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrc-t08118-install-'))
    dirs.push(dir)
    const lines = schemaArmedWindowLines(join(dir, 'absent.sqlite'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('unreadable')
  })
})
