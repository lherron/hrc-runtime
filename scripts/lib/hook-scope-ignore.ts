/**
 * Which changed paths cannot change what code validation proves.
 *
 * The hooks used to carry this judgement as a hardcoded extension set, so a
 * change confined to `architecture/` — a `.yaml` invariant record and its
 * generated `.jsonl` projection — read as code and bought the full pre-push
 * suite. The suite graded nothing in that diff: `test:fast` never loads an
 * architecture record, and Biome parses neither `.yaml` nor `.jsonl`. The list
 * moved into a tracked `.hookignore` so the allowance is reviewable in a diff
 * instead of buried in a classifier.
 *
 * FAIL CLOSED. A path no rule matches is code. A missing, unreadable or empty
 * `.hookignore` yields zero rules, which makes every path code and every hook
 * run — slower, never weaker.
 *
 * Deliberately NOT shared with `scripts/lib/install-source-scope.ts`. That
 * classifier answers a different question — whether a dirty path could change
 * what an install builds — and the two lists agreeing today is not a reason to
 * couple them.
 *
 * Supported syntax, a subset of gitignore:
 *
 *   `# comment`        a full-line comment; blank lines are skipped
 *   `docs/`            trailing `/` matches a directory's contents at any depth
 *   `*.md`             no `/` matches the basename at any depth
 *   `/root-only.txt`   leading `/` anchors at the repository root
 *   `architecture/**`  an embedded `/` anchors at the repository root
 *   `!keep.md`         re-includes a path, forcing validation; last match wins
 *
 * Two deliberate departures from gitignore. Matching is CASE-INSENSITIVE,
 * because the hooks run on a case-insensitive filesystem and a `README.MARKDOWN`
 * is prose whatever its shell casing. And trailing whitespace is always
 * stripped: gitignore's `\ ` escape for a filename ending in a space is not
 * supported, nor is `\#` or `\!` for a literal leading character.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const HOOK_SCOPE_IGNORE_FILE = '.hookignore'

interface Rule {
  negated: boolean
  globs: Bun.Glob[]
}

export interface HookScopeIgnore {
  /** Rules parsed from the list. Zero means every path counts as code. */
  readonly ruleCount: number
  /**
   * True when the path cannot change what code validation proves.
   * Repository-root-relative POSIX paths, exactly as git reports them.
   */
  ignores(path: string): boolean
}

/**
 * Expand one gitignore-shaped pattern into the globs that cover it. A pattern
 * without a trailing `/` names a file OR a directory, so it gets both its own
 * glob and a `/**` glob for anything beneath it.
 */
function globsFor(pattern: string, directoryOnly: boolean): Bun.Glob[] {
  let body = pattern
  let anchored = false
  if (body.startsWith('/')) {
    body = body.slice(1)
    anchored = true
  } else {
    anchored = body.includes('/')
  }
  if (body === '') return []
  const base = anchored ? body : `**/${body}`
  const patterns = directoryOnly ? [`${base}/**`] : [base, `${base}/**`]
  return patterns.map((candidate) => new Bun.Glob(candidate))
}

export function parseHookScopeIgnore(text: string): HookScopeIgnore {
  const rules: Rule[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trimEnd()
    if (line === '' || line.startsWith('#')) continue

    const negated = line.startsWith('!')
    // Lowercase here rather than at each match: the patterns are parsed once
    // and the paths are the hot side of the comparison.
    let pattern = (negated ? line.slice(1) : line).trim().toLowerCase()
    if (pattern === '') continue

    const directoryOnly = pattern.endsWith('/')
    if (directoryOnly) pattern = pattern.replace(/\/+$/, '')

    const globs = globsFor(pattern, directoryOnly)
    if (globs.length > 0) rules.push({ negated, globs })
  }

  return {
    ruleCount: rules.length,
    ignores(path: string): boolean {
      if (path === '') return false
      const candidate = path.toLowerCase()
      let ignored = false
      // Last match wins, so a `!` rule can re-include a path an earlier rule
      // covered — and a later broad rule can cover it again.
      for (const rule of rules) {
        if (rule.globs.some((glob) => glob.match(candidate))) ignored = !rule.negated
      }
      return ignored
    },
  }
}

/**
 * Read the list from `root`. Any failure — no file, no permission, not a
 * checkout — yields an empty ruleset, which is the fail-closed answer.
 */
export function loadHookScopeIgnore(root: string): HookScopeIgnore {
  try {
    return parseHookScopeIgnore(readFileSync(join(root, HOOK_SCOPE_IGNORE_FILE), 'utf8'))
  } catch {
    return parseHookScopeIgnore('')
  }
}

/**
 * The worktree root, so the list is found when a hook runs from a subdirectory.
 * Falls back to the working directory, whose missing file fails closed.
 */
export function worktreeRoot(cwd: string = process.cwd()): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return cwd
  const root = result.stdout.toString().trim()
  return root === '' ? cwd : root
}
