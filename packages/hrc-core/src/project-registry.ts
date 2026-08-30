import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The wrkq project registry, as HRC reads it.
 *
 * `wrkq set <project> --root <path>` is the ONLY place a project whose checkout
 * does not sit beside the other checkouts can declare where it lives. The
 * canonical example is `agents`, whose root IS the agent-home root
 * (`~/praesidium/var/agents`): no cwd walk-up can find it, because the placement
 * marker scan refuses to cross the agent-home boundary by design.
 *
 * Both placement resolvers therefore have to consult it, and they must consult
 * the SAME reader — a registry the CLI honors and the daemon does not is exactly
 * the divergence that made ledger-born seats unplaceable for `agents` while
 * `hrc start` on the identical scope worked (T-07749).
 */
export interface WrkqProjectRegistryEntry {
  slug?: string | undefined
  path?: string | undefined
  title?: string | undefined
  root?: string | null | undefined
}

export function expandRegistryHome(
  path: string,
  env: Record<string, string | undefined> = process.env
): string {
  const home = env['HOME'] ?? homedir()
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/**
 * Read the registry by shelling `wrkq projects --json`.
 *
 * A failed read is an EMPTY registry, never a throw: the registry is one
 * placement authority among several, and a wrkq that is missing or busy must
 * degrade to the other candidates rather than strand every caller.
 */
export function readWrkqProjectRegistry(
  env: Record<string, string | undefined> = process.env
): WrkqProjectRegistryEntry[] {
  const result = spawnSync('wrkq', ['projects', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0 || !result.stdout) return []
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    return Array.isArray(parsed) ? (parsed as WrkqProjectRegistryEntry[]) : []
  } catch {
    return []
  }
}

/** Match on any identifier wrkq prints for a project, widest first. */
export function findWrkqProjectEntry(
  projects: readonly WrkqProjectRegistryEntry[],
  projectId: string
): WrkqProjectRegistryEntry | undefined {
  return projects.find(
    (project) =>
      project.slug === projectId || project.path === projectId || project.title === projectId
  )
}
