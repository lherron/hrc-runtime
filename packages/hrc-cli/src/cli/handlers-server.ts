import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'

import type { KillBrokerTmuxLeasesResponse } from 'hrc-core'

import {
  collectServerRuntimeStatus,
  collectTmuxStatus,
  consumeShutdownIntent,
  daemonizeAndWait,
  detectLaunchdOwner,
  evaluateServerLifecycleAuthorization,
  execProcess,
  formatInFlightWork,
  formatServerRuntimeStatus,
  formatTmuxStatus,
  isLiveProcess,
  launchctlKickstart,
  listInFlightWork,
  resolveOtelPreferredPortFromEnv,
  resolveServerMode,
  resolveServerPaths,
  stopServerProcess,
  waitForInFlightDrain,
  writeServerProcessLog,
  writeShutdownIntent,
} from '../cli-runtime.js'
import { agentHarnessGuardMessage } from '../harness-guard.js'
import { printJson } from '../print.js'
import { assertNoMaintenanceSweep } from '../release-gc-sweep.js'
import { resolveSessionArg } from '../selector-resolve.js'
import { parseSinceMs, renderPorcelain, renderSessions } from '../session-render.js'
import { hasFlag, parseFlag, parseIntegerFlag, requireArg } from './argv.js'
import { isHrcDomainErrorLike } from './errors.js'
import { CliStatusExit, createClient, fatal } from './shared.js'

const DEFAULT_RESTART_PROOF_TIMEOUT_MS = 30_000

/**
 * Run the HRC server in the foreground without probing launchd. Intended
 * for supervisors (launchd, systemd) that invoke hrc directly; user-facing
 * `hrc server start` delegates to launchctl when a Launch Agent is loaded.
 */
export async function cmdServerServe(_args: string[]): Promise<void> {
  const status = await collectServerRuntimeStatus({ includeTmux: false })
  if (status.running) {
    fatal(`daemon already running on ${status.socketPath} (pid ${status.pid ?? 'unknown'})`)
  }
  return serverForeground(parseLocalPersonaAllowlist(_args))
}

function parseLocalPersonaAllowlist(args: string[]): readonly string[] | undefined {
  const allowed: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--allow-persona') {
      const value = args[index + 1]
      if (value === undefined) fatal('--allow-persona requires an agent id')
      allowed.push(value)
      index += 1
      continue
    }
    if (arg?.startsWith('--allow-persona=')) {
      allowed.push(arg.slice('--allow-persona='.length))
    }
  }
  return allowed.length === 0 ? undefined : allowed
}

export async function cmdServerStart(
  args: string[],
  defaultMode: 'foreground' | 'daemon'
): Promise<void> {
  const mode = resolveServerMode(args, defaultMode)
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const status = await collectServerRuntimeStatus({ includeTmux: false })

  if (status.running) {
    fatal(`daemon already running on ${status.socketPath} (pid ${status.pid ?? 'unknown'})`)
  }

  // Both branches must refuse under a release sweep: the ownerless path below
  // self-daemonizes and takes no lock of its own, so omitting the check there
  // silently reopens the mid-unlink race the sweep's L1 depends on (T-07686).
  assertNoMaintenanceSweep()

  const owner = await detectLaunchdOwner()
  if (owner) {
    const kickstart = await launchctlKickstart(owner)
    // EALREADY means launchd is already bringing the job up, which is what we
    // asked for; anything else is a real failure to actuate.
    if (!kickstart.ok) {
      if (!kickstart.benign) fatal(kickstart.message)
      process.stderr.write(`hrc: ${kickstart.message}\n`)
    }
    process.stderr.write(`hrc: daemon started via launchd (${owner.serviceTarget})\n`)
    return
  }

  if (mode === 'daemon') {
    assertNoMaintenanceSweep()
    await daemonizeAndWait(timeoutMs)
    return
  }

  assertNoMaintenanceSweep()
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
    const refusalCode =
      action === 'restart' ? 'restart_refused_in_flight' : 'stop_refused_in_flight'
    process.stderr.write(
      `hrc: [${refusalCode}] refusing to ${action}: ${inFlight.length} ${noun}(s) in flight. Use --wait to drain or --force to ${action} anyway.\n${formatInFlightWork(inFlight)}`
    )
    process.stderr.write(
      `hrc: [${refusalCode}] ${action} refused: ${inFlight.length} ${noun}(s) remain in flight; no ${action} was attempted.\n`
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
    const refusalCode = action === 'restart' ? 'restart_drain_timeout' : 'stop_drain_timeout'
    process.stderr.write(
      `hrc: [${refusalCode}] drain timed out after ${waitTimeoutMs}ms with ${inFlight.length} ${noun}(s) still in flight. Re-run with --force to ${action} anyway.\n${formatInFlightWork(inFlight)}`
    )
    process.stderr.write(
      `hrc: [${refusalCode}] ${action} refused: ${inFlight.length} ${noun}(s) remained in flight after ${waitTimeoutMs}ms; no ${action} was attempted.\n`
    )
    throw new CliStatusExit(2)
  }
}

function processStartedAt(
  status: Awaited<ReturnType<typeof collectServerRuntimeStatus>>
): string | undefined {
  return status.release?.processStartedAt ?? status.api?.startedAt
}

async function requireRestartProof(
  before: Awaited<ReturnType<typeof collectServerRuntimeStatus>>,
  timeoutMs: number
): Promise<void> {
  const beforeStartedAt = processStartedAt(before)
  if (before.running && beforeStartedAt === undefined) {
    process.stderr.write(
      'hrc: [restart_refused_unobservable] daemon is healthy but its processStartedAt could not be read; refusing an unprovable restart\n'
    )
    throw new CliStatusExit(2)
  }

  const deadline = Date.now() + timeoutMs
  let observed = before
  while (true) {
    observed = await collectServerRuntimeStatus({ includeTmux: false })
    const observedStartedAt = processStartedAt(observed)
    if (
      observed.running &&
      observedStartedAt !== undefined &&
      (beforeStartedAt === undefined || observedStartedAt !== beforeStartedAt)
    ) {
      process.stderr.write(
        `hrc: restart proven (processStartedAt ${beforeStartedAt ?? '(not running)'} -> ${observedStartedAt})\n`
      )
      return
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const elapsedMs = timeoutMs - remainingMs
    const pollIntervalMs = elapsedMs < 1_000 ? 50 : elapsedMs < 5_000 ? 100 : 250
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)))
  }

  const beforePid = before.pid
  const oldPidAlive = beforePid === undefined ? 'unknown' : isLiveProcess(beforePid) ? 'yes' : 'no'
  const apiHealth = observed.apiHealth.ok ? 'healthy' : observed.apiHealth.error

  process.stderr.write(
    `hrc: [restart_unproven] restart actuation returned, but no healthy new process answered within ${timeoutMs}ms (before processStartedAt=${beforeStartedAt ?? '(not running)'}, before pid=${beforePid ?? '(none)'}, observed processStartedAt=${processStartedAt(observed) ?? '(unavailable)'}, observed pid=${observed.pid ?? '(none)'}, old pid alive=${oldPidAlive}, observed pid alive=${observed.pidAlive ? 'yes' : 'no'}, socket responsive=${observed.socketResponsive ? 'yes' : 'no'}, api health=${apiHealth}, observed status=${observed.status})\n`
  )
  throw new CliStatusExit(1)
}

async function closeAdmissionAndDrainForRestart(
  args: string[],
  attribution: {
    requestedBy: string | null
    reason: string | null
  }
): Promise<{
  operationId: string
  forceFallback: boolean
}> {
  const timeoutMs = parseIntegerFlag(args, '--drain-timeout-ms', {
    defaultValue: 300_000,
    min: 1,
  })
  const operationId = `restart-drain-${randomUUID()}`
  const client = createClient()
  const closed = await client.closeTurnAdmission({
    operationId,
    requestedBy: attribution.requestedBy,
    requestedRunId: process.env['HRC_RUN_ID'] ?? null,
    reason: attribution.reason ?? 'hrc server restart --drain',
  })
  process.stderr.write(
    `hrc: turn admission closed (${operationId}); active admissions=${closed.activeAdmissions}\n`
  )

  const filter = {
    excludeTransports: ['tmux'] as const,
    includeAcceptedRuns: true,
  }
  let inFlight = listInFlightWork(undefined, filter)
  if (inFlight.length > 0) {
    process.stderr.write(
      `hrc: waiting up to ${timeoutMs}ms for ${inFlight.length} in-flight headless run(s) under closed admission...\n`
    )
    let lastReportedCount = inFlight.length
    inFlight = await waitForInFlightDrain({
      timeoutMs,
      filter,
      onTick: (items) => {
        if (items.length !== lastReportedCount) {
          process.stderr.write(`hrc: ${items.length} headless run(s) still in flight\n`)
          lastReportedCount = items.length
        }
      },
    })
  }

  // One final registry cut while admission is still closed. No new turn can
  // cross the daemon gate between this observation and actuation.
  inFlight = listInFlightWork(undefined, filter)
  if (inFlight.length > 0) {
    process.stderr.write(
      `hrc: drain timed out after ${timeoutMs}ms with ${inFlight.length} headless run(s) still in flight. Falling back explicitly to force restart semantics under closed admission.\n${formatInFlightWork(inFlight)}`
    )
    return { operationId, forceFallback: true }
  }

  process.stderr.write('hrc: drain complete; closed-admission recheck found no headless work\n')
  return { operationId, forceFallback: false }
}

function requireServerLifecycleAuthorization(args: string[]): {
  requestedBy: string | null
  reason: string | null
} {
  const result = evaluateServerLifecycleAuthorization(process.env, parseFlag(args, '--reason'))
  if (!result.allowed) {
    fatal(result.message)
  }
  return {
    requestedBy: result.requestedBy,
    reason: result.reason,
  }
}

export async function cmdServerStop(args: string[]): Promise<void> {
  const attribution = requireServerLifecycleAuthorization(args)
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const force = hasFlag(args, '--force')
  const before = await collectServerRuntimeStatus({ includeTmux: false })

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

  writeShutdownIntent('stop', attribution)
  await stopServerProcess({ timeoutMs, force, allowNotRunning: true })
  process.stderr.write('hrc: daemon stopped\n')
}

export async function cmdServerRestart(args: string[]): Promise<void> {
  const attribution = requireServerLifecycleAuthorization(args)
  const mode = resolveServerMode(args, 'daemon')
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const proofTimeoutMs = parseIntegerFlag(args, '--proof-timeout-ms', {
    defaultValue: DEFAULT_RESTART_PROOF_TIMEOUT_MS,
    min: 1,
  })
  const drain = hasFlag(args, '--drain')
  if (drain && hasFlag(args, '--wait')) {
    fatal('--drain and --wait are mutually exclusive; --drain owns the closed-admission wait')
  }

  let admissionOperationId: string | undefined
  let restartInitiated = false
  let force = hasFlag(args, '--force')
  try {
    if (drain) {
      const result = await closeAdmissionAndDrainForRestart(args, attribution)
      admissionOperationId = result.operationId
      force ||= result.forceFallback
    } else {
      await gateOnInFlightWork(args, 'restart')
    }

    const before =
      hasFlag(args, '--wait') || drain
        ? await collectServerRuntimeStatus({ includeTmux: false })
        : undefined

    if (before?.running && processStartedAt(before) === undefined) {
      await requireRestartProof(before, proofTimeoutMs)
    }

    writeShutdownIntent('restart', attribution)

    const owner = await detectLaunchdOwner()
    if (owner) {
      restartInitiated = true
      const kickstart = await launchctlKickstart(owner, { kill: true })

      // A non-zero launchctl status describes the actuation request, not the
      // outcome. When we can prove the outcome, the proof is authoritative and
      // launchctl's complaint is context — failing here instead would report a
      // false RED for a restart that worked, whose natural operator response is
      // a retry or --force against a healthy daemon that has already taken live
      // turns.
      if (!kickstart.ok) {
        process.stderr.write(`hrc: ${kickstart.message}\n`)
      }
      if (before !== undefined) {
        await requireRestartProof(before, proofTimeoutMs)
      } else if (!kickstart.ok && !kickstart.benign) {
        // Nothing to prove against (no --wait/--drain baseline), so a hard
        // launchctl failure stays a failure.
        fatal(kickstart.message)
      }
      process.stderr.write(`hrc: daemon restarted via launchd (${owner.serviceTarget})\n`)
      return
    }

    restartInitiated = true
    await stopServerProcess({ timeoutMs, force, allowNotRunning: true })
    if (mode === 'daemon') {
      await daemonizeAndWait(timeoutMs)
      if (before !== undefined) await requireRestartProof(before, proofTimeoutMs)
      process.stderr.write('hrc: daemon restarted\n')
      return
    }

    return serverForeground()
  } catch (error) {
    if (admissionOperationId !== undefined && !restartInitiated) {
      try {
        await createClient().reopenTurnAdmission({ operationId: admissionOperationId })
        process.stderr.write(
          `hrc: restart aborted before actuation; turn admission reopened (${admissionOperationId})\n`
        )
      } catch (reopenError) {
        process.stderr.write(
          `hrc: WARNING restart aborted but turn admission could not be reopened: ${
            reopenError instanceof Error ? reopenError.message : String(reopenError)
          }\nhrc: recovery: run 'hrc server restart' without --drain to reopen admission during restart.\n`
        )
      }
    }
    throw error
  }
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

export async function cmdServerSubscribers(args: string[]): Promise<void> {
  const snapshot = await createClient().getSubscribers()
  if (hasFlag(args, '--json')) {
    printJson(snapshot)
    return
  }

  const rows = [...snapshot.active, ...snapshot.recentlyClosed]
  if (rows.length === 0) {
    process.stdout.write('No active or recently closed follow-stream admissions.\n')
    return
  }

  for (const entry of rows) {
    const state = entry.closedAt === null ? 'active' : 'closed'
    process.stdout.write(
      `${state}\t${entry.route}\tenqueued=${entry.enqueuedCount}\taccepted=${entry.streamAcceptedCount}\tpending=${entry.pendingCount}\tdesiredSize=${entry.desiredSize ?? '-'}\treceipt=${entry.receiptState}\tack=${entry.lastConsumerAcknowledgedSeq ?? '-'}\tbehindSince=${entry.consumerReceiptBehindSince ?? '-'}\tsubscriber=${entry.subscriberId}\tselector=${JSON.stringify(entry.selector)}\n`
    )
  }
}

async function serverForeground(localPersonaAllowlist?: readonly string[]): Promise<void> {
  // Refuse to boot as a child of a coding-agent harness: the server would leak
  // the harness's recursion-guard env into every child harness it launches,
  // silently killing every dispatched run. The launchd-delegating start/restart
  // paths return before reaching here, so the supported flows are unaffected.
  const harnessGuard = agentHarnessGuardMessage(process.env)
  if (harnessGuard) {
    fatal(harnessGuard)
  }

  const { createHrcServer, loadCommandRunTargetsFromEnv, loadRegistrationClassesFromEnv } =
    await import('hrc-server')

  const paths = resolveServerPaths()

  const server = await createHrcServer({
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    lockPath: paths.lockPath,
    spoolDir: paths.spoolDir,
    dbPath: paths.dbPath,
    tmuxSocketPath: paths.tmuxSocketPath,
    localPersonaAllowlist,
    otelPreferredPort: resolveOtelPreferredPortFromEnv(),
    commandRunTargets: await loadCommandRunTargetsFromEnv(),
    registrationClasses: await loadRegistrationClassesFromEnv(),
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
            requestedReason: intent.reason,
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
  // Deliberately NOT `summonIntent: 'explicit_local'`, though a human may well
  // be typing it. T-06609's AC names `hrc run` and `hrc start` as the operator
  // commands, and this verb is neither: it is the scripting/plumbing primitive
  // that SDK callers and test harnesses drive, and it prints JSON rather than
  // starting anything. Treating it as a placement declaration would hand every
  // script that calls it the authority to establish a scope wherever it happens
  // to run — the exact conflation federation spec §5 draws the line against.
  // Placing a scope from the shell is `hrc run`/`hrc start`.
  const result = await client.resolveSession({
    sessionRef,
    ...(create ? { create: true } : {}),
  })
  printJson(result)
}

export async function cmdSessionList(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  const lane = parseFlag(args, '--lane')
  const all = hasFlag(args, '--all')
  const since = parseFlag(args, '--since')

  const client = createClient()
  // T-07575 — the server bounds an unscoped read to a recency window, so the
  // two flags that widen the *render* window must widen the *read* too.
  // Otherwise `--all` or `--since 30d` would silently re-render the same seven
  // days and look like the store held nothing older.
  const { sessions, total, withheld } = await client.listSessionsWithProjection({
    ...(scope ? { scopeRef: scope } : {}),
    ...(lane ? { laneRef: lane } : {}),
    ...(all ? { all: true } : {}),
    ...(!all && since
      ? { updatedSince: new Date(Date.now() - parseSinceMs(since)).toISOString() }
      : {}),
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

  process.stdout.write(
    renderSessions(sessions, {
      now: new Date(),
      color: process.stdout.isTTY === true,
      all: hasFlag(args, '--all'),
      dormant: hasFlag(args, '--dormant'),
      gens: hasFlag(args, '--gens'),
      groupBy: hasFlag(args, '--by-project') ? 'project' : 'agent',
      ...(since ? { sinceMs: parseSinceMs(since) } : {}),
      ...(scope ? { scope } : {}),
    })
  )
  process.stdout.write(renderProjectionFooter({ shown: sessions.length, total, withheld }))
}

/**
 * T-07575 — say out loud when the read was bounded.
 *
 * The bug this change fixes was 8,319 rows arriving at every caller; the bug it
 * could introduce is a caller believing 525 rows are all there is. A bounded
 * read that does not announce itself is the second bug, so the footer names the
 * withheld count and the flag that lifts the bound.
 */
function renderProjectionFooter(input: {
  shown: number
  total?: number | undefined
  withheld?: number | undefined
}): string {
  if (input.withheld === undefined || input.withheld <= 0) return ''
  const total = input.total ?? input.shown + input.withheld
  return `\n${input.withheld} older session(s) withheld of ${total} stored — pass --all, --since, or --scope to reach them.\n`
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

export async function cmdSessionRetitle(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const title = parseFlag(args, '--title')
  const regenerate = hasFlag(args, '--regenerate')
  const force = hasFlag(args, '--force')
  if (title === undefined && !regenerate) {
    fatal('session retitle requires exactly one of --title or --regenerate')
  }
  if (title !== undefined && regenerate) {
    fatal('--title and --regenerate are mutually exclusive')
  }
  if (force && regenerate) {
    fatal('--force applies to --title only; --regenerate always clears')
  }

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  if (regenerate) {
    printJson(await client.deleteSessionTitle(hostSessionId))
    return
  }
  try {
    printJson(
      await client.setSessionTitle(hostSessionId, {
        title: title as string,
        source: 'manual',
        force,
      })
    )
  } catch (err) {
    // The server refuses to silently discard an operator's own title. Name the
    // flag that unblocks it — the bare conflict code reads like version skew.
    if (isHrcDomainErrorLike(err) && (err.detail as { requiresForce?: boolean })?.requiresForce) {
      fatal(`${err.message}; re-run with --force to replace it`)
    }
    throw err
  }
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
  if (brokerLeaseResult.preservedClaimed > 0) {
    process.stderr.write(`, ${brokerLeaseResult.preservedClaimed} claimed preserved`)
  }
  if (brokerLeaseResult.reapedClaimedOrphans > 0) {
    process.stderr.write(`, ${brokerLeaseResult.reapedClaimedOrphans} claimed orphan(s) reaped`)
  }
  if (brokerLeaseResult.staledClaimedRuntimes > 0) {
    process.stderr.write(`, ${brokerLeaseResult.staledClaimedRuntimes} runtime(s) staled`)
  }
  if (brokerLeaseResult.removedBrokerIpcDirs > 0) {
    process.stderr.write(`, ${brokerLeaseResult.removedBrokerIpcDirs} broker IPC dir(s) removed`)
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
