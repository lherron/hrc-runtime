import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { dirtyTrackedPaths, readDirtyTrackedPaths, refusalMessage } from './install-dirty-guard'

describe('dirtyTrackedPaths', () => {
  test('reports worktree and index modifications', () => {
    expect(dirtyTrackedPaths(' M justfile\nM  scripts/atomic-install.ts\n')).toEqual([
      'justfile',
      'scripts/atomic-install.ts',
    ])
  })

  test('ignores untracked and ignored entries', () => {
    expect(dirtyTrackedPaths('?? scratch.md\n!! dist/index.js\n M justfile\n')).toEqual([
      'justfile',
    ])
  })

  test('reports the destination path of a rename', () => {
    expect(dirtyTrackedPaths('R  scripts/old.ts -> scripts/new.ts\n')).toEqual(['scripts/new.ts'])
  })

  test('reads clean output as no dirty paths', () => {
    expect(dirtyTrackedPaths('')).toEqual([])
  })
})

describe('refusalMessage', () => {
  test('names every dirty path and the escape hatch', () => {
    const message = refusalMessage(['justfile', 'scripts/atomic-install.ts'])
    expect(message).toContain('2 tracked paths modified')
    expect(message).toContain('  justfile')
    expect(message).toContain('  scripts/atomic-install.ts')
    expect(message).toContain('just install allow-dirty=1')
  })
})

describe('readDirtyTrackedPaths', () => {
  let repo: string

  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'install-dirty-guard-'))
    git('init', '--quiet')
    git('config', 'user.email', 'guard@example.test')
    git('config', 'user.name', 'guard')
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
    git('add', 'tracked.txt')
    git('commit', '--quiet', '-m', 'baseline')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a clean checkout has no dirty paths', () => {
    expect(readDirtyTrackedPaths(repo)).toEqual([])
  })

  test('an untracked file does not make the tree dirty', () => {
    writeFileSync(join(repo, 'scratch.md'), 'scratch\n')
    expect(readDirtyTrackedPaths(repo)).toEqual([])
  })

  test('a modified tracked file makes the tree dirty', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'uncommitted\n')
    expect(readDirtyTrackedPaths(repo)).toEqual(['tracked.txt'])
  })
})
