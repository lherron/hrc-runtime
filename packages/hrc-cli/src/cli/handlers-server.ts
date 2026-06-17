import { mkdir, unlink, writeFile } from 'node:fs/promises'

import type { KillBrokerTmuxLeasesResponse } from 'hrc-core'

import {
  collectServerRuntimeStatus,
  collectTmuxStatus,
  consumeShutdownIntent,
  daemonizeAndWait,
  detectLaunchdOwner,
  execProcess,
  formatInFlightWork,
  formatServerRuntimeStatus,
  formatTmuxStatus,
  launchctlKickstart,
  listInFlightWork,
  resolveServerMode,
  resolveServerPaths,
  stopServerProcess,
  waitForInFlightDrain,
  writeServerProcessLog,
  writeShutdownIntent,
} from '../cli-runtime.js'
import { agentHarnessGuardMessage } from '../harness-guard.js'
import { printJson } from '../print.js'
import { parseSinceMs, renderPorcelain, renderSessions } from '../session-render.js'
import { resolveSessionArg } from '../selector-resolve.js'
import { hasFlag, parseFlag, parseIntegerFlag, requireArg } from './argv.js'
import { CliStatusExit, createClient, fatal } from './shared.js'

/**
 * Run the HRC server in the foreground without probing launchd. Intended
 * for supervisors (launchd, systemd) that invoke hrc directly; user-facing
 * `hrc server start` delegates to launchctl when a Launch Agent is loaded.
 */
export async function cmdServerServe(_args: string[]): Promise<void> {
  const status = await collectServerRuntimeStatus()
  if (status.running) {
    fatal(`daemon already running on ${status.socketPath} (pid ${status.pid ?? 'unknown'})`)
  }
  return serverForeground()
}

export async function cmdServerStart(
  args: string[],
  defaultMode: 'foreground' | 'daemon'
): Promise<void> {
  const mode = resolveServerMode(args, defaultMode)
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const status = await collectServerRuntimeStatus()

  if (status.running) {
    fatal(`daemon already running on ${status.socketPath} (pid ${status.pid ?? 'unknown'})`)
  }

  const owner = await detectLaunchdOwner()
  if (owner) {
    await launchctlKickstart(owner)
    process.stderr.write(`hrc: daemon started via launchd (${owner.serviceTarget})\n`)
    return
  }

  if (mode === 'daemon') {
    await daemonizeAndWait(timeoutMs)
    return
  }

  return serverForeground()
}

/**
 * Block stop/restart when agent runs are still active. Default behaviour: list
 * what's running and exit non-zero. `--force` skips the check (and is also the
 * SIGTERM→SIGKILL escalation flag for the actual process kill). `--wait` polls
 * up to `--wait-timeout-ms` for runs to drain on their own; if the timeout
 * fires with work still in flight, we error out (no force fallback — the
 * operator has to opt in to that explicitly).
 *
 * For `restart`, tmux runs are excluded from the gate: tmux sessions are owned
 * by the tmux server, not by hrc, and they keep running across a daemon
 * restart. Only headless/sdk runs (which the daemon supervises directly) are
 * actually at risk.
 */
async function gateOnInFlightWork(args: string[], action: 'stop' | 'restart'): Promise<void> {
  if (hasFlag(args, '--force')) return
  const wait = hasFlag(args, '--wait')
  const waitTimeoutMs = parseIntegerFlag(args, '--wait-timeout-ms', {
    defaultValue: 300_000,
    min: 1,
  })

  const filter = action === 'restart' ? { excludeTransports: ['tmux'] as const } : undefined
  const noun = action === 'restart' ? 'headless run' : 'run'

  let inFlight = listInFlightWork(undefined, filter)
  if (inFlight.length === 0) return

  if (!wait) {
    process.stderr.write(
      `hrc: refusing to ${action}: ${inFlight.length} ${noun}(s) in flight. Use --wait to drain or --force to ${action} anyway.\n${formatInFlightWork(inFlight)}`
    )
    throw new CliStatusExit(2)
  }

  process.stderr.write(
    `hrc: waiting up to ${waitTimeoutMs}ms for ${inFlight.length} in-flight ${noun}(s) to drain...\n`
  )
  let lastReportedCount = inFlight.length
  inFlight = await waitForInFlightDrain({
    timeoutMs: waitTimeoutMs,
    filter,
    onTick: (items) => {
      if (items.length !== lastReportedCount) {
        process.stderr.write(`hrc: ${items.length} ${noun}(s) still in flight\n`)
        lastReportedCount = items.length
      }
    },
  })

  if (inFlight.length > 0) {
    process.stderr.write(
      `hrc: drain timed out after ${waitTimeoutMs}ms with ${inFlight.length} ${noun}(s) still in flight. Re-run with --force to ${action} anyway.\n${formatInFlightWork(inFlight)}`
    )
    throw new CliStatusExit(2)
  }
}

export async function cmdServerStop(args: string[]): Promise<void> {
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const force = hasFlag(args, '--force')
  const before = await collectServerRuntimeStatus()

  if (!before.running && before.pid === undefined) {
    process.stderr.write('hrc: daemon is not running\n')
    return
  }

  await gateOnInFlightWork(args, 'stop')

  const owner = await detectLaunchdOwner()
  if (owner) {
    fatal(
      `daemon is supervised by launchd (${owner.serviceTarget}); launchd will respawn it. ` +
        `To stop permanently: launchctl unload -w ~/Library/LaunchAgents/${owner.label}.plist`
    )
  }

  writeShutdownIntent('stop')
  await stopServerProcess({ timeoutMs, force, allowNotRunning: true })
  process.stderr.write('hrc: daemon stopped\n')
}

export async function cmdServerRestart(args: string[]): Promise<void> {
  const mode = resolveServerMode(args, 'daemon')
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const force = hasFlag(args, '--force')

  await gateOnInFlightWork(args, 'restart')

  writeShutdownIntent('restart')

  const owner = await detectLaunchdOwner()
  if (owner) {
    await launchctlKickstart(owner, { kill: true })
    process.stderr.write(`hrc: daemon restarted via launchd (${owner.serviceTarget})\n`)
    return
  }

  await stopServerProcess({ timeoutMs, force, allowNotRunning: true })
  if (mode === 'daemon') {
    await daemonizeAndWait(timeoutMs)
    process.stderr.write('hrc: daemon restarted\n')
    return
  }

  return serverForeground()
}

export async function cmdServerStatus(args: string[]): Promise<void> {
  const jsonFlag = hasFlag(args, '--json')
  const status = await collectServerRuntimeStatus()
  if (jsonFlag) {
    printJson(status)
  } else {
    process.stdout.write(formatServerRuntimeStatus(status))
  }
  if (status.exitCode !== 0) {
    throw new CliStatusExit(status.exitCode)
  }
}

async function serverForeground(): Promise<void> {
  // Refuse to boot as a child of a coding-agent harness: the server would leak
  // the harness's recursion-guard env into every child harness it launches,
  // silently killing every dispatched run. The launchd-delegating start/restart
  // paths return before reaching here, so the supported flows are unaffected.
  const harnessGuard = agentHarnessGuardMessage(process.env)
  if (harnessGuard) {
    fatal(harnessGuard)
  }

  const { createHrcServer } = await import('hrc-server')

  const paths = resolveServerPaths()

  const server = await createHrcServer({
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    lockPath: paths.lockPath,
    spoolDir: paths.spoolDir,
    dbPath: paths.dbPath,
    tmuxSocketPath: paths.tmuxSocketPath,
  })

  // Write PID file for foreground too (used by status/stop)
  await mkdir(paths.runtimeRoot, { recursive: true })
  await writeFile(paths.pidPath, `${process.pid}\n`)

  writeServerProcessLog('server.listening', {
    pid: process.pid,
    socketPath: paths.socketPath,
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    tmuxSocketPath: paths.tmuxSocketPath,
  })

  const shutdown = async (reason: string) => {
    const intent = consumeShutdownIntent()
    writeServerProcessLog('server.shutting_down', {
      pid: process.pid,
      reason,
      requestedBy: intent?.requestedBy ?? null,
      ...(intent
        ? {
            requestedAction: intent.action,
            requestedRunId: intent.requestedRunId,
            requestedByPid: intent.byPid,
          }
        : {}),
    })
    await server.stop()
    // Clean up PID file
    try {
      await unlink(paths.pidPath)
    } catch {}
    process.exit(0)
  }

  // Ignore SIGHUP so the daemon survives when the parent terminal/session exits
  // (e.g., Claude Code terminating). SIGINT and SIGTERM still trigger graceful shutdown.
  process.on('SIGHUP', () => {})
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

export async function cmdSessionResolve(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  if (!scope) fatal('--scope is required for session resolve')

  const lane = parseFlag(args, '--lane') ?? 'main'
  const sessionRef = `${scope}/lane:${lane}`
  const create = hasFlag(args, '--create')

  const client = createClient()
  const result = await client.resolveSession({ sessionRef, ...(create ? { create: true } : {}) })
  printJson(result)
}

export async function cmdSessionList(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  const lane = parseFlag(args, '--lane')

  const client = createClient()
  const sessions = await client.listSessions({
    ...(scope ? { scopeRef: scope } : {}),
    ...(lane ? { laneRef: lane } : {}),
  })

  if (hasFlag(args, '--porcelain')) {
    process.stdout.write(renderPorcelain(sessions))
    return
  }

  // JSON when forced or piped (keeps `hrc session list | jq` working); the
  // human render only kicks in for an interactive TTY launch.
  if (hasFlag(args, '--json') || !process.stdout.isTTY) {
    printJson(sessions)
    return
  }

  const since = parseFlag(args, '--since')
  process.stdout.write(
    renderSessions(sessions, {
      now: new Date(),
      color: process.stdout.isTTY === true,
      all: hasFlag(args, '--all'),
      gens: hasFlag(args, '--gens'),
      groupBy: hasFlag(args, '--by-project') ? 'project' : 'agent',
      ...(since ? { sinceMs: parseSinceMs(since) } : {}),
      ...(scope ? { scope } : {}),
    })
  )
}

export async function cmdSessionGet(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const live = hasFlag(args, '--live')
  const probe = hasFlag(args, '--probe')

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const session = await client.getSession(hostSessionId)

  if (!live) {
    printJson(session)
    return
  }

  // --live: join the backing runtime generation(s). Broker-backed runtimes get
  // the broker read model (InvocationInspectionSummary); non-broker runtimes get
  // the HRC-derived fallback view (labeled source:'hrc-derived').
  const runtimes = await client.listRuntimes({ hostSessionId })
  const inspections = await Promise.all(
    runtimes.map(async (rt) => {
      try {
        const inspection = await client.brokerInspect({
          runtimeId: rt.runtimeId,
          ...(probe ? { probeLiveness: true } : {}),
        })
        return { runtimeId: rt.runtimeId, generation: rt.generation, inspection }
      } catch (error) {
        return {
          runtimeId: rt.runtimeId,
          generation: rt.generation,
          inspectionError: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )

  printJson({ session, runtimes: inspections })
}

export async function cmdSessionDropContinuation(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const reason = parseFlag(args, '--reason')

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const result = await client.dropContinuation({
    hostSessionId,
    ...(reason ? { reason } : {}),
  })
  printJson(result)
}

export async function cmdTmuxStatus(args: string[]): Promise<void> {
  const jsonFlag = hasFlag(args, '--json')
  const status = await collectTmuxStatus()
  if (jsonFlag) {
    printJson(status)
    return
  }
  process.stdout.write(formatTmuxStatus(status))
}

export async function cmdTmuxKill(args: string[]): Promise<void> {
  if (!hasFlag(args, '--yes')) {
    fatal(
      'tmux kill is destructive; rerun with --yes to kill the HRC tmux server and broker-tmux lease servers'
    )
  }

  let brokerLeaseResult: KillBrokerTmuxLeasesResponse
  try {
    const client = createClient()
    brokerLeaseResult = await client.killBrokerTmuxLeases()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fatal(`daemon unavailable; broker-tmux lease servers were not reaped: ${detail}`)
  }

  const status = await collectTmuxStatus()
  if (!status.available) {
    fatal(status.error ?? 'tmux unavailable')
  }

  process.stderr.write(
    `hrc: broker-tmux lease server(s) reaped: ${brokerLeaseResult.killedLiveLeaseServers} killed, ${brokerLeaseResult.removedDeadSocketFiles} dead socket file(s) removed`
  )
  if (brokerLeaseResult.skippedClaimed > 0) {
    process.stderr.write(`, ${brokerLeaseResult.skippedClaimed} claimed preserved`)
  }
  if (brokerLeaseResult.errors > 0) {
    process.stderr.write(`, ${brokerLeaseResult.errors} error(s)`)
  }
  process.stderr.write('\n')

  if (!status.running) {
    process.stderr.write('hrc: tmux server is not running\n')
    return
  }

  const result = await execProcess(['tmux', '-S', status.socketPath, 'kill-server'])
  if (result.exitCode !== 0) {
    fatal(`${result.stderr}\n${result.stdout}`.trim() || 'tmux kill-server failed')
  }

  process.stderr.write(`hrc: tmux server killed (${status.sessionCount} session(s))\n`)
}
