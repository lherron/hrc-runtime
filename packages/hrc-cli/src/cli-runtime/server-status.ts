import { existsSync, openSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'

import type { FederationPeerHealthObservation, HrcReleaseStatus, HrcStatusResponse } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { fatalExit, hasFlag } from '../runtime-args.js'
import {
  execProcess,
  formatError,
  isLiveProcess,
  isUnixSocketResponsive,
  readPidFile,
  resolveServerPaths,
  validateDiagnosticRoot,
  waitForCondition,
} from './server-paths.js'
import type { ServerPaths } from './server-paths.js'
import { collectTmuxStatus } from './tmux-status.js'
import type { TmuxStatus } from './tmux-status.js'

export type ServerRuntimeStatus = {
  ok: boolean
  status: 'healthy' | 'not-running' | 'degraded' | 'probe-failed'
  exitCode: 0 | 1 | 2 | 3
  running: boolean
  runtimeRoot: string
  stateRoot: string
  cwd?: string | undefined
  binaryPath?: string | undefined
  packagePath?: string | undefined
  release?: HrcReleaseStatus | undefined
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
    | Pick<
        HrcStatusResponse,
        | 'startedAt'
        | 'uptime'
        | 'apiVersion'
        | 'runtimeRoot'
        | 'stateRoot'
        | 'socketPath'
        | 'dbPath'
        | 'cwd'
        | 'binaryPath'
        | 'packagePath'
        | 'release'
      >
    | undefined
  /**
   * Node identity + peer summary from the running daemon (federation §3/§6).
   * Undefined when the daemon is not reachable — identity is daemon truth, not
   * something the CLI re-derives locally.
   */
  node?: HrcStatusResponse['node'] | undefined
  peerHealth?: FederationPeerHealthObservation[] | undefined
  tmux: TmuxStatus
  serverStatus?: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined
  error?: string | undefined
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
    fatalExit(`launchctl kickstart failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`)
  }
}

export async function collectServerRuntimeStatus(
  options: { includeTmux?: boolean | undefined } = {}
): Promise<ServerRuntimeStatus> {
  try {
    const paths = resolveServerPaths()
    validateDiagnosticRoot(paths.runtimeRoot, 'runtime root')
    validateDiagnosticRoot(paths.stateRoot, 'state root')

    const pidFileExists = existsSync(paths.pidPath)
    const pid = readPidFile(paths.pidPath)
    const pidAlive = pid !== undefined ? isLiveProcess(pid) : false
    const socketResponsive = await isUnixSocketResponsive(paths.socketPath)
    const tmux =
      options.includeTmux === false
        ? skippedTmuxStatus(paths.tmuxSocketPath)
        : await collectTmuxStatus({ includeLeases: false })
    let apiHealth: ServerRuntimeStatus['apiHealth'] = {
      ok: false,
      error: 'daemon not running',
    }
    let api: ServerRuntimeStatus['api']
    let node: ServerRuntimeStatus['node']
    let peerHealth: ServerRuntimeStatus['peerHealth']
    let serverStatus: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined

    if (socketResponsive) {
      const client = new HrcClient(paths.socketPath)
      try {
        apiHealth = await client.getHealth()
      } catch (error) {
        apiHealth = {
          ok: false,
          error: `API health probe failed: ${formatError(error)}`,
        }
      }

      try {
        const status = await client.getStatus({ includePeerHealth: true })
        api = {
          startedAt: status.startedAt,
          uptime: status.uptime,
          apiVersion: status.apiVersion,
          runtimeRoot: status.runtimeRoot,
          stateRoot: status.stateRoot,
          socketPath: status.socketPath,
          dbPath: status.dbPath,
          cwd: status.cwd,
          binaryPath: status.binaryPath,
          packagePath: status.packagePath,
          release: status.release,
        }
        node = status.node
        peerHealth = status.peerHealth
        serverStatus = {
          startedAt: status.startedAt,
          apiVersion: status.apiVersion,
        }
      } catch (error) {
        if (apiHealth.ok) {
          apiHealth = {
            ok: false,
            error: `API status probe failed: ${formatError(error)}`,
          }
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
      runtimeRoot: paths.runtimeRoot,
      stateRoot: paths.stateRoot,
      ...(api
        ? {
            cwd: api.cwd,
            binaryPath: api.binaryPath,
            packagePath: api.packagePath,
            release: api.release,
          }
        : {}),
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
      ...(node ? { node } : {}),
      ...(peerHealth ? { peerHealth } : {}),
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
      runtimeRoot: paths?.runtimeRoot ?? '',
      stateRoot: paths?.stateRoot ?? '',
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

function skippedTmuxStatus(socketPath: string): TmuxStatus {
  return {
    available: false,
    socketPath,
    running: false,
    sessionCount: 0,
    sessions: [],
    error: 'tmux diagnostics not probed',
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
    `  runtime root: ${status.runtimeRoot}`,
    `  state root:   ${status.stateRoot}`,
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

  if (status.cwd) lines.push(`  cwd:          ${status.cwd}`)
  if (status.binaryPath) lines.push(`  binary:       ${status.binaryPath}`)
  if (status.packagePath) lines.push(`  package:      ${status.packagePath}`)
  if (status.release?.mode === 'atomic') {
    lines.push(`  release:      ${status.release.releaseId} (atomic)`)
    lines.push(
      `  installed:    ${status.release.runningEqualsInstalled ? 'matches running' : 'differs from running'}`
    )
    lines.push(
      `  HRC build:    ${status.release.hrcBuild.setVersion} @ ${status.release.hrcBuild.sourceCommit}`
    )
    lines.push(
      `  ASP build:    ${status.release.aspBuild.setVersion} @ ${status.release.aspBuild.sourceCommit}`
    )
  } else if (status.release?.mode === 'unmanaged') {
    lines.push('  release:      unmanaged')
  }

  if (status.node) {
    const node = status.node
    lines.push(`  nodeId:       ${node.nodeId} (${node.nodeIdProvenance})`)
    lines.push(`  node mode:    ${node.mode}`)
    lines.push(
      `  node config:  ${node.configPath}${node.configExists ? '' : ' (absent, single-node mode)'}`
    )
    if (node.peerCount > 0) {
      lines.push(`  peers:        ${node.peerCount}`)
      for (const peer of node.peers) {
        lines.push(`    - ${peer.nodeId}: ${peer.endpoint}`)
        if (peer.registryEndpoint !== undefined) {
          lines.push(`      registry: ${peer.registryEndpoint}`)
        }
      }
    }
  }

  for (const peer of status.peerHealth ?? []) {
    lines.push(
      `  peer health: ${peer.nodeId} ${peer.state} (${peer.latencyMs}ms${
        peer.answeredAt === undefined ? '' : `, answered ${peer.answeredAt}`
      })${peer.detail === undefined ? '' : ` — ${peer.detail}`}`
    )
  }

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
    fatalExit('choose either --foreground or --daemon/--background, not both')
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
    fatalExit(
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
    fatalExit(`daemon is responsive on ${socketPath}, but pid file is missing at ${pidPath}`)
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
    fatalExit(`daemon socket ${socketPath} is still responsive, but pid ${pid} is not alive`)
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
    fatalExit(
      `daemon pid ${pid} did not stop within ${timeoutMs}ms${force ? ' after SIGTERM/SIGKILL' : ''}`
    )
  }

  try {
    await unlink(pidPath)
  } catch {}
}
