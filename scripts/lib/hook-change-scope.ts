/**
 * What a pre-commit or pre-push hook run is about to validate.
 *
 * Used by the code-validation gate (`run-if-code-changed.ts`), which also
 * records its classification for the run, so the `change_kind` a
 * `hook.settled` fact reports is the judgement the gate made when it chose to
 * run or skip.
 */

import { loadHookScopeIgnore, worktreeRoot } from './hook-scope-ignore.ts'

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type HookName = 'pre-commit' | 'pre-push'

export interface ChangeScope {
  paths: string[]
  deletionOnlyPush: boolean
  ambiguous: boolean
}

function git(args: string[], stdin?: string): Uint8Array {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: process.cwd(),
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

function nulDelimitedPaths(output: Uint8Array): string[] {
  return Buffer.from(output).toString('utf8').split('\0').filter(Boolean)
}

function commitsForUpdate(localOid: string, remoteOid: string): string[] {
  const args = ['rev-list', localOid, '--not']
  if (isZeroOid(remoteOid)) {
    args.push('--remotes')
  } else {
    args.push(remoteOid)
  }
  return Buffer.from(git(args)).toString('utf8').trim().split('\n').filter(Boolean)
}

function pathsForCommits(commits: string[]): string[] {
  if (commits.length === 0) return []
  return nulDelimitedPaths(
    git(
      [
        'diff-tree',
        '--stdin',
        '--root',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACMRD',
        '-m',
        '-r',
        '-z',
      ],
      `${commits.join('\n')}\n`
    )
  )
}

function preCommitScope(): ChangeScope {
  return {
    paths: nulDelimitedPaths(
      git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRD', '-z'])
    ),
    deletionOnlyPush: false,
    ambiguous: false,
  }
}

function validOid(value: string): boolean {
  return oidPattern.test(value)
}

function isZeroOid(value: string): boolean {
  return validOid(value) && /^0+$/.test(value)
}

function prePushScope(input: string): ChangeScope {
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { paths: [], deletionOnlyPush: false, ambiguous: true }

  const paths = new Set<string>()
  let sawUpdate = false
  let sawNonDeletion = false

  for (const line of lines) {
    const fields = line.split(/\s+/)
    if (fields.length !== 4) return { paths: [], deletionOnlyPush: false, ambiguous: true }
    const [localRef, localOid, remoteRef, remoteOid] = fields as [string, string, string, string]
    if (!validOid(localOid) || !validOid(remoteOid) || !remoteRef.startsWith('refs/')) {
      return { paths: [], deletionOnlyPush: false, ambiguous: true }
    }

    sawUpdate = true
    if (localRef === '(delete)' && isZeroOid(localOid) && !isZeroOid(remoteOid)) continue
    if (!localRef.startsWith('refs/') || isZeroOid(localOid)) {
      return { paths: [], deletionOnlyPush: false, ambiguous: true }
    }

    sawNonDeletion = true
    for (const path of pathsForCommits(commitsForUpdate(localOid, remoteOid))) paths.add(path)
  }

  return {
    paths: [...paths],
    deletionOnlyPush: sawUpdate && !sawNonDeletion,
    ambiguous: !sawUpdate,
  }
}

export function changeScope(hook: HookName, prePushInput = ''): ChangeScope {
  try {
    return hook === 'pre-commit' ? preCommitScope() : prePushScope(prePushInput)
  } catch (error) {
    console.error(`[hook-scope] unable to inspect changes; running validation: ${error}`)
    return { paths: [], deletionOnlyPush: false, ambiguous: true }
  }
}

export type ChangeKind = 'code' | 'documentation' | 'deletion_only' | 'none' | 'ambiguous'

/**
 * `documentation` means every path is covered by `.hookignore`, so the code
 * suites were skipped; `none` is an empty change set.
 */
export function classifyChange(
  scope: ChangeScope,
  root: string = worktreeRoot()
): { kind: ChangeKind; fileCount: number } {
  const fileCount = scope.paths.length
  if (scope.ambiguous) return { kind: 'ambiguous', fileCount }
  if (scope.deletionOnlyPush) return { kind: 'deletion_only', fileCount }
  if (fileCount === 0) return { kind: 'none', fileCount }
  const ignore = loadHookScopeIgnore(root)
  return {
    kind: scope.paths.every((path) => ignore.ignores(path)) ? 'documentation' : 'code',
    fileCount,
  }
}
