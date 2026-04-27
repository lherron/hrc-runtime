import { existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import {
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
  resolveTmuxSocketPath,
} from 'hrc-core'
import type { HrcStatusResponse } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { fatal, hasFlag } from './runtime-args.js'

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

export type ServerRuntimeStatus = {
  ok: boolean
  status: 'healthy' | 'not-running' | 'degraded' | 'probe-failed'
  exitCode: 0 | 1 | 2 | 3
  running: boolean
  pid?: number | undefined
  pidAlive: boolean
  pidPath: string
  daemon: {
    running: boolean
    pid?: number | undefined
    pidAlive: boolean
    pidPath: string
    pidFileExists: boolean
  }
  socketPath: string
  socketResponsive: boolean
  socket: {
    path: string
    responsive: boolean
  }
  lockPath: string
  lockExists: boolean
  tmuxSocketPath: string
  apiHealth: { ok: true } | { ok: false; error: string }
  api?:
    | Pick<HrcStatusResponse, 'startedAt' | 'uptime' | 'apiVersion' | 'socketPath' | 'dbPath'>
    | undefined
  tmux: TmuxStatus
  serverStatus?: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined
  error?: string | undefined
}

export type TmuxStatus = {
  available: boolean
  version?: string | undefined
  socketPath: string
  running: boolean
  sessionCount: number
  sessions: string[]
  error?: string | undefined
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

function readPidFile(pidPath: string): number | undefined {
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateDiagnosticRoot(path: string, label: string): void {
  if (!existsSync(path)) return
  const stat = statSync(path)
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`)
  }
}

function isLiveProcess(pid: number): boolean {
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

async function isUnixSocketResponsive(socketPath: string, timeoutMs = 200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath)
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
  })
}

async function waitForCondition(
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

export async function execProcess(argv: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

const DEFAULT_LAUNCHD_LABEL = 'com.praesidium.hrc-server'

export type LaunchdOwner = {
  label: string
  domain: string
  serviceTarget: string
}

/**
 * Probe launchd to see if the HRC daemon is managed by a Launch Agent.
 * Returns non-null only on macOS when the labelled agent is loaded in the
 * current user's GUI domain. The plist should invoke `hrc server serve`
 * so the supervised process never enters this code path.
 */
export async function detectLaunchdOwner(): Promise<LaunchdOwner | null> {
  if (process.platform !== 'darwin') return null
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) return null

  const label = process.env['HRC_LAUNCHD_LABEL'] ?? DEFAULT_LAUNCHD_LABEL
  const domain = `gui/${uid}`
  const serviceTarget = `${domain}/${label}`
  const result = await execProcess(['launchctl', 'print', serviceTarget])
  if (result.exitCode !== 0) return null
  return { label, domain, serviceTarget }
}

export async function launchctlKickstart(
  owner: LaunchdOwner,
  opts: { kill?: boolean } = {}
): Promise<void> {
  const argv = ['launchctl', 'kickstart']
  if (opts.kill) argv.push('-k')
  argv.push(owner.serviceTarget)
  const result = await execProcess(argv)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    fatal(`launchctl kickstart failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`)
  }
}

export async function collectServerRuntimeStatus(): Promise<ServerRuntimeStatus> {
  try {
    const paths = resolveServerPaths()
    validateDiagnosticRoot(paths.runtimeRoot, 'runtime root')
    validateDiagnosticRoot(paths.stateRoot, 'state root')

    const pidFileExists = existsSync(paths.pidPath)
    const pid = readPidFile(paths.pidPath)
    const pidAlive = pid !== undefined ? isLiveProcess(pid) : false
    const socketResponsive = await isUnixSocketResponsive(paths.socketPath)
    const tmux = await collectTmuxStatus()
    let apiHealth: ServerRuntimeStatus['apiHealth'] = { ok: false, error: 'daemon not running' }
    let api: ServerRuntimeStatus['api']
    let serverStatus: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined

    if (socketResponsive) {
      const client = new HrcClient(paths.socketPath)
      try {
        apiHealth = await client.getHealth()
      } catch (error) {
        apiHealth = { ok: false, error: `API health probe failed: ${formatError(error)}` }
      }

      try {
        const status = await client.getStatus()
        api = {
          startedAt: status.startedAt,
          uptime: status.uptime,
          apiVersion: status.apiVersion,
          socketPath: status.socketPath,
          dbPath: status.dbPath,
        }
        serverStatus = {
          startedAt: status.startedAt,
          apiVersion: status.apiVersion,
        }
      } catch (error) {
        if (apiHealth.ok) {
          apiHealth = { ok: false, error: `API status probe failed: ${formatError(error)}` }
        }
      }
    }

    const running = socketResponsive && apiHealth.ok
    const degraded = socketResponsive || pidAlive || pidFileExists
    const status = running ? 'healthy' : degraded ? 'degraded' : 'not-running'
    const exitCode = status === 'healthy' ? 0 : status === 'not-running' ? 1 : 2

    return {
      ok: status === 'healthy',
      status,
      exitCode,
      running,
      ...(pid !== undefined ? { pid } : {}),
      pidAlive,
      pidPath: paths.pidPath,
      daemon: {
        running,
        ...(pid !== undefined ? { pid } : {}),
        pidAlive,
        pidPath: paths.pidPath,
        pidFileExists,
      },
      socketPath: paths.socketPath,
      socketResponsive,
      socket: {
        path: paths.socketPath,
        responsive: socketResponsive,
      },
      lockPath: paths.lockPath,
      lockExists: existsSync(paths.lockPath),
      tmuxSocketPath: paths.tmuxSocketPath,
      apiHealth,
      ...(api ? { api } : {}),
      tmux,
      ...(serverStatus ? { serverStatus } : {}),
    }
  } catch (error) {
    const message = formatError(error)
    let paths: ServerPaths | undefined
    try {
      paths = resolveServerPaths()
    } catch {}

    return {
      ok: false,
      status: 'probe-failed',
      exitCode: 3,
      running: false,
      pidAlive: false,
      pidPath: paths?.pidPath ?? '',
      daemon: {
        running: false,
        pidAlive: false,
        pidPath: paths?.pidPath ?? '',
        pidFileExists: paths ? existsSync(paths.pidPath) : false,
      },
      socketPath: paths?.socketPath ?? '',
      socketResponsive: false,
      socket: {
        path: paths?.socketPath ?? '',
        responsive: false,
      },
      lockPath: paths?.lockPath ?? '',
      lockExists: paths ? existsSync(paths.lockPath) : false,
      tmuxSocketPath: paths?.tmuxSocketPath ?? '',
      apiHealth: { ok: false, error: 'status diagnostic failed' },
      tmux: {
        available: false,
        socketPath: paths?.tmuxSocketPath ?? '',
        running: false,
        sessionCount: 0,
        sessions: [],
        error: 'status diagnostic failed',
      },
      error: message,
    }
  }
}

export function formatServerRuntimeStatus(status: ServerRuntimeStatus): string {
  const lines = [
    'HRC Daemon Status',
    `  running:      ${status.running ? 'yes' : 'no'}`,
    `  status:       ${status.status}`,
    `  pid:          ${status.pid ?? '(none)'}`,
    `  pid alive:    ${status.pidAlive ? 'yes' : 'no'}`,
    `  pid file:     ${status.pidPath}`,
    `  socket:       ${status.socketPath}${status.socketResponsive ? ' (responsive)' : ' (down)'}`,
    `  api health:   ${status.apiHealth.ok ? 'ok' : `failed (${status.apiHealth.error})`}`,
    `  lock:         ${status.lockPath}${status.lockExists ? ' (present)' : ' (missing)'}`,
    `  tmux:         ${
      status.tmux.available
        ? status.tmux.running
          ? `running (${status.tmux.sessionCount} session(s))`
          : 'available (not running)'
        : `unavailable${status.tmux.error ? ` (${status.tmux.error})` : ''}`
    }`,
    `  tmux socket:  ${status.tmuxSocketPath}`,
  ]

  if (status.api) {
    lines.push(`  uptime:       ${status.api.uptime}s`)
    lines.push(`  started:      ${status.api.startedAt}`)
    lines.push(`  apiVersion:   ${status.api.apiVersion}`)
  } else if (status.serverStatus) {
    lines.push(`  started:      ${status.serverStatus.startedAt}`)
    lines.push(`  apiVersion:   ${status.serverStatus.apiVersion}`)
  }

  if (status.error) {
    lines.push(`  error:        ${status.error}`)
  }

  return `${lines.join('\n')}\n`
}

export function resolveServerMode(
  args: string[],
  defaultMode: 'foreground' | 'daemon'
): 'foreground' | 'daemon' {
  const wantsDaemon =
    hasFlag(args, '--daemon') || hasFlag(args, '-d') || hasFlag(args, '--background')
  const wantsForeground = hasFlag(args, '--foreground')

  if (wantsDaemon && wantsForeground) {
    fatal('choose either --foreground or --daemon/--background, not both')
  }

  if (wantsForeground) return 'foreground'
  if (wantsDaemon) return 'daemon'
  return defaultMode
}

export async function daemonizeAndWait(timeoutMs = 5_000): Promise<number> {
  const { runtimeRoot, pidPath, socketPath } = resolveServerPaths()
  await mkdir(runtimeRoot, { recursive: true })

  const logPath = `${runtimeRoot}/server.log`
  const logFd = openSync(logPath, 'a')
  const proc = Bun.spawn(['bun', process.argv[1] ?? import.meta.path, 'server', 'start'], {
    detached: true,
    stdout: logFd,
    stderr: logFd,
    stdin: 'ignore',
    env: { ...process.env },
  })

  proc.unref()
  await writeFile(pidPath, `${proc.pid}\n`)

  const ready = await waitForCondition(() => isUnixSocketResponsive(socketPath), timeoutMs)
  if (!ready) {
    fatal(
      `daemon did not become responsive within ${timeoutMs}ms (pid ${proc.pid}); log at ${logPath}`
    )
  }

  process.stderr.write(`hrc: daemon started (pid ${proc.pid}), log at ${logPath}\n`)
  return proc.pid
}

export async function stopServerProcess(options?: {
  timeoutMs?: number | undefined
  force?: boolean | undefined
  allowNotRunning?: boolean | undefined
}): Promise<void> {
  const { pidPath, socketPath } = resolveServerPaths()
  const pid = readPidFile(pidPath)
  const socketResponsive = await isUnixSocketResponsive(socketPath)

  if (pid === undefined) {
    if (!socketResponsive || options?.allowNotRunning) {
      return
    }
    fatal(`daemon is responsive on ${socketPath}, but pid file is missing at ${pidPath}`)
  }

  const timeoutMs = options?.timeoutMs ?? 5_000
  const force = options?.force ?? false

  if (!isLiveProcess(pid)) {
    try {
      await unlink(pidPath)
    } catch {}
    if (!socketResponsive || options?.allowNotRunning) {
      return
    }
    fatal(`daemon socket ${socketPath} is still responsive, but pid ${pid} is not alive`)
  }

  process.kill(pid, 'SIGTERM')
  let stopped = await waitForCondition(
    async () => !isLiveProcess(pid) && !(await isUnixSocketResponsive(socketPath)),
    timeoutMs
  )

  if (!stopped && force) {
    process.kill(pid, 'SIGKILL')
    stopped = await waitForCondition(
      async () => !isLiveProcess(pid) && !(await isUnixSocketResponsive(socketPath)),
      timeoutMs
    )
  }

  if (!stopped) {
    fatal(
      `daemon pid ${pid} did not stop within ${timeoutMs}ms${force ? ' after SIGTERM/SIGKILL' : ''}`
    )
  }

  try {
    await unlink(pidPath)
  } catch {}
}

export async function collectTmuxStatus(): Promise<TmuxStatus> {
  const socketPath = resolveTmuxSocketPath()
  const versionResult = await execProcess(['tmux', '-V'])
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim()
  const version = versionResult.exitCode === 0 ? versionOutput : undefined
  if (versionResult.exitCode !== 0) {
    return {
      available: false,
      socketPath,
      running: false,
      sessionCount: 0,
      sessions: [],
      error: versionOutput || 'tmux unavailable',
    }
  }

  const listResult = await execProcess(['tmux', '-S', socketPath, 'list-sessions', '-F', '#S'])
  if (listResult.exitCode !== 0) {
    const output = `${listResult.stderr}\n${listResult.stdout}`.trim().toLowerCase()
    const noServer =
      output.includes('no server running') ||
      output.includes('failed to connect to server') ||
      output.includes('no such file or directory')

    return {
      available: true,
      version,
      socketPath,
      running: false,
      sessionCount: 0,
      sessions: [],
      ...(noServer ? {} : { error: `${listResult.stderr}\n${listResult.stdout}`.trim() }),
    }
  }

  const sessions = listResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return {
    available: true,
    version,
    socketPath,
    running: true,
    sessionCount: sessions.length,
    sessions,
  }
}

export function formatTmuxStatus(status: TmuxStatus): string {
  const lines = [
    'HRC Tmux Status',
    `  available:    ${status.available ? 'yes' : 'no'}`,
    `  running:      ${status.running ? 'yes' : 'no'}`,
    `  socket:       ${status.socketPath}`,
    `  version:      ${status.version ?? '(unknown)'}`,
    `  sessions:     ${status.sessionCount}`,
  ]

  if (status.sessions.length > 0) {
    lines.push(`  session list: ${status.sessions.join(', ')}`)
  }
  if (status.error) {
    lines.push(`  error:        ${status.error}`)
  }

  return `${lines.join('\n')}\n`
}
