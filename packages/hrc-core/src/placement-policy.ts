/**
 * T-08597 — HRC-owned project placement policy.
 *
 * Pure policy helpers for resolving a project root from a project id: explicit
 * override, wrkq-registry lookup, cwd-independent marker scan, sibling
 * fallback, and task-worktree refinement. Ported from hrc-sdk's
 * project-placement resolver so the daemon's `POST /v1/placements/resolve`
 * route and every SDK/CLI caller share one authority. No ASP imports: project
 * and worktree placement policy is HRC-retained law
 * (hrc-runtime.declaration-observation-consumer); ASP-owned facts (agent
 * existence, manifest interpretation, catalog) arrive via aspd observation and
 * are applied by the caller, never derived here.
 */

import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { environmentWithoutGitOverrides } from './git-environment.js'
import { findProjectMarker } from './placement-conventions.js'
import { type WrkqProjectRegistryEntry, findWrkqProjectEntry } from './project-registry.js'

export type GitWorktree = {
  path: string
  branch?: string | undefined
}

export function expandHome(path: string, env: Record<string, string | undefined>): string {
  const home = env['HOME'] ?? homedir()
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isCanonicalCheckout(path: string): boolean {
  return isDirectory(join(path, '.git'))
}

export function isLinkedCheckout(path: string): boolean {
  try {
    return statSync(join(path, '.git')).isFile()
  } catch {
    return false
  }
}

export function defaultProjectSearchRoots(env: Record<string, string | undefined>): string[] {
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

export function markerScanCandidates(
  projectId: string,
  registryEntry: WrkqProjectRegistryEntry | undefined,
  roots: string[]
): string[] {
  const relativeCandidates = new Set<string>([projectId])
  if (registryEntry?.path) relativeCandidates.add(registryEntry.path)

  const candidates = new Set<string>()
  for (const root of roots) {
    for (const relativePath of relativeCandidates) {
      candidates.add(resolve(root, relativePath))
    }

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

/**
 * Sibling fallback (HRC policy): the checkout that sits beside the caller's
 * cwd, or beside the praesidium source root above the agent home. This is the
 * discovery ACP's real-launcher and the federation summon path apply when the
 * registry and marker scan miss — e.g. cody@agent-spaces launched from the
 * agent-control-plane checkout, whose sibling agent-spaces checkout is the
 * project root. Candidates mirror those callers exactly; each is accepted when
 * a marker walk from it finds a project root (no canonical-checkout gate, as
 * in the callers).
 */
export function siblingFallbackCandidates(projectId: string, cwd: string): string[] {
  return [join(cwd, projectId)]
}

export function agentHomeRelativeSibling(
  projectId: string,
  agentRoot: string | undefined
): string | undefined {
  if (agentRoot === undefined) return undefined
  const agentsRoot = dirname(agentRoot)
  const runtimeVarRoot = dirname(agentsRoot)
  if (basename(agentsRoot) !== 'agents' || basename(runtimeVarRoot) !== 'var') return undefined
  return join(dirname(runtimeVarRoot), projectId)
}

export function resolveSiblingProjectRoot(
  projectId: string,
  options: { cwd: string; agentRoot?: string | undefined; agentsRoot?: string | undefined }
): string | undefined {
  const candidates = siblingFallbackCandidates(projectId, options.cwd)
  const relative = agentHomeRelativeSibling(projectId, options.agentRoot)
  if (relative !== undefined) candidates.push(relative)
  for (const candidate of candidates) {
    const marker = findProjectMarker(candidate, {
      ...(options.agentsRoot ? { agentsRoot: options.agentsRoot } : {}),
    })
    if (marker !== undefined) return marker.dir
  }
  return undefined
}

export function taskTokens(value: string): string[] {
  return [...value.matchAll(/(?<!\d)T-\d+(?!\d)/g)].map((match) => match[0])
}

export function parseWorktreePorcelain(output: string): GitWorktree[] {
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

/**
 * `git worktree list` for a checkout, never blocking the caller's thread
 * (T-08783: the daemon reached this on every task-scoped placement and the
 * spawnSync alone was ~5s of main-thread time in a 23-minute profile).
 *
 * A canonical checkout's answer is memoized against a stat fingerprint of the
 * files `git worktree add|remove|move|prune` and a branch switch rewrite, so a
 * new task worktree is seen on the very next call — no TTL window in which a
 * placement could miss it. Concurrent callers for the same key share one child.
 */
const worktreeListCache = new Map<string, { fingerprint: string; worktrees: GitWorktree[] }>()
const worktreeListInFlight = new Map<string, Promise<GitWorktree[]>>()

const GIT_LOCATION_OVERRIDES = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'] as const

function mtimeOf(path: string): string {
  try {
    return String(statSync(path).mtimeMs)
  } catch {
    return '-'
  }
}

/** undefined = not fingerprintable (linked checkout, or the env relocates git). */
function worktreeFingerprint(
  canonicalRoot: string,
  env: Record<string, string | undefined>
): string | undefined {
  if (GIT_LOCATION_OVERRIDES.some((key) => env[key] !== undefined)) return undefined
  const gitDir = join(canonicalRoot, '.git')
  if (!isDirectory(gitDir)) return undefined
  const worktreesDir = join(gitDir, 'worktrees')
  const parts = [mtimeOf(join(gitDir, 'HEAD')), mtimeOf(worktreesDir)]
  let names: string[] = []
  try {
    names = readdirSync(worktreesDir).sort()
  } catch {
    // No linked worktrees yet: the directory mtime above ('-') covers creation.
  }
  for (const name of names) {
    const admin = join(worktreesDir, name)
    parts.push(name, mtimeOf(join(admin, 'HEAD')), mtimeOf(join(admin, 'gitdir')))
  }
  return parts.join('|')
}

function spawnGitWorktreeList(
  canonicalRoot: string,
  env: Record<string, string | undefined>
): Promise<GitWorktree[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-C', canonicalRoot, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', env: env as NodeJS.ProcessEnv, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const status = typeof error.code === 'number' ? error.code : undefined
          const diagnostic =
            String(stderr ?? '').trim() || `git exited ${status ?? 'without status'}`
          reject(new Error(`cannot inspect worktrees for ${canonicalRoot}: ${diagnostic}`))
          return
        }
        resolvePromise(parseWorktreePorcelain(stdout))
      }
    )
  })
}

async function listGitWorktrees(
  canonicalRoot: string,
  explicitEnv: Record<string, string | undefined>
): Promise<GitWorktree[]> {
  const env = { ...environmentWithoutGitOverrides(), ...explicitEnv }
  const fingerprint = worktreeFingerprint(canonicalRoot, env)
  if (fingerprint === undefined) return spawnGitWorktreeList(canonicalRoot, env)

  const cached = worktreeListCache.get(canonicalRoot)
  if (cached !== undefined && cached.fingerprint === fingerprint) return cached.worktrees

  const flightKey = `${canonicalRoot}\0${fingerprint}`
  const inFlight = worktreeListInFlight.get(flightKey)
  if (inFlight !== undefined) return inFlight
  const listing = spawnGitWorktreeList(canonicalRoot, env)
    .then((worktrees) => {
      worktreeListCache.set(canonicalRoot, { fingerprint, worktrees })
      return worktrees
    })
    .finally(() => worktreeListInFlight.delete(flightKey))
  worktreeListInFlight.set(flightKey, listing)
  return listing
}

export async function refineTaskWorktree(
  canonicalRoot: string,
  taskId: string | undefined,
  explicitEnv: Record<string, string | undefined>
): Promise<{ path: string; branch?: string | undefined } | undefined> {
  if (!taskId || !/^T-\d+$/.test(taskId)) return undefined

  const worktrees = await listGitWorktrees(canonicalRoot, explicitEnv)
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
    const mismatch = suspicious.branch
      ? `branch ${suspicious.branch} does not carry ${taskId}`
      : 'is detached HEAD (no branch)'
    throw new Error(
      `worktree at ${suspicious.path} appears associated with ${taskId} but ${mismatch}`
    )
  }
  return undefined
}

export function didYouMeanExplicitTaskProject(
  projects: readonly WrkqProjectRegistryEntry[],
  projectId: string
): string | undefined {
  const taskId = taskTokens(projectId)[0]
  if (!taskId) return undefined
  const knownProject = projects
    .map((project) => project.slug ?? project.path ?? project.title)
    .filter((candidate): candidate is string => Boolean(candidate))
    .sort((left, right) => right.length - left.length)
    .find((candidate) => projectId.startsWith(`${candidate}-`))
  return knownProject ? `did you mean @${knownProject}:${taskId}` : undefined
}

export type CanonicalProjectRoot = {
  root: string
  source: 'explicit-override' | 'wrkq-registry' | 'marker-scan' | 'sibling-fallback'
}

/**
 * Resolve the canonical project root for an explicit project id through HRC
 * policy, in order: explicit override, wrkq registry, marker scan, sibling
 * fallback. Throws with the same messages hrc-sdk's resolver throws today when
 * nothing resolves (callers surface them as typed placement failures).
 */
export function resolveCanonicalProjectRoot(
  projectId: string,
  options: {
    env: Record<string, string | undefined>
    cwd: string
    agentRoot?: string | undefined
    projectRootOverride?: string | undefined
    /**
     * The wrkq project registry, already loaded. REQUIRED: this resolver never
     * reads wrkq itself, so no caller (the daemon least of all) can reach a
     * blocking subprocess through it (T-08783).
     */
    registryProjects: readonly WrkqProjectRegistryEntry[]
    projectSearchRoots?: string[] | undefined
  }
): CanonicalProjectRoot {
  const env = options.env
  const override = options.projectRootOverride ?? env['ASP_PROJECT_ROOT_OVERRIDE']
  if (override) {
    const projectRoot = resolve(expandHome(override, env))
    if (!isDirectory(projectRoot)) {
      throw new Error(`explicit project root does not exist or is not a directory: ${projectRoot}`)
    }
    return { root: projectRoot, source: 'explicit-override' }
  }

  const projects = options.registryProjects
  const registryEntry = findWrkqProjectEntry(projects, projectId)
  if (registryEntry?.root) {
    const canonicalRoot = resolve(expandHome(registryEntry.root, env))
    if (!isCanonicalCheckout(canonicalRoot)) {
      const kind = isLinkedCheckout(canonicalRoot)
        ? 'is a linked worktree'
        : 'is not a canonical git checkout'
      throw new Error(
        `registered root for ${projectId} ${canonicalRoot} ${kind}; repair it with: wrkq set ${projectId} --root <canonical>`
      )
    }
    return { root: canonicalRoot, source: 'wrkq-registry' }
  }

  const roots = options.projectSearchRoots ?? defaultProjectSearchRoots(env)
  const scanned = markerScanCandidates(projectId, registryEntry, roots).find(isCanonicalCheckout)
  if (scanned) return { root: scanned, source: 'marker-scan' }

  const sibling = resolveSiblingProjectRoot(projectId, {
    cwd: options.cwd,
    ...(options.agentRoot !== undefined ? { agentRoot: options.agentRoot } : {}),
  })
  if (sibling) return { root: sibling, source: 'sibling-fallback' }

  const suggestion = didYouMeanExplicitTaskProject(projects, projectId)
  throw new Error(
    `project root unknown for ${projectId}; register it with: wrkq set ${projectId} --root <path>${
      suggestion ? `; ${suggestion}` : ''
    }`
  )
}
