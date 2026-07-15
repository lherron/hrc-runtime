import { Database } from 'bun:sqlite'
import { execFile } from 'node:child_process'
import { existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { join } from 'node:path'
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

import { fatalExit, hasFlag } from './runtime-args.js'

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
  runtimeRoot: string
  stateRoot: string
  cwd?: string | undefined
  binaryPath?: string | undefined
  packagePath?: string | undefined
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
      >
    | undefined
  tmux: TmuxStatus
  serverStatus?: Pick<HrcStatusResponse, 'startedAt' | 'apiVersion'> | undefined
  error?: string | undefined
}

export type TmuxLeaseStatus = {
  socketPath: string
  running: boolean
  sessions: string[]
  error?: string | undefined
  /**
   * T-01814 (T-01801 Phase 5) — per-lease control state + both named panes so an
   * operator can tell the broker control pane from the operator TUI pane and see
   * whether the runtime is broker-attached or degraded.
   */
  controlMode?: string | undefined
  brokerAttached?: boolean | undefined
  brokerPane?: { windowName: string; paneId: string; pid?: number | undefined } | undefined
  tuiPane?: { windowName: string; paneId: string } | undefined
}

export type TmuxStatus = {
  available: boolean
  version?: string | undefined
  socketPath: string
  running: boolean
  sessionCount: number
  sessions: string[]
  leaseDiagnostics?: BrokerTmuxLeaseDiagnostics | undefined
  /**
   * Per-runtime broker-tmux lease servers under `<runtimeRoot>/btmux/`. Each is
   * an independent tmux server on its own socket (T-01738 F-V2). Empty when no
   * lease sockets exist.
   */
  leases?: TmuxLeaseStatus[] | undefined
  error?: string | undefined
}

export type BrokerTmuxLeaseDiagnostics = {
  total: number
  probed: number
  skipped: number
}

export function writeServerProcessLog(
  event: string,
  details?: Record<string, unknown> | undefined
): void {
  const ts = new Date().toISOString()
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  process.stderr.write(`${ts} [hrc-server] INFO ${event}${suffix}\n`)
}

/**
 * Attribution for a daemon stop/restart. The CLI process that runs
 * `hrc server stop|restart` knows who is asking (HRC_SESSION_REF / HRC_RUN_ID
 * from its env), but it tears the daemon down with a bare SIGTERM — a signal
 * carries no payload, and the launchd-supervised daemon's own env is fixed, so
 * it cannot otherwise learn the initiator. We hand the identity over via a
 * short-lived intent file the daemon consumes in its shutdown handler.
 */
export type ShutdownIntent = {
  action: 'stop' | 'restart'
  requestedBy: string | null
  requestedRunId: string | null
  byPid: number
  at: string
}

function shutdownIntentPath(): string {
  return `${resolveRuntimeRoot()}/shutdown-intent.json`
}

/**
 * Record who is initiating a stop/restart, just before signalling the daemon.
 * Best-effort: a failure here must never block the actual stop/restart.
 */
export function writeShutdownIntent(action: 'stop' | 'restart'): void {
  const intent: ShutdownIntent = {
    action,
    requestedBy: process.env['HRC_SESSION_REF'] ?? null,
    requestedRunId: process.env['HRC_RUN_ID'] ?? null,
    byPid: process.pid,
    at: new Date().toISOString(),
  }
  try {
    writeFileSync(shutdownIntentPath(), `${JSON.stringify(intent)}\n`)
  } catch {}
}

/**
 * Read and delete the shutdown intent, returning it only when fresh. Called by
 * the daemon's shutdown handler so it can attribute `server.shutting_down`. A
 * missing/stale file means the SIGTERM came from outside the CLI (manual kill,
 * launchctl, crash supervisor) — the caller logs that as an unattributed stop.
 */
export function consumeShutdownIntent(maxAgeMs = 30_000): ShutdownIntent | undefined {
  const path = shutdownIntentPath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    unlinkSync(path)
  } catch {}
  try {
    const intent = JSON.parse(raw) as ShutdownIntent
    const age = Date.now() - new Date(intent.at).getTime()
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      return undefined
    }
    return intent
  } catch {
    return undefined
  }
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

const DEFAULT_LAUNCHD_LABEL = 'com.praesidium.hrc-server'
const HRC_OTLP_PREFERRED_PORT_ENV = 'HRC_OTLP_PREFERRED_PORT'
const HRC_OTEL_PREFERRED_PORT_ENV = 'HRC_OTEL_PREFERRED_PORT'

type EnvMap = Record<string, string | undefined>

function readOptionalEnv(env: EnvMap, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function resolveOtelPreferredPortFromEnv(env: EnvMap = process.env): number | undefined {
  const raw =
    readOptionalEnv(env, HRC_OTLP_PREFERRED_PORT_ENV) ??
    readOptionalEnv(env, HRC_OTEL_PREFERRED_PORT_ENV)
  if (raw === undefined) return undefined

  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${HRC_OTLP_PREFERRED_PORT_ENV} must be an integer port, got ${JSON.stringify(raw)}`
    )
  }
  const port = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${HRC_OTLP_PREFERRED_PORT_ENV} must be between 0 and 65535, got ${raw}`)
  }
  return port
}

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
          runtimeRoot: status.runtimeRoot,
          stateRoot: status.stateRoot,
          socketPath: status.socketPath,
          dbPath: status.dbPath,
          cwd: status.cwd,
          binaryPath: status.binaryPath,
          packagePath: status.packagePath,
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
      runtimeRoot: paths.runtimeRoot,
      stateRoot: paths.stateRoot,
      ...(api ? { cwd: api.cwd, binaryPath: api.binaryPath, packagePath: api.packagePath } : {}),
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

/**
 * One in-flight unit of work that would be killed by stopping/restarting hrc.
 */
export type InFlightWork = {
  runId: string
  scopeRef: string
  laneRef: string
  status: string
  transport: string | undefined
  startedAt: string | undefined
}

/**
 * How recently a runtime must have shown activity to count as "in flight".
 * Runtimes whose `runs.status='started'` row was never reconciled (orphans
 * from prior crashes or dropped tmux sessions) are filtered out so the gate
 * doesn't permanently block on zombie state from days ago. Operators can
 * still see stale rows by querying the db directly; the gate's job is to
 * protect live work, not audit history.
 */
const IN_FLIGHT_RECENCY_MS = 5 * 60_000

/**
 * The caller's own runId, if invoked from inside an agent runtime. Used to
 * filter the caller from the in-flight list so `hrc server restart --wait`
 * doesn't deadlock waiting on itself: the agent can't finish its turn until
 * the wait returns, and the wait can't return until the agent isn't in
 * flight. Self-exclusion breaks the cycle.
 */
function selfRunId(): string | undefined {
  return process.env['HRC_RUN_ID']
}

/**
 * Optional filter for the in-flight list. `excludeTransports` drops rows whose
 * `runs.transport` matches any listed value. Used by `hrc server restart` to
 * skip tmux runs, which keep running independently of the daemon and are not
 * killed by a restart.
 */
export type InFlightFilter = {
  excludeTransports?: readonly string[] | undefined
}

/**
 * Read in-flight runs directly from hrc state.sqlite. We hit the file rather
 * than the daemon because callers want this data right before stopping the
 * daemon — querying the daemon mid-shutdown is racy and pointless.
 *
 * "In flight" = a runtime is currently `busy` with an `active_run_id`, **and**
 * the hrc_events stream shows recent activity for that runtime. We use the
 * event timestamp rather than `runtimes.last_activity_at` because the latter
 * is set at child_started and never refreshed, so legitimately-busy runtimes
 * can show ancient values. We JOIN through runtimes rather than scanning runs
 * alone because abandoned `runs.status='started'` rows accumulate when
 * launches die hard.
 */
export function listInFlightWork(dbPath?: string, filter?: InFlightFilter): InFlightWork[] {
  const path = dbPath ?? resolveDatabasePath()
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    const cutoff = new Date(Date.now() - IN_FLIGHT_RECENCY_MS).toISOString()
    const rows = db
      .query<
        {
          run_id: string
          scope_ref: string
          lane_ref: string
          status: string
          transport: string | null
          started_at: string | null
        },
        [string]
      >(
        `SELECT r.run_id, r.scope_ref, r.lane_ref, r.status, r.transport, r.started_at
         FROM runtimes rt
         INNER JOIN runs r ON r.run_id = rt.active_run_id
         WHERE rt.status = 'busy'
           AND rt.active_run_id IS NOT NULL
           AND r.status IN ('accepted', 'started', 'running')
           AND r.completed_at IS NULL
           AND (
             SELECT e.ts FROM hrc_events e
             WHERE e.runtime_id = rt.runtime_id
             ORDER BY e.hrc_seq DESC
             LIMIT 1
           ) > ?
         ORDER BY r.started_at ASC`
      )
      .all(cutoff)
    const self = selfRunId()
    const excluded = filter?.excludeTransports?.length
      ? new Set(filter.excludeTransports)
      : undefined
    return rows
      .filter((row) => row.run_id !== self)
      .filter((row) => (excluded ? !excluded.has(row.transport ?? '') : true))
      .map((row) => ({
        runId: row.run_id,
        scopeRef: row.scope_ref,
        laneRef: row.lane_ref,
        status: row.status,
        transport: row.transport ?? undefined,
        startedAt: row.started_at ?? undefined,
      }))
  } finally {
    db.close()
  }
}

export function formatInFlightWork(items: InFlightWork[]): string {
  if (items.length === 0) return '(no in-flight work)\n'
  const lines: string[] = []
  for (const item of items) {
    const transport = item.transport ? ` [${item.transport}]` : ''
    const started = item.startedAt ? ` since ${item.startedAt}` : ''
    lines.push(
      `  ${item.runId}  ${item.scopeRef}~${item.laneRef}  ${item.status}${transport}${started}`
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Poll until no in-flight work remains, or the timeout elapses. Returns the
 * final in-flight list (empty on success). pollIntervalMs defaults to 500.
 */
export async function waitForInFlightDrain(options: {
  timeoutMs: number
  pollIntervalMs?: number | undefined
  dbPath?: string | undefined
  filter?: InFlightFilter | undefined
  onTick?: ((items: InFlightWork[]) => void) | undefined
}): Promise<InFlightWork[]> {
  const interval = options.pollIntervalMs ?? 500
  const deadline = Date.now() + options.timeoutMs
  let items = listInFlightWork(options.dbPath, options.filter)
  options.onTick?.(items)
  while (items.length > 0 && Date.now() < deadline) {
    await delay(interval)
    items = listInFlightWork(options.dbPath, options.filter)
    options.onTick?.(items)
  }
  return items
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

const TMUX_DIAGNOSTIC_TIMEOUT_MS = 750
const DEFAULT_BROKER_TMUX_LEASE_PROBE_LIMIT = 64

type TmuxSessionProbe = {
  running: boolean
  sessions: string[]
  error?: string | undefined
}

/** List the sessions on a single tmux server socket without letting diagnostics wedge. */
async function listTmuxSessionsOnSocket(socketPath: string): Promise<TmuxSessionProbe> {
  const listResult = await execProcess(['tmux', '-S', socketPath, 'list-sessions', '-F', '#S'], {
    timeoutMs: TMUX_DIAGNOSTIC_TIMEOUT_MS,
  })
  if (listResult.timedOut) {
    return {
      running: false,
      sessions: [],
      error: `unresponsive after ${TMUX_DIAGNOSTIC_TIMEOUT_MS}ms`,
    }
  }
  if (listResult.exitCode !== 0) {
    return { running: false, sessions: [] }
  }
  return {
    running: true,
    sessions: listResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  }
}

/**
 * Enumerate per-runtime broker-tmux lease servers under `<runtimeRoot>/btmux/`.
 * Each `*.sock` is an independent tmux server; a dead/leftover socket reports
 * running:false (T-01738 F-V2). Read-only — never kills or removes anything.
 */
export async function collectBrokerTmuxLeases(options?: {
  probeLimit?: number | undefined
}): Promise<TmuxLeaseStatus[]> {
  return collectBrokerTmuxLeaseDiagnostics(options).then((result) => result.leases)
}

export async function collectBrokerTmuxLeaseDiagnostics(options?: {
  probeLimit?: number | undefined
}): Promise<{ leases: TmuxLeaseStatus[]; diagnostics: BrokerTmuxLeaseDiagnostics }> {
  const dir = join(resolveRuntimeRoot(), 'btmux')
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith('.sock'))
  } catch {
    return { leases: [], diagnostics: { total: 0, probed: 0, skipped: 0 } }
  }
  const probeLimit = options?.probeLimit
  const sortedEntries = entries.sort()
  const probeEntries =
    probeLimit !== undefined && probeLimit >= 0 ? sortedEntries.slice(0, probeLimit) : sortedEntries
  const leases: TmuxLeaseStatus[] = []
  for (const entry of probeEntries) {
    const socketPath = join(dir, entry)
    const probe = await listTmuxSessionsOnSocket(socketPath)
    leases.push({
      socketPath,
      running: probe.running,
      sessions: probe.sessions,
      ...(probe.error ? { error: probe.error } : {}),
    })
  }
  return {
    leases,
    diagnostics: {
      total: entries.length,
      probed: probeEntries.length,
      skipped: Math.max(0, entries.length - probeEntries.length),
    },
  }
}

export async function collectTmuxStatus(options?: {
  includeLeases?: boolean | undefined
  leaseProbeLimit?: number | undefined
}): Promise<TmuxStatus> {
  const socketPath = resolveTmuxSocketPath()
  const versionResult = await execProcess(['tmux', '-V'], {
    timeoutMs: TMUX_DIAGNOSTIC_TIMEOUT_MS,
  })
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim()
  const version =
    versionResult.exitCode === 0 && !versionResult.timedOut ? versionOutput : undefined
  if (versionResult.exitCode !== 0 || versionResult.timedOut) {
    return {
      available: false,
      socketPath,
      running: false,
      sessionCount: 0,
      sessions: [],
      error: versionResult.timedOut
        ? `tmux -V unresponsive after ${TMUX_DIAGNOSTIC_TIMEOUT_MS}ms`
        : versionOutput || 'tmux unavailable',
    }
  }

  const leaseResult =
    options?.includeLeases === false
      ? {
          leases: [] as TmuxLeaseStatus[],
          diagnostics: { total: 0, probed: 0, skipped: 0 },
        }
      : await collectBrokerTmuxLeaseDiagnostics({
          probeLimit: options?.leaseProbeLimit ?? DEFAULT_BROKER_TMUX_LEASE_PROBE_LIMIT,
        })
  const { leases, diagnostics: leaseDiagnostics } = leaseResult

  const listResult = await execProcess(['tmux', '-S', socketPath, 'list-sessions', '-F', '#S'], {
    timeoutMs: TMUX_DIAGNOSTIC_TIMEOUT_MS,
  })
  if (listResult.exitCode !== 0) {
    if (listResult.timedOut) {
      return {
        available: true,
        version,
        socketPath,
        running: false,
        sessionCount: 0,
        sessions: [],
        leases,
        leaseDiagnostics,
        error: `tmux list-sessions unresponsive after ${TMUX_DIAGNOSTIC_TIMEOUT_MS}ms`,
      }
    }
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
      leases,
      leaseDiagnostics,
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
    leases,
    leaseDiagnostics,
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

  const leases = status.leases ?? []
  const leaseDiagnostics = status.leaseDiagnostics
  const leaseSummary =
    leaseDiagnostics && leaseDiagnostics.total !== leases.length
      ? `${leases.length} probed of ${leaseDiagnostics.total} (${leaseDiagnostics.skipped} skipped)`
      : String(leases.length)
  lines.push(`  btmux leases: ${leaseSummary}`)
  for (const lease of leases) {
    const state = lease.running
      ? lease.sessions.length > 0
        ? lease.sessions.join(', ')
        : '(running, no sessions)'
      : lease.error
        ? `(${lease.error})`
        : '(dead socket)'
    lines.push(`    - ${lease.socketPath}: ${state}`)
    if (lease.controlMode !== undefined || lease.brokerAttached !== undefined) {
      const attached = lease.brokerAttached ? 'yes' : 'no'
      lines.push(`        control: ${lease.controlMode ?? '(unknown)'} (attached=${attached})`)
    }
    if (lease.brokerPane) {
      const pid = lease.brokerPane.pid !== undefined ? lease.brokerPane.pid : '(unknown)'
      lines.push(
        `        broker:  window=${lease.brokerPane.windowName} pane=${lease.brokerPane.paneId} pid=${pid}`
      )
    }
    if (lease.tuiPane) {
      lines.push(`        tui:     window=${lease.tuiPane.windowName} pane=${lease.tuiPane.paneId}`)
    }
  }

  if (status.error) {
    lines.push(`  error:        ${status.error}`)
  }

  return `${lines.join('\n')}\n`
}
