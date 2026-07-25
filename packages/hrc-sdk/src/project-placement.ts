import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type ResolveAgentPlacementPathsOptions,
  type ResolvedAgentPlacementPaths,
  resolveAgentPlacementPaths,
} from 'spaces-config'

import type { ProjectOrigin } from './resolve-scope.js'

export type ProjectPlacementSource =
  | 'explicit-override'
  | 'wrkq-registry'
  | 'marker-scan'
  | 'task-worktree'
  | 'inferred'

export interface ProjectPlacementResolution {
  source: ProjectPlacementSource
  projectId?: string | undefined
  canonicalRoot?: string | undefined
  cwd?: string | undefined
  branch?: string | undefined
  reason: string
}

export interface HrcResolvedAgentPlacementPaths extends ResolvedAgentPlacementPaths {
  resolution: ProjectPlacementResolution
}

export interface ProjectRegistryEntry {
  slug?: string | undefined
  path?: string | undefined
  title?: string | undefined
  root?: string | null | undefined
}

export interface ResolveHrcAgentPlacementPathsOptions extends ResolveAgentPlacementPathsOptions {
  projectOrigin: ProjectOrigin
  taskId?: string | undefined
  /** Test seam; production reads `wrkq projects --json`. */
  registryProjects?: ProjectRegistryEntry[] | undefined
  /** Test/operator seam; production scans the canonical Praesidium source root. */
  projectSearchRoots?: string[] | undefined
}

type GitWorktree = {
  path: string
  branch?: string | undefined
}

function expandHome(path: string, env: Record<string, string | undefined>): string {
  const home = env['HOME'] ?? homedir()
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isCanonicalCheckout(path: string): boolean {
  return isDirectory(join(path, '.git'))
}

function readProjectRegistry(env: Record<string, string | undefined>): ProjectRegistryEntry[] {
  const result = spawnSync('wrkq', ['projects', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0 || !result.stdout) return []
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    return Array.isArray(parsed) ? (parsed as ProjectRegistryEntry[]) : []
  } catch {
    return []
  }
}

function findRegistryEntry(
  projects: ProjectRegistryEntry[],
  projectId: string
): ProjectRegistryEntry | undefined {
  return projects.find(
    (project) =>
      project.slug === projectId || project.path === projectId || project.title === projectId
  )
}

function defaultProjectSearchRoots(env: Record<string, string | undefined>): string[] {
  const configured = env['HRC_PROJECT_SEARCH_ROOTS']
  if (configured) {
    return configured
      .split(':')
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => resolve(expandHome(path, env)))
  }
  return [join(env['HOME'] ?? homedir(), 'praesidium')]
}

function markerScanCandidates(
  projectId: string,
  registryEntry: ProjectRegistryEntry | undefined,
  roots: string[]
): string[] {
  const relativeCandidates = new Set<string>([projectId])
  if (registryEntry?.path) relativeCandidates.add(registryEntry.path)

  const candidates = new Set<string>()
  for (const root of roots) {
    for (const relativePath of relativeCandidates) {
      candidates.add(resolve(root, relativePath))
    }

    // Registry-free projects normally live one directory below the source root.
    // Listing that level lets a marker whose directory name is the project id win
    // without consulting the sender's cwd.
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === projectId) {
          candidates.add(resolve(root, entry.name))
        }
      }
    } catch {
      // Missing search roots are simply absent candidates.
    }
  }
  return [...candidates]
}

function parseWorktreePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = []
  let current: GitWorktree | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = { path: line.slice('worktree '.length) }
      continue
    }
    if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      continue
    }
    if (line.length === 0 && current) {
      worktrees.push(current)
      current = undefined
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

function listGitWorktrees(
  canonicalRoot: string,
  env: Record<string, string | undefined>
): GitWorktree[] {
  const result = spawnSync('git', ['-C', canonicalRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim() || `git exited ${result.status ?? 'without status'}`
    throw new Error(`cannot inspect worktrees for ${canonicalRoot}: ${diagnostic}`)
  }
  return parseWorktreePorcelain(result.stdout)
}

function taskTokens(value: string): string[] {
  return [...value.matchAll(/(?<!\d)T-\d+(?!\d)/g)].map((match) => match[0])
}

function refineTaskWorktree(
  canonicalRoot: string,
  taskId: string | undefined,
  env: Record<string, string | undefined>
): { path: string; branch?: string | undefined } | undefined {
  if (!taskId || !/^T-\d+$/.test(taskId)) return undefined

  const worktrees = listGitWorktrees(canonicalRoot, env)
  const matches = worktrees.filter(
    (worktree) => worktree.branch && taskTokens(worktree.branch).includes(taskId)
  )
  if (matches.length > 1) {
    throw new Error(
      `multiple worktrees match ${taskId}: ${matches
        .map((worktree) => `${worktree.path} (${worktree.branch})`)
        .join(', ')}`
    )
  }
  if (matches.length === 1) return matches[0]

  const suspicious = worktrees.find((worktree) => taskTokens(worktree.path).includes(taskId))
  if (suspicious) {
    throw new Error(
      `worktree at ${suspicious.path} appears associated with ${taskId} but its branch ${
        suspicious.branch ?? 'detached'
      } does not carry it`
    )
  }
  return undefined
}

function withResolvedProject(
  options: ResolveHrcAgentPlacementPathsOptions,
  projectRoot: string,
  resolution: ProjectPlacementResolution
): HrcResolvedAgentPlacementPaths {
  const paths = resolveAgentPlacementPaths({
    ...options,
    projectRoot,
    cwd: projectRoot,
  })
  return { ...paths, resolution }
}

/**
 * HRC-owned placement policy layered over ASP's agent-root resolver.
 *
 * Inferred projects retain ASP's cwd walk-up unchanged. Explicit projects are
 * resolved from explicit override, wrkq registry, or a cwd-independent marker
 * scan, then optionally refined to the task's live git worktree.
 */
export function resolveHrcAgentPlacementPaths(
  options: ResolveHrcAgentPlacementPathsOptions
): HrcResolvedAgentPlacementPaths {
  const env = options.env ?? process.env
  if (options.projectOrigin === 'inferred' || !options.projectId) {
    const paths = resolveAgentPlacementPaths(options)
    return {
      ...paths,
      resolution: {
        source: 'inferred',
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(paths.cwd ? { cwd: paths.cwd } : {}),
        reason: options.projectId
          ? `cwd from inferred project ${options.projectId}`
          : 'cwd from agent root (project-less scope)',
      },
    }
  }

  const override = options.projectRoot ?? env['ASP_PROJECT_ROOT_OVERRIDE']
  if (override) {
    const projectRoot = resolve(expandHome(override, env))
    return withResolvedProject(options, projectRoot, {
      source: 'explicit-override',
      projectId: options.projectId,
      canonicalRoot: projectRoot,
      cwd: projectRoot,
      reason: `cwd from explicit project root ${projectRoot}`,
    })
  }

  const projects = options.registryProjects ?? readProjectRegistry(env)
  const registryEntry = findRegistryEntry(projects, options.projectId)
  let canonicalRoot: string | undefined
  let canonicalSource: 'wrkq-registry' | 'marker-scan' | undefined
  if (registryEntry?.root) {
    canonicalRoot = resolve(expandHome(registryEntry.root, env))
    canonicalSource = 'wrkq-registry'
  } else {
    const roots = options.projectSearchRoots ?? defaultProjectSearchRoots(env)
    canonicalRoot = markerScanCandidates(options.projectId, registryEntry, roots).find(
      isCanonicalCheckout
    )
    canonicalSource = canonicalRoot ? 'marker-scan' : undefined
  }

  if (!canonicalRoot || !canonicalSource) {
    const fallback = resolveAgentPlacementPaths(options)
    return {
      ...fallback,
      resolution: {
        source: 'inferred',
        projectId: options.projectId,
        ...(fallback.cwd ? { cwd: fallback.cwd } : {}),
        reason: `explicit project ${options.projectId} has no canonical root yet`,
      },
    }
  }

  const worktree = refineTaskWorktree(canonicalRoot, options.taskId, env)
  if (worktree) {
    return withResolvedProject(options, worktree.path, {
      source: 'task-worktree',
      projectId: options.projectId,
      canonicalRoot,
      cwd: worktree.path,
      ...(worktree.branch ? { branch: worktree.branch } : {}),
      reason: `cwd from task worktree ${worktree.path}, branch ${worktree.branch}`,
    })
  }

  return withResolvedProject(options, canonicalRoot, {
    source: canonicalSource,
    projectId: options.projectId,
    canonicalRoot,
    cwd: canonicalRoot,
    reason:
      canonicalSource === 'wrkq-registry'
        ? `cwd from wrkq registry root ${canonicalRoot}`
        : `cwd from marker scan ${canonicalRoot}`,
  })
}

export const projectPlacementInternals = {
  isCanonicalCheckout,
  parseWorktreePorcelain,
  taskTokens,
}
