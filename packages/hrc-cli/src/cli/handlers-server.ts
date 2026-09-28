import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'

import { HRC_LIFECYCLE_PRE_CONTRACT_MESSAGE, HRC_SERVER_LAUNCHD_LABEL } from 'hrc-core'
import type {
  HrcServerLifecycleAction,
  HrcServerLifecycleGrant,
  HrcServerLifecycleInFlightItem,
  HrcServerLifecycleRequest,
  KillBrokerTmuxLeasesResponse,
} from 'hrc-core'
import type { ServerShutdownAttribution } from 'hrc-server'

import {
  collectServerRuntimeStatus,
  collectTmuxStatus,
  daemonizeAndWait,
  detectLaunchdOwner,
  detectStrandedLaunchAgent,
  execProcess,
  formatServerRuntimeStatus,
  formatStrandedLaunchAgentRefusal,
  formatTmuxStatus,
  isLiveProcess,
  launchctlKickstart,
  resolveServerMode,
  resolveServerPaths,
  writeServerProcessLog,
} from '../cli-runtime.js'
import { agentHarnessGuardMessage } from '../harness-guard.js'
import { printJson } from '../print.js'
import { assertNoMaintenanceSweep } from '../release-gc-sweep.js'
import { resolveSessionArg } from '../selector-resolve.js'
import { parseSinceMs, renderPorcelain, renderSessions } from '../session-render.js'
import { hasFlag, parseFlag, parseIntegerFlag, requireArg } from './argv.js'
import { isHrcDomainErrorLike } from './errors.js'
import { CliStatusExit, createClient, fatal, lifecycleCredentialHeaders } from './shared.js'

const DEFAULT_RESTART_PROOF_TIMEOUT_MS = 30_000
/**
 * Absolute process-level ceiling for graceful shutdown. Individual server
 * teardown stages have narrower budgets where practical, but this final bound
 * guarantees that an overlooked or future never-settling stage cannot keep a
 * signalled daemon alive forever.
 */
const DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS = 30_000

export class ServerShutdownTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`server.stop() did not settle within ${timeoutMs}ms`)
    this.name = 'ServerShutdownTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * `onDeadlineExpired` runs synchronously when the deadline fires, BEFORE the
 * timeout rejection is observed (T-08137 rev 4): the server marks its lifecycle
 * `shutdown_deadline_expired`, so a stop() that settles late can never append
 * server.stopped.
 */
export async function stopServerWithinDeadline(
  stop: () => Promise<void>,
  timeoutMs = DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS,
  onDeadlineExpired?: () => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      stop(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onDeadlineExpired?.()
          reject(new ServerShutdownTimeoutError(timeoutMs))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type SerializedRejectionCause = {
  type: string
  name?: string | undefined
  message: string
  stack?: string | undefined
}

function rejectionCauseChain(reason: unknown): SerializedRejectionCause[] {
  const chain: SerializedRejectionCause[] = []
  const seen = new Set<unknown>()
  let current = reason

  while (true) {
    if ((typeof current === 'object' && current !== null) || typeof current === 'function') {
      if (seen.has(current)) {
        chain.push({ type: 'circular', message: '[circular cause]' })
        break
      }
      seen.add(current)
    }

    if (!(current instanceof Error)) {
      let message: string
      try {
        message = String(current)
      } catch {
        message = '[unprintable rejection]'
      }
      chain.push({ type: typeof current, message })
      break
    }

    chain.push({
      type: 'Error',
      name: current.name,
      message: current.message,
      ...(current.stack === undefined ? {} : { stack: current.stack }),
    })

    let cause: unknown
    try {
      cause = current.cause
    } catch {
      cause = '[unreadable cause]'
    }
    if (cause === undefined) break
    current = cause
  }

  return chain
}

function grantLogDetails(grant: HrcServerLifecycleGrant | undefined): Record<string, unknown> {
  return grant === undefined
    ? { grant: null }
    : {
        grant: {
          requestId: grant.requestId,
          requestedBy: grant.requestedBy,
          callerKind: grant.callerKind,
          originNode: grant.originNode,
          action: grant.action,
          reason: grant.reason,
        },
      }
}

/**
 * T-09861 §7: the `server.shutting_down` payload. A granted shutdown carries
 * the daemon's own verified grant; anything else (a raw SIGTERM from `kill` or
 * `launchctl kickstart -k`, or an unhandled rejection) is explicitly ungranted.
 */
export function shutdownAttribution(
  reason: string,
  grant: HrcServerLifecycleGrant | undefined
): ServerShutdownAttribution {
  return grant === undefined ? { reason, grant: null, ungranted: true } : { reason, grant }
}

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

  await refuseStrandedLaunchAgent('start')

  if (mode === 'daemon') {
    assertNoMaintenanceSweep()
    await daemonizeAndWait(timeoutMs)
    return
  }

  assertNoMaintenanceSweep()
  return serverForeground()
}

/**
 * Guard the ownerless start/restart path. `detectLaunchdOwner` returning null
 * conflates two states — "this node has no LaunchAgent" and "this node's
 * LaunchAgent is not loaded right now" — and self-daemonizing is only correct
 * for the first. In the second it strands the daemon outside the plist's
 * environment, which is not visible in `hrc server status` and disables the mail
 * kicker (T-07957). Refuse, and say exactly how to load the job.
 */
async function refuseStrandedLaunchAgent(action: 'start' | 'restart'): Promise<void> {
  const stranded = await detectStrandedLaunchAgent()
  if (stranded !== null) fatal(formatStrandedLaunchAgentRefusal(stranded, action))
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
    `hrc: [restart_unproven] restart was granted, but no healthy new process answered within ${timeoutMs}ms (before processStartedAt=${beforeStartedAt ?? '(not running)'}, before pid=${beforePid ?? '(none)'}, observed processStartedAt=${processStartedAt(observed) ?? '(unavailable)'}, observed pid=${observed.pid ?? '(none)'}, old pid alive=${oldPidAlive}, observed pid alive=${observed.pidAlive ? 'yes' : 'no'}, socket responsive=${observed.socketResponsive ? 'yes' : 'no'}, api health=${apiHealth}, observed status=${observed.status})\n`
  )
  throw new CliStatusExit(1)
}

async function requireStopProof(
  before: Awaited<ReturnType<typeof collectServerRuntimeStatus>>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const observed = await collectServerRuntimeStatus({ includeTmux: false })
    const oldAlive = before.pid !== undefined && isLiveProcess(before.pid)
    if (!observed.socketResponsive && !oldAlive) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  process.stderr.write(
    `hrc: [stop_unproven] stop was granted, but pid ${before.pid ?? '(unknown)'} still answered after ${timeoutMs}ms\n`
  )
  throw new CliStatusExit(1)
}

function formatInFlight(items: readonly HrcServerLifecycleInFlightItem[]): string {
  if (items.length === 0) return '(no in-flight work)\n'
  return `${items
    .map((item) => {
      const transport = item.transport ? ` [${item.transport}]` : ''
      const started = item.startedAt ? ` since ${item.startedAt}` : ''
      return `  ${item.runId}  ${item.scopeRef}~${item.laneRef}  ${item.status}${transport}${started}`
    })
    .join('\n')}\n`
}

/**
 * T-09861 §5 — `hrc server stop|restart` is a thin client of the daemon's
 * lifecycle endpoint. It never signals, kills or kickstarts a running daemon,
 * and it never decides authority: the daemon does, from the credential it
 * minted. Against a daemon without the capability it fails closed.
 */
async function requestServerLifecycle(
  args: string[],
  action: HrcServerLifecycleAction
): Promise<void> {
  const targetNode = parseFlag(args, '--node')?.trim() || undefined
  const proofTimeoutMs = parseIntegerFlag(args, '--proof-timeout-ms', {
    defaultValue: DEFAULT_RESTART_PROOF_TIMEOUT_MS,
    min: 1,
  })
  const waitTimeoutMs = parseIntegerFlag(args, '--wait-timeout-ms', {
    defaultValue: 300_000,
    min: 1,
  })
  const drainTimeoutMs = parseIntegerFlag(args, '--drain-timeout-ms', {
    defaultValue: 300_000,
    min: 1,
  })
  const wait = hasFlag(args, '--wait')
  const drain = hasFlag(args, '--drain')
  if (drain && wait) {
    fatal('--drain and --wait are mutually exclusive; --drain owns the closed-admission wait')
  }

  const before = await collectServerRuntimeStatus({ includeTmux: false })
  if (!before.socketResponsive) {
    if (action === 'stop' && targetNode === undefined && !before.running) {
      process.stderr.write('hrc: daemon is not running\n')
      return
    }
    fatal(
      `no HRC daemon answers on ${before.socketPath}; nothing to ${action}. Start a down daemon with: hrc server start`
    )
  }

  const client = createClient()
  const status = await client.getStatus()
  if (status.capabilities?.serverLifecycle !== true) {
    process.stderr.write(
      `hrc: [server_lifecycle_unsupported] ${HRC_LIFECYCLE_PRE_CONTRACT_MESSAGE}\n`
    )
    throw new CliStatusExit(1)
  }
  const localNodeId = status.node?.nodeId
  const remote = targetNode !== undefined && targetNode !== localNodeId

  const request: HrcServerLifecycleRequest = {
    action,
    ...(parseFlag(args, '--reason') === undefined ? {} : { reason: parseFlag(args, '--reason') }),
    ...(targetNode === undefined ? {} : { targetNode }),
    wait,
    drain,
    force: hasFlag(args, '--force'),
    waitTimeoutMs,
    drainTimeoutMs,
    proofTimeoutMs,
    ...(process.env['HRC_RUN_ID'] ? { requestedRunId: process.env['HRC_RUN_ID'] } : {}),
  }

  let response: Awaited<ReturnType<typeof client.serverLifecycle>>
  try {
    response = await client.serverLifecycle(request, lifecycleCredentialHeaders(status.runtimeRoot))
  } catch (error) {
    if (isHrcDomainErrorLike(error) && error.code === 'server_lifecycle_refused') {
      process.stderr.write(`hrc: [server_lifecycle_refused] ${error.message}\n`)
      throw new CliStatusExit(1)
    }
    if (isHrcDomainErrorLike(error) && error.code === 'server_lifecycle_in_flight') {
      const detail = (error.detail ?? {}) as {
        refusalCode?: string
        inFlight?: HrcServerLifecycleInFlightItem[]
      }
      const code = detail.refusalCode ?? `${action}_refused_in_flight`
      const items = detail.inFlight ?? []
      process.stderr.write(`hrc: [${code}] ${error.message}\n${formatInFlight(items)}`)
      process.stderr.write(
        `hrc: [${code}] ${action} refused: ${items.length} run(s) in flight; no ${action} was attempted.\n`
      )
      throw new CliStatusExit(2)
    }
    throw error
  }

  const grant = response.grant
  process.stderr.write(
    `hrc: ${action} granted on ${response.targetNode} (${grant.requestId}; ${grant.callerKind} ${grant.requestedBy})\n`
  )
  for (const note of response.notes ?? []) process.stderr.write(`hrc: ${note}\n`)

  if (remote) {
    if (action === 'restart') {
      const proof = response.remote
      if (proof?.proven !== true) {
        process.stderr.write(
          `hrc: [restart_unproven] ${response.targetNode} did not report a new process within ${proofTimeoutMs}ms (before startedAt=${proof?.beforeStartedAt ?? '(unknown)'}, observed startedAt=${proof?.afterStartedAt ?? '(unavailable)'})\n`
        )
        throw new CliStatusExit(1)
      }
      process.stderr.write(
        `hrc: restart proven on ${response.targetNode} (startedAt ${proof.beforeStartedAt ?? '(unknown)'} -> ${proof.afterStartedAt})\n`
      )
    }
    return
  }

  if (action === 'restart') {
    await requireRestartProof(before, proofTimeoutMs)
    process.stderr.write('hrc: daemon restarted\n')
    return
  }
  await requireStopProof(before, proofTimeoutMs)
  process.stderr.write('hrc: daemon stopped\n')
}

export async function cmdServerStop(args: string[]): Promise<void> {
  await requestServerLifecycle(args, 'stop')
}

export async function cmdServerRestart(args: string[]): Promise<void> {
  await requestServerLifecycle(args, 'restart')
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

export async function cmdAdminStatus(args: string[]): Promise<void> {
  const status = await createClient().getStatus({ includeSessions: false })
  if (hasFlag(args, '--json')) {
    printJson(status.aspToolchain)
    return
  }

  const report = status.aspToolchain
  process.stdout.write(
    `ASP toolchain root: ${report.configuredRoot ?? '(unset)'} (${report.toolchainRootActive ? 'active' : 'inactive'})\n`
  )
  if (report.bundledAspBuild !== undefined) {
    process.stdout.write(
      `Bundled ASP: ${report.bundledAspBuild.setVersion} (${report.bundledAspBuild.sourceCommit})\n`
    )
  }
  const aspd = status.aspd
  if (aspd !== undefined) {
    process.stdout.write(
      aspd.configured
        ? `aspd: ${aspd.endpoint ?? '(invalid)'} ${aspd.reachable ? `serving ${aspd.release?.releaseId ?? '(unidentified)'} ${aspd.protocolVersion ?? ''}`.trimEnd() : `unreachable: ${aspd.error?.code ?? 'unknown'}`}\n`
        : 'aspd: (not configured)\n'
    )
  }
  for (const binary of report.binaries) {
    process.stdout.write(
      `${binary.kind}: ${binary.source} ${binary.path}${binary.available ? '' : ` [unavailable: ${binary.error ?? 'unknown error'}]`}\n`
    )
    if (binary.hello !== undefined) {
      process.stdout.write(
        `  hello: ${binary.hello.name}@${binary.hello.version} protocol=${binary.hello.protocolVersion} observed=${binary.hello.observedAt}\n`
      )
    }
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

/**
 * T-09861: the launchd job this daemon runs under, if any. launchd sets
 * XPC_SERVICE_NAME to the job label for its jobs; a terminal-launched process
 * carries some other value (or none), so only an exact label match counts.
 */
function launchdJobLabel(): string | undefined {
  const label = process.env['HRC_LAUNCHD_LABEL'] ?? HRC_SERVER_LAUNCHD_LABEL
  return process.env['XPC_SERVICE_NAME'] === label ? label : undefined
}

/**
 * The detached successor for an unsupervised (scratch) daemon's granted
 * restart: it waits for this pid to exit — and so release the lock and socket
 * — then re-runs this exact command line.
 */
function spawnUnsupervisedSuccessor(logPath: string): void {
  let out: number | 'ignore' = 'ignore'
  try {
    out = openSync(logPath, 'a')
  } catch {}
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'while kill -0 "$0" 2>/dev/null; do sleep 0.05; done; exec "$@"',
      String(process.pid),
      process.execPath,
      ...process.argv.slice(1),
    ],
    { detached: true, stdio: ['ignore', out, out], env: { ...process.env } }
  )
  child.unref()
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

  const {
    WrkqStdioLedgerClient,
    createHrcServer,
    loadCommandRunTargetsFromEnv,
    loadRegistrationClassesFromEnv,
  } = await import('hrc-server')

  const paths = resolveServerPaths()

  let shutdownStarted = false
  let shutdownReason: string | undefined
  let shutdownGrant: HrcServerLifecycleGrant | undefined
  /** An authorized grant whose SIGTERM (launchd bootout) has not arrived yet. */
  let pendingGrant: HrcServerLifecycleGrant | undefined
  let shutdownExitCode = 0
  let afterStop: (() => void) | undefined

  // T-09861 §5: the daemon performs an authorized action itself. Restart exits
  // for launchd's KeepAlive respawn (or hands off to a detached successor when
  // unsupervised); stop unloads its own job. The grant is recorded before
  // anything is torn down.
  const lifecycleExecutor = (grant: HrcServerLifecycleGrant): void => {
    const label = launchdJobLabel()
    if (grant.action === 'stop' && label !== undefined) {
      pendingGrant = grant
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
      const bootout = spawn('launchctl', ['bootout', `gui/${uid ?? ''}/${label}`], {
        detached: true,
        stdio: 'ignore',
      })
      bootout.on('exit', (code) => {
        if (code !== 0 && !shutdownStarted) {
          pendingGrant = undefined
          writeServerProcessLog('server.lifecycle.bootout_failed', {
            pid: process.pid,
            exitCode: code,
            requestId: grant.requestId,
          })
        }
      })
      bootout.unref()
      return
    }
    if (grant.action === 'restart' && label === undefined) {
      afterStop = () => spawnUnsupervisedSuccessor(`${paths.runtimeRoot}/server.log`)
    }
    shutdown(`lifecycle:${grant.action}`, { grant })
  }

  const server = await createHrcServer({
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    lockPath: paths.lockPath,
    spoolDir: paths.spoolDir,
    dbPath: paths.dbPath,
    tmuxSocketPath: paths.tmuxSocketPath,
    localPersonaAllowlist,
    commandRunTargets: await loadCommandRunTargetsFromEnv(),
    registrationClasses: await loadRegistrationClassesFromEnv(),
    // The ONE place that reaches the fleet wrkq ledger. Any other
    // `createHrcServer` — every test, every embedded instance — gets the
    // unreachable default, so an in-process server cannot drive mail or write
    // project events into shared state by inheriting the daemon's environment.
    wrkqLedger: new WrkqStdioLedgerClient(),
    // T-08137: the ONE instance that records daemon lifecycle provenance.
    lifecycleProvenance: true,
    // T-09861: and the ONE instance that performs authorized lifecycle actions.
    lifecycleExecutor,
  })

  const shutdown = (
    reason: string,
    options: { exitCode?: number; grant?: HrcServerLifecycleGrant | undefined } = {}
  ): void => {
    shutdownExitCode = Math.max(shutdownExitCode, options.exitCode ?? 0)
    if (shutdownStarted) return

    shutdownStarted = true
    shutdownReason = reason
    shutdownGrant = options.grant ?? pendingGrant
    writeServerProcessLog('server.shutting_down', {
      pid: process.pid,
      reason,
      ...grantLogDetails(shutdownGrant),
    })
    // T-08137: the durable copy of the line above, appended synchronously before
    // any teardown. Its failure must never block shutdown.
    try {
      server.beginLifecycleShutdown(shutdownAttribution(reason, shutdownGrant))
    } catch (error) {
      writeServerProcessLog('server.lifecycle_shutdown_record_failed', {
        pid: process.pid,
        causeChain: rejectionCauseChain(error),
      })
    }

    // This promise is deliberately caught locally. The process-level rejection
    // policy must not recursively handle a failure in its own graceful teardown.
    void (async () => {
      try {
        await stopServerWithinDeadline(
          () => server.stop(),
          undefined,
          () => server.markShutdownDeadlineExpired()
        )
      } catch (error) {
        shutdownExitCode = 1
        writeServerProcessLog('server.shutdown_failed', {
          pid: process.pid,
          reason,
          causeChain: rejectionCauseChain(error),
          ...grantLogDetails(shutdownGrant),
        })
      }
      try {
        await unlink(paths.pidPath)
      } catch {}
      try {
        afterStop?.()
      } catch (error) {
        writeServerProcessLog('server.lifecycle.successor_spawn_failed', {
          pid: process.pid,
          causeChain: rejectionCauseChain(error),
        })
      }
      process.exit(shutdownExitCode)
    })().catch((error) => {
      writeServerProcessLog('server.shutdown_failed', {
        pid: process.pid,
        reason,
        causeChain: rejectionCauseChain(error),
        ...grantLogDetails(shutdownGrant),
      })
      process.exit(1)
    })
  }

  process.on('unhandledRejection', (reason) => {
    const decision = shutdownStarted ? 'continue_shutdown' : 'fail_fast'
    shutdownExitCode = 1
    writeServerProcessLog('server.unhandled_rejection', {
      pid: process.pid,
      decision,
      shutdownInProgress: shutdownStarted,
      shutdownReason: shutdownReason ?? null,
      causeChain: rejectionCauseChain(reason),
      ...grantLogDetails(shutdownGrant),
    })
    if (!shutdownStarted) {
      // Installing the listener prevents Bun's implicit immediate exit. The
      // fail-fast path still exits non-zero, but only after server.stop() has
      // deliberately drained and closed daemon-owned resources.
      shutdown('unhandledRejection', { exitCode: 1 })
    }
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

  // Ignore SIGHUP so the daemon survives when the parent terminal/session exits
  // (e.g., Claude Code terminating). SIGINT and SIGTERM still trigger graceful
  // shutdown; without a pending grant they are recorded as ungranted (§7).
  process.on('SIGHUP', () => {})
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
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
