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
 * Every placement resolution therefore has to consult it, through ONE reader:
 * a registry the CLI honors and the daemon does not is exactly the divergence
 * that made ledger-born seats unplaceable for `agents` while `hrc start` on the
 * identical scope worked (T-07749). That reader is the daemon's cached
 * `wrkq.project.listView` over its ledger client (hrc-server
 * federation/project-registry-roots.ts); the policy here takes the loaded
 * registry as input and never shells wrkq itself (T-08783).
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
