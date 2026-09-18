/**
 * T-08597 — daemon-backed agent placement resolution.
 *
 * `resolveHrcAgentPlacementPaths` keeps its name and result shape but no
 * longer interprets ASP declarations in-process: placement policy runs on the
 * installed daemon (`POST /v1/placements/resolve`) and profile/targets/catalog
 * facts arrive via the daemon's aspd observation. A missing daemon socket (or
 * an unreachable daemon) is a typed `runtime_unavailable` HrcDomainError —
 * never a local fallback. The daemon reads its OWN environment and registry;
 * caller-side `env`/`aspHome` overrides are not honored (documented delta from
 * the local resolver; the parity table runs both sides on the same node).
 */

import {
  HrcDomainError,
  HrcErrorCode,
  type ResolvePlacementRequest,
  type ResolvePlacementResponse,
  type ResolvedAgentHarness,
  type WrkqProjectRegistryEntry,
  isCanonicalCheckout as isCanonicalCheckoutCore,
  isLinkedCheckout as isLinkedCheckoutCore,
  parseWorktreePorcelain as parseWorktreePorcelainCore,
  resolveControlSocketPath,
  taskTokens as taskTokensCore,
} from 'hrc-core'

import { HrcClient } from './client.js'
import { discoverSocket } from './discover.js'
import type { ProjectOrigin } from './resolve-scope.js'

export type ProjectPlacementSource =
  | 'explicit-override'
  | 'wrkq-registry'
  | 'marker-scan'
  | 'sibling-fallback'
  | 'task-worktree'
  | 'inferred'
  | 'projectless'

export interface ProjectPlacementResolution {
  source: ProjectPlacementSource
  projectId?: string | undefined
  canonicalRoot?: string | undefined
  cwd?: string | undefined
  branch?: string | undefined
  reason: string
}

export interface HrcResolvedAgentPlacementPaths {
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  searchedAgentRoots?: string[] | undefined
  warnings?: string[] | undefined
  resolution: ProjectPlacementResolution
}

/**
 * The registry shape lives in `hrc-core` so the daemon's own placement resolver
 * reads the same authority this one does (T-07749).
 */
export type ProjectRegistryEntry = WrkqProjectRegistryEntry

export interface ResolveHrcAgentPlacementPathsOptions {
  agentId: string
  projectId?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  projectOrigin: ProjectOrigin
  taskId?: string | undefined
  /** Strict for launch placement; advisory for messaging/read selectors. */
  taskWorktreeAssociation?: 'strict' | 'advisory' | undefined
  /** Test seam; production leaves this undefined so the daemon reads its registry. */
  registryProjects?: ProjectRegistryEntry[] | undefined
  /** Test seam; production leaves this undefined so the daemon uses its search roots. */
  projectSearchRoots?: string[] | undefined
  /** Test/operator seam for the scratch-daemon proof; production discovers the socket. */
  socketPath?: string | undefined
}

function missingSocketError(): HrcDomainError {
  const socketPath = resolveControlSocketPath()
  return new HrcDomainError(
    HrcErrorCode.RUNTIME_UNAVAILABLE,
    `HRC daemon socket not found at ${socketPath}. Is the HRC server running?`,
    { code: 'hrc_daemon_missing_socket', socketPath }
  )
}

function placementClient(socketPath: string | undefined): HrcClient {
  if (socketPath !== undefined) return new HrcClient(socketPath)
  try {
    return new HrcClient(discoverSocket())
  } catch {
    throw missingSocketError()
  }
}

/**
 * Build the placements/resolve request from wrapper options (pure; pinned by
 * unit tests). The daemon reads its own environment and registry; test seams
 * ride explicitly.
 */
export function buildPlacementRequest(
  options: ResolveHrcAgentPlacementPathsOptions
): ResolvePlacementRequest {
  return {
    agentId: options.agentId,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.agentRoot !== undefined ? { agentRoot: options.agentRoot } : {}),
    projectOrigin: options.projectOrigin,
    ...(options.taskWorktreeAssociation !== undefined
      ? { taskWorktreeAssociation: options.taskWorktreeAssociation }
      : {}),
    ...(options.registryProjects !== undefined
      ? { registryProjects: options.registryProjects }
      : {}),
    ...(options.projectSearchRoots !== undefined
      ? { projectSearchRoots: options.projectSearchRoots }
      : {}),
  }
}

/**
 * Map a daemon agent-miss (declaration_invalid + producerCode agent_not_found)
 * to the local-equivalent placement: no agentRoot, searched roots, and the
 * inferred resolution — never a throw.
 */
export function toMissedPaths(
  options: Pick<ResolveHrcAgentPlacementPathsOptions, 'projectId'>,
  detail:
    | {
        searchedAgentRoots?: string[] | undefined
        projectRoot?: string | undefined
        cwd?: string | undefined
      }
    | undefined
): HrcResolvedAgentPlacementPaths {
  return {
    ...(detail?.projectRoot !== undefined ? { projectRoot: detail.projectRoot } : {}),
    ...(detail?.cwd !== undefined ? { cwd: detail.cwd } : {}),
    ...(Array.isArray(detail?.searchedAgentRoots) && detail.searchedAgentRoots.length > 0
      ? { searchedAgentRoots: detail.searchedAgentRoots }
      : {}),
    resolution: {
      source: 'inferred',
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      reason:
        options.projectId !== undefined
          ? `cwd from inferred project ${options.projectId}`
          : 'cwd from agent root (project-less scope)',
    },
  }
}

/**
 * SDK-internal: raw daemon placement observation (full response, including
 * identity/harness facts resolve-scope needs). One socket round trip.
 */
export async function resolvePlacementObservation(
  options: ResolveHrcAgentPlacementPathsOptions
): Promise<ResolvePlacementResponse> {
  return placementClient(options.socketPath).resolvePlacement(buildPlacementRequest(options))
}

export function toResolvedPaths(
  response: ResolvePlacementResponse
): HrcResolvedAgentPlacementPaths {
  return {
    ...(response.agentRoot !== undefined ? { agentRoot: response.agentRoot } : {}),
    ...(response.projectRoot !== undefined ? { projectRoot: response.projectRoot } : {}),
    ...(response.cwd !== undefined ? { cwd: response.cwd } : {}),
    ...(response.searchedAgentRoots.length > 0
      ? { searchedAgentRoots: response.searchedAgentRoots }
      : {}),
    ...(response.warnings.length > 0 ? { warnings: response.warnings } : {}),
    resolution: {
      source: response.resolution.source as ProjectPlacementSource,
      ...(response.resolution.projectId !== undefined
        ? { projectId: response.resolution.projectId }
        : {}),
      ...(response.resolution.canonicalRoot !== undefined
        ? { canonicalRoot: response.resolution.canonicalRoot }
        : {}),
      ...(response.resolution.cwd !== undefined ? { cwd: response.resolution.cwd } : {}),
      ...(response.resolution.branch !== undefined ? { branch: response.resolution.branch } : {}),
      reason: response.resolution.reason,
    },
  }
}

/**
 * The daemon reports an unknown agent as declaration_invalid + producerCode
 * agent_not_found (detail carries searchedAgentRoots and any resolved
 * projectRoot/cwd). Both placement entry points treat it as a lenient miss,
 * exactly as the local resolver returned — never a throw.
 */
export function isAgentNotFoundError(error: unknown): error is HrcDomainError {
  return (
    error instanceof HrcDomainError &&
    error.code === HrcErrorCode.DECLARATION_INVALID &&
    (error.detail as { producerCode?: unknown } | undefined)?.producerCode === 'agent_not_found'
  )
}

/**
 * HRC-owned placement resolution layered over the daemon's aspd-backed
 * observation.
 *
 * Inferred projects retain the cwd walk-up; explicit projects resolve from
 * explicit override, wrkq registry, marker scan, or sibling fallback, then
 * optionally refine to the task's live git worktree. An unresolvable agent
 * resolves to a placement WITHOUT agentRoot (with searchedAgentRoots), exactly
 * as the local resolver returned; an unresolvable explicit project throws with
 * the same message the local resolver threw.
 */
export async function resolveHrcAgentPlacementPaths(
  options: ResolveHrcAgentPlacementPathsOptions
): Promise<HrcResolvedAgentPlacementPaths> {
  let response: ResolvePlacementResponse
  try {
    response = await resolvePlacementObservation(options)
  } catch (error) {
    if (isAgentNotFoundError(error)) {
      return toMissedPaths(options, error.detail as { searchedAgentRoots?: string[] } | undefined)
    }
    throw error
  }
  return toResolvedPaths(response)
}

/**
 * T-08597 — daemon-backed agent harness resolution (same name, same result
 * shape, async over the socket). The provider, frontend harness, and
 * provisioning baseline are observed from the agent's declaration; HRC
 * performs no profile parsing or catalog lookup. `harness` is the observed
 * frontend form (canonical `entry.frontend`); profiles that declare bare
 * catalog ids surface here in frontend form — the one documented value-level
 * delta from the local merge, listed in the parity table.
 */
export async function resolveAgentHarness(input: {
  agentRoot: string
  agentId: string
  projectRoot?: string | undefined
  socketPath?: string | undefined
}): Promise<ResolvedAgentHarness> {
  const observation = await resolvePlacementObservation({
    agentId: input.agentId,
    agentRoot: input.agentRoot,
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    projectOrigin: 'explicit',
    ...(input.socketPath !== undefined ? { socketPath: input.socketPath } : {}),
  })
  return {
    provider: observation.harness.provider,
    harness: observation.harness.frontend,
    provision: observation.provision.scalars as ResolvedAgentHarness['provision'],
  }
}

export const projectPlacementInternals = {
  isCanonicalCheckout: isCanonicalCheckoutCore,
  isLinkedCheckout: isLinkedCheckoutCore,
  parseWorktreePorcelain: parseWorktreePorcelainCore,
  taskTokens: taskTokensCore,
}
