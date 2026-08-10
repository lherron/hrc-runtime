import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type GitFixture,
  createGitFixture,
  runGit,
  runGitResult,
} from '../../../../test-support/git-fixture.js'

import { resolveHrcAgentPlacementPaths } from '../project-placement.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hrc-project-placement-'))
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

describe('resolveHrcAgentPlacementPaths', () => {
  it('resolves an explicit project from a ~-relative wrkq registry root', () => {
    const home = temporaryRoot()
    const projectRoot = join(home, 'praesidium', 'taskboard')
    canonicalCheckout(projectRoot)

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(home, 'agents', 'cody'),
      projectId: 'taskboard',
      projectOrigin: 'explicit',
      registryProjects: [{ slug: 'taskboard', root: '~/praesidium/taskboard' }],
      env: { HOME: home },
    })

    expect(resolved.projectRoot).toBe(projectRoot)
    expect(resolved.cwd).toBe(projectRoot)
    expect(resolved.resolution.source).toBe('wrkq-registry')
  })

  it('falls back to a cwd-independent canonical marker scan and excludes linked worktrees', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    canonicalCheckout(projectRoot)
    const linked = join(root, 'linked-project')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), 'gitdir: elsewhere\n')

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(root, 'agents', 'cody'),
      projectId: 'taskboard',
      projectOrigin: 'explicit',
      registryProjects: [{ slug: 'taskboard', root: null }],
      projectSearchRoots: [root],
      cwd: linked,
      env: {},
    })

    expect(resolved.projectRoot).toBe(projectRoot)
    expect(resolved.resolution.source).toBe('marker-scan')
  })

  it('refines an explicit canonical root to the worktree whose branch carries the task token', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const worktree = join(root, 'taskboard-T-06369')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '-b', 'drain/T-06369-placement', worktree)

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(root, 'agents', 'cody'),
      projectId: 'taskboard',
      taskId: 'T-06369',
      projectOrigin: 'explicit',
      registryProjects: [{ slug: 'taskboard', root: projectRoot }],
      env: repo.env,
    })

    expect(resolved.projectRoot).toBe(realpathSync(worktree))
    expect(resolved.cwd).toBe(realpathSync(worktree))
    expect(resolved.resolution).toMatchObject({
      source: 'task-worktree',
      canonicalRoot: projectRoot,
      branch: 'drain/T-06369-placement',
    })
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
      const ambient = resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-07138',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        env: {},
      })
      expect(ambient.cwd).toBe(realpathSync(worktree))
      expect(ambient.resolution.source).toBe('task-worktree')

      const deliberate = resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-07138',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        env: { GIT_DIR: poison.gitDir, GIT_WORK_TREE: poison.workTree },
      })
      expect(deliberate.cwd).toBe(projectRoot)
      expect(deliberate.resolution.source).toBe('wrkq-registry')
    } finally {
      if (originalGitDir === undefined) Reflect.deleteProperty(process.env, 'GIT_DIR')
      else process.env['GIT_DIR'] = originalGitDir
      if (originalGitWorkTree === undefined) Reflect.deleteProperty(process.env, 'GIT_WORK_TREE')
      else process.env['GIT_WORK_TREE'] = originalGitWorkTree
    }
  })

  it('keeps explicit placement identical across unrelated, agent-home, and target cwd locations', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const repo = committedRepo(projectRoot)
    const senderLocations = [
      join(root, 'unrelated'),
      join(root, 'agents', 'cody'),
      join(projectRoot, 'packages', 'ui'),
    ]
    for (const location of senderLocations) mkdirSync(location, { recursive: true })

    const absent = senderLocations.map((cwd) =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06371',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        cwd,
        env: repo.env,
      })
    )

    expect(absent[0]).toEqual(absent[1])
    expect(absent[1]).toEqual(absent[2])
    expect(absent[0]?.cwd).toBe(projectRoot)
    expect(absent[0]?.resolution.source).toBe('wrkq-registry')

    const worktree = join(root, 'taskboard-T-06371')
    git(repo, 'worktree', 'add', '-b', 'feature/T-06371-matrix', worktree)
    const present = senderLocations.map((cwd) =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06371',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        cwd,
        env: repo.env,
      })
    )

    expect(present[0]).toEqual(present[1])
    expect(present[1]).toEqual(present[2])
    expect(present[0]?.cwd).toBe(realpathSync(worktree))
    expect(present[0]?.resolution.source).toBe('task-worktree')
  })

  it('preserves caller cwd behavior for project-less placement across the location matrix', () => {
    const root = temporaryRoot()
    const agentRoot = join(root, 'agents', 'cody')
    const senderLocations = [
      join(root, 'unrelated'),
      agentRoot,
      join(root, 'target', 'packages', 'ui'),
    ]
    for (const location of senderLocations) mkdirSync(location, { recursive: true })

    const resolved = senderLocations.map((cwd) =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot,
        projectOrigin: 'inferred',
        cwd,
        env: {},
      })
    )

    expect(resolved.map((placement) => placement.cwd)).toEqual(senderLocations)
    expect(resolved.map((placement) => placement.resolution.source)).toEqual([
      'inferred',
      'inferred',
      'inferred',
    ])
    expect(resolved.map((placement) => placement.resolution.reason)).toEqual([
      'cwd from agent root (project-less scope)',
      'cwd from agent root (project-less scope)',
      'cwd from agent root (project-less scope)',
    ])
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

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(root, 'agents', 'cody'),
      projectId: 'taskboard',
      projectOrigin: 'explicit',
      registryProjects: [{ slug: 'taskboard', root: null }],
      projectSearchRoots: [poisonedSearchRoot, canonicalSearchRoot],
      env: {},
    })

    expect(resolved.projectRoot).toBe(projectRoot)
    expect(resolved.cwd).toBe(projectRoot)
    expect(resolved.resolution.source).toBe('marker-scan')
  })

  it('fails closed when more than one worktree branch carries the exact task token', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '-b', 'drain/T-06369-one', join(root, 'one'))
    git(repo, 'worktree', 'add', '-b', 'wf/T-06369-two', join(root, 'two'))

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06369',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        env: repo.env,
      })
    ).toThrow(/multiple worktrees match T-06369.*one.*two/)
  })

  it('trips on a task-named detached worktree instead of silently selecting canonical', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const detached = join(root, 'taskboard-T-06369-detached')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '--detach', detached)

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06369',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        env: repo.env,
      })
    ).toThrow(
      `worktree at ${realpathSync(detached)} appears associated with T-06369 but is detached HEAD (no branch)`
    )
  })

  it('advisory mode warns and selects canonical for a detached task-named worktree', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const detached = join(root, 'taskboard-T-06369-detached')
    const repo = committedRepo(projectRoot)
    git(repo, 'worktree', 'add', '--detach', detached)

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(root, 'agents', 'cody'),
      projectId: 'taskboard',
      taskId: 'T-06369',
      projectOrigin: 'explicit',
      taskWorktreeAssociation: 'advisory',
      registryProjects: [{ slug: 'taskboard', root: projectRoot }],
      env: repo.env,
    })

    expect(resolved.cwd).toBe(projectRoot)
    expect(resolved.resolution.source).toBe('wrkq-registry')
    expect(resolved.warnings).toEqual([
      `worktree at ${realpathSync(detached)} appears associated with T-06369 but is detached HEAD (no branch); proceeding without task-worktree refinement`,
    ])
  })

  it('leaves inferred placement on the caller cwd walk-up', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    canonicalCheckout(projectRoot)
    const nested = join(projectRoot, 'packages', 'ui')
    mkdirSync(nested, { recursive: true })

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(root, 'agents', 'cody'),
      projectId: 'taskboard',
      projectOrigin: 'inferred',
      cwd: nested,
      env: {},
    })

    expect(resolved.projectRoot).toBe(projectRoot)
    expect(resolved.cwd).toBe(nested)
    expect(resolved.resolution.source).toBe('inferred')
  })

  it('fails closed when an explicit project root override does not exist', () => {
    const root = temporaryRoot()
    const missing = join(root, 'missing')

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        projectOrigin: 'explicit',
        projectRoot: missing,
        registryProjects: [],
        env: {},
      })
    ).toThrow(`explicit project root does not exist or is not a directory: ${missing}`)
  })

  it('rejects a linked-worktree registry root and names the canonical remediation', () => {
    const root = temporaryRoot()
    const linked = join(root, 'linked-taskboard')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), 'gitdir: elsewhere\n')

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: linked }],
        projectSearchRoots: [root],
        env: {},
      })
    ).toThrow(
      `registered root for taskboard ${linked} is a linked worktree; repair it with: wrkq set taskboard --root <canonical>`
    )
  })

  it('fails an unknown explicit project with registration and task-handle remediation', () => {
    const root = temporaryRoot()

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard-T-06370-worktree',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: null }],
        projectSearchRoots: [root],
        env: {},
      })
    ).toThrow(
      'project root unknown for taskboard-T-06370-worktree; register it with: wrkq set taskboard-T-06370-worktree --root <path>; did you mean @taskboard:T-06370'
    )
  })

  it('keeps fixture commits isolated from hostile inherited Git repository variables', () => {
    const root = temporaryRoot()
    const poisonRoot = join(root, 'poison')
    const fixtureRoot = join(root, 'fixture')
    const poison = createFixtureRepo(poisonRoot)
    const fixture = committedRepo(fixtureRoot, {
      ...process.env,
      GIT_DIR: poison.gitDir,
      GIT_WORK_TREE: poison.workTree,
      GIT_INDEX_FILE: join(poison.gitDir, 'index'),
    })

    expect(git(fixture, 'rev-parse', '--absolute-git-dir')).toBe(fixture.gitDir)
    expect(git(fixture, 'rev-parse', '--show-toplevel')).toBe(fixture.workTree)
    expect(git(fixture, 'log', '-1', '--format=%s')).toBe('fixture')
    expect(git(fixture, 'config', '--local', '--list')).not.toContain('user.')
    expect(runGitResult(poison, ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0)
  })

  it('refuses a fixture cwd that resolves inside the real checkout', () => {
    const unsafePath = join(process.cwd(), '.hrc-placement-test-fixture')

    expect(() => createGitFixture(unsafePath)).toThrow(
      /refusing Git fixture cwd .*: it resolves inside existing checkout/
    )
    expect(existsSync(unsafePath)).toBe(false)
  })
})
