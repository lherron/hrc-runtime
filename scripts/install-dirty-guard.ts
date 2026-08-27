/**
 * `just install` builds and publishes whatever is on disk, not what is committed.
 * An install from a dirty worktree therefore ships work nobody has reviewed and
 * cannot be traced back to a commit. This guard refuses that install before any
 * build step runs, unless the caller asks for it with allow-dirty=1.
 *
 * Untracked files are ignored: the install never packs them, and scratch files
 * in a checkout are normal. Only tracked modifications (worktree or index) count.
 *
 * No exclusion list is needed. The install's own generated output is untracked
 * or ignored (`dist/`, `node_modules/`, `asp_modules/`, `asp-lock.json`), it
 * installs with `bun install --frozen-lockfile` so `bun.lock` is never advanced,
 * and the publish step's rewrite of each package.json is restored in a `finally`
 * before the recipe returns. A package.json left modified is a failed publish,
 * which is exactly what the guard should refuse.
 */
import { spawnSync } from 'node:child_process'

import { parseInstallOptions } from './install-options'

/**
 * Paths with tracked modifications, from `git status --porcelain=v1 -uno` output.
 * Rename entries report the destination path; untracked and ignored entries are
 * dropped defensively even though `-uno` already excludes them.
 */
export function dirtyTrackedPaths(porcelain: string): string[] {
  const paths: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    if (code === '??' || code === '!!') continue
    const entry = line.slice(3)
    const arrow = entry.indexOf(' -> ')
    paths.push(arrow === -1 ? entry : entry.slice(arrow + 4))
  }
  return paths
}

export function refusalMessage(paths: string[]): string {
  return [
    `[install] refusing to install from a dirty worktree (${paths.length} tracked ${
      paths.length === 1 ? 'path' : 'paths'
    } modified):`,
    ...paths.map((path) => `  ${path}`),
    '[install] commit or stash these first, or re-run with: just install allow-dirty=1',
  ].join('\n')
}

const AMBIENT_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']

export function readDirtyTrackedPaths(sourceRoot: string): string[] {
  // An ambient GIT_DIR/GIT_WORK_TREE (a git hook's environment, say) outranks cwd,
  // and would silently report some other repository's status as this one's.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !AMBIENT_GIT_ENV.includes(key))
  )
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env,
  })
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`)
  }
  return dirtyTrackedPaths(result.stdout)
}

function parseCli(argv: string[]): { allowDirty: boolean; sourceRoot: string } {
  let sourceRoot = process.cwd()
  const tokens: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--source-root=')) sourceRoot = arg.slice('--source-root='.length)
    else tokens.push(arg)
  }
  // The other install options belong to the policy step; parsing them here only
  // rejects a typo in the same breath as the guard rather than one step later.
  return { allowDirty: parseInstallOptions(tokens).allowDirty, sourceRoot }
}

if (import.meta.main) {
  const options = parseCli(process.argv.slice(2))
  const paths = readDirtyTrackedPaths(options.sourceRoot)
  if (paths.length === 0) {
    console.log('[install] dirty-tree guard: clean tracked worktree')
  } else if (options.allowDirty) {
    console.log(
      `[install] dirty-tree guard bypassed by allow-dirty=1; installing ${paths.length} uncommitted tracked change(s)`
    )
  } else {
    console.error(refusalMessage(paths))
    process.exit(1)
  }
}
