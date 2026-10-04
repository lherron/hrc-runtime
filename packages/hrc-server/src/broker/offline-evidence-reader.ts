/** T-08566 stage 2 — offline evidence reader process (SPEC §3.4.1). */

import { dirname, join } from 'node:path'

import {
  SubprocessOutputLimitError,
  SubprocessTimeoutError,
  killSubprocess,
  runBoundedSubprocess,
} from '../bounded-subprocess.js'
import {
  OFFLINE_EVIDENCE_STDERR_MAX_BYTES,
  OFFLINE_EVIDENCE_STDOUT_SLACK_BYTES,
} from './offline-evidence-outcomes'

// ── reader process ────────────────────────────────────────────────────────────

export type ReaderCall =
  | { kind: 'ok'; response: Record<string, unknown>; stdoutBytes: number }
  | { kind: 'typed'; response: Record<string, unknown>; stdoutBytes: number }
  | { kind: 'failed'; outcome: string; detail: Record<string, unknown>; stdoutBytes: number }

function minimalReaderEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** In-flight reader process groups, so server stop can reap them (no orphans). */
const activeReaderGroups = new Set<number>()

function killReaderGroup(pid: number | undefined): void {
  // The reader leads its own process group; kill the group so helper
  // grandchildren (shell wrappers, interpreters) cannot outlive it.
  if (pid !== undefined) killSubprocess(pid, true)
}

/** Kill every in-flight offline reader (graceful server stop). */
export function killActiveOfflineReaders(): number {
  const pids = [...activeReaderGroups]
  for (const pid of pids) killReaderGroup(pid)
  activeReaderGroups.clear()
  return pids.length
}

export async function callReader(
  executable: string,
  ledgerPath: string,
  request: Record<string, unknown>,
  maxBytes: number,
  timeoutMs: number
): Promise<ReaderCall> {
  const indexPath = join(dirname(ledgerPath), 'ledger-index.db')
  const stdoutCap = maxBytes + OFFLINE_EVIDENCE_STDOUT_SLACK_BYTES
  let pid: number | undefined
  let result: Awaited<ReturnType<typeof runBoundedSubprocess>>
  try {
    result = await runBoundedSubprocess(
      [executable, 'evidence-read', '--event-ledger', ledgerPath, '--index', indexPath],
      {
        env: minimalReaderEnv(),
        timeoutMs,
        stdin: JSON.stringify(request),
        maxStdoutBytes: stdoutCap,
        stderrTailChars: OFFLINE_EVIDENCE_STDERR_MAX_BYTES,
        processGroup: true,
        onSpawn: (spawned) => {
          pid = spawned
          activeReaderGroups.add(spawned)
        },
      }
    )
  } catch (error) {
    if (error instanceof SubprocessTimeoutError) {
      return { kind: 'failed', outcome: 'reader_timeout', detail: { timeoutMs }, stdoutBytes: 0 }
    }
    if (error instanceof SubprocessOutputLimitError) {
      return {
        kind: 'failed',
        outcome: 'reader_contract_violation',
        detail: { violation: 'stdout_overflow', stdoutCap, stdoutBytes: error.stdoutBytes },
        stdoutBytes: error.stdoutBytes,
      }
    }
    return {
      kind: 'failed',
      outcome: 'reader_failed',
      detail: { error: error instanceof Error ? error.message : String(error) },
      stdoutBytes: 0,
    }
  } finally {
    if (pid !== undefined) activeReaderGroups.delete(pid)
  }

  const { exitCode: code, stdoutBytes, stderr } = result
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = undefined
  }
  if (code === 0 || code === 2) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        kind: 'failed',
        outcome: 'reader_contract_violation',
        detail: { violation: 'unparseable_response', exitCode: code },
        stdoutBytes,
      }
    }
    return {
      kind: code === 0 ? 'ok' : 'typed',
      response: parsed as Record<string, unknown>,
      stdoutBytes,
    }
  }
  return {
    kind: 'failed',
    outcome: 'reader_failed',
    detail: { exitCode: code, stderr: stderr.slice(0, 2048) },
    stdoutBytes,
  }
}
