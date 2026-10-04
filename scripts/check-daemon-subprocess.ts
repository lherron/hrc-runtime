#!/usr/bin/env bun
/**
 * Daemon code runs subprocesses only through runBoundedSubprocess (T-10226).
 *
 * The daemon is one event loop. A child it waits on without a raced, killable
 * deadline holds every runtime it serves, and each recurrence was fixed at the
 * one call site that bit: tmux sweeps (d96ff60d), lsof holder enumeration
 * (b2ecc48f, then 0960fbc3 because the first fix's deadline could not land),
 * spawnSync of `wrkq projects` / `git worktree list` on placement paths
 * (9db3c633). The next spawn copied whichever neighbour it opened.
 *
 * - A synchronous spawn in hrc-server or any workspace package it depends on
 *   fails outright.
 * - A raw async spawn (`Bun.spawn`, `spawn`, `execFile`) outside
 *   packages/hrc-core/src/bounded-subprocess.ts fails when a file has more
 *   than scripts/daemon-subprocess-baseline.json records. The baseline is {}
 *   since T-10229 migrated every site; keep it there.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * hrc-server and every workspace package it depends on at runtime, read from
 * its manifest so a new dependency is covered without editing this file.
 */
export function daemonPackages(repoRoot: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'packages/hrc-server/package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> }
  const workspace = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    existsSync(join(repoRoot, 'packages', name, 'package.json'))
  )
  return ['hrc-server', ...workspace]
}

export const BOUNDED_MODULE = 'packages/hrc-core/src/bounded-subprocess.ts'
export const BASELINE_PATH = 'scripts/daemon-subprocess-baseline.json'

const SYNC_SPAWN = /(?<![.\w])(spawnSync|execSync|execFileSync)\s*\(|\bBun\.spawnSync\s*\(/g
const ASYNC_SPAWN = /(?<![.\w])(spawn|execFile|exec)\s*\(|\bBun\.spawn\s*\(/g

export function isDaemonSource(path: string, packages: readonly string[]): boolean {
  const match = /^packages\/([^/]+)\/src\/.+\.tsx?$/.exec(path)
  if (!match || !packages.includes(match[1] ?? '')) return false
  return !/(^|\/)__tests__\//.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith('.d.ts')
}

/** Drop comments so a sentence about spawnSync is not a call. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

export function countMatches(source: string, pattern: RegExp): number {
  return [...stripComments(source).matchAll(pattern)].length
}

export type SubprocessViolation = { path: string; message: string }

export function findSubprocessViolations(
  files: ReadonlyArray<{ path: string; source: string }>,
  baseline: Readonly<Record<string, number>>
): SubprocessViolation[] {
  const violations: SubprocessViolation[] = []
  for (const { path, source } of files) {
    if (path === BOUNDED_MODULE) continue
    const sync = countMatches(source, SYNC_SPAWN)
    if (sync > 0) {
      violations.push({
        path,
        message: `${sync} synchronous spawn(s) block the daemon's event loop; use runBoundedSubprocess from ${BOUNDED_MODULE}`,
      })
    }
    const raw = countMatches(source, ASYNC_SPAWN)
    const allowed = baseline[path] ?? 0
    if (raw > allowed) {
      violations.push({
        path,
        message: `${raw} raw subprocess spawn(s), baseline ${allowed}; run it through runBoundedSubprocess from ${BOUNDED_MODULE}`,
      })
    }
  }
  return violations
}

function main(): void {
  const repoRoot = dirname(import.meta.dir)
  const packages = daemonPackages(repoRoot)
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', 'packages'], {
    cwd: repoRoot,
    stdout: 'pipe',
  })
  if (listed.exitCode !== 0) {
    console.error('check-daemon-subprocess: git ls-files failed')
    process.exit(1)
  }
  const files = listed.stdout
    .toString()
    .split('\0')
    .filter((path) => path && isDaemonSource(path, packages))
    .map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))
  const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), 'utf8')) as Record<
    string,
    number
  >
  const violations = findSubprocessViolations(files, baseline)
  if (violations.length > 0) {
    console.error('check-daemon-subprocess: unbounded subprocess in daemon code:')
    for (const violation of violations) console.error(`  ${violation.path}: ${violation.message}`)
    process.exit(1)
  }
  const lowerable = files.filter(
    ({ path, source }) => countMatches(source, ASYNC_SPAWN) < (baseline[path] ?? 0)
  )
  for (const { path } of lowerable) {
    console.log(
      `check-daemon-subprocess: ${path} is below its baseline; lower it in ${BASELINE_PATH}`
    )
  }
  console.log('check-daemon-subprocess: no new unbounded subprocess in daemon code')
}

if (import.meta.main) main()
