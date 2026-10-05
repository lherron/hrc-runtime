import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { assertSocketPathWithinBudget, socketPathByteBudget } from 'spaces-harness-broker-client'

import { SubprocessTimeoutError, runBoundedSubprocess } from './bounded-subprocess.js'
import { requireTmuxPane } from './require-helpers.js'
import { writeServerLog } from './server-log.js'
import type { HrcServerOptions } from './server-types.js'

const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}

export function getTmuxSocketPath(
  options: Pick<HrcServerOptions, 'runtimeRoot' | 'tmuxSocketPath'>
): string {
  return options.tmuxSocketPath ?? join(options.runtimeRoot, 'tmux.sock')
}

const BROKER_TMUX_DRIVER_SEGMENT_MAX = 12
const BROKER_TMUX_RUNTIME_SEGMENT_MAX = 32

export function getBrokerTmuxSocketPath(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  brokerDriver: string,
  runtimeId: string
): string {
  const driver = sanitizeBrokerTmuxPathSegment(brokerDriver).slice(
    0,
    BROKER_TMUX_DRIVER_SEGMENT_MAX
  )
  const runtime = sanitizeBrokerTmuxPathSegment(runtimeId).slice(0, BROKER_TMUX_RUNTIME_SEGMENT_MAX)
  return join(options.runtimeRoot, 'btmux', `${driver}-${runtime}.sock`)
}

/**
 * T-10330 — the daemon refuses at startup a runtime root whose Unix sockets
 * cannot fit `sockaddr_un.sun_path`, instead of failing every birth later with
 * a truncated "File name too long". Names the FULL path, its byte length and
 * the limit.
 */
export class RuntimeRootSocketPathTooLongError extends Error {
  readonly code = 'runtime_root_socket_path_too_long'
  constructor(
    readonly socket: 'hrc.sock' | 'tmux.sock' | 'btmux',
    readonly socketPath: string,
    readonly byteLength: number,
    readonly limit: number
  ) {
    const label = socket === 'btmux' ? 'worst-case btmux' : socket
    super(
      [
        `runtime root socket path too long: the ${label} socket path ${socketPath} is ${byteLength} bytes;`,
        `the platform sockaddr_un limit is ${limit} bytes including the trailing NUL, so at most ${limit - 1}.`,
        'Use a shorter HRC_RUNTIME_DIR.',
      ].join(' ')
    )
    this.name = 'RuntimeRootSocketPathTooLongError'
  }
}

/**
 * Check the daemon socket, the shared tmux socket and the worst-case per-runtime
 * broker tmux socket (driver and runtime-id segments at their full width)
 * against the platform budget. Throws {@link RuntimeRootSocketPathTooLongError}
 * for the first one that cannot fit.
 */
export function assertRuntimeRootSocketPathsFit(
  options: Pick<HrcServerOptions, 'runtimeRoot' | 'socketPath' | 'tmuxSocketPath'>
): void {
  const worstBrokerTmux = getBrokerTmuxSocketPath(
    options,
    // Real ids at full segment width: the longest driver and a full runtime id
    // both truncate to the segment caps, so this is the longest path a birth
    // can derive.
    'codex-app-server',
    'rt-00000000-0000-0000-0000-000000000000'
  )
  const candidates = [
    ['hrc.sock', options.socketPath],
    ['tmux.sock', getTmuxSocketPath(options)],
    ['btmux', worstBrokerTmux],
  ] as const
  const limit = socketPathByteBudget()
  for (const [socket, socketPath] of candidates) {
    const byteLength = Buffer.byteLength(socketPath, 'utf8')
    if (byteLength + 1 > limit) {
      throw new RuntimeRootSocketPathTooLongError(socket, socketPath, byteLength, limit)
    }
  }
}

export function sanitizeBrokerTmuxPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Allocate the per-runtime broker Unix IPC socket path. The durable interactive
 * broker is reached over a Unix-domain socket whose `sockaddr_un.sun_path` budget
 * is tiny (104B macOS / 108B Linux), so the path is SHORT BY CONSTRUCTION: a
 * 12-hex hash of (driver, runtimeId) under `<runtimeRoot>/bipc/<hash>/b.sock`.
 * The owner-only dir + attach token live alongside `b.sock`. T-01812 Phase 3.
 */
export function getBrokerIpcSocketPath(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  brokerDriver: string,
  runtimeId: string
): string {
  const hash = createHash('sha256')
    .update(`${brokerDriver}:${runtimeId}`)
    .digest('hex')
    .slice(0, 12)
  return join(options.runtimeRoot, 'bipc', hash, 'b.sock')
}

/**
 * T-04921 (T-04905 Phase A) — allocate the per-runtime broker OBSERVER socket
 * path for the codex-app-server tmux-tui route. The read-only observer
 * socket is HRC-owned and lives UNDER THE SAME owner-only `bipc/<hash>/` leaf as
 * the broker IPC socket (`b.sock`), so HRC selects ONE path it passes to BOTH the
 * durable Unix broker launch (`--experimental-observer-socket <path>`) and the
 * renderer dispatch env (`HARNESS_BROKER_OBSERVER_SOCKET`) — never two independent
 * derivations that could diverge. Derived from {@link getBrokerIpcSocketPath} so
 * the two paths share a directory by construction.
 */
export function getBrokerObserverSocketPath(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  brokerDriver: string,
  runtimeId: string
): string {
  const ipcSocketPath = getBrokerIpcSocketPath(options, brokerDriver, runtimeId)
  return join(dirname(ipcSocketPath), 'observer.sock')
}

/**
 * HARD preflight a broker Unix IPC socket path against the platform
 * `sockaddr_un` budget BEFORE any tmux spawn / connect — so an over-long path
 * fails EARLY with a readable "socket path too long" error rather than a
 * low-level bind/connect errno later. Wraps the ASP budget assertion.
 */
export function preflightBrokerIpcSocketPath(socketPath: string): void {
  assertSocketPathWithinBudget(socketPath)
}

/** `tmux -V` prints and exits without touching a server. */
const TMUX_VERSION_PROBE_TIMEOUT_MS = 5_000

export async function detectTmuxBackend(): Promise<{
  available: boolean
  version?: string | undefined
}> {
  try {
    const { stdout, stderr, exitCode } = await runBoundedSubprocess(['tmux', '-V'], {
      timeoutMs: TMUX_VERSION_PROBE_TIMEOUT_MS,
    })
    const version = parseTmuxVersion(stdout, stderr)
    const available =
      exitCode === 0 &&
      (version.major > MIN_SUPPORTED_TMUX_VERSION.major ||
        (version.major === MIN_SUPPORTED_TMUX_VERSION.major &&
          version.minor >= MIN_SUPPORTED_TMUX_VERSION.minor))
    return {
      available,
      version: version.raw,
    }
  } catch (error) {
    // A timed-out probe says nothing about whether tmux is installed; name it
    // in the log so an unavailable status is never read as "tmux is missing".
    if (error instanceof SubprocessTimeoutError) {
      writeServerLog('WARN', 'tmux.version_probe_timeout', { timeoutMs: error.timeoutMs })
    }
    return { available: false }
  }
}

export function parseTmuxVersion(
  stdout: string,
  stderr: string
): { major: number; minor: number; raw: string } {
  const source = `${stdout}\n${stderr}`.trim()
  const match = source.match(/tmux\s+(\d+)\.(\d+(?:[a-z])?)/i)
  if (!match) {
    throw new Error(`unable to parse tmux version from output: ${source || '<empty>'}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt((match[2] ?? '0').replace(/[^0-9].*$/, ''), 10),
    raw: `${match[1]}.${match[2]}`,
  }
}

export function getTmuxSessionName(runtime: HrcRuntimeSnapshot): string {
  return requireTmuxPane(runtime).sessionName
}
