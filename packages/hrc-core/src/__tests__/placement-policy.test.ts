/**
 * T-08597 — HRC placement policy unit tests (ported from
 * hrc-sdk project-placement.test.ts at ad04040d).
 *
 * Policy (explicit override → wrkq registry → marker scan → sibling fallback →
 * task-worktree refinement) runs identically on the daemon's placements route;
 * these hermetic tests pin the policy outcomes. Observation-backed results
 * (agentRoot, bundle, harness) are proved by the route parity table, not here.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type GitFixture, createGitFixture, runGit } from '../../../../test-support/git-fixture.js'

import { findProjectMarker, inferProjectIdFromCwd } from '../placement-conventions.js'
import {
  refineTaskWorktree,
  resolveCanonicalProjectRoot,
  resolveSiblingProjectRoot,
} from '../placement-policy.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hrc-placement-policy-'))
  roots.push(root)
  return root
}

function canonicalCheckout(path: string): void {
  mkdirSync(join(path, '.git'), { recursive: true })
}

function createFixtureRepo(
  path: string,
  inheritedEnvironment: Record<string, string | undefined> = process.env
): GitFixture {
  return createGitFixture(path, {
    initialBranch: 'main',
    inheritedEnvironment,
    identity: { name: 'Placement Test', email: 'test@example.com' },
  })
}

function git(repo: GitFixture, ...args: string[]): string {
  return runGit(repo, args)
}

function committedRepo(
  path: string,
  inheritedEnvironment: Record<string, string | undefined> = process.env
): GitFixture {
  const repo = createFixtureRepo(path, inheritedEnvironment)
  writeFileSync(join(repo.workTree!, 'README.md'), 'fixture\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'fixture')
  return repo
}

describe('resolveCanonicalProjectRoot', () => {
  it('resolves an explicit project from a ~-relative wrkq registry root', () => {
    const home = temporaryRoot()
    const projectRoot = join(home, 'praesidium', 'taskboard')
    canonicalCheckout(projectRoot)

    const resolved = resolveCanonicalProjectRoot('taskboard', {
      env: { HOME: home },
      cwd: home,
      registryProjects: [{ slug: 'taskboard', root: '~/praesidium/taskboard' }],
    })

    expect(resolved).toEqual({ root: projectRoot, source: 'wrkq-registry' })
  })

  it('falls back to a cwd-independent canonical marker scan and excludes linked worktrees', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    canonicalCheckout(projectRoot)
    const linked = join(root, 'linked-project')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), 'gitdir: elsewhere\n')

    const resolved = resolveCanonicalProjectRoot('taskboard', {
      env: {},
      cwd: linked,
      registryProjects: [{ slug: 'taskboard', root: null }],
      projectSearchRoots: [root],
    })

    expect(resolved).toEqual({ root: projectRoot, source: 'marker-scan' })
  })

  it('skips a taskboard-named linked checkout collision in favor of the canonical marker', () => {
    const root = temporaryRoot()
    const poisonedSearchRoot = join(root, 'poisoned')
    const canonicalSearchRoot = join(root, 'canonical')
    const linked = join(poisonedSearchRoot, 'taskboard')
    const projectRoot = join(canonicalSearchRoot, 'taskboard')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), 'gitdir: elsewhere\n')
    canonicalCheckout(projectRoot)

    const resolved = resolveCanonicalProjectRoot('taskboard', {
      env: {},
      cwd: root,
      registryProjects: [{ slug: 'taskboard', root: null }],
      projectSearchRoots: [poisonedSearchRoot, canonicalSearchRoot],
    })

    expect(resolved).toEqual({ root: projectRoot, source: 'marker-scan' })
  })

  it('fails closed when an explicit project root override does not exist', () => {
    const root = temporaryRoot()
    const missing = join(root, 'missing')

    expect(() =>
      resolveCanonicalProjectRoot('taskboard', {
        env: {},
        cwd: root,
        projectRootOverride: missing,
        registryProjects: [],
      })
    ).toThrow(`explicit project root does not exist or is not a directory: ${missing}`)
  })

  it('rejects a linked-worktree registry root and names the canonical remediation', () => {
    const root = temporaryRoot()
    const linked = join(root, 'linked-taskboard')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), 'gitdir: elsewhere\n')

    expect(() =>
      resolveCanonicalProjectRoot('taskboard', {
        env: {},
        cwd: root,
        registryProjects: [{ slug: 'taskboard', root: linked }],
        projectSearchRoots: [root],
      })
    ).toThrow(
      `registered root for taskboard ${linked} is a linked worktree; repair it with: wrkq set taskboard --root <canonical>`
    )
  })

  it('fails an unknown explicit project with registration and task-handle remediation', () => {
    const root = temporaryRoot()

    expect(() =>
      resolveCanonicalProjectRoot('taskboard-T-06370-worktree', {
        env: {},
        cwd: root,
        registryProjects: [{ slug: 'taskboard', root: null }],
        projectSearchRoots: [root],
      })
    ).toThrow(
      'project root unknown for taskboard-T-06370-worktree; register it with: wrkq set taskboard-T-06370-worktree --root <path>; did you mean @taskboard:T-06370'
    )
  })

  it('resolves an unregistered project from the sibling fallback', () => {
    const root = temporaryRoot()
    const launcher = join(root, 'launcher')
    mkdirSync(launcher, { recursive: true })
    const projectRoot = join(launcher, 'taskboard')
    canonicalCheckout(projectRoot)
    writeFileSync(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n')

    const resolved = resolveCanonicalProjectRoot('taskboard', {
      env: {},
      cwd: launcher,
      registryProjects: [{ slug: 'taskboard', root: null }],
      projectSearchRoots: [join(root, 'elsewhere')],
    })

    expect(resolved).toEqual({ root: projectRoot, source: 'sibling-fallback' })
  })

  it('resolves the agents-home-relative sibling candidate', () => {
    const home = temporaryRoot()
    const agentsRoot = join(home, 'praesidium', 'var', 'agents')
    const projectRoot = join(home, 'praesidium', 'agent-spaces')
    mkdirSync(join(agentsRoot, 'cody'), { recursive: true })
    canonicalCheckout(projectRoot)
    writeFileSync(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n')

    const resolved = resolveSiblingProjectRoot('agent-spaces', {
      cwd: join(home, 'praesidium', 'agent-control-plane'),
      agentRoot: join(agentsRoot, 'cody'),
    })

    expect(resolved).toBe(projectRoot)
  })
})

describe('refineTaskWorktree', () => {
  it('refines an explicit canonical root to the worktree whose branch carries the task token', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const worktree = join(root, 'taskboard-T-06369')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '-b', 'drain/T-06369-placement', worktree)

    const refined = refineTaskWorktree(projectRoot, 'T-06369', repo.env)

    expect(refined?.path).toBe(realpathSync(worktree))
    expect(refined?.branch).toBe('drain/T-06369-placement')
  })

  it('ignores hostile ambient Git context while preserving deliberate Git env overrides', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const worktree = join(root, 'taskboard-T-07138')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '-b', 'feature/T-07138-placement', worktree)
    const poison = committedRepo(join(root, 'poison'))

    const originalGitDir = process.env['GIT_DIR']
    const originalGitWorkTree = process.env['GIT_WORK_TREE']
    process.env['GIT_DIR'] = poison.gitDir
    Reflect.deleteProperty(process.env, 'GIT_WORK_TREE')
    try {
      const ambient = refineTaskWorktree(projectRoot, 'T-07138', {})
      expect(ambient?.path).toBe(realpathSync(worktree))

      const deliberate = refineTaskWorktree(projectRoot, 'T-07138', {
        GIT_DIR: poison.gitDir,
        GIT_WORK_TREE: poison.workTree,
      })
      expect(deliberate).toBeUndefined()
    } finally {
      if (originalGitDir === undefined) Reflect.deleteProperty(process.env, 'GIT_DIR')
      else process.env['GIT_DIR'] = originalGitDir
      if (originalGitWorkTree === undefined) Reflect.deleteProperty(process.env, 'GIT_WORK_TREE')
      else process.env['GIT_WORK_TREE'] = originalGitWorkTree
    }
  })

  it('fails closed when more than one worktree branch carries the exact task token', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '-b', 'drain/T-06369-one', join(root, 'one'))
    git(repo, 'worktree', 'add', '-b', 'wf/T-06369-two', join(root, 'two'))

    expect(() => refineTaskWorktree(projectRoot, 'T-06369', repo.env)).toThrow(
      /multiple worktrees match T-06369.*one.*two/
    )
  })

  it('trips on a task-named detached worktree instead of silently selecting canonical', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const detached = join(root, 'taskboard-T-06369-detached')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '--detach', detached)

    expect(() => refineTaskWorktree(projectRoot, 'T-06369', repo.env)).toThrow(
      `worktree at ${realpathSync(detached)} appears associated with T-06369 but is detached HEAD (no branch)`
    )
  })
})

describe('marker discovery (vendored conventions)', () => {
  it('walks up from cwd to the marker and infers the project id', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    canonicalCheckout(projectRoot)
    writeFileSync(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n')
    const nested = join(projectRoot, 'packages', 'ui')
    mkdirSync(nested, { recursive: true })

    expect(findProjectMarker(nested, {})).toEqual({ dir: projectRoot, id: 'taskboard' })
    expect(inferProjectIdFromCwd({ cwd: nested, env: {} })).toBe('taskboard')
  })

  it('does not cross the agents root boundary', () => {
    const root = temporaryRoot()
    const agentsRoot = join(root, 'agents')
    mkdirSync(join(agentsRoot, 'cody'), { recursive: true })

    expect(findProjectMarker(join(agentsRoot, 'cody'), { agentsRoot })).toBeUndefined()
  })

  it('returns undefined with no marker and no git root', () => {
    const root = temporaryRoot()
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })

    expect(findProjectMarker(plain, {})).toBeUndefined()
    expect(inferProjectIdFromCwd({ cwd: plain, env: {} })).toBeUndefined()
  })
})
