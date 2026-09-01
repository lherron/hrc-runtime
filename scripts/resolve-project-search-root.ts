import { spawnSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'

export function environmentWithoutGitOverrides(
  env: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => !entry[0].startsWith('GIT_') && entry[1] !== undefined
    )
  )
}

/**
 * Git's common directory belongs to the canonical checkout even when the
 * caller is a linked worktree. HRC project discovery wants the directory that
 * contains that canonical checkout, not the linked worktree's path-shaped
 * parent (for example, under-construction/).
 */
export function projectSearchRootFromCommonGitDir(commonGitDir: string): string {
  const absoluteCommonDir = resolve(commonGitDir)
  if (basename(absoluteCommonDir) !== '.git') {
    throw new Error(`expected Git common directory to end in .git: ${absoluteCommonDir}`)
  }
  return dirname(dirname(absoluteCommonDir))
}

export function resolveProjectSearchRoot(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env
): string {
  const result = spawnSync(
    'git',
    ['-C', resolve(repoRoot), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      encoding: 'utf8',
      env: environmentWithoutGitOverrides(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim() || `git exited ${result.status ?? 'without status'}`
    throw new Error(`cannot resolve canonical project search root: ${diagnostic}`)
  }
  return projectSearchRootFromCommonGitDir(result.stdout.trim())
}

if (import.meta.main) {
  const repoRoot = process.argv[2]
  if (!repoRoot) {
    console.error('usage: bun scripts/resolve-project-search-root.ts <repo-root>')
    process.exit(2)
  }
  console.log(resolveProjectSearchRoot(repoRoot))
}
