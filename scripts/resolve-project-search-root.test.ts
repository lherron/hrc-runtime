import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import {
  environmentWithoutGitOverrides,
  projectSearchRootFromCommonGitDir,
  resolveProjectSearchRoot,
} from './resolve-project-search-root'

describe('dev-env project search root', () => {
  test('canonical and linked checkout contexts resolve the same source parent', () => {
    const commonGitDir = '/srv/praesidium/hrc-runtime/.git'

    expect(projectSearchRootFromCommonGitDir(commonGitDir)).toBe('/srv/praesidium')
    // A linked checkout lives elsewhere, but `git --git-common-dir` still
    // returns the canonical checkout's .git directory.
    expect(projectSearchRootFromCommonGitDir(commonGitDir)).not.toBe(
      '/srv/praesidium/under-construction'
    )
  })

  test('the Git probe drops hook-owned repository overrides', () => {
    expect(
      environmentWithoutGitOverrides({
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        GIT_DIR: '.',
        GIT_WORK_TREE: '/wrong/checkout',
        GIT_INDEX_FILE: '/wrong/index',
      })
    ).toEqual({ PATH: '/usr/bin', HOME: '/tmp/home' })
  })

  test('resolves this checkout even under a hostile inherited hook context', () => {
    const repoRoot = resolve(import.meta.dir, '..')
    const expected = projectSearchRootFromCommonGitDir(resolve(repoRoot, '.git'))

    expect(
      resolveProjectSearchRoot(repoRoot, {
        ...process.env,
        GIT_DIR: '/does/not/exist',
        GIT_WORK_TREE: '/wrong/checkout',
        GIT_INDEX_FILE: '/wrong/index',
      })
    ).toBe(expected)
  })
})
