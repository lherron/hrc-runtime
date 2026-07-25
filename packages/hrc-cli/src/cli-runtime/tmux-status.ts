import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveRuntimeRoot, resolveTmuxSocketPath } from 'hrc-core'

import { execProcess } from './server-paths.js'

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
}): Promise<{
  leases: TmuxLeaseStatus[]
  diagnostics: BrokerTmuxLeaseDiagnostics
}> {
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
