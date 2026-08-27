/**
 * Regression test for T-07635.
 *
 * The fixtures in this package provision canonical checkouts by shelling git.
 * On 2026-08-27 three shared checkouts lost git for every seat because one of
 * them ran a bare `git init`: an ambient GIT_DIR outranks cwd AND the directory
 * argument, so under a pre-push hook — which exports an absolute GIT_DIR when
 * it runs in a linked worktree — the init landed on the real repository and
 * wrote `core.bare = true` into the config a main checkout SHARES with every
 * linked worktree. Every git command in every seat then failed with
 * `fatal: this operation must be run in a work tree`, and the init exited 0.
 *
 * So: stand up a scratch repository with a linked worktree, export the exact
 * environment a hook in that worktree would give us, provision fixtures, and
 * assert the scratch repository's config came through byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { environmentWithoutGitOverrides } from 'hrc-core'

import { createGitFixture } from '../../../../test-support/git-fixture.js'

type ScratchRepo = {
  root: string
  mainCheckout: string
  linkedWorktree: string
  configPath: string
  linkedGitDir: string
}

const scratchRoots: string[] = []
const savedGitEnvironment = new Map<string, string | undefined>()

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: environmentWithoutGitOverrides(),
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
}

function createScratchRepo(): ScratchRepo {
  // realpathSync: tmpdir() is a symlink on macOS, and git records the resolved
  // path — an unresolved prefix here would compare against the wrong string.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hrc-git-env-isolation-')))
  scratchRoots.push(root)
  const mainCheckout = join(root, 'main')
  const linkedWorktree = join(root, 'linked')
  mkdirSync(mainCheckout, { recursive: true })
  git(mainCheckout, ['init', '--quiet', '--initial-branch=main'])
  git(mainCheckout, ['config', 'user.email', 'isolation@example.test'])
  git(mainCheckout, ['config', 'user.name', 'Isolation Test'])
  git(mainCheckout, ['commit', '--quiet', '--allow-empty', '-m', 'baseline'])
  git(mainCheckout, ['worktree', 'add', '--quiet', '-b', 'linked', linkedWorktree])
  return {
    root,
    mainCheckout,
    linkedWorktree,
    configPath: join(mainCheckout, '.git', 'config'),
    linkedGitDir: join(mainCheckout, '.git', 'worktrees', 'linked'),
  }
}

function temporaryDirectory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hrc-git-env-isolation-fixture-'))
  scratchRoots.push(root)
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Export the environment git gives a hook running in a linked worktree.
 *
 * A hook-launched process has these in the environment it STARTS with, so its
 * own default-environment child spawns inherit them. A test can only mutate
 * `process.env` after startup, and Bun's default spawn environment is a
 * snapshot taken before that — so the spawns below pass `{ ...process.env }`
 * explicitly to stand in for what a real inherited environment hands a child.
 */
function exportHookEnvironment(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!savedGitEnvironment.has(key)) savedGitEnvironment.set(key, process.env[key])
    process.env[key] = value
  }
}

function inheritedEnvironment(): Record<string, string> {
  return { ...process.env } as Record<string, string>
}

beforeEach(() => {
  savedGitEnvironment.clear()
})

afterEach(() => {
  for (const [key, value] of savedGitEnvironment) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  savedGitEnvironment.clear()
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('fixture git spawns under a poisoned environment', () => {
  /**
   * The control. Not a demonstration for its own sake: without it, a green
   * subject case proves nothing, because it cannot distinguish "the scrub
   * works" from "this environment never poisoned anything to begin with".
   * Everything here happens to a throwaway repository.
   */
  it('CONTROL: a bare `git init` with the inherited environment poisons the shared config', () => {
    const scratch = createScratchRepo()
    expect(readFileSync(scratch.configPath, 'utf8')).not.toContain('bare = true')
    exportHookEnvironment({
      GIT_DIR: scratch.linkedGitDir,
      GIT_INDEX_FILE: join(scratch.linkedGitDir, 'index'),
    })

    const projectRoot = temporaryDirectory('taskboard')
    const init = spawnSync('git', ['init', '-q'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: inheritedEnvironment(),
    })

    // Exit 0, and it initialized the wrong repository: GIT_DIR outranks cwd.
    expect(init.status).toBe(0)
    expect(existsSync(join(projectRoot, '.git'))).toBe(false)
    expect(readFileSync(scratch.configPath, 'utf8')).toContain('bare = true')
  })

  it('CONTROL: GIT_WORK_TREE turns the same spawn into a core.worktree write', () => {
    const scratch = createScratchRepo()
    exportHookEnvironment({
      GIT_DIR: scratch.linkedGitDir,
      GIT_WORK_TREE: scratch.linkedWorktree,
    })

    const projectRoot = temporaryDirectory('taskboard')
    const init = spawnSync('git', ['init', '-q'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: inheritedEnvironment(),
    })
    expect(init.status).toBe(0)

    expect(readFileSync(scratch.configPath, 'utf8')).toContain(
      `worktree = ${scratch.linkedWorktree}`
    )
  })

  it('the scrubbed environment leaves the shared config byte-identical', () => {
    const scratch = createScratchRepo()
    const before = readFileSync(scratch.configPath, 'utf8')
    exportHookEnvironment({
      GIT_DIR: scratch.linkedGitDir,
      GIT_WORK_TREE: scratch.linkedWorktree,
      GIT_INDEX_FILE: join(scratch.linkedGitDir, 'index'),
    })

    const projectRoot = temporaryDirectory('taskboard')
    const init = spawnSync('git', ['init', '-q'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: environmentWithoutGitOverrides(),
    })

    expect(init.status).toBe(0)
    expect(readFileSync(scratch.configPath, 'utf8')).toBe(before)
    // And it initialized the repository it was actually pointed at.
    expect(existsSync(join(projectRoot, '.git'))).toBe(true)
  })

  it('createGitFixture — the shape these suites now use — leaves it byte-identical', () => {
    const scratch = createScratchRepo()
    const before = readFileSync(scratch.configPath, 'utf8')
    exportHookEnvironment({
      GIT_DIR: scratch.linkedGitDir,
      GIT_WORK_TREE: scratch.linkedWorktree,
      GIT_INDEX_FILE: join(scratch.linkedGitDir, 'index'),
    })

    const projectRoot = join(temporaryDirectory('fixture'), 'taskboard')
    const fixture = createGitFixture(projectRoot)

    expect(readFileSync(scratch.configPath, 'utf8')).toBe(before)
    // realpathSync: tmpdir() is a symlink on macOS and the fixture canonicalizes.
    expect(fixture.gitDir).toBe(join(realpathSync(projectRoot), '.git'))
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: environmentWithoutGitOverrides(),
    })
    expect(gitDir.status).toBe(0)
    expect(gitDir.stdout.trim()).toBe(fixture.gitDir)
  })

  it('refuses a fixture path that resolves inside an existing checkout', () => {
    const scratch = createScratchRepo()
    expect(() => createGitFixture(join(scratch.mainCheckout, 'nested', 'fixture'))).toThrow(
      /resolves inside existing checkout/
    )
  })
})
