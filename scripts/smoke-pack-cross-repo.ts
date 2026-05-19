// WHY: Verify that prepack + postpack on the 17 cross-repo boundary packages
// actually produce tarballs with no `bun` export condition. `bun pm pack` does
// not auto-invoke prepack/postpack lifecycle hooks for private workspace
// packages, so this script explicitly runs `bun run prepack` (strips bun keys),
// then `bun pm pack --ignore-scripts` (no double-execution), untars the
// resulting tarball, asserts no `bun` condition remains under any exports
// entry, then runs `bun run postpack` (git-restores the committed manifest).
// Cleans up tarball + extraction dir each pass. Exit 0 = all pass.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

const PACKAGES = [
  'packages/agent-scope',
  'packages/cli-kit',
  'packages/config',
  'packages/runtime',
  'packages/execution',
  'packages/harness-claude',
  'packages/harness-codex',
  'packages/harness-pi',
  'packages/harness-pi-sdk',
  'packages/agent-spaces',
  'packages/agent-action-render',
  'packages/hrc-core',
  'packages/hrc-sdk',
  'packages/hrc-frame-render',
  'packages/hrc-server',
  'packages/hrc-events',
  'packages/hrc-store-sqlite',
] as const

type CheckOutcome =
  | { pkg: string; status: 'pass' }
  | { pkg: string; status: 'fail'; reason: string }

function findBunCondition(exportsField: unknown): string[] {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return []
  const offenders: string[] = []
  for (const [key, v] of Object.entries(exportsField as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      'bun' in (v as Record<string, unknown>)
    ) {
      offenders.push(key)
    }
  }
  return offenders
}

function run(cmd: string, args: string[], cwd: string): { status: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return { status: r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` }
}

async function checkPackage(rel: string): Promise<CheckOutcome> {
  const pkgDir = join(ROOT, rel)
  const tmp = await mkdtemp(join(tmpdir(), 'asp-pack-'))
  // Track whether we mutated package.json so finally can always restore.
  let prepackRan = false
  try {
    const prepack = run('bun', ['run', 'prepack'], pkgDir)
    if (prepack.status !== 0) {
      return {
        pkg: rel,
        status: 'fail',
        reason: `prepack exited ${prepack.status}: ${prepack.out}`,
      }
    }
    prepackRan = true
    const pack = run('bun', ['pm', 'pack', '--destination', tmp, '--ignore-scripts'], pkgDir)
    if (pack.status !== 0) {
      return { pkg: rel, status: 'fail', reason: `bun pm pack exited ${pack.status}: ${pack.out}` }
    }
    const entries = await readdir(tmp)
    const tarball = entries.find((e) => e.endsWith('.tgz'))
    if (!tarball) {
      return {
        pkg: rel,
        status: 'fail',
        reason: `no tarball produced in ${tmp} (entries: ${entries.join(',')})`,
      }
    }
    const tarballPath = join(tmp, tarball)
    const extractDir = join(tmp, 'extract')
    const mk = run('mkdir', ['-p', extractDir], ROOT)
    if (mk.status !== 0) return { pkg: rel, status: 'fail', reason: 'mkdir extract failed' }
    const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir], ROOT)
    if (tar.status !== 0) return { pkg: rel, status: 'fail', reason: `tar -xzf failed: ${tar.out}` }
    // npm tarballs unpack into a top-level `package/` directory.
    const stagedPkg = JSON.parse(
      await readFile(join(extractDir, 'package', 'package.json'), 'utf8')
    )
    const offenders = findBunCondition(stagedPkg.exports)
    if (offenders.length > 0) {
      return {
        pkg: rel,
        status: 'fail',
        reason: `tarball package.json retains exports[*].bun for: ${offenders.join(', ')}`,
      }
    }
    return { pkg: rel, status: 'pass' }
  } finally {
    if (prepackRan) {
      // Always restore the committed manifest, even on failure.
      const postpack = run('bun', ['run', 'postpack'], pkgDir)
      if (postpack.status !== 0) {
        console.error(`WARN  postpack on ${rel} exited ${postpack.status}: ${postpack.out}`)
      }
    }
    await rm(tmp, { recursive: true, force: true })
  }
}

async function main() {
  let failed = false
  for (const rel of PACKAGES) {
    const outcome = await checkPackage(rel)
    if (outcome.status === 'pass') {
      console.log(`PASS  ${rel}`)
    } else {
      console.log(`FAIL  ${rel}  ${outcome.reason}`)
      failed = true
      break
    }
  }
  process.exit(failed ? 1 : 0)
}

await main()
