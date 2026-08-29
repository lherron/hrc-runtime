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
 * Governed set is the root package.json `overrides` pin table, the same table
 * scripts/check-dependency-pins.ts enforces: an exact pin there means the workspace
 * resolves that dependency to exactly one version, so a nested copy at a DIFFERENT
 * version can only be a stale artifact and is safe to remove. A nested copy at the
 * SAME version shadows nothing and is left alone. Ungoverned dependencies are never
 * touched — bun nests those deliberately to satisfy genuinely conflicting ranges.
 *
 * The pin table is read from THIS repo, but the root resolution to compare against
 * is read from whichever root owns this repo's install. Under the praesidium dev
 * workspace that is the parent, and this repo's own node_modules is empty — reading
 * the resolution here would find nothing to compare against and the sweep would
 * keep every stale copy while reporting success. See scripts/lib/workspace-root.ts.
 *
 * `--check` reports without deleting, for use in a gate. `--root <dir>` points the
 * sweep at another tree, which is how the tests drive it over a fixture.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { resolveInstallRoot } from './lib/workspace-root'

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

/** Root `overrides` entries naming one exact version — the governed set. */
export async function governedDependencies(repoRoot: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as PackageJson
  return Object.entries(asRecord(manifest.overrides))
    .filter(([, specifier]) => typeof specifier === 'string' && exactVersion.test(specifier))
    .map(([dependency]) => dependency)
    .sort()
}

/**
 * Every `node_modules/<dependency>` directory under `repoRoot` EXCEPT the copy in
 * the install root's own node_modules. The walk descends through node_modules too,
 * so a copy nested inside another package's install is found as well.
 */
async function nestedCopies(
  repoRoot: string,
  installRoot: string,
  dependency: string
): Promise<string[]> {
  const rootCopy = join(installRoot, 'node_modules', dependency)
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
        if (candidate !== rootCopy && (await readVersion(candidate)) !== undefined) {
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
  const stale: StaleCopy[] = []
  const unresolved: string[] = []

  for (const dependency of governed) {
    const rootVersion = await readVersion(join(installRoot, 'node_modules', dependency))
    for (const copy of await nestedCopies(repoRoot, installRoot, dependency)) {
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
