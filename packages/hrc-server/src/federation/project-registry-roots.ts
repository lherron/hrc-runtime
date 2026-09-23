import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import { type WrkqProjectRegistryEntry, expandRegistryHome, findWrkqProjectEntry } from 'hrc-core'

import { writeServerLog } from '../server-log.js'

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
 * The daemon's ONE reader of the wrkq project registry (T-08783).
 *
 * It used to shell `wrkq projects --json` with spawnSync, uncached on the main
 * placement path — ~25s of main-thread time in a 23-minute profile, on
 * /v1/federation/locate and the kicker's placement sweep. It now reads the
 * existing `wrkq.project.listView` over the ledger client the server already
 * holds, so a read is one RPC frame on a long-lived child and never blocks.
 *
 * FRESHNESS. The registry changes when an operator runs `wrkq set --root`, so a
 * 30s TTL keeps placement honest without a read per attempt: a new root is seen
 * by placement at most 30s late.
 *
 * FAILURE SERVES THE LAST GOOD REGISTRY. An empty registry silently changes
 * placement (explicit projects stop canonicalizing through it), so a failed or
 * empty read never replaces one that loaded; `[]` is served only when nothing
 * has ever loaded. Either way the failure is logged, and the next attempt waits
 * out a 5s retry window, so a wrkq outage costs one RPC per window rather than
 * one per placement.
 *
 * SINGLE-FLIGHT. Concurrent callers on a cold or expired cache share one
 * in-flight read. A cold cache awaits that read; there is no synchronous
 * fallback on any path.
 */
const REGISTRY_CACHE_TTL_MS = 30_000
const REGISTRY_RETRY_AFTER_FAILURE_MS = 5_000

export type ProjectRegistrySource = () => Promise<WrkqProjectRegistryEntry[]>

type RegistryState = {
  lastGood?: { readAt: number; projects: WrkqProjectRegistryEntry[] } | undefined
  failedAt?: number | undefined
  inFlight?: Promise<WrkqProjectRegistryEntry[]> | undefined
}

let source: ProjectRegistrySource | undefined
let state: RegistryState = {}

/**
 * Point the reader at a server's ledger. Returns the uninstaller, which only
 * uninstalls if this source is still the current one (in-process test servers
 * may overlap).
 */
export function installProjectRegistrySource(next: ProjectRegistrySource): () => void {
  source = next
  state = {}
  return () => {
    if (source !== next) return
    source = undefined
    state = {}
  }
}

/** Test seam: drop the memo so a fixture registry is observed immediately. */
export function resetProjectRegistryCache(): void {
  state = {}
}

export async function loadProjectRegistry(
  now: number = Date.now()
): Promise<readonly WrkqProjectRegistryEntry[]> {
  const { lastGood, failedAt, inFlight } = state
  if (lastGood !== undefined && now - lastGood.readAt < REGISTRY_CACHE_TTL_MS) {
    return lastGood.projects
  }
  if (failedAt !== undefined && now - failedAt < REGISTRY_RETRY_AFTER_FAILURE_MS) {
    return lastGood?.projects ?? []
  }
  if (inFlight !== undefined) return inFlight

  const owner = state
  const read = refresh(now).finally(() => {
    if (owner.inFlight === read) owner.inFlight = undefined
  })
  owner.inFlight = read
  return read
}

async function refresh(now: number): Promise<WrkqProjectRegistryEntry[]> {
  const owner = state
  let failure: string
  try {
    if (source === undefined) {
      failure = 'no wrkq ledger is wired to this server'
    } else {
      const projects = await source()
      if (projects.length > 0) {
        owner.lastGood = { readAt: now, projects }
        owner.failedAt = undefined
        return projects
      }
      // An empty read is a failed or absent wrkq, not a registry with no projects.
      failure = 'wrkq.project.listView returned no projects'
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  owner.failedAt = now
  const lastGood = owner.lastGood
  writeServerLog('WARN', 'project_registry.refresh_failed', {
    error: failure,
    serving: lastGood === undefined ? 'empty' : 'last-good',
    ...(lastGood !== undefined
      ? { lastGoodAgeMs: now - lastGood.readAt, projects: lastGood.projects.length }
      : {}),
    retryAfterMs: REGISTRY_RETRY_AFTER_FAILURE_MS,
  })
  return lastGood?.projects ?? []
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
    /** The loaded registry (loadProjectRegistry, or a test fixture). */
    registryProjects: readonly WrkqProjectRegistryEntry[]
  }
): string | undefined {
  const root = findWrkqProjectEntry(options.registryProjects, projectId)?.root
  if (root === undefined || root === null || root.trim().length === 0) return undefined
  const expanded = resolve(expandRegistryHome(root.trim(), options.env))
  // A root registered on another node is simply absent here. Returning it would
  // launch a runtime at a path that does not exist; returning undefined lets the
  // existing `unresolvableProjectPath` diagnostic name the real problem.
  return isDirectory(expanded) ? expanded : undefined
}
