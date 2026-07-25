import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type WorktreePruneReport,
  pruneCompletedTaskWorktrees,
  taskTokens,
} from '../worktree-prune.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function fixture(taskId = 'T-12345'): {
  root: string
  worktree: string
  branch: string
} {
  const base = mkdtempSync(join(tmpdir(), 'hrc-worktree-prune-'))
  roots.push(base)
  const root = join(base, 'repo')
  const worktree = join(base, 'task-worktree')
  execFileSync('git', ['init', '--initial-branch=main', root])
  git(root, 'config', 'user.email', 'cody@example.test')
  git(root, 'config', 'user.name', 'Cody Test')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'base')
  const branch = `work/${taskId}`
  git(root, 'worktree', 'add', '-b', branch, worktree)
  return { root, worktree, branch }
}

function run(
  root: string,
  states: Record<string, string>,
  apply = false,
  listLiveRuntimeOccupancies: () => {
    runtimeId: string
    status: string
    scopeRef: string
    cwd?: string
  }[] = () => []
): WorktreePruneReport {
  return pruneCompletedTaskWorktrees(
    { projectId: 'fixture', projectRoot: root, apply },
    {
      readTask: (taskId) => ({ id: taskId, state: states[taskId] }),
      listLiveRuntimeOccupancies,
    }
  )
}

describe('completed-task worktree pruning', () => {
  it('extracts exact task tokens without prefix collisions', () => {
    expect(taskTokens('work/T-12345-and-T-123456')).toEqual(['T-12345', 'T-123456'])
    expect(taskTokens('work/XT-12345Z')).toEqual(['T-12345'])
    expect(taskTokens('work/T-1234567')).not.toContain('T-12345')
  })

  it('defaults to dry-run and preserves an eligible worktree and branch', () => {
    const { root, worktree, branch } = fixture()
    const report = run(root, { 'T-12345': 'completed' })

    expect(report.mode).toBe('dry-run')
    expect(report.summary).toMatchObject({
      wouldPrune: 1,
      pruned: 0,
      errors: 0,
    })
    expect(existsSync(worktree)).toBe(true)
    expect(git(root, 'show-ref', '--verify', `refs/heads/${branch}`)).toContain(branch)
  })

  it('removes only the linked worktree and preserves its branch when --yes applies', () => {
    const { root, worktree, branch } = fixture()
    const report = run(root, { 'T-12345': 'completed' }, true)

    expect(report.summary).toMatchObject({
      wouldPrune: 0,
      pruned: 1,
      errors: 0,
    })
    expect(existsSync(worktree)).toBe(false)
    expect(git(root, 'show-ref', '--verify', `refs/heads/${branch}`)).toContain(branch)
    expect(existsSync(root)).toBe(true)
  })

  it('refuses a dirty completed-task worktree', () => {
    const { root, worktree } = fixture()
    writeFileSync(join(worktree, 'untracked.txt'), 'do not delete\n')

    const report = run(root, { 'T-12345': 'completed' }, true)

    expect(report.results).toEqual([
      expect.objectContaining({
        disposition: 'skipped',
        reason: 'worktree is dirty',
      }),
    ])
    expect(existsSync(worktree)).toBe(true)
  })

  it('refuses a clean worktree whose HEAD is not merged into canonical HEAD', () => {
    const { root, worktree } = fixture()
    writeFileSync(join(worktree, 'README.md'), 'task commit\n')
    git(worktree, 'add', 'README.md')
    git(worktree, 'commit', '-m', 'unmerged task work')

    const report = run(root, { 'T-12345': 'completed' }, true)

    expect(report.results).toEqual([
      expect.objectContaining({
        disposition: 'skipped',
        reason: 'worktree HEAD is not merged into canonical HEAD',
      }),
    ])
    expect(existsSync(worktree)).toBe(true)
  })

  it('requires every task token on a branch to be completed', () => {
    const { root, worktree } = fixture('T-12345')
    git(root, 'worktree', 'remove', worktree)
    const second = join(root, '..', 'multi-task-worktree')
    git(root, 'worktree', 'add', '-b', 'work/T-12345-and-T-67890', second)

    const report = run(root, { 'T-12345': 'completed', 'T-67890': 'in_progress' }, true)

    expect(report.results).toEqual([
      expect.objectContaining({
        disposition: 'skipped',
        reason: 'task not completed: T-67890=in_progress',
      }),
    ])
    expect(existsSync(second)).toBe(true)
  })

  it('refuses an unknown task token rather than treating it as completed', () => {
    const { root, worktree } = fixture()

    const report = run(root, {}, true)

    expect(report.results).toEqual([
      expect.objectContaining({
        disposition: 'skipped',
        reason: 'task not completed: T-12345=not-found',
      }),
    ])
    expect(existsSync(worktree)).toBe(true)
  })

  it('refuses a worktree occupied by a live runtime cwd', () => {
    const { root, worktree } = fixture()
    const runtimeCwd = join(worktree, 'packages', 'app')
    mkdirSync(runtimeCwd, { recursive: true })

    const report = run(root, { 'T-12345': 'completed' }, true, () => [
      {
        runtimeId: 'rt-live',
        status: 'ready',
        scopeRef: 'agent:cody:project:other:task:primary',
        cwd: runtimeCwd,
      },
    ])

    expect(report.results).toEqual([
      expect.objectContaining({
        disposition: 'skipped',
        reason: 'live runtime rt-live (ready) occupies the worktree',
      }),
    ])
    expect(existsSync(worktree)).toBe(true)
  })

  it('refuses a live exact project/task binding when legacy HRC state lacks cwd', () => {
    const { root, worktree } = fixture()

    const report = run(root, { 'T-12345': 'completed' }, true, () => [
      {
        runtimeId: 'rt-legacy',
        status: 'busy',
        scopeRef: 'agent:cody:project:fixture:task:T-12345',
      },
    ])

    expect(report.results[0]).toMatchObject({
      disposition: 'skipped',
      reason: 'live runtime rt-legacy (busy) occupies the worktree',
    })
    expect(existsSync(worktree)).toBe(true)
  })

  it('trusts an authoritative live cwd outside the worktree over scope fallback', () => {
    const { root, worktree } = fixture()

    const report = run(root, { 'T-12345': 'completed' }, true, () => [
      {
        runtimeId: 'rt-canonical',
        status: 'ready',
        scopeRef: 'agent:cody:project:fixture:task:T-12345',
        cwd: root,
      },
    ])

    expect(report.results[0]).toMatchObject({
      disposition: 'pruned',
      reason: 'removed linked worktree; branch preserved',
    })
    expect(existsSync(worktree)).toBe(false)
  })

  it('rechecks HRC occupancy immediately before removal', () => {
    const { root, worktree } = fixture()
    let checks = 0

    const report = run(root, { 'T-12345': 'completed' }, true, () => {
      checks += 1
      return checks === 1
        ? []
        : [
            {
              runtimeId: 'rt-raced',
              status: 'starting',
              scopeRef: 'agent:cody:project:fixture:task:T-12345',
              cwd: worktree,
            },
          ]
    })

    expect(report.results[0]).toMatchObject({
      disposition: 'skipped',
      reason: 'live runtime rt-raced (starting) occupied the worktree before removal',
    })
    expect(existsSync(worktree)).toBe(true)
  })

  it('never treats the canonical checkout or a non-task branch as a candidate', () => {
    const { root, worktree } = fixture('T-12345')
    git(root, 'worktree', 'remove', worktree)
    const ordinary = join(root, '..', 'ordinary')
    git(root, 'worktree', 'add', '-b', 'ordinary-branch', ordinary)

    const report = run(root, {}, true)

    expect(report.results).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(existsSync(ordinary)).toBe(true)
  })
})
