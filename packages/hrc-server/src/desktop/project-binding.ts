/**
 * Freeze a desktop conversation's project at registration (T-08294 §4, and the
 * open defect T-07514).
 *
 * T-07514's observation was a desktop thread opened on
 * `/Users/lherron/praesidium/clients/hrc-ios` running as
 * `agent:cody:project:praesidium:task:codex-<uuid>`. Two things produce that
 * answer and BOTH are refused here:
 *
 *  1. **Ambient env.** `ASP_PROJECT` inherited from whatever launched the
 *     process is not evidence about the workspace. Nothing in this module reads
 *     it; the only inputs are the workspace directory the hook reported and the
 *     wrkq registry. (`env` is threaded through solely so `~` expansion and the
 *     registry read behave, never as a project source.)
 *  2. **An ancestor marker winning over a nested project.** `~/praesidium`
 *     carries `asp-targets.toml`, so a naive walk-up from any nested workspace
 *     answers `praesidium`. The rule below is DEEPEST-WINS: the most specific
 *     boundary containing the workspace decides, and the registry supplies the
 *     canonical identity for it.
 *
 * The binding is resolved ONCE and persisted. Later cwd or title changes never
 * re-run this — that is what "frozen" means, and it is why an ambiguous answer
 * must be reported as pending rather than guessed: a guess made once is a guess
 * that never gets corrected.
 */

import {
  type WrkqProjectRegistryEntry,
  expandRegistryHome,
  readWrkqProjectRegistry,
} from 'hrc-core'
import { findProjectMarker, getAgentsRoot } from 'spaces-config'

import { canonicalPath, isSameOrInside } from './native-identity.js'

export type DesktopProjectBinding = {
  readonly projectId: string
  readonly projectRoot: string
  /** Which authority decided, for the durable diagnostic trail. */
  readonly resolvedBy: 'registry' | 'registry+marker'
}

export type DesktopProjectResolution =
  | { readonly bound: DesktopProjectBinding }
  | { readonly pending: true; readonly reason: string; readonly detail: string }

type RegistryCandidate = { readonly projectId: string; readonly root: string }

/**
 * Every registered project root that CONTAINS the workspace, deepest first.
 *
 * Roots are canonicalized before comparison because the registry and the desktop
 * app spell the same directory differently on the observed host: `hrc-ios` is
 * registered at `~/praesidium/hrc-ios`, which is a symlink to
 * `~/praesidium/clients/hrc-ios` — the path desktop reports. Comparing the
 * spellings would miss the match and hand the workspace to `praesidium`, which
 * is exactly T-07514.
 */
function containingRegistryRoots(
  workspace: string,
  projects: readonly WrkqProjectRegistryEntry[],
  env: Record<string, string | undefined>
): RegistryCandidate[] {
  const candidates: RegistryCandidate[] = []
  for (const project of projects) {
    const projectId = project.slug ?? project.path
    const root = project.root
    if (projectId === undefined || root === undefined || root === null) continue
    if (root.trim().length === 0) continue
    const canonicalRoot = canonicalPath(expandRegistryHome(root.trim(), env))
    if (!isSameOrInside(workspace, canonicalRoot)) continue
    candidates.push({ projectId, root: canonicalRoot })
  }
  return candidates.sort((left, right) => right.root.length - left.root.length)
}

/**
 * Resolve the project for a desktop workspace.
 *
 * @param workspaceCwd the workspace the desktop hook reported (`session_meta.cwd`)
 */
export function resolveDesktopProjectBinding(input: {
  readonly workspaceCwd: string
  readonly env: Record<string, string | undefined>
  /** Test seam; production reads `wrkq projects --json`. */
  readonly registryProjects?: readonly WrkqProjectRegistryEntry[] | undefined
  /** Test seam for the ASP marker walk-up boundary. */
  readonly agentsRoot?: string | undefined
}): DesktopProjectResolution {
  const workspace = canonicalPath(input.workspaceCwd)
  const projects = input.registryProjects ?? readWrkqProjectRegistry(input.env)
  const registryCandidates = containingRegistryRoots(workspace, projects, input.env)

  const agentsRoot = input.agentsRoot ?? safeAgentsRoot(input.env)
  const marker = findProjectMarker(workspace, agentsRoot === undefined ? {} : { agentsRoot })
  const markerRoot = marker === undefined ? undefined : canonicalPath(marker.dir)

  const deepestRegistry = registryCandidates[0]

  if (deepestRegistry === undefined && markerRoot === undefined) {
    return {
      pending: true,
      reason: 'project_unresolved',
      detail: `no registered project root and no project marker contains ${workspace}`,
    }
  }

  if (deepestRegistry === undefined) {
    // A real boundary exists (a git root or an `asp-targets.toml`) but no
    // project declares it. Registering under an undeclared id would mint a
    // permanent address in a namespace nothing else can reach, so this is
    // pending with the fix named rather than a plausible guess.
    return {
      pending: true,
      reason: 'project_unregistered',
      detail: `workspace boundary ${markerRoot} is not a registered project; run \`wrkq set <project> --root ${markerRoot}\``,
    }
  }

  if (markerRoot === undefined || isSameOrInside(markerRoot, deepestRegistry.root)) {
    // Marker at or above the registered root, or no marker at all: the registry
    // is the more specific and canonical authority. This is the branch that
    // fixes T-07514 — `hrc-ios` is registered, `praesidium` merely encloses it.
    if (markerRoot !== undefined && markerRoot !== deepestRegistry.root) {
      // A nested boundary INSIDE the registered root that is not itself
      // registered (a linked worktree, say). Two defensible answers exist and
      // choosing silently is how a wrong project gets frozen forever.
      return {
        pending: true,
        reason: 'project_ambiguous',
        detail:
          `workspace ${workspace} sits under registered project "${deepestRegistry.projectId}" ` +
          `(${deepestRegistry.root}) but its own boundary is ${markerRoot}; ` +
          `register that boundary with \`wrkq set <project> --root ${markerRoot}\` to disambiguate`,
      }
    }
    return {
      bound: {
        projectId: deepestRegistry.projectId,
        projectRoot: deepestRegistry.root,
        resolvedBy: markerRoot === undefined ? 'registry' : 'registry+marker',
      },
    }
  }

  // Marker root strictly ABOVE the registered root cannot happen — the registry
  // candidate contains the workspace and the marker is found by walking up from
  // it — but if the two authorities ever disagree in a way this code did not
  // anticipate, refuse instead of picking one.
  return {
    pending: true,
    reason: 'project_ambiguous',
    detail: `registered root ${deepestRegistry.root} and workspace boundary ${markerRoot} disagree for ${workspace}`,
  }
}

function safeAgentsRoot(env: Record<string, string | undefined>): string | undefined {
  try {
    return getAgentsRoot({ env })
  } catch {
    return undefined
  }
}
