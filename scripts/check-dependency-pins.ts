#!/usr/bin/env bun
/**
 * Pinned-dependency agreement guard.
 *
 * The root package.json `overrides` block is this repo's pin table: an exact
 * version recorded there is the ONE version the whole workspace is allowed to
 * resolve. This guard makes every workspace manifest agree with it.
 *
 * WHY: a workspace member that declares a governed dependency with a floating
 * specifier ("latest", a caret, a dist-tag) does not merely widen the range — bun
 * resolves it separately and, when it lands on a different version than the root,
 * materialises a NESTED `<package>/node_modules/<dep>` copy. TypeScript resolves
 * types from the nearest node_modules, so that copy SHADOWS the root for every
 * file in that package while the lockfile still shows one clean root resolution
 * and `bun install --frozen-lockfile` reports "no changes".
 *
 * This repo was the worst-exposed of the three (T-07695, ported from agent-spaces
 * T-07690): eleven packages declared `@types/bun: "latest"` over a root that had
 * NO overrides pin at all, so the declaration was the resolution and a fresh clone
 * installed eleven nested @types/bun@1.4.0 copies over a root at 1.3.14. Build and
 * typecheck happened to stay green — the divergent overloads were not on a surface
 * this repo used yet — which is precisely why a guard and not a red build is the
 * thing that holds: the shadow was already installed and waiting for the first
 * file to touch it.
 *
 * Governed set is DERIVED, not hardcoded: whatever the root pins exactly in
 * `overrides` is governed, so adding a pin there extends this guard automatically.
 * Non-exact override entries (ranges, `file:`/`workspace:` redirects) are ignored —
 * they express intent other than "exactly this version".
 *
 * peerDependencies are deliberately NOT governed: a peer range is a compatibility
 * statement about the consumer's tree, not a resolution this workspace performs.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type PinViolation = {
  manifest: string
  line: number
  section: string
  dependency: string
  declared: string
  pinned: string
}

type PackageJson = {
  overrides?: unknown
  dependencies?: unknown
  devDependencies?: unknown
}

const governedSections = ['dependencies', 'devDependencies'] as const
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

/** The pin table: root `overrides` entries that name one exact version. */
export function pinTable(rootManifestContent: string): Map<string, string> {
  const overrides = asRecord((JSON.parse(rootManifestContent) as PackageJson).overrides)
  const pins = new Map<string, string>()
  for (const [dependency, specifier] of Object.entries(overrides)) {
    if (typeof specifier === 'string' && exactVersion.test(specifier)) {
      pins.set(dependency, specifier)
    }
  }
  return pins
}

/**
 * Line of a dependency's declaration in its own manifest text. The guard reports a
 * manifest, so an approximate line would send the reader to the wrong key; scanning
 * the raw text keeps `file:line` clickable and exact.
 */
export function declarationLine(content: string, dependency: string): number {
  const lines = content.split('\n')
  const key = `"${dependency}"`
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}:`))
  return index === -1 ? 1 : index + 1
}

/** Root manifest first, then every workspace member manifest, in path order. */
async function manifestPaths(repoRoot: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, 'packages'), { withFileTypes: true })
  const members = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'package.json'))
    .sort()
  return ['package.json', ...members]
}

export async function collectPinViolations(repoRoot: string): Promise<PinViolation[]> {
  const pins = pinTable(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  if (pins.size === 0) {
    return []
  }

  const violations: PinViolation[] = []
  for (const manifest of await manifestPaths(repoRoot)) {
    let content: string
    try {
      content = await readFile(join(repoRoot, manifest), 'utf8')
    } catch {
      // A packages/* directory without a manifest is not a workspace member.
      continue
    }
    const packageJson = JSON.parse(content) as PackageJson

    for (const section of governedSections) {
      for (const [dependency, specifier] of Object.entries(asRecord(packageJson[section]))) {
        const pinned = pins.get(dependency)
        if (pinned === undefined || specifier === pinned) {
          continue
        }

        violations.push({
          manifest,
          line: declarationLine(content, dependency),
          section,
          dependency,
          declared: String(specifier),
          pinned,
        })
      }
    }
  }

  return violations.sort(
    (left, right) => left.manifest.localeCompare(right.manifest) || left.line - right.line
  )
}

export function formatPinViolationDiagnostic(violation: PinViolation): string[] {
  return [
    `${violation.manifest}:${violation.line}`,
    [
      `FIX: set "${violation.dependency}": "${violation.pinned}" in ${violation.manifest}`,
      `(${violation.section} declares "${violation.declared}"), then run \`bun install\``,
      'and `just doctor` to prune any nested copy already on disk.',
    ].join(' '),
    [
      'WHY: a specifier that disagrees with the root overrides pin resolves separately and installs',
      'a NESTED node_modules copy that shadows the root for that package only — types and runtime',
      'silently differ there while the lockfile still shows one clean resolution.',
    ].join(' '),
    [
      `EXCEPTION: to hold a different version of '${violation.dependency}' deliberately, remove it from`,
      'the root package.json `overrides` pin table so it is no longer governed, and record why in a',
      'wrkq task. Do not suppress, silence, or vendor around this check.',
    ].join(' '),
  ]
}

function report(violations: PinViolation[]): void {
  console.error(
    'Dependency pin check failed: manifests disagree with the root overrides pin table.'
  )
  for (const violation of violations) {
    console.error('')
    for (const line of formatPinViolationDiagnostic(violation)) {
      console.error(`  ${line}`)
    }
  }
  console.error('')
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..')
  const violations = await collectPinViolations(repoRoot)

  if (violations.length === 0) {
    console.log('Dependency pin check passed.')
    process.exit(0)
  }

  report(violations)
  process.exit(1)
}
