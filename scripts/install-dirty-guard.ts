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
import { realpathSync } from 'node:fs'

import { environmentWithoutGitOverrides } from 'hrc-core'

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

// An ambient GIT_DIR/GIT_WORK_TREE (a git hook's environment, say) outranks cwd,
// and would silently report some other repository's state as this one's.
function git(
  sourceRoot: string,
  args: string[]
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: environmentWithoutGitOverrides(),
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function readDirtyTrackedPaths(sourceRoot: string): string[] {
  const result = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=no'])
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`)
  }
  return dirtyTrackedPaths(result.stdout)
}

/**
 * A main checkout SHARES `.git/config` with every linked worktree, so a bad
 * `core.bare` or `core.worktree` there takes git down for every seat in the
 * repository at once, with nothing but
 * `fatal: this operation must be run in a work tree` to go on.
 *
 * That is not hypothetical: three shared checkouts went down that way in one
 * afternoon (T-07635). The writer is a `git init` that inherited an ambient
 * GIT_DIR from a git hook — GIT_DIR outranks cwd and the directory argument
 * both, so the init lands on the hook's repository and exits 0. Every git
 * command that means one specific repository now runs with
 * `environmentWithoutGitOverrides()`; this guard is the backstop that names the
 * damage if some other tool writes it again.
 */
export type GitConfigOverrides = {
  bare: string | undefined
  worktree: string | undefined
  configPath: string
}

export function readGitConfigOverrides(sourceRoot: string): GitConfigOverrides {
  const read = (key: string): string | undefined => {
    const result = git(sourceRoot, ['config', '--get', key])
    return result.status === 0 ? result.stdout.trim() : undefined
  }
  const commonDir = git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return {
    bare: read('core.bare'),
    worktree: read('core.worktree'),
    configPath:
      commonDir.status === 0 && commonDir.stdout.trim()
        ? `${commonDir.stdout.trim()}/config`
        : `${sourceRoot}/.git/config`,
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The message to refuse with, or undefined when the config is sound. Pure over
 * its inputs so the refusal text is testable without a poisoned repository.
 */
export function gitConfigPoisonMessage(
  overrides: GitConfigOverrides,
  sourceRoot: string
): string | undefined {
  const gitDirFlag = `git --git-dir='${overrides.configPath.replace(/\/config$/, '')}'`
  if (overrides.bare === 'true') {
    return poisonMessage(
      'core.bare = true',
      overrides.configPath,
      `${gitDirFlag} config --unset core.bare`
    )
  }
  // core.worktree is unset in a normal checkout. Set to anything but this
  // checkout's own root, it redirects every seat to a directory that is usually
  // gone by the time anyone notices.
  if (overrides.worktree && realpathOrSelf(overrides.worktree) !== realpathOrSelf(sourceRoot)) {
    return poisonMessage(
      `core.worktree = ${overrides.worktree}`,
      overrides.configPath,
      `${gitDirFlag} config --unset core.worktree`
    )
  }
  return undefined
}

function poisonMessage(setting: string, configPath: string, fix: string): string {
  return [
    "[install] refusing to install: this repository's git config is poisoned.",
    `[install]   ${setting}`,
    `[install]   in ${configPath}`,
    '[install] A main checkout shares that file with every linked worktree, so git is',
    '[install] broken for every seat in this repository ("fatal: this operation must be',
    '[install] run in a work tree").',
    '[install] Cause: a `git init` that inherited an ambient GIT_DIR — a git hook exports',
    '[install] one — re-initialized this repository instead of its own directory (T-07635).',
    `[install] Fix: ${fix}`,
  ].join('\n')
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
  // Before the dirty check, which would otherwise fail on a poisoned config with
  // git's bare "must be run in a work tree" and no idea what to do about it.
  // Not gated on allow-dirty: this is corruption, not uncommitted work.
  const poisoned = gitConfigPoisonMessage(
    readGitConfigOverrides(options.sourceRoot),
    options.sourceRoot
  )
  if (poisoned) {
    console.error(poisoned)
    process.exit(1)
  }
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
