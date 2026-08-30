import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  type WrkqProjectRegistryEntry,
  expandRegistryHome,
  findWrkqProjectEntry,
  readWrkqProjectRegistry,
} from 'hrc-core'

/**
 * The registered checkout root for a project, as the daemon sees it (T-07749).
 *
 * Node-local placement used to reconstruct a project root by walking up from
 * the daemon's cwd and then guessing two sibling directories. That finds every
 * project whose checkout sits beside the others and misses the ones that do
 * not — most sharply `agents`, whose root IS the agent-home root, a boundary
 * the marker walk-up refuses to cross by construction. The registry is where
 * such a project declares itself, and `hrc start` has always honored it, so a
 * kicker that did not made ledger-born seats unplaceable for scopes an operator
 * could start by hand.
 *
 * This is a candidate, not an override: it is consulted only after the marker
 * walk-up has already failed, so nothing that resolves today changes.
 */

/**
 * `wrkq projects --json` is a subprocess, and the drive path may consult it once
 * per unseated target per sweep. The registry changes when an operator runs
 * `wrkq set --root`, so a short TTL keeps the daemon honest without paying a
 * spawn per attempt.
 */
const REGISTRY_CACHE_TTL_MS = 30_000

let cache: { readAt: number; projects: WrkqProjectRegistryEntry[] } | undefined

/** Test seam: drop the memo so a fixture registry is observed immediately. */
export function resetProjectRegistryCache(): void {
  cache = undefined
}

function cachedRegistry(
  env: Record<string, string | undefined>,
  now: number
): WrkqProjectRegistryEntry[] {
  if (cache !== undefined && now - cache.readAt < REGISTRY_CACHE_TTL_MS) return cache.projects
  const projects = readWrkqProjectRegistry(env)
  // An empty read is a failed or absent wrkq, not a registry with no projects.
  // Memoizing it would pin the daemon to that failure for the whole TTL, so the
  // next caller retries instead.
  if (projects.length > 0) cache = { readAt: now, projects }
  return projects
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function resolveRegisteredProjectRoot(
  projectId: string,
  options: {
    env: Record<string, string | undefined>
    /** Test seam; production reads `wrkq projects --json`. */
    registryProjects?: readonly WrkqProjectRegistryEntry[] | undefined
    now?: number | undefined
  }
): string | undefined {
  const projects =
    options.registryProjects ?? cachedRegistry(options.env, options.now ?? Date.now())
  const root = findWrkqProjectEntry(projects, projectId)?.root
  if (root === undefined || root === null || root.trim().length === 0) return undefined
  const expanded = resolve(expandRegistryHome(root.trim(), options.env))
  // A root registered on another node is simply absent here. Returning it would
  // launch a runtime at a path that does not exist; returning undefined lets the
  // existing `unresolvableProjectPath` diagnostic name the real problem.
  return isDirectory(expanded) ? expanded : undefined
}
