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

/**
 * A LaunchAgent plist that exists on disk for this label, governs THIS runtime
 * root, and whose job is not loaded in the user's gui domain.
 *
 * This is the state that produced T-07957: the plist carries the daemon's whole
 * environment (HRC_MAIL_KICKER_ENABLED, HRC_WRKQ_DB, the broker flags), and when
 * the job is not loaded `detectLaunchdOwner` returns null exactly as it does on
 * a node that has no LaunchAgent at all. `hrc server start`/`restart` then take
 * the self-daemonize path and produce a healthy, correctly-versioned daemon with
 * none of that environment: the mail kicker is off and there is no canonical
 * wrkq endpoint, so cold summonses to that node are never seated and no local
 * signal says why.
 */
export type StrandedLaunchAgent = {
  label: string
  plistPath: string
  serviceTarget: string
  domain: string
  /** HRC_* keys the plist declares, sorted; empty when the plist declares none. */
  declaredEnvKeys: readonly string[]
}

function normalizeRoot(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
}

/**
 * Read a plist's `EnvironmentVariables` dict via plutil. Returns null when the
 * plist has no such key, is unreadable, or is not a string dict — all of which
 * mean "this plist declares no environment we can reason about", never "the
 * plist is absent".
 */
async function readPlistEnvironment(plistPath: string): Promise<Record<string, string> | null> {
  const result = await execProcess([
    'plutil',
    '-extract',
    'EnvironmentVariables',
    'json',
    '-o',
    '-',
    plistPath,
  ])
  if (result.exitCode !== 0) return null
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value
    }
    return env
  } catch {
    return null
  }
}

/**
 * Detect a plist that exists but is not loaded, for the daemon this CLI would
 * act on. Call only after `detectLaunchdOwner()` has returned null.
 *
 * Governance is the discriminator, not mere existence: a `hrc dev env` daemon or
 * a test daemon runs on its own runtime root and must keep self-daemonizing even
 * though the operator's plist sits in ~/Library/LaunchAgents. So the plist
 * governs this daemon only when its declared HRC_RUNTIME_DIR matches the
 * runtime root we resolved, or — when the plist declares none — when this
 * process also has no HRC_RUNTIME_DIR override, so both take the same default.
 */
export async function detectStrandedLaunchAgent(): Promise<StrandedLaunchAgent | null> {
  if (process.platform !== 'darwin') return null
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) return null
  const home = process.env['HOME']
  if (home === undefined || home.length === 0) return null

  const label = process.env['HRC_LAUNCHD_LABEL'] ?? DEFAULT_LAUNCHD_LABEL
  const plistPath = `${home}/Library/LaunchAgents/${label}.plist`
  // Cheapest discriminator first: nodes that are genuinely unsupervised have no
  // plist, and must not pay for a launchctl probe on every start.
  if (!existsSync(plistPath)) return null

  const domain = `gui/${uid}`
  const serviceTarget = `${domain}/${label}`
  const loaded = await execProcess(['launchctl', 'print', serviceTarget])
  if (loaded.exitCode === 0) return null

  const declared = await readPlistEnvironment(plistPath)
  const declaredRuntimeDir = declared?.['HRC_RUNTIME_DIR']
  if (declaredRuntimeDir === undefined) {
    if (process.env['HRC_RUNTIME_DIR'] !== undefined) return null
  } else if (
    normalizeRoot(declaredRuntimeDir) !== normalizeRoot(resolveServerPaths().runtimeRoot)
  ) {
    return null
  }

  const declaredEnvKeys = Object.keys(declared ?? {})
    .filter((key) => key.startsWith('HRC_'))
    .sort()
  return { label, plistPath, serviceTarget, domain, declaredEnvKeys }
}

/**
 * The refusal text for a stranded LaunchAgent. Names the mechanism and the exact
 * repair, because the failure it prevents is silent: the operator who ignores
 * this and self-daemonizes gets a green `hrc server status` on the right release
 * and a node that quietly stops seating cold summonses.
 */
export function formatStrandedLaunchAgentRefusal(
  agent: StrandedLaunchAgent,
  action: 'start' | 'restart'
): string {
  const missing =
    agent.declaredEnvKeys.length > 0 ? agent.declaredEnvKeys.join(', ') : 'its environment'
  return [
    `refusing to ${action} an unsupervised daemon: the LaunchAgent plist ${agent.plistPath} exists but ${agent.serviceTarget} is not loaded.`,
    `Self-daemonizing here would run a daemon with none of the environment the plist declares (${missing}), which silently disables the mail kicker and the canonical wrkq endpoint (T-07957).`,
    'Repair:',
    '  hrc server stop            # if an unsupervised daemon already holds the socket',
    `  launchctl bootout ${agent.serviceTarget} 2>/dev/null || true`,
    `  launchctl bootstrap ${agent.domain} ${agent.plistPath}`,
    `If this node is deliberately unsupervised, move ${agent.plistPath} aside first.`,
  ].join('\n')
}

/**
 * `EALREADY` from launchctl. `kickstart -k` asked launchd to kill and relaunch a
 * job whose restart was already in flight, so launchd declined to start a second
 * one. The actuation still happened — this is a race with our own shutdown or
 * with launchd's KeepAlive respawn, not a failure to restart.
 */
export const LAUNCHCTL_EALREADY = 37

export type LaunchctlKickstartResult = {
  /** launchctl reported success. */
  ok: boolean
  exitCode: number
  /** Trimmed stderr/stdout from launchctl, when it said anything. */
  detail: string
  /**
   * launchctl failed, but with a status that does not mean the job failed to
   * restart. Callers must still prove the outcome; they must not report failure
   * on this basis alone.
   */
  benign: boolean
  /** Human-readable summary for logs and error messages. */
  message: string
}

/**
 * Ask launchd to (re)start the job. Never exits or throws on a non-zero
 * launchctl status: the exit code of `launchctl kickstart` describes the
 * *actuation request*, not the *outcome*, and only observing the daemon can
 * establish the latter. Callers own the verdict — see `requireRestartProof`.
 */
export async function launchctlKickstart(
  owner: LaunchdOwner,
  opts: { kill?: boolean } = {}
): Promise<LaunchctlKickstartResult> {
  const argv = ['launchctl', 'kickstart']
  if (opts.kill) argv.push('-k')
  argv.push(owner.serviceTarget)
  const result = await execProcess(argv)
  if (result.exitCode === 0) {
    return { ok: true, exitCode: 0, detail: '', benign: false, message: '' }
  }

  const detail = (result.stderr || result.stdout).trim()
  const benign = result.exitCode === LAUNCHCTL_EALREADY
  const message = benign
    ? `launchctl kickstart reported EALREADY (exit ${LAUNCHCTL_EALREADY}: operation already in progress) for ${owner.serviceTarget}; a restart was already in flight`
    : `launchctl kickstart failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
  return { ok: false, exitCode: result.exitCode, detail, benign, message }
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
