import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * The highest directory whose `node_modules` may legitimately serve
 * `startDirectory`: the workspace root that CLAIMS it, or `startDirectory` itself.
 *
 * A foreign workspace root — one with `workspaces` globs that do not name this
 * directory — is a hard boundary. Without it the search runs to `/` and a linked
 * worktree under ~/praesidium/under-construction, whose own node_modules lacks a
 * broker binary, silently binds the SHARED checkout's instead. That is
 * cross-contamination between two checkouts with no signal, and it is strictly
 * worse than the ENOENT it replaces: a missing binary is loud and local, whereas
 * running another worktree's harness looks like it worked.
 */
function highestServingRoot(startDirectory: string): string {
  const name = basename(startDirectory)
  for (let directory = dirname(startDirectory); ; directory = dirname(directory)) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          workspaces?: string[]
        }
        const globs = manifest.workspaces ?? []
        if (globs.some((glob) => glob.startsWith(`${name}/`))) return directory
        // A workspace root that does not claim us owns a different tree.
        if (globs.length > 0) return startDirectory
      } catch {
        // An unparseable manifest is not ours to interpret; keep walking.
      }
    }
    if (dirname(directory) === directory) return startDirectory
  }
}

/**
 * Resolve a dependency-provided executable, searching `startDirectory` first and
 * then upward only as far as the workspace root that claims it.
 *
 * Nearest match wins, so an atomic release — which carries its own root
 * node_modules beside packages/hrc-server — stops immediately and resolves exactly
 * as a hardcoded relative path did. The search exists because "the root
 * node_modules/.bin occupies the corresponding location" holds only when this repo
 * is installed alone: under the praesidium dev workspace bun hoists binaries to
 * the shared root and leaves no repo-local node_modules/.bin at all.
 *
 * Returns the conventional repo-local path when nothing is found, so the caller
 * still fails with a spawn ENOENT naming the expected location.
 */
export function resolveHoistedBinary(startDirectory: string, name: string): string {
  const conventional = join(startDirectory, 'node_modules', '.bin', name)
  const boundary = highestServingRoot(startDirectory)
  for (let directory = startDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', '.bin', name)
    if (existsSync(candidate)) {
      // Opt-in only. Resolving at the claiming workspace root is the ORDINARY
      // path under the praesidium dev workspace, so logging it unconditionally is
      // noise on the expected case — and this runs at module load, where writing
      // to stderr breaks callers that assert a clean stream. The boundary in
      // highestServingRoot already makes the genuinely surprising case (borrowing
      // another checkout's binary) impossible, so this is a debugging aid, not a
      // safety net.
      if (directory !== startDirectory && process.env['HRC_DEBUG_BINARY_RESOLUTION'] === '1') {
        process.stderr.write(
          `hrc: resolved ${name} from workspace root ${directory} (not ${startDirectory})\n`
        )
      }
      return candidate
    }
    if (directory === boundary || dirname(directory) === directory) return conventional
  }
}
