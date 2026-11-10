import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { schemaArmedWindowLines } from './atomic-install.js'

/**
 * T-08118. `just install` replaces the CLI surface while the daemon keeps
 * running the previous release, so between the cutover and `hrc server restart`
 * the store is behind the installed binaries and the direct-open commands
 * refuse. The install says so.
 *
 * Every state is asserted deliberately: a warning printed in every state is one
 * operators learn to skip, so the quiet case has to be provably quiet.
 *
 * The reading comes from a real `rusthrc` (the installer passes the release it
 * just selected). HRC_T08118_RUSTHRC names one; otherwise the installed one.
 */
const RUSTHRC = process.env['HRC_T08118_RUSTHRC'] ?? join(homedir(), '.bun', 'bin', 'rusthrc')

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hrc-t08118-install-'))
  dirs.push(dir)
  return dir
}

/** A store at this release's schema, created by the release's own migrator. */
function currentStore(): string {
  const dbPath = join(scratch(), 'state.sqlite')
  const created = spawnSync(RUSTHRC, ['store', 'migrate', dbPath], { encoding: 'utf8' })
  expect(created.status, created.stderr).toBe(0)
  return dbPath
}

/** The newest migration this release carries, as `store state` names it. */
function releaseVersion(dbPath: string): string {
  const reading = JSON.parse(
    spawnSync(RUSTHRC, ['store', 'state', dbPath], { encoding: 'utf8' }).stdout
  )
  expect(reading.state).toBe('current')
  return reading.releaseVersion
}

function editStore(dbPath: string, sql: string): string {
  const raw = new Database(dbPath)
  raw.exec(sql)
  raw.close()
  return dbPath
}

describe('T-08118 just install armed-window warning', () => {
  it('reads through a real rusthrc', () => {
    expect(existsSync(RUSTHRC), RUSTHRC).toBeTrue()
  })

  it('names the armed window and every command that refuses in it', () => {
    const dbPath = currentStore()
    const newest = releaseVersion(dbPath)
    editStore(dbPath, `DELETE FROM hrc_migrations WHERE id = '${newest}'`)
    const lines = schemaArmedWindowLines(RUSTHRC, dbPath).join('\n')
    expect(lines).toContain('differs from running')
    expect(lines).toContain('1 unapplied migration(s)')
    expect(lines).toContain(newest)
    expect(lines).toContain('hrc server restart')
    for (const command of ['hrc monitor show', 'hrc monitor watch', 'hrc monitor wait']) {
      expect(lines).toContain(command)
    }
  })

  it('stays quiet when the store already matches the installed release', () => {
    const lines = schemaArmedWindowLines(RUSTHRC, currentStore())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('matches running')
    expect(lines.join('\n')).not.toContain('hrc server restart')
  })

  it('says ahead, not "matches", for a store a newer release migrated', () => {
    const dbPath = editStore(
      currentStore(),
      "INSERT INTO hrc_migrations (id, applied_at) VALUES ('9999_from_a_newer_release', 'x')"
    )
    const lines = schemaArmedWindowLines(RUSTHRC, dbPath)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ahead of this release')
    expect(lines[0]).toContain('9999_from_a_newer_release')
    expect(lines[0]).not.toContain('matches')
  })

  it('says unreadable rather than "matches" for a store that is not there', () => {
    const lines = schemaArmedWindowLines(RUSTHRC, join(scratch(), 'absent.sqlite'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('unreadable')
  })

  it('says unreadable for a binary that gives no reading, and never throws', () => {
    const dir = scratch()
    const silent = join(dir, 'rusthrc')
    writeFileSync(silent, '#!/bin/sh\nexit 2\n')
    chmodSync(silent, 0o755)
    for (const exe of [silent, join(dir, 'missing-rusthrc')]) {
      const lines = schemaArmedWindowLines(exe, join(dir, 'state.sqlite'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('unreadable')
    }
  })
})
