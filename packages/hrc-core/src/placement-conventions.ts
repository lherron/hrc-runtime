/**
 * T-08597 — HRC-owned placement conventions vendored from ASP.
 *
 * HRC retains "project and worktree placement policy … home designation"
 * (hrc-runtime.declaration-observation-consumer). The functions below are
 * trivially HRC-shaped path conventions with no ASP declaration semantics:
 * marker discovery, home designation defaults, and routing grammar data.
 * ASP-owned interpretation (profile/targets parsing, catalog, priming) is NOT
 * here — it is observed from the daemon's aspd-backed declaration resolution.
 *
 * ASP origin (behavioral copies at hrc-runtime ad04040d; do not extend with
 * new ASP knowledge):
 * - PROJECT_MARKER_FILENAME / findProjectMarker / inferProjectIdFromCwd /
 *   getAgentsRoot / getAspHome / DEFAULT_ASP_HOME ← spaces-config
 *   (store/runtime-placement.js, store/asp-config.js, store/paths.js)
 * - ROSTER_SLOT_TOKENS ← spaces-config core/types/agent-profile.js (data only)
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type HrcRunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export type HrcRuntimeBundleRef =
  | {
      kind: 'agent-project'
      agentName: string
      projectRoot?: string | undefined
    }
  | {
      kind: 'compose'
      compose: `space:${string}@${string}`[]
    }

export interface HrcRunScaffoldPacket {
  slot: string
  content?: string | undefined
  ref?: string | undefined
  contentType?: 'markdown' | 'json' | 'text' | undefined
  version?: string | undefined
}

export interface HrcHostCorrelation {
  hostSessionId?: string | undefined
  runId?: string | undefined
  generation?: number | undefined
  sessionRef?: { scopeRef: string; laneRef: string } | undefined
}

export interface HrcRuntimePlacement {
  agentRoot: string
  projectRoot?: string | undefined
  cwd?: string | undefined
  runMode: HrcRunMode
  bundle: HrcRuntimeBundleRef
  scaffoldPackets?: HrcRunScaffoldPacket[] | undefined
  correlation?: HrcHostCorrelation | undefined
  dryRun?: boolean | undefined
}

export interface HrcResolvedAgentPlacementPaths {
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  searchedAgentRoots?: string[] | undefined
  warnings?: string[] | undefined
}

export interface HrcAttachmentRef {
  kind: 'url' | 'file'
  filename?: string | undefined
  url?: string | undefined
  path?: string | undefined
  contentType?: string | undefined
  sizeBytes?: number | undefined
  alt?: string | undefined
}

/** Filename that marks a directory as an ASP project root. */
export const PROJECT_MARKER_FILENAME = 'asp-targets.toml'

export interface ProjectMarker {
  dir: string
  id: string
}

/** Default ASP_HOME location. */
export function defaultAspHome(): string {
  return join(homedir(), '.asp')
}

/**
 * Get the ASP_HOME directory path.
 * Uses ASP_HOME env var if set, otherwise defaults to ~/.asp
 */
export function getAspHome(): string {
  return process.env['ASP_HOME'] ?? defaultAspHome()
}

function readAspConfigFile(opts?: {
  aspHome?: string | undefined
  env?: Record<string, string | undefined> | undefined
}): Record<string, unknown> | undefined {
  const env = opts?.env ?? process.env
  const aspHome = opts?.aspHome ?? env['ASP_HOME'] ?? defaultAspHome()
  const configPath = join(aspHome, 'config.toml')
  if (!existsSync(configPath)) return undefined
  try {
    const content = readFileSync(configPath, 'utf8')
    const runtime = globalThis as unknown as {
      Bun?: { TOML?: { parse(input: string): unknown } } | undefined
    }
    const parsed = runtime.Bun?.TOML?.parse(content)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

function expandHomePath(value: string, env: Record<string, string | undefined>): string {
  if (!value.startsWith('~')) return value
  const home = env['HOME'] ?? homedir()
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

function getConfiguredRoot(
  envKey: string,
  configKey: string,
  opts?: { aspHome?: string | undefined; env?: Record<string, string | undefined> | undefined }
): string | undefined {
  const env = opts?.env ?? process.env
  const fromEnv = env[envKey]
  if (fromEnv) return expandHomePath(fromEnv, env)
  const config = readAspConfigFile(opts)
  const fromConfig = config?.[configKey]
  return typeof fromConfig === 'string' ? expandHomePath(fromConfig, env) : undefined
}

export function getAgentsRoot(opts?: {
  aspHome?: string | undefined
  env?: Record<string, string | undefined> | undefined
}): string | undefined {
  const explicit = getConfiguredRoot('ASP_AGENTS_ROOT', 'agents-root', opts)
  if (explicit) return explicit
  const env = opts?.env
  const home = env === undefined ? (process.env['HOME'] ?? homedir()) : env['HOME']
  if (!home) return undefined
  const conventionPath = join(home, 'praesidium', 'var', 'agents')
  return existsSync(conventionPath) ? conventionPath : undefined
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir)
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Walk up from `startDir` looking for an `asp-targets.toml`, or infer an
 * implicit marker from the containing git repository.
 */
export function findProjectMarker(
  startDir: string,
  options?: {
    agentsRoot?: string | undefined
    agentRoots?: string[] | undefined
    projectRoot?: string | undefined
  }
): ProjectMarker | undefined {
  let dir = resolve(startDir)
  const agentRoots = [
    ...(options?.agentRoots ?? []),
    ...(options?.agentsRoot ? [options.agentsRoot] : []),
  ].map((root) => resolve(root))
  const allowedProjectRoot = options?.projectRoot ? resolve(options.projectRoot) : undefined
  const gitRoot = findGitRoot(dir)
  const boundaryFor = (path: string): string | undefined =>
    agentRoots.find((root) => isSameOrInside(path, root))
  const canCrossBoundary = (root: string): boolean =>
    allowedProjectRoot !== undefined && isSameOrInside(root, allowedProjectRoot)
  while (true) {
    const boundary = boundaryFor(dir)
    if (boundary !== undefined && !canCrossBoundary(boundary)) {
      return undefined
    }
    if (boundary === undefined && existsSync(join(dir, PROJECT_MARKER_FILENAME))) {
      return { dir, id: basename(dir) }
    }
    if (gitRoot && dir === gitRoot) break
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  const gitBoundary = gitRoot ? boundaryFor(gitRoot) : undefined
  if (gitRoot && (gitBoundary === undefined || canCrossBoundary(gitBoundary))) {
    return { dir: gitRoot, id: basename(gitRoot) }
  }
  return undefined
}

/**
 * Infer a projectId from the current working directory.
 *
 * Resolution: `asp-targets.toml` (or implicit git-repo root) found by walking
 * up from cwd — id = basename(markerDir). Intentionally does NOT consult
 * `ASP_PROJECT`.
 */
export function inferProjectIdFromCwd(options?: {
  cwd?: string | undefined
  aspHome?: string | undefined
  env?: Record<string, string | undefined> | undefined
}): string | undefined {
  const env = options?.env ?? process.env
  const agentsRoot = getAgentsRoot({
    ...(options?.aspHome ? { aspHome: options.aspHome } : {}),
    env,
  })
  const marker = findProjectMarker(options?.cwd ?? process.cwd(), { agentsRoot })
  return marker?.id
}

/**
 * Closed suffix namespace reserved by every declared placement home base.
 * Data copied from spaces-config core/types/agent-profile.js — routing grammar
 * data owned by HRC's roster policy, not catalog interpretation.
 */
export const ROSTER_SLOT_TOKENS: readonly string[] = [
  'nova',
  'comet',
  'pulsar',
  'quasar',
  'meteor',
  'aurora',
  'zenith',
  'eclipse',
  'orbit',
  'cosmos',
]
