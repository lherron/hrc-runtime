import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import {
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
  resolveTmuxSocketPath,
} from 'hrc-core'

export type ServerPaths = {
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  lockPath: string
  spoolDir: string
  dbPath: string
  tmuxSocketPath: string
  pidPath: string
}

export function writeServerProcessLog(
  event: string,
  details?: Record<string, unknown> | undefined
): void {
  const ts = new Date().toISOString()
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  process.stderr.write(`${ts} [hrc-server] INFO ${event}${suffix}\n`)
}

export function resolveServerPaths(): ServerPaths {
  const runtimeRoot = resolveRuntimeRoot()
  return {
    runtimeRoot,
    stateRoot: resolveStateRoot(),
    socketPath: resolveControlSocketPath(),
    lockPath: `${runtimeRoot}/server.lock`,
    spoolDir: resolveSpoolDir(),
    dbPath: resolveDatabasePath(),
    tmuxSocketPath: resolveTmuxSocketPath(),
    pidPath: `${runtimeRoot}/server.pid`,
  }
}

export function readPidFile(pidPath: string): number | undefined {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim()
    if (raw.length === 0) {
      return undefined
    }
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function validateDiagnosticRoot(path: string, label: string): void {
  if (!existsSync(path)) return
  const stat = statSync(path)
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`)
  }
}

export function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

export async function isUnixSocketResponsive(
  socketPath: string,
  timeoutMs = 200
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    try {
      socket.connect(socketPath)
    } catch {
      finish(false)
    }
  })
}

export async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }
    await delay(intervalMs)
  }
  return await check()
}

export async function execProcess(
  argv: string[],
  options: { timeoutMs?: number | undefined } = {}
): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean | undefined
}> {
  const [command, ...args] = argv
  if (!command) {
    return { stdout: '', stderr: 'missing command', exitCode: 127 }
  }

  return await new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        env: { ...process.env },
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      },
      (error, stdout, stderr) => {
        const timedOut =
          options.timeoutMs !== undefined &&
          typeof error === 'object' &&
          error !== null &&
          'killed' in error &&
          error.killed === true &&
          'signal' in error &&
          error.signal === 'SIGKILL'
        const code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
            ? error.code
            : timedOut
              ? 124
              : error
                ? 1
                : 0
        resolve({
          stdout,
          stderr,
          exitCode: code,
          ...(timedOut ? { timedOut } : {}),
        })
      }
    )
  })
}
