import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { CliUsageError } from 'cli-kit'
import { resolveDatabasePath } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: string
}

type RegistryProject = {
  slug?: string
  path?: string
  title?: string
  root?: string | null
}

type TaskRecord = {
  id?: string
  state?: string
}

type GitWorktree = {
  path: string
  branch?: string
}

export interface LiveRuntimeOccupancy {
  runtimeId: string
  status: string
  scopeRef: string
  cwd?: string
}

export type WorktreePruneDisposition = 'would-prune' | 'pruned' | 'skipped' | 'error'

export interface WorktreePruneResult {
  projectId: string
  canonicalRoot: string
  path: string
  branch?: string
  taskIds: string[]
  disposition: WorktreePruneDisposition
  reason: string
}

export interface WorktreePruneReport {
  mode: 'dry-run' | 'apply'
  projectsInspected: number
  results: WorktreePruneResult[]
  summary: {
    matched: number
    wouldPrune: number
    pruned: number
    skipped: number
    errors: number
  }
}

export interface WorktreePruneOptions {
  projectId?: string
  projectRoot?: string
  apply?: boolean
  env?: Record<string, string | undefined>
}

export interface WorktreePruneDependencies {
  run?: (command: string, args: string[]) => CommandResult
  listProjects?: () => RegistryProject[]
  readTask?: (taskId: string) => TaskRecord | undefined
  listLiveRuntimeOccupancies?: () => LiveRuntimeOccupancy[]
}

export interface WorktreePruneCommandOptions {
  project?: string
  root?: string
  dryRun?: boolean
  yes?: boolean
  json?: boolean
}

function defaultRun(command: string, args: string[]): CommandResult {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (command !== 'git' || !entry[0].startsWith('GIT_'))
    )
  )
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  }
}

function commandDiagnostic(result: CommandResult): string {
  return (
    result.error?.trim() ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exit ${result.status ?? 'unknown'}`
  )
}

function parseJsonArray<T>(result: CommandResult, label: string): T[] {
  if (result.status !== 0) {
    throw new Error(`${label}: ${commandDiagnostic(result)}`)
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(value)) throw new Error('response is not an array')
    return value as T[]
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function expandHome(path: string, env: Record<string, string | undefined>): string {
  const home = env['HOME'] ?? homedir()
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

function defaultSearchRoot(env: Record<string, string | undefined>): string {
  const configured = env['HRC_PROJECT_SEARCH_ROOTS']
    ?.split(':')
    .map((entry) => entry.trim())
    .find(Boolean)
  return resolve(expandHome(configured ?? '~/praesidium', env))
}

function projectId(project: RegistryProject): string | undefined {
  return project.slug ?? project.path ?? project.title
}

function resolveProjectRoot(
  project: RegistryProject,
  env: Record<string, string | undefined>
): string | undefined {
  if (project.root) return resolve(expandHome(project.root, env))
  const relative = project.path ?? project.slug
  return relative ? resolve(defaultSearchRoot(env), relative) : undefined
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

function isLinkedCheckout(path: string): boolean {
  try {
    return statSync(join(path, '.git')).isFile()
  } catch {
    return false
  }
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
    if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      continue
    }
    if (current && line.length === 0) {
      worktrees.push(current)
      current = undefined
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

export function taskTokens(value: string): string[] {
  return [...new Set([...value.matchAll(/(?<!\d)T-\d+(?!\d)/g)].map((match) => match[0]))]
}

function makeResult(
  project: string,
  root: string,
  worktree: GitWorktree,
  taskIds: string[],
  disposition: WorktreePruneDisposition,
  reason: string
): WorktreePruneResult {
  return {
    projectId: project,
    canonicalRoot: root,
    path: worktree.path,
    ...(worktree.branch ? { branch: worktree.branch } : {}),
    taskIds,
    disposition,
    reason,
  }
}

function defaultProjects(
  run: (command: string, args: string[]) => CommandResult
): RegistryProject[] {
  return parseJsonArray<RegistryProject>(
    run('wrkq', ['projects', '--json']),
    'wrkq projects failed'
  )
}

function defaultTaskReader(
  run: (command: string, args: string[]) => CommandResult
): (taskId: string) => TaskRecord | undefined {
  return (taskId) => {
    const result = run('wrkq', ['cat', taskId, '--json'])
    if (result.status !== 0) {
      // A genuine miss ("task not found") means the record is gone and the
      // worktree must stay; anything else is an infrastructure failure (auth,
      // rpc, missing binary) and must not be mistaken for task state.
      if (/task not found/i.test(result.stderr)) return undefined
      throw new Error(`wrkq cat ${taskId} failed: ${commandDiagnostic(result)}`)
    }
    try {
      const value = JSON.parse(result.stdout) as unknown
      return Array.isArray(value) ? (value[0] as TaskRecord | undefined) : undefined
    } catch {
      throw new Error(`wrkq cat ${taskId} returned unparseable JSON`)
    }
  }
}

const DEAD_RUNTIME_STATUSES = new Set([
  'dead',
  'stale',
  'terminated',
  'stopped',
  'failed',
  'disposed',
  'crashed',
  'exited',
])

function projectionCwd(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const projection = JSON.parse(value) as { process?: { cwd?: unknown } }
    return typeof projection.process?.cwd === 'string' ? projection.process.cwd : undefined
  } catch {
    return undefined
  }
}

function defaultLiveRuntimeOccupancies(): LiveRuntimeOccupancy[] {
  const db = openHrcDatabase(resolveDatabasePath())
  try {
    return db.runtimes
      .listAll()
      .filter((runtime) => !DEAD_RUNTIME_STATUSES.has(runtime.status))
      .map((runtime) => {
        const invocations = db.brokerInvocations.listByRuntimeId(runtime.runtimeId)
        const activeInvocation =
          invocations.find(
            (invocation) => invocation.invocationId === runtime.activeInvocationId
          ) ?? invocations.at(-1)
        const cwd = projectionCwd(activeInvocation?.specProjectionJson)
        return {
          runtimeId: runtime.runtimeId,
          status: runtime.status,
          scopeRef: runtime.scopeRef,
          ...(cwd ? { cwd } : {}),
        }
      })
  } finally {
    db.close()
  }
}

function pathContains(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  const canonical = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  const suffix = relative(canonical(root), canonical(candidate))
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

function scopeProject(scopeRef: string): string | undefined {
  return /(?:^|:)project:([^:]+)/.exec(scopeRef)?.[1]
}

function scopeTask(scopeRef: string): string | undefined {
  return /(?:^|:)task:(T-\d+)(?::|$)/.exec(scopeRef)?.[1]
}

function occupyingRuntime(
  occupancies: LiveRuntimeOccupancy[],
  projectId: string,
  worktreePath: string,
  taskIds: string[]
): LiveRuntimeOccupancy | undefined {
  return occupancies.find((runtime) => {
    if (runtime.cwd) return pathContains(worktreePath, runtime.cwd)

    // Older runtime rows may lack a persisted spec projection. A live exact
    // project/task binding is enough to refuse conservatively.
    const taskId = scopeTask(runtime.scopeRef)
    return (
      scopeProject(runtime.scopeRef) === projectId &&
      taskId !== undefined &&
      taskIds.includes(taskId)
    )
  })
}

/**
 * Audit and optionally remove clean linked worktrees whose task branches are
 * completed and whose HEAD is already reachable from the canonical checkout's
 * HEAD. Branch refs are deliberately preserved.
 */
export function pruneCompletedTaskWorktrees(
  options: WorktreePruneOptions = {},
  dependencies: WorktreePruneDependencies = {}
): WorktreePruneReport {
  const env = options.env ?? process.env
  const run = dependencies.run ?? defaultRun
  const readTask = dependencies.readTask ?? defaultTaskReader(run)
  const listLiveRuntimeOccupancies =
    dependencies.listLiveRuntimeOccupancies ?? defaultLiveRuntimeOccupancies
  let initialOccupancies: LiveRuntimeOccupancy[] | undefined
  const readInitialOccupancies = (): LiveRuntimeOccupancy[] => {
    initialOccupancies ??= listLiveRuntimeOccupancies()
    return initialOccupancies
  }
  const projects =
    options.projectRoot && options.projectId
      ? [{ slug: options.projectId, root: options.projectRoot }]
      : (dependencies.listProjects?.() ?? defaultProjects(run))
  const selectedProjects = options.projectId
    ? projects.filter((project) => projectId(project) === options.projectId)
    : projects

  if (options.projectRoot && !options.projectId) {
    throw new CliUsageError(
      '--root requires --project. Retry with: hrc admin worktrees prune --project <id> --root <path>'
    )
  }
  if (options.projectId && selectedProjects.length === 0) {
    const known = projects.map(projectId).filter((value): value is string => value !== undefined)
    throw new CliUsageError(
      `unknown project: ${options.projectId}. Known projects: ${known.length > 0 ? known.join(', ') : '(none)'}. List projects with: wrkq projects --json`
    )
  }

  const results: WorktreePruneResult[] = []
  let projectsInspected = 0

  for (const project of selectedProjects) {
    const id = projectId(project)
    const root = resolveProjectRoot(project, env)
    if (!id || !root || !existsSync(root)) continue
    projectsInspected += 1

    if (!isCanonicalCheckout(root)) {
      results.push(
        makeResult(
          id,
          root,
          { path: root },
          [],
          'error',
          'project root is not a canonical checkout (.git directory required)'
        )
      )
      continue
    }

    const listed = run('git', ['-C', root, 'worktree', 'list', '--porcelain'])
    if (listed.status !== 0) {
      results.push(
        makeResult(
          id,
          root,
          { path: root },
          [],
          'error',
          `cannot list worktrees: ${commandDiagnostic(listed)}`
        )
      )
      continue
    }

    for (const worktree of parseWorktreePorcelain(listed.stdout)) {
      if (resolve(worktree.path) === resolve(root)) continue
      // A detached worktree has no branch to carry a task token, so it used to
      // vanish from the report entirely — invisible rather than deliberately
      // left alone (T-06974, from T-06405). Fall back to the path, which is where
      // the token lives for these, and surface it as an explicit skip.
      if (worktree.branch === undefined) {
        const pathTokens = taskTokens(worktree.path)
        if (pathTokens.length === 0) continue
        results.push(
          makeResult(
            id,
            root,
            worktree,
            pathTokens,
            'skipped',
            'detached worktree; task token from path; not eligible for automated pruning'
          )
        )
        continue
      }
      const tokens = taskTokens(worktree.branch)
      if (tokens.length === 0) continue

      if (!isDirectory(worktree.path) || !isLinkedCheckout(worktree.path)) {
        results.push(
          makeResult(id, root, worktree, tokens, 'skipped', 'worktree path is absent or not linked')
        )
        continue
      }

      let taskStates: { taskId: string; state: string | undefined }[]
      try {
        taskStates = tokens.map((taskId) => ({
          taskId,
          state: readTask(taskId)?.state,
        }))
      } catch (lookupError) {
        const message = lookupError instanceof Error ? lookupError.message : String(lookupError)
        process.stderr.write(
          `worktree-prune: task lookup failed for ${worktree.path}: ${message}\n`
        )
        results.push(
          makeResult(id, root, worktree, tokens, 'error', `task lookup failed: ${message}`)
        )
        continue
      }
      const incomplete = taskStates.filter((task) => task.state !== 'completed')
      if (incomplete.length > 0) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'skipped',
            `task not completed: ${incomplete
              .map((task) => `${task.taskId}=${task.state ?? 'not-found'}`)
              .join(', ')}`
          )
        )
        continue
      }

      const occupied = occupyingRuntime(readInitialOccupancies(), id, worktree.path, tokens)
      if (occupied) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'skipped',
            `live runtime ${occupied.runtimeId} (${occupied.status}) occupies the worktree`
          )
        )
        continue
      }

      const status = run('git', [
        '-C',
        worktree.path,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ])
      if (status.status !== 0) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'error',
            `cannot inspect worktree status: ${commandDiagnostic(status)}`
          )
        )
        continue
      }
      if (status.stdout.trim().length > 0) {
        results.push(makeResult(id, root, worktree, tokens, 'skipped', 'worktree is dirty'))
        continue
      }

      const head = run('git', ['-C', worktree.path, 'rev-parse', 'HEAD'])
      if (head.status !== 0) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'error',
            `cannot resolve worktree HEAD: ${commandDiagnostic(head)}`
          )
        )
        continue
      }
      const merged = run('git', [
        '-C',
        root,
        'merge-base',
        '--is-ancestor',
        head.stdout.trim(),
        'HEAD',
      ])
      if (merged.status === 1) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'skipped',
            'worktree HEAD is not merged into canonical HEAD'
          )
        )
        continue
      }
      if (merged.status !== 0) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'error',
            `cannot verify merge ancestry: ${commandDiagnostic(merged)}`
          )
        )
        continue
      }

      if (!options.apply) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'would-prune',
            'completed, clean, and merged; branch will be preserved'
          )
        )
        continue
      }

      const occupiedAtRemoval = occupyingRuntime(
        listLiveRuntimeOccupancies(),
        id,
        worktree.path,
        tokens
      )
      if (occupiedAtRemoval) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'skipped',
            `live runtime ${occupiedAtRemoval.runtimeId} (${occupiedAtRemoval.status}) occupied the worktree before removal`
          )
        )
        continue
      }

      // Deliberately omit --force. Git performs the final race-sensitive dirty
      // check and refuses removal if the worktree changed after our audit.
      const removed = run('git', ['-C', root, 'worktree', 'remove', worktree.path])
      if (removed.status !== 0) {
        results.push(
          makeResult(
            id,
            root,
            worktree,
            tokens,
            'error',
            `git refused worktree removal: ${commandDiagnostic(removed)}`
          )
        )
        continue
      }
      results.push(
        makeResult(
          id,
          root,
          worktree,
          tokens,
          'pruned',
          'removed linked worktree; branch preserved'
        )
      )
    }
  }

  const count = (disposition: WorktreePruneDisposition): number =>
    results.filter((result) => result.disposition === disposition).length
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    projectsInspected,
    results,
    summary: {
      matched: results.length,
      wouldPrune: count('would-prune'),
      pruned: count('pruned'),
      skipped: count('skipped'),
      errors: count('error'),
    },
  }
}

function formatWorktreePruneReport(report: WorktreePruneReport): string {
  const lines = [`worktree prune (${report.mode})`]
  for (const result of report.results) {
    const tasks = result.taskIds.length > 0 ? ` ${result.taskIds.join(',')}` : ''
    lines.push(
      `[${result.disposition}] ${result.projectId}${tasks} ${result.path}: ${result.reason}`
    )
  }
  lines.push(
    `summary: projects=${report.projectsInspected} matched=${report.summary.matched} would-prune=${report.summary.wouldPrune} pruned=${report.summary.pruned} skipped=${report.summary.skipped} errors=${report.summary.errors}`
  )
  return `${lines.join('\n')}\n`
}

export function cmdAdminWorktreesPrune(options: WorktreePruneCommandOptions): WorktreePruneReport {
  if (options.dryRun && options.yes) {
    throw new Error('--dry-run and --yes are mutually exclusive')
  }
  const report = pruneCompletedTaskWorktrees({
    ...(options.project ? { projectId: options.project } : {}),
    ...(options.root ? { projectRoot: options.root } : {}),
    apply: options.yes === true,
  })
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : formatWorktreePruneReport(report)
  )
  return report
}
