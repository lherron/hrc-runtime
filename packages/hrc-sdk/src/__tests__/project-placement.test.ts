import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function committedRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'ignore' })
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'Placement Test')
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(path, 'add', 'README.md')
  git(path, 'commit', '-m', 'fixture')
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
    committedRepo(projectRoot)
    git(projectRoot, 'worktree', 'add', '-b', 'drain/T-06369-placement', worktree)

    const resolved = resolveHrcAgentPlacementPaths({
      agentId: 'cody',
      agentRoot: join(root, 'agents', 'cody'),
      projectId: 'taskboard',
      taskId: 'T-06369',
      projectOrigin: 'explicit',
      registryProjects: [{ slug: 'taskboard', root: projectRoot }],
      env: {},
    })

    expect(resolved.projectRoot).toBe(realpathSync(worktree))
    expect(resolved.cwd).toBe(realpathSync(worktree))
    expect(resolved.resolution).toMatchObject({
      source: 'task-worktree',
      canonicalRoot: projectRoot,
      branch: 'drain/T-06369-placement',
    })
  })

  it('keeps explicit placement identical across unrelated, agent-home, and target cwd locations', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    committedRepo(projectRoot)
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
        env: {},
      })
    )

    expect(absent[0]).toEqual(absent[1])
    expect(absent[1]).toEqual(absent[2])
    expect(absent[0]?.cwd).toBe(projectRoot)
    expect(absent[0]?.resolution.source).toBe('wrkq-registry')

    const worktree = join(root, 'taskboard-T-06371')
    git(projectRoot, 'worktree', 'add', '-b', 'feature/T-06371-matrix', worktree)
    const present = senderLocations.map((cwd) =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06371',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        cwd,
        env: {},
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
    committedRepo(projectRoot)
    git(projectRoot, 'worktree', 'add', '-b', 'drain/T-06369-one', join(root, 'one'))
    git(projectRoot, 'worktree', 'add', '-b', 'wf/T-06369-two', join(root, 'two'))

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06369',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        env: {},
      })
    ).toThrow(/multiple worktrees match T-06369.*one.*two/)
  })

  it('trips on a task-named detached worktree instead of silently selecting canonical', () => {
    const root = temporaryRoot()
    const projectRoot = join(root, 'taskboard')
    const detached = join(root, 'taskboard-T-06369-detached')
    committedRepo(projectRoot)
    git(projectRoot, 'worktree', 'add', '--detach', detached)

    expect(() =>
      resolveHrcAgentPlacementPaths({
        agentId: 'cody',
        agentRoot: join(root, 'agents', 'cody'),
        projectId: 'taskboard',
        taskId: 'T-06369',
        projectOrigin: 'explicit',
        registryProjects: [{ slug: 'taskboard', root: projectRoot }],
        env: {},
      })
    ).toThrow(
      `worktree at ${realpathSync(detached)} appears associated with T-06369 but its branch detached`
    )
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
})
