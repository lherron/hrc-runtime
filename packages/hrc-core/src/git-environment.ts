/**
 * Git's `GIT_*` environment variables outrank every argument that names a
 * repository. An ambient `GIT_DIR` beats `cwd`, beats `-C <dir>`, and beats
 * even the directory argument to `git init` — `git init -q /tmp/fixture` with
 * `GIT_DIR` exported silently re-initializes the repository `GIT_DIR` names and
 * never touches `/tmp/fixture` at all, while still exiting 0.
 *
 * Anything spawned from a git hook inherits exactly that: git exports an
 * absolute `GIT_DIR` to hooks run in a linked worktree, so a pre-push gate's
 * whole process tree is pointed at the shared checkout no matter what each
 * child was told to operate on.
 *
 * T-07635 is what that costs. A fixture `git init` in the hrc-cli suite,
 * spawned with an inherited environment from the pre-push hook of a worktree
 * under `under-construction/`, re-initialized the real hrc-runtime checkout and
 * wrote `core.bare = true` into `.git/config` — the config a main checkout
 * SHARES with every linked worktree. Every git command in every seat then
 * failed with `fatal: this operation must be run in a work tree`. Three repos
 * went down that way in one afternoon.
 *
 * Any git spawn that means one SPECIFIC repository — one it identified by cwd,
 * by `-C`, or by an argument — must run with this environment. Only a command
 * that deliberately means "whatever repository the hook is acting on" may
 * inherit the ambient one.
 */
export function environmentWithoutGitOverrides(
  inheritedEnvironment: Record<string, string | undefined> = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')
    )
  )
}
