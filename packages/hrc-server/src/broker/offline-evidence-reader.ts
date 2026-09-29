/** T-08566 stage 2 — offline evidence reader process (SPEC §3.4.1). */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

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
  if (pid === undefined) return
  try {
    // The reader leads its own process group; kill the group so helper
    // grandchildren (shell wrappers, interpreters) cannot outlive it.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
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
  return await new Promise<ReaderCall>((resolve) => {
    let settled = false
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    const child = spawn(
      executable,
      ['evidence-read', '--event-ledger', ledgerPath, '--index', indexPath],
      { env: minimalReaderEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true }
    )
    if (child.pid !== undefined) activeReaderGroups.add(child.pid)
    const finish = (result: ReaderCall) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.pid !== undefined) activeReaderGroups.delete(child.pid)
      resolve(result)
    }
    const kill = () => killReaderGroup(child.pid)
    const timer = setTimeout(() => {
      kill()
      finish({
        kind: 'failed',
        outcome: 'reader_timeout',
        detail: { timeoutMs, stderr: stderr.slice(0, 2048) },
        stdoutBytes,
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > stdoutCap) {
        kill()
        finish({
          kind: 'failed',
          outcome: 'reader_contract_violation',
          detail: { violation: 'stdout_overflow', stdoutCap, stdoutBytes },
          stdoutBytes,
        })
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OFFLINE_EVIDENCE_STDERR_MAX_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({
        kind: 'failed',
        outcome: 'reader_failed',
        detail: { error: error.message },
        stdoutBytes,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      const text = Buffer.concat(stdout).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (code === 0 || code === 2) {
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          finish({
            kind: 'failed',
            outcome: 'reader_contract_violation',
            detail: { violation: 'unparseable_response', exitCode: code },
            stdoutBytes,
          })
          return
        }
        finish({
          kind: code === 0 ? 'ok' : 'typed',
          response: parsed as Record<string, unknown>,
          stdoutBytes,
        })
        return
      }
      finish({
        kind: 'failed',
        outcome: 'reader_failed',
        detail: { exitCode: code, stderr: stderr.slice(0, 2048) },
        stdoutBytes,
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(request))
  })
}
