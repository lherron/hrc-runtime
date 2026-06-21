/**
 * Best-effort wrkq task-slug resolution for the headless-viewer status bar
 * (T-04977).
 *
 * The scope ref carries a task id (`T-04977`) but not the human-readable wrkq
 * slug (`add-task-slug-to-ghostmux-status-bar`). This helper enriches the status
 * bar by reading the slug from `wrkq cat <id> --json`. It is strictly READ-ONLY
 * and PURELY COSMETIC: it never mutates wrkq state and never throws — every
 * failure mode (missing wrkq, non-zero exit, timeout, malformed JSON, missing
 * task, empty slug, non-task scope) resolves to `null` so the caller falls back
 * to the existing `project · T-id` rendering. Slug lookup must never delay or
 * fail viewer creation, dispatch, or lifecycle status-bar updates.
 */

import { parseScopeRef } from 'agent-scope'

/** Result of running `wrkq cat <id> --json`. */
export type WrkqRunResult = { stdout: string; stderr: string; exitCode: number }

/** Injectable subprocess runner (tests pass a fake; prod spawns wrkq). */
export type WrkqRunner = (taskId: string) => Promise<WrkqRunResult>

/** Resolve a scope ref to a task slug (or null when unavailable). Never throws. */
export type TaskSlugResolver = (scopeRef: string) => Promise<string | null>

/** Only real task scopes carry a slug — `primary` and lanes never do. */
const TASK_ID_PATTERN = /^T-\d+$/

/** Bound the wrkq read so a slow/hung CLI never stalls the status-bar path. */
const WRKQ_TIMEOUT_MS = 2000

/**
 * Extract a wrkq task id from a scope ref, but only when the task segment looks
 * like a canonical `T-<digits>` id. Returns null for `primary`, lane-only, or
 * unparseable refs — those have no slug to resolve.
 */
export function extractTaskIdFromScope(scopeRef: string): string | null {
  let parsed: ReturnType<typeof parseScopeRef> | null = null
  try {
    parsed = parseScopeRef(scopeRef)
  } catch {
    return null
  }
  const taskId = parsed?.taskId
  if (typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId)) return taskId
  return null
}

/**
 * Parse the `slug` field from the first record of `wrkq cat <id> --json`
 * stdout. `wrkq cat` returns a JSON array of task records. Returns null on
 * malformed JSON, an empty array, or a missing/empty slug.
 */
export function parseTaskSlug(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed
  if (typeof record !== 'object' || record === null) return null
  const slug = (record as Record<string, unknown>)['slug']
  if (typeof slug === 'string' && slug.trim().length > 0) return slug.trim()
  return null
}

/** Default runner: spawn `wrkq cat <id> --json` with a bounded timeout. */
async function defaultWrkqRunner(taskId: string): Promise<WrkqRunResult> {
  const proc = Bun.spawn(['wrkq', 'cat', taskId, '--json'], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(WRKQ_TIMEOUT_MS),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/**
 * Build a memoizing task-slug resolver. The lookup is keyed by task id and
 * caches only SUCCESSFUL resolutions, so frequent lifecycle repaints reuse one
 * subprocess result while transient failures stay retryable. Non-task scopes
 * short-circuit to null without spawning anything. The returned resolver never
 * throws.
 */
export function createTaskSlugResolver(options: { runner?: WrkqRunner } = {}): TaskSlugResolver {
  const runner = options.runner ?? defaultWrkqRunner
  const cache = new Map<string, string>()
  return async (scopeRef: string): Promise<string | null> => {
    const taskId = extractTaskIdFromScope(scopeRef)
    if (!taskId) return null
    const cached = cache.get(taskId)
    if (cached !== undefined) return cached
    try {
      const result = await runner(taskId)
      if (result.exitCode !== 0) return null
      const slug = parseTaskSlug(result.stdout)
      if (slug !== null) cache.set(taskId, slug)
      return slug
    } catch {
      return null
    }
  }
}

let sharedResolver: TaskSlugResolver | undefined

/**
 * Process-wide shared resolver so the initial viewer-spawn path and the
 * lifecycle projector share one memo cache (a task's slug is read at most once
 * per process under normal flow).
 */
export function defaultTaskSlugResolver(): TaskSlugResolver {
  if (!sharedResolver) sharedResolver = createTaskSlugResolver()
  return sharedResolver
}
