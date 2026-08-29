import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Resolve a dependency-provided executable by walking up from `startDirectory`
 * and taking the FIRST `node_modules/.bin/<name>` that exists.
 *
 * The daemon and every broker kind must come from one coherent atomic release,
 * and nearest-match preserves that: a release carries its own root node_modules
 * beside packages/hrc-server, so the walk stops immediately and resolves exactly
 * as a hardcoded relative path did.
 *
 * The walk exists because "the root node_modules/.bin occupies the corresponding
 * location" is only true when this repo is installed alone. Under the praesidium
 * dev workspace the three repos install as one workspace and bun hoists binaries
 * to that shared root, leaving no repo-local node_modules/.bin whatsoever — so a
 * fixed `../../../../node_modules/.bin` path names a file that does not exist and
 * fails at spawn time, not at startup.
 *
 * Returns the conventional path when nothing is found, so the caller still fails
 * with a spawn ENOENT naming the expected location rather than a silent success.
 */
export function resolveHoistedBinary(startDirectory: string, name: string): string {
  const conventional = join(startDirectory, 'node_modules', '.bin', name)
  for (let directory = startDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', '.bin', name)
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) return conventional
  }
}
