import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { environmentWithoutGitOverrides } from 'hrc-core'

import {
  dirtyTrackedPaths,
  gitConfigPoisonMessage,
  readDirtyTrackedPaths,
  readGitConfigOverrides,
  refusalMessage,
} from './install-dirty-guard'

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

  // Scrubbed, not inherited: an ambient GIT_DIR outranks cwd, so `git init` here
  // would re-initialize the caller's repository instead of the temp dir (T-07635).
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: environmentWithoutGitOverrides(),
    })
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

describe('gitConfigPoisonMessage', () => {
  const configPath = '/repo/.git/config'

  test('a sound config yields no refusal', () => {
    expect(
      gitConfigPoisonMessage({ bare: 'false', worktree: undefined, configPath }, '/repo')
    ).toBeUndefined()
  })

  test('core.bare=true names the setting, the file, and the unset command', () => {
    const message = gitConfigPoisonMessage(
      { bare: 'true', worktree: undefined, configPath },
      '/repo'
    )
    expect(message).toContain('core.bare = true')
    expect(message).toContain(configPath)
    expect(message).toContain("git --git-dir='/repo/.git' config --unset core.bare")
    expect(message).toContain('T-07635')
  })

  test('core.worktree pointing elsewhere is refused', () => {
    const message = gitConfigPoisonMessage(
      { bare: 'false', worktree: '/elsewhere/under-construction/t07632', configPath },
      '/repo'
    )
    expect(message).toContain('core.worktree = /elsewhere/under-construction/t07632')
    expect(message).toContain("git --git-dir='/repo/.git' config --unset core.worktree")
  })

  test('core.worktree naming this very checkout is left alone', () => {
    expect(
      gitConfigPoisonMessage({ bare: 'false', worktree: '/repo', configPath }, '/repo')
    ).toBeUndefined()
  })
})

describe('readGitConfigOverrides', () => {
  let repo: string

  const git = (...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: environmentWithoutGitOverrides(),
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'install-dirty-guard-config-')))
    git('init', '--quiet')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a healthy checkout reads sound and is not refused', () => {
    const overrides = readGitConfigOverrides(repo)
    expect(overrides.bare).toBe('false')
    expect(overrides.worktree).toBeUndefined()
    expect(overrides.configPath).toBe(join(repo, '.git', 'config'))
    expect(gitConfigPoisonMessage(overrides, repo)).toBeUndefined()
  })

  test('reads a poisoned config that has already broken every other git command', () => {
    git('config', 'core.bare', 'true')
    // The damage, from the same checkout the guard runs in.
    const status = spawnSync('git', ['status'], {
      cwd: repo,
      encoding: 'utf8',
      env: environmentWithoutGitOverrides(),
    })
    expect(status.status).not.toBe(0)
    expect(status.stderr).toContain('must be run in a work tree')

    const overrides = readGitConfigOverrides(repo)
    expect(overrides.bare).toBe('true')
    expect(gitConfigPoisonMessage(overrides, repo)).toContain('core.bare = true')

    git('config', '--unset', 'core.bare')
  })
})
