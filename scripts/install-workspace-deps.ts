#!/usr/bin/env bun
/**
 * `bun install` against whichever root owns this repo's dependencies, then a
 * workspace-doctor sweep.
 *
 * See scripts/lib/workspace-root.ts for why a bare `bun install` is not safe here.
 *
 * The sweep runs HERE rather than in `just install` because this is the only place
 * the repo actually resolves dependencies — `just install` builds and publishes an
 * atomic release and never advances the tree's node_modules. `bun install` writes
 * but never tidies, so a nested copy an earlier resolution wrote outlives the
 * manifest fix that should have retired it (T-07695). Pruning immediately after
 * the install is what keeps a corrected manifest and the tree on disk agreeing.
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { resolveInstallRoot } from './lib/workspace-root'

const repoRoot = resolve(import.meta.dir, '..')
const installRoot = resolveInstallRoot(repoRoot)
if (installRoot !== repoRoot) {
  console.log(`[install] praesidium dev workspace detected; installing at ${installRoot}`)
}
const install = spawnSync('bun', ['install'], { cwd: installRoot, stdio: 'inherit' })
if (install.status !== 0) {
  process.exit(install.status ?? 1)
}

const doctor = spawnSync('bun', [join(repoRoot, 'scripts', 'workspace-doctor.ts')], {
  cwd: repoRoot,
  stdio: 'inherit',
})
process.exit(doctor.status ?? 1)
