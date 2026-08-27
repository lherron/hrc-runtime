import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'lib', 'verdaccio-sync.ts'), 'utf8')

// T-07629: a producer repo's `just install` drives this sync in every consumer.
// It must not write git history in a repo it does not own — only this repo's own
// `just pull-deps` commits, through commitSyncedLockfile.
describe('verdaccio sync lockfile ownership', () => {
  test('syncFromVerdaccio never commits', () => {
    const sync = source.slice(source.indexOf('export async function syncFromVerdaccio'))
    expect(sync).not.toBe('')
    expect(sync).not.toContain('commitLockfile')
    expect(sync).toContain('announceDirtyLockfile(spec.label)')
  })

  test('commitSyncedLockfile is the only caller of commitLockfile', () => {
    const callers = source.split('\n').filter((line) => /(?<!function )commitLockfile\(/.test(line))
    expect(callers).toHaveLength(1)
    expect(source.indexOf(callers[0] as string)).toBeGreaterThan(
      source.indexOf('export async function commitSyncedLockfile')
    )
  })

  test('the commit is not merely flagged off', () => {
    expect(source).not.toContain('PRAESIDIUM_SYNC_NO_COMMIT')
  })
})
