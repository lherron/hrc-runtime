/**
 * Whole-hook timing records and the `hook.settled` fact they post.
 *
 * The record shape and post arguments deliberately match agent-spaces'
 * `scripts/lib/hook-timing.ts` (schema v1) so one reader and one backfill
 * format cover both repos. The `.githooks` shims time lefthook themselves and
 * hand the result to `scripts/record-hook-timing.ts`; nothing here may change
 * a hook's exit code.
 *
 * The shims never read pre-push stdin (git-push-fact is its only consumer),
 * so the change classification comes from the gate itself: every
 * `run-if-code-changed.ts` invocation leaves its judgement in a per-run file
 * under the Git common directory, keyed by the run id the shim exported.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { ChangeKind, HookName } from './hook-change-scope.ts'

export const HOOK_TIMING_SCHEMA_VERSION = 1
export const HOOK_RUN_ID_ENV = 'HRC_HOOK_RUN_ID'
export const HOOK_TIMINGS_PATH_ENV = 'HRC_HOOK_TIMINGS_PATH'

const runIdPattern = /^[A-Za-z0-9-]{8,64}$/
const changeKinds = new Set<ChangeKind>([
  'code',
  'documentation',
  'deletion_only',
  'none',
  'ambiguous',
])

export interface HookChange {
  kind: ChangeKind
  fileCount: number
}

export interface HookTimingRecord {
  schemaVersion: typeof HOOK_TIMING_SCHEMA_VERSION
  recordType: 'hook'
  recordedAt: string
  runId: string
  hook: HookName
  startedAt: string
  finishedAt: string
  durationMs: number
  result: 'passed' | 'failed' | 'skipped'
  exitCode: number | null
  change: HookChange
  head?: string | undefined
  branch?: string | undefined
  platform: NodeJS.Platform
  arch: string
  bunVersion: string
  lefthookVersion?: string | undefined
}

export function hookSettledPostArgs(record: HookTimingRecord): string[] {
  const args = [
    'post',
    'hrc-runtime',
    '--type',
    'hook.settled',
    '-m',
    `${record.hook} ${record.result} in ${(record.durationMs / 1000).toFixed(1)}s`,
    '--occurred-at',
    record.finishedAt,
    '--key',
    `hook:${record.runId}`,
  ]
  const attributes: [string, string | number | undefined][] = [
    ['source', 'hrc-runtime-hook-timing'],
    ['node', hostname()],
    ['hook', record.hook],
    ['result', record.result],
    ['exit_code', record.exitCode ?? undefined],
    ['duration_ms', Math.round(record.durationMs)],
    ['change_kind', record.change.kind],
    ['file_count', record.change.fileCount],
    ['head', record.head],
    ['branch', record.branch],
    ['run_id', record.runId],
    ['started_at', record.startedAt],
  ]
  for (const [key, value] of attributes) {
    if (value !== undefined) args.push('--attr', `${key}=${value}`)
  }
  return args
}

/** Detached and unawaited: a slow or missing wrkp never delays the hook. */
export function postHookSettled(record: HookTimingRecord): void {
  try {
    const child = spawn('wrkp', hookSettledPostArgs(record), { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The JSONL history replays through `scripts/post-hook-timings.ts --backfill`.
  }
}

function gitCommonDir(cwd: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`unable to resolve Git common directory${detail ? `: ${detail}` : ''}`)
  }
  const commonDir = result.stdout.toString().trim()
  return isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir)
}

export function resolveHookTimingsPath(cwd = process.cwd()): string {
  const override = process.env[HOOK_TIMINGS_PATH_ENV]
  if (override) return isAbsolute(override) ? override : resolve(cwd, override)
  return join(gitCommonDir(cwd), 'praesidium', 'hook-timings.jsonl')
}

function hookChangePath(runId: string, cwd: string): string {
  return join(gitCommonDir(cwd), 'praesidium', 'hook-change', `${runId}.json`)
}

/**
 * Called by the gate. A run id inherited from an outer hook (a fixture repo
 * committing under this repo's pre-push) lands in the fixture's own Git
 * directory, never in the outer run's file.
 */
export function recordHookChange(change: HookChange, cwd = process.cwd()): void {
  const runId = process.env[HOOK_RUN_ID_ENV]
  if (!runId || !runIdPattern.test(runId)) return
  try {
    const path = hookChangePath(runId, cwd)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(change)}\n`, 'utf8')
  } catch {
    // Timing is observability; the gate's decision stands without it.
  }
}

/**
 * Consume the gate's judgement for this run, or `ambiguous` when no gate
 * reached it.
 */
export function takeHookChange(runId: string, cwd = process.cwd()): HookChange {
  try {
    const path = hookChangePath(runId, cwd)
    const text = readFileSync(path, 'utf8')
    rmSync(path, { force: true })
    const value = JSON.parse(text) as Partial<HookChange>
    if (
      value.kind &&
      changeKinds.has(value.kind) &&
      Number.isSafeInteger(value.fileCount) &&
      (value.fileCount ?? -1) >= 0
    ) {
      return { kind: value.kind, fileCount: value.fileCount as number }
    }
  } catch {
    // Missing: the hook failed or skipped before any wrapped command ran.
  }
  return { kind: 'ambiguous', fileCount: 0 }
}

export function appendTimingRecord(record: HookTimingRecord, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readTimingRecords(path: string): {
  records: HookTimingRecord[]
  malformedLines: number
} {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { records: [], malformedLines: 0 }
    throw error
  }
  const records: HookTimingRecord[] = []
  let malformedLines = 0
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line) as Partial<HookTimingRecord>
      if (
        value.schemaVersion !== HOOK_TIMING_SCHEMA_VERSION ||
        value.recordType !== 'hook' ||
        typeof value.runId !== 'string' ||
        typeof value.durationMs !== 'number'
      ) {
        malformedLines += 1
        continue
      }
      records.push(value as HookTimingRecord)
    } catch {
      malformedLines += 1
    }
  }
  return { records, malformedLines }
}
