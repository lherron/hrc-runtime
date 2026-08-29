#!/usr/bin/env bun
/**
 * Lock-hygiene gate (T-07412): a tracked `bun.lock` may only name the canonical
 * registry host.
 *
 * `bun install` records the tarball URL it actually fetched, so a sync run on a
 * host that reaches Verdaccio under a different name bakes that name into
 * shared history. On 2026-08-21 hrc-runtime's origin/main lock carried 26
 * `http://127.0.0.1:4873/` URLs beside 311 `http://mini:4873/` ones; on every
 * node but the Verdaccio host `bun install` died with ConnectionRefused and the
 * repo was uninstallable.
 *
 * The rule is deliberately total — EVERY http(s) URL in the lock must be on
 * `CANONICAL_REGISTRY_URL`'s host — because every dependency this fleet
 * installs comes through mini's proxy. A public `registry.npmjs.org` tarball in
 * the lock is the same defect wearing a friendlier host: it means the lock was
 * written against a registry other than the canonical one.
 *
 * Fails CLOSED, naming the offending lines and the count.
 */
import { existsSync, readFileSync } from 'node:fs'

import { CANONICAL_REGISTRY_URL, registryOrigin, scanLockContent } from './lib/registry'

/**
 * This gate deliberately inherits the ambient git environment. Per
 * `environmentWithoutGitOverrides`, stripping `GIT_*` is for a command that
 * means one SPECIFIC repository; this one means "whatever repository the hook
 * is acting on", and in pre-commit `GIT_INDEX_FILE` is exactly what points it
 * at the index of the commit in flight.
 */
function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`
    )
  }
  return result.stdout.toString()
}

function trackedLockPaths(): string[] {
  return git(['ls-files', '-z', '--', 'bun.lock', '*/bun.lock']).split('\0').filter(Boolean)
}

/**
 * The content git would record for `path`: the index blob, which in a
 * pre-commit hook is the commit in flight and elsewhere is HEAD plus whatever
 * is staged. Reading the worktree instead would let a partially-staged lock
 * through.
 */
function stagedContent(path: string): string {
  return git(['show', `:${path}`])
}

function main(): number {
  let paths: string[]
  try {
    paths = trackedLockPaths()
  } catch (error) {
    console.error(`lock-hygiene: cannot enumerate tracked lockfiles: ${String(error)}`)
    return 1
  }

  // An empty enumeration beside a lockfile on disk means the enumeration broke,
  // not that the repo is clean. Fail closed rather than green-light nothing.
  if (paths.length === 0) {
    if (existsSync('bun.lock')) {
      console.error('lock-hygiene: bun.lock exists but git tracks no lockfile; refusing to pass')
      return 1
    }
    console.log('lock-hygiene: no tracked lockfiles')
    return 0
  }

  const canonicalHost = registryOrigin(CANONICAL_REGISTRY_URL)
  let failed = false
  for (const path of paths) {
    let content: string
    try {
      content = stagedContent(path)
    } catch {
      content = readFileSync(path, 'utf8')
    }
    const violations = scanLockContent(content)
    if (violations.length === 0) continue
    failed = true
    const hosts = [...new Set(violations.map((violation) => violation.host))].sort()
    console.error(
      `lock-hygiene: ${path} carries ${violations.length} URL(s) on non-canonical host(s) ${hosts.join(', ')} (canonical: ${canonicalHost})`
    )
    for (const violation of violations.slice(0, 10)) {
      console.error(`  ${path}:${violation.line}: ${violation.url}`)
    }
    if (violations.length > 10) console.error(`  ... and ${violations.length - 10} more`)
  }

  if (failed) {
    console.error(
      `Re-sync the lock against ${CANONICAL_REGISTRY_URL} (just pull-deps on a host that resolves it) before committing.`
    )
    return 1
  }
  console.log(`lock-hygiene: ${paths.length} tracked lockfile(s) on ${canonicalHost}`)
  return 0
}

if (import.meta.main) process.exit(main())
