/**
 * Which dirty paths an install is allowed to refuse over.
 *
 * Both install gates — the dirty-worktree guard and the canonical publication
 * proof — used to refuse over ANY dirty path. That is broader than the thing
 * they exist to prevent. The proposition an install has to defend is "the bytes
 * being built and published are the bytes someone committed", and a modified
 * `docs/operations-runbook.md` or a half-written architecture record cannot
 * falsify it: no build step reads them, no package packs them, and no installed
 * command changes when they do. The refusal they produced was pure friction —
 * an operator with an open doc edit either stashed unrelated work or reached for
 * `allow-dirty=1`, which switches the guard off for the source files too.
 *
 * So the gates cut on SOURCE, not on dirt. A dirty path gates an install when it
 * could change what the install builds, publishes, or installs.
 *
 * Fail closed. The classifier names what is known to be inert and calls
 * everything else source, so a new top-level directory gates installs until
 * someone decides otherwise rather than slipping through unexamined.
 *
 * This is deliberately NOT shared with `scripts/run-if-code-changed.ts`, which
 * looks similar but answers a different question — whether a change needs code
 * VALIDATION — and whose skip set is scoped to the hooks it guards. Widening one
 * is not evidence for widening the other.
 */

/**
 * Directories whose entire contents are prose or durable records ABOUT the
 * system rather than inputs to it. `architecture/` holds the invariant/risk
 * records and their generated `index.jsonl` projection; `just verify` grades
 * those, and `just install` never reads them.
 */
const DOCUMENTATION_DIRECTORIES: readonly string[] = ['docs', 'architecture']

/**
 * Extensions that are prose wherever they sit, including beside the code they
 * describe (`packages/hrc-server/src/wrkq/session-project-events.md`). No
 * tracked file with one of these extensions is loaded at runtime or packed into
 * a published package; if that ever changes, the file stops being documentation
 * and this set stops covering it.
 */
const DOCUMENTATION_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.html', '.htm', '.txt']

function hasDocumentationExtension(path: string): boolean {
  const slash = path.lastIndexOf('/')
  const basename = slash === -1 ? path : path.slice(slash + 1)
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return false
  return DOCUMENTATION_EXTENSIONS.includes(basename.slice(dot).toLowerCase())
}

function isWithinDocumentationDirectory(path: string): boolean {
  return DOCUMENTATION_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`))
}

/**
 * True when a dirty path could change what an install builds, publishes, or
 * installs. Repository-root-relative POSIX paths, exactly as git reports them.
 */
export function isInstallSourcePath(path: string): boolean {
  if (path === '') return false
  return !isWithinDocumentationDirectory(path) && !hasDocumentationExtension(path)
}

export type InstallScopePartition = {
  /** Paths that gate the install. */
  source: string[]
  /** Paths reported for context but not refused over. */
  documentation: string[]
}

export function partitionInstallScope(paths: readonly string[]): InstallScopePartition {
  const source: string[] = []
  const documentation: string[] = []
  for (const path of paths) {
    if (isInstallSourcePath(path)) source.push(path)
    else documentation.push(path)
  }
  return { source, documentation }
}

/**
 * One line naming the documentation paths a gate declined to refuse over, or
 * undefined when there are none. A gate that passes silently over dirt teaches
 * the operator nothing about what it looked at.
 */
export function documentationNoticeLine(
  prefix: string,
  documentation: string[]
): string | undefined {
  if (documentation.length === 0) return undefined
  const shown = documentation.slice(0, 5).join(', ')
  const rest = documentation.length - 5
  return `${prefix} ignoring ${documentation.length} dirty documentation path(s): ${shown}${
    rest > 0 ? `, +${rest} more` : ''
  }`
}

/**
 * Paths from `git status --porcelain=v1` output. Rename entries report the
 * destination path; ignored entries are always dropped, and untracked entries
 * are dropped unless the caller asked for them (a `--untracked-files=no` status
 * has none to begin with).
 */
export function parsePorcelainPaths(
  porcelain: string,
  options: { includeUntracked?: boolean } = {}
): string[] {
  const paths: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    if (code === '!!') continue
    if (code === '??' && options.includeUntracked !== true) continue
    const entry = line.slice(3)
    const arrow = entry.indexOf(' -> ')
    paths.push(arrow === -1 ? entry : entry.slice(arrow + 4))
  }
  return paths
}
