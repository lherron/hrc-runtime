import { describe, expect, it } from 'bun:test'

import { environmentWithoutGitOverrides } from '../git-environment.js'

describe('environmentWithoutGitOverrides', () => {
  it('drops every GIT_ variable a hook exports', () => {
    const result = environmentWithoutGitOverrides({
      GIT_DIR: '/repo/.git/worktrees/task',
      GIT_WORK_TREE: '/repo/worktrees/task',
      GIT_INDEX_FILE: '/repo/.git/worktrees/task/index',
      GIT_CONFIG_PARAMETERS: "'user.name'='hook'",
      GIT_PREFIX: '',
      PATH: '/usr/bin',
    })

    expect(result).toEqual({ PATH: '/usr/bin' })
  })

  it('keeps variables that merely mention git', () => {
    const result = environmentWithoutGitOverrides({
      GITHUB_TOKEN: 'token',
      HOME: '/home/agent',
    })

    expect(result).toEqual({ GITHUB_TOKEN: 'token', HOME: '/home/agent' })
  })

  it('drops unset variables so the result is assignable to a spawn environment', () => {
    expect(environmentWithoutGitOverrides({ HOME: '/home/agent', TERM: undefined })).toEqual({
      HOME: '/home/agent',
    })
  })
})
