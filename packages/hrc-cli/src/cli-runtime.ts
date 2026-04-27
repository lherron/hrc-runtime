import { existsSync, openSync, readFileSync } from 'node:fs'
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
  running: boolean
  pid?: number | undefined
  pidAlive: boolean
  pidPath: string
  socketPath: string
  socketResponsive: boolean
  lockPath: string
  lockExists: boolean
  tmuxSocketPath: string
  serverStatus?: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined
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
  const paths = resolveServerPaths()
  const pid = readPidFile(paths.pidPath)
  const pidAlive = pid !== undefined ? isLiveProcess(pid) : false
  const socketResponsive = await isUnixSocketResponsive(paths.socketPath)
  let serverStatus: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined

  if (socketResponsive) {
    try {
      const status = await new HrcClient(paths.socketPath).getStatus()
      serverStatus = {
        startedAt: status.startedAt,
        apiVersion: status.apiVersion,
      }
    } catch {
      // Treat the daemon as responsive even if the status request fails mid-restart.
    }
  }

  return {
    running: socketResponsive && (pid === undefined || pidAlive),
    ...(pid !== undefined ? { pid } : {}),
    pidAlive,
    pidPath: paths.pidPath,
    socketPath: paths.socketPath,
    socketResponsive,
    lockPath: paths.lockPath,
    lockExists: existsSync(paths.lockPath),
    tmuxSocketPath: paths.tmuxSocketPath,
    ...(serverStatus ? { serverStatus } : {}),
  }
}

export function formatServerRuntimeStatus(status: ServerRuntimeStatus): string {
  const lines = [
    'HRC Daemon Status',
    `  running:      ${status.running ? 'yes' : 'no'}`,
    `  pid:          ${status.pid ?? '(none)'}`,
    `  pid alive:    ${status.pidAlive ? 'yes' : 'no'}`,
    `  pid file:     ${status.pidPath}`,
    `  socket:       ${status.socketPath}${status.socketResponsive ? ' (responsive)' : ' (down)'}`,
    `  lock:         ${status.lockPath}${status.lockExists ? ' (present)' : ' (missing)'}`,
    `  tmux socket:  ${status.tmuxSocketPath}`,
  ]

  if (status.serverStatus) {
    lines.push(`  started:      ${status.serverStatus.startedAt}`)
    lines.push(`  apiVersion:   ${status.serverStatus.apiVersion}`)
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
