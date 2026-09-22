#!/usr/bin/env bun
/**
 * Workspace doctor: prune nested node_modules copies of pinned dependencies.
 *
 * `bun install` writes; it does not tidy. When a manifest declares a governed
 * dependency with a specifier that resolves differently than the root, bun
 * materialises a NESTED `<package>/node_modules/<dep>` copy at that version.
 * Correcting the specifier does NOT remove the directory: the lockfile now records
 * one resolution, `bun install --frozen-lockfile` reports "no changes", and the
 * stale copy stays on disk — where TypeScript's nearest-node_modules resolution
 * keeps preferring it over the root (T-07690, ported here as T-07695).
 *
 * Governed set is exact root package.json `overrides` plus the ASP coherence
 * groups that `just pull-deps` resolves as one release tuple. In both cases a
 * nested copy at a DIFFERENT version is stale and safe to remove. A nested copy
 * at the SAME version shadows nothing and is left alone. Other ungoverned
 * dependencies are never touched — bun nests those deliberately for conflicts.
 *
 * Exact pins compare against whichever root owns this repo's install. Under the
 * praesidium dev workspace that is the parent. ASP groups instead compare against
 * this repo's coherent lock tuple, because the parent workspace may intentionally
 * remain on a different published ASP release. This prevents an old parent copy
 * from causing a newer HRC materialization to be pruned. See
 * scripts/lib/workspace-root.ts.
 *
 * `--check` reports without deleting, for use in a gate. `--root <dir>` points the
 * sweep at another tree, which is how the tests drive it over a fixture.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { parseLockResolutions } from './lib/verdaccio-sync'
import { resolveInstallRoot } from './lib/workspace-root'
import { aspSyncSpec } from './sync-asp-from-verdaccio'

const skippedDirectories = new Set(['.git', 'coverage', 'dist', 'tmp'])
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/

type PackageJson = { overrides?: unknown; version?: unknown }

export type StaleCopy = {
  /** Path relative to the swept repo root. */
  where: string
  dependency: string
  version: string | undefined
  rootVersion: string
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

export function parseRoot(argv: string[], fallback: string): string {
  const flag = argv.indexOf('--root')
  if (flag === -1) {
    return fallback
  }

  const value = argv[flag + 1]
  if (!value) {
    throw new Error('--root requires a directory')
  }
  return resolve(value)
}

async function readVersion(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageDir, 'package.json'), 'utf8')
    ) as PackageJson
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

const aspCoherenceDependencies = new Set(aspSyncSpec.groups.flatMap((group) => group.packages))

/** Hoisted ASP resolutions are authoritative in this repo's coherent lock. */
async function aspLockVersions(repoRoot: string): Promise<Map<string, string>> {
  try {
    const lock = await readFile(join(repoRoot, 'bun.lock'), 'utf8')
    const resolutions = parseLockResolutions(lock).filter(
      (entry) => !entry.nested && aspCoherenceDependencies.has(entry.name)
    )
    const versions = new Map<string, string>()
    for (const group of aspSyncSpec.groups) {
      const groupPackages = new Set(group.packages)
      const groupVersions = new Set(
        resolutions.filter((entry) => groupPackages.has(entry.name)).map((entry) => entry.version)
      )
      // A coherent tuple has exactly one published version. Use that release
      // for every group member, including transitive members Bun did not hoist.
      if (groupVersions.size !== 1) continue
      const [version] = groupVersions
      if (version === undefined) continue
      for (const dependency of group.packages) versions.set(dependency, version)
    }
    return versions
  } catch {
    return new Map()
  }
}

/** Exact root pins plus the published ASP tuple, whose manifests retain `latest`. */
export async function governedDependencies(repoRoot: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as PackageJson
  const exactOverrides = Object.entries(asRecord(manifest.overrides))
    .filter(([, specifier]) => typeof specifier === 'string' && exactVersion.test(specifier))
    .map(([dependency]) => dependency)
  const aspCoherencePackages = aspSyncSpec.groups.flatMap((group) => group.packages)
  return [...new Set([...exactOverrides, ...aspCoherencePackages])].sort()
}

/**
 * Every `node_modules/<dependency>` directory under `repoRoot` EXCEPT the copy in
 * the install root's own node_modules. The walk descends through node_modules too,
 * so a copy nested inside another package's install is found as well.
 */
async function nestedCopies(
  repoRoot: string,
  excludedRootCopies: ReadonlySet<string>,
  dependency: string
): Promise<string[]> {
  const found: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || skippedDirectories.has(entry.name)) {
        continue
      }

      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') {
        const candidate = join(path, dependency)
        if (!excludedRootCopies.has(candidate) && (await readVersion(candidate)) !== undefined) {
          found.push(candidate)
        }
      }

      await walk(path)
    }
  }

  await walk(repoRoot)
  return found.sort()
}

export async function findStaleCopies(
  repoRoot: string,
  installRoot: string
): Promise<{ stale: StaleCopy[]; unresolved: string[]; governed: string[] }> {
  const governed = await governedDependencies(repoRoot)
  const lockedAspVersions = await aspLockVersions(repoRoot)
  const stale: StaleCopy[] = []
  const unresolved: string[] = []

  for (const dependency of governed) {
    const aspCoherencePackage = aspCoherenceDependencies.has(dependency)
    const repoRootCopy = join(repoRoot, 'node_modules', dependency)
    const installRootCopy = join(installRoot, 'node_modules', dependency)
    const rootVersion =
      (aspCoherencePackage ? lockedAspVersions.get(dependency) : undefined) ??
      (await readVersion(installRootCopy))
    const excludedRootCopies = new Set(
      aspCoherencePackage ? [repoRootCopy, installRootCopy] : [installRootCopy]
    )
    for (const copy of await nestedCopies(repoRoot, excludedRootCopies, dependency)) {
      const version = await readVersion(copy)
      const where = relative(repoRoot, copy)

      if (rootVersion === undefined) {
        unresolved.push(`${where}@${version}`)
        continue
      }
      if (version === rootVersion) {
        continue
      }

      stale.push({ where, dependency, version, rootVersion })
    }
  }

  return { stale, unresolved, governed }
}

if (import.meta.main) {
  const repoRoot = parseRoot(process.argv, resolve(import.meta.dir, '..'))
  const installRoot = resolveInstallRoot(repoRoot)
  if (installRoot !== repoRoot) {
    console.log(
      `[doctor] praesidium dev workspace detected; root resolutions read at ${installRoot}`
    )
  }

  const checkOnly = process.argv.includes('--check')
  const { stale, unresolved, governed } = await findStaleCopies(repoRoot, installRoot)

  for (const copy of unresolved) {
    console.warn(`[doctor] ${copy}: no root resolution to compare against; kept`)
  }
  for (const copy of stale) {
    console.log(
      `[doctor] ${copy.where}@${copy.version} shadows root ${copy.dependency}@${copy.rootVersion}`
    )
    if (!checkOnly) {
      await rm(join(repoRoot, copy.where), { recursive: true, force: true })
    }
  }

  if (stale.length === 0) {
    console.log(
      `Workspace doctor: no stale nested copies of ${governed.length} pinned dependencies.`
    )
    process.exit(0)
  }

  if (checkOnly) {
    console.error(
      `Workspace doctor: ${stale.length} stale nested copy(ies) shadow the root resolution. Run \`just doctor\` to prune them.`
    )
    process.exit(1)
  }

  console.log(`Workspace doctor: pruned ${stale.length} stale nested copy(ies).`)
}
