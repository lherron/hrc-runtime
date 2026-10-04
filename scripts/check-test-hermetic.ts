#!/usr/bin/env bun
/**
 * Every test root runs hermetically, and runs at all (T-10226).
 *
 * The hermetic test environment has one owner, scripts/lib/hermetic-test-env.ts,
 * and two registrations per test root that bun cannot infer: the `test` script
 * must start bun through scripts/hermetic-test.ts (the only way a child spawned
 * without an explicit env is clean), and bunfig.toml must name the preload
 * (in-process readers, and the refusal of a run that bypassed the wrapper). A
 * package added by copying a neighbour's manifest without its bunfig ran its
 * tests against the operator's live environment from 1c0c9c7d until this check;
 * the preload alone never reached child processes at all (159a4c26).
 *
 * The root `test:unit` / `test:contract` / `test:integration` tiers name their
 * packages by hand, so a test-bearing package outside every tier never runs in
 * `just verify`. That is checked here too.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const HERMETIC_PRELOAD = 'scripts/test-preload-hermetic-env.ts'
export const HERMETIC_RUNNER = 'scripts/hermetic-test.ts'
const ROOT_TIERS = ['test:unit', 'test:contract', 'test:integration'] as const

/** The directory bun runs tests from for a tracked test file: its package, or the root. */
export function testRootFor(path: string): string {
  const match = /^packages\/([^/]+)\//.exec(path)
  return match ? `packages/${match[1]}` : '.'
}

export function registersPreload(
  repoRoot: string,
  testRoot: string,
  bunfigSource: string | undefined
): boolean {
  if (bunfigSource === undefined) return false
  const parsed = Bun.TOML.parse(bunfigSource) as { test?: { preload?: unknown } }
  const preload = parsed.test?.preload
  const entries = typeof preload === 'string' ? [preload] : Array.isArray(preload) ? preload : []
  const target = realpathSync(join(repoRoot, HERMETIC_PRELOAD))
  return entries.some((entry) => {
    if (typeof entry !== 'string') return false
    const candidate = resolve(repoRoot, testRoot, entry)
    return existsSync(candidate) && realpathSync(candidate) === target
  })
}

/** The script must exec bun through the runner, not `bun test` directly. */
export function runsThroughHermeticRunner(script: string | undefined, testRoot: string): boolean {
  if (script === undefined) return false
  const runner = testRoot === '.' ? HERMETIC_RUNNER : `../../${HERMETIC_RUNNER}`
  return /(^|\s)bun\s+test(\s|$)/.test(script) === false && script.includes(`bun ${runner}`)
}

function readJson(path: string): { name?: string; scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function findHermeticViolations(repoRoot: string, trackedFiles: string[]): string[] {
  const roots = [
    ...new Set(trackedFiles.filter((path) => /\.test\.tsx?$/.test(path)).map(testRootFor)),
  ].sort()
  const rootScripts = readJson(join(repoRoot, 'package.json')).scripts ?? {}
  const violations: string[] = []
  for (const testRoot of roots) {
    const bunfig = join(repoRoot, testRoot, 'bunfig.toml')
    const bunfigPath = testRoot === '.' ? 'bunfig.toml' : `${testRoot}/bunfig.toml`
    const preloadEntry = testRoot === '.' ? `./${HERMETIC_PRELOAD}` : `../../${HERMETIC_PRELOAD}`
    if (
      !registersPreload(
        repoRoot,
        testRoot,
        existsSync(bunfig) ? readFileSync(bunfig, 'utf8') : undefined
      )
    ) {
      violations.push(`${bunfigPath}: add [test] preload = ["${preloadEntry}"]`)
    }

    if (testRoot === '.') {
      if (!runsThroughHermeticRunner(rootScripts['test:scripts'], '.')) {
        violations.push(
          `package.json scripts.test:scripts: run \`bun ${HERMETIC_RUNNER} … scripts/\`, not \`bun test\``
        )
      }
      continue
    }

    const manifestPath = join(repoRoot, testRoot, 'package.json')
    const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}
    if (!runsThroughHermeticRunner(manifest.scripts?.['test'], testRoot)) {
      violations.push(
        `${testRoot}/package.json scripts.test: run \`bun ../../${HERMETIC_RUNNER} <bun test args>\`, not \`bun test\``
      )
    }
    const name = manifest.name ?? testRoot.slice('packages/'.length)
    const tiers = ROOT_TIERS.filter((tier) =>
      new RegExp(`(["' ]|--filter\\s+)${name}(["' ]|$)`).test(rootScripts[tier] ?? '')
    )
    if (tiers.length !== 1) {
      violations.push(
        `package.json: ${name} has tests and must be named in exactly one of ${ROOT_TIERS.join(', ')} (found ${tiers.length})`
      )
    }
  }
  return violations
}

function main(): void {
  const repoRoot = dirname(import.meta.dir)
  const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repoRoot, stdout: 'pipe' })
  if (listed.exitCode !== 0) {
    console.error('check-test-hermetic: git ls-files failed')
    process.exit(1)
  }
  const tracked = listed.stdout.toString().split('\0').filter(Boolean)
  const violations = findHermeticViolations(repoRoot, tracked)
  if (violations.length > 0) {
    console.error('check-test-hermetic: test roots that are not hermetic or never run:')
    for (const violation of violations) console.error(`  ${violation}`)
    console.error(
      `Why: scripts/lib/hermetic-test-env.ts. Without these, tests inherit the caller's GIT_DIR and HRC_WRKQ_DB.`
    )
    process.exit(1)
  }
  console.log('check-test-hermetic: every test root is hermetic and in one verify tier')
}

if (import.meta.main) main()
