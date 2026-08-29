#!/usr/bin/env bun
/**
 * `bun install` against whichever root owns this repo's dependencies.
 * See scripts/lib/workspace-root.ts for why a bare `bun install` is not safe here.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { resolveInstallRoot } from './lib/workspace-root'

const repoRoot = resolve(import.meta.dir, '..')
const installRoot = resolveInstallRoot(repoRoot)
if (installRoot !== repoRoot) {
  console.log(`[install] praesidium dev workspace detected; installing at ${installRoot}`)
}
const result = spawnSync('bun', ['install'], { cwd: installRoot, stdio: 'inherit' })
process.exit(result.status ?? 1)
