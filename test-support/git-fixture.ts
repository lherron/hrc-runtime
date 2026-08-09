import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type GitFixture = {
  workTree?: string
  gitDir: string
  env: Record<string, string>
}

type GitFixtureOptions = {
  bare?: boolean
  initialBranch?: string
  inheritedEnvironment?: Record<string, string | undefined>
  identity?: {
    name: string
    email: string
  }
}

const DEFAULT_IDENTITY = {
  name: 'HRC Git Fixture',
  email: 'hrc-git-fixture@example.test',
}

export function environmentWithoutGitOverrides(
  inheritedEnvironment: Record<string, string | undefined> = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')
    )
  )
}

function assertOutsideExistingCheckout(path: string): void {
  let existingAncestor = resolve(path)
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }

  let cursor = realpathSync(existingAncestor)
  for (;;) {
    if (existsSync(join(cursor, '.git'))) {
      throw new Error(
        `refusing Git fixture cwd ${path}: it resolves inside existing checkout ${cursor}`
      )
    }
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

export function createGitFixture(path: string, options: GitFixtureOptions = {}): GitFixture {
  assertOutsideExistingCheckout(path)
  mkdirSync(path, { recursive: true })

  const bare = options.bare ?? false
  const canonicalPath = realpathSync(path)
  const workTree = bare ? undefined : canonicalPath
  const gitDir = bare ? canonicalPath : join(canonicalPath, '.git')
  const identity = options.identity ?? DEFAULT_IDENTITY
  const env = {
    ...environmentWithoutGitOverrides(options.inheritedEnvironment),
    GIT_DIR: gitDir,
    ...(workTree ? { GIT_WORK_TREE: workTree } : {}),
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(gitDir, 'global-config'),
    GIT_TERMINAL_PROMPT: '0',
  }
  const fixture: GitFixture = { ...(workTree ? { workTree } : {}), gitDir, env }
  const initArgs = [
    'init',
    ...(bare ? ['--bare'] : []),
    ...(options.initialBranch ? [`--initial-branch=${options.initialBranch}`] : []),
  ]
  execFileSync('git', initArgs, {
    cwd: workTree ?? dirname(gitDir),
    env,
    stdio: 'ignore',
  })
  return fixture
}

export function runGit(fixture: GitFixture, args: string[]): string {
  return execFileSync('git', args, {
    cwd: fixture.workTree ?? dirname(fixture.gitDir),
    encoding: 'utf8',
    env: fixture.env,
  }).trim()
}

export function runGitAt(fixture: GitFixture, cwd: string, args: string[]): string {
  if (!fixture.workTree) throw new Error('bare Git fixture has no work tree')
  const workTree = realpathSync(cwd)
  if (workTree === fixture.workTree) return runGit(fixture, args)

  const marker = readFileSync(join(workTree, '.git'), 'utf8').trim()
  const match = /^gitdir:\s*(.+)$/.exec(marker)
  if (!match?.[1]) throw new Error(`linked Git fixture at ${cwd} has no gitdir marker`)
  const gitDir = resolve(workTree, match[1])
  const rel = relative(fixture.gitDir, gitDir)
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`linked Git fixture at ${cwd} escapes fixture git dir ${fixture.gitDir}`)
  }
  return runGit(
    {
      workTree,
      gitDir,
      env: { ...fixture.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree },
    },
    args
  )
}

export function runGitResult(fixture: GitFixture, args: string[]) {
  return spawnSync('git', args, {
    cwd: fixture.workTree ?? dirname(fixture.gitDir),
    encoding: 'utf8',
    env: fixture.env,
  })
}
