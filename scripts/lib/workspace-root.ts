import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Resolve the directory whose `bun install` owns this repo's dependencies.
 *
 * This repo is its own workspace root, so a bare `bun install` here always
 * succeeds — and under the praesidium dev workspace that is exactly the problem:
 * it repopulates a repo-local node_modules with REGISTRY copies of agent-spaces
 * packages, which then shadow the source symlinks the parent workspace created.
 * Node resolution walks up from the importer, so the nearer copy wins and the
 * whole dev workspace silently reverts to registry resolution. The pre-push hook
 * runs `bun install`, so without this the link would not survive a single push.
 *
 * Returns the parent workspace root when one claims this repo, else `repoRoot`.
 */
export function resolveInstallRoot(repoRoot: string): string {
  const repoName = basename(repoRoot)
  for (let directory = dirname(repoRoot); ; directory = dirname(directory)) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { workspaces?: string[] }
        const claimsThisRepo = (manifest.workspaces ?? []).some((glob) =>
          glob.startsWith(`${repoName}/`)
        )
        // A parent that CLAIMS this repo but has not been installed owns nothing:
        // its node_modules is where the packages are not. Declaring it the install
        // root would point every installed-version probe at an empty directory and
        // report the whole dependency set missing. Require the install to exist.
        if (claimsThisRepo && existsSync(join(directory, 'node_modules'))) return directory
      } catch {
        // An unparseable parent manifest is not ours to interpret; keep walking.
      }
    }
    if (dirname(directory) === directory) return repoRoot
  }
}
