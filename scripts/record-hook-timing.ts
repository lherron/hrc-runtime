/**
 * Record one whole-hook run and post it as `hook.settled`.
 *
 *   bun scripts/record-hook-timing.ts <hook> <run-id> <started-ms> <finished-ms> <exit-code> <lefthook-bin>
 *
 * Invoked by the `.githooks` shims after lefthook returns. The shim owns the
 * hook's exit code and ignores this script's; it still always exits 0 and
 * reports a problem as one `[hook-timing]` line on stderr.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { HookName } from './lib/hook-change-scope.ts'
import {
  HOOK_TIMING_SCHEMA_VERSION,
  type HookTimingRecord,
  appendTimingRecord,
  postHookSettled,
  resolveHookTimingsPath,
  takeHookChange,
} from './lib/hook-timing.ts'

function gitOutput(args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) return undefined
  const output = result.stdout.toString().trim()
  return output === '' ? undefined : output
}

function lefthookVersion(lefthookBin: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dirname(lefthookBin)), 'lefthook', 'package.json'), 'utf8')
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function main(): void {
  const [hook, runId, startedArg, finishedArg, exitArg, lefthookBin = ''] = process.argv.slice(2)
  if ((hook !== 'pre-commit' && hook !== 'pre-push') || !runId) {
    throw new Error(`unexpected arguments: ${process.argv.slice(2).join(' ')}`)
  }
  const startedMs = Number(startedArg)
  const finishedMs = Number(finishedArg)
  const exitCode = Number(exitArg)
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || !Number.isInteger(exitCode)) {
    throw new Error(`unparseable timing: ${startedArg} ${finishedArg} ${exitArg}`)
  }

  const change = takeHookChange(runId)
  // Only a deletion-only push skips validation here; an empty change set
  // (`none`) still runs every gate.
  const skipped = exitCode === 0 && change.kind === 'deletion_only'
  const finishedAt = new Date(finishedMs).toISOString()
  const record: HookTimingRecord = {
    schemaVersion: HOOK_TIMING_SCHEMA_VERSION,
    recordType: 'hook',
    recordedAt: new Date().toISOString(),
    runId,
    hook: hook as HookName,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt,
    durationMs: Math.max(0, finishedMs - startedMs),
    result: exitCode !== 0 ? 'failed' : skipped ? 'skipped' : 'passed',
    exitCode,
    change,
    head: gitOutput(['rev-parse', 'HEAD']),
    branch: gitOutput(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    lefthookVersion: lefthookVersion(lefthookBin),
  }

  const path = resolveHookTimingsPath()
  appendTimingRecord(record, path)
  postHookSettled(record)
}

try {
  main()
} catch (error) {
  console.error(`[hook-timing] unable to record hook timing: ${error}`)
}
process.exit(0)
