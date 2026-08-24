import { readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import {
  BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
  rejectedBrokerAdoptionPaths,
} from '../broker/adoption-root.js'
import {
  brokerLeaseIdentityMatches,
  parseBrokerRuntimeHostingState,
} from '../broker/runtime-hosting.js'
import { extractBrokerEndpoint } from '../broker/runtime-state.js'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { requireSession } from '../require-helpers.js'
import { runtimeActivityPatch } from '../runtime-activity.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from '../server-util.js'
import {
  type TmuxManager,
  type TmuxPaneState,
  createTmuxManager,
  isTmuxCommandTimeoutError,
} from '../tmux.js'
import { logStartupIssue, markRuntimeStale } from './runtime-mutations.js'
import type {
  BrokerReattachOutcome,
  BrokerTmuxLeaseSweepOptions,
  BrokerTmuxLeaseSweepResult,
  BrokerWindowObservation,
  RendererControlSocketSweepOptions,
  RendererControlSocketSweepResult,
} from './types.js'

const LEASE_SOCKET_INSPECT_TIMEOUT_MS = 750
const RENDERER_CONTROL_HOLDER_ENUMERATION_TIMEOUT_MS = 10_000
const RENDERER_CONTROL_SOCKET_PREFIX = 'codex-app-server-renderer-control.'
// The btmux directory also contains Codex app renderer-control Unix sockets.
// They are not tmux servers, so the orphan lease sweeper must not probe them.
const NON_LEASE_BTMUX_SOCKET_PREFIXES = [RENDERER_CONTROL_SOCKET_PREFIX]
const DEFAULT_TERMINAL_BROKER_LEASE_TTL_MS = 15 * 60 * 1000

/**
 * Reap stale Codex app renderer-control sockets under `<runtimeRoot>/btmux/`.
 * Holder discovery is a single `lsof` enumeration and never connects to the
 * socket. A candidate is removed only when it is both unheld and past grace.
 */
export async function sweepOrphanedRendererControlSockets(
  runtimeRoot: string,
  options: RendererControlSocketSweepOptions
): Promise<RendererControlSocketSweepResult> {
  const result: RendererControlSocketSweepResult = {
    scanned: 0,
    removed: 0,
    skippedHeld: 0,
    skippedWithinGrace: 0,
    errors: 0,
  }
  const dir = join(runtimeRoot, 'btmux')
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter(isRendererControlSocketEntry)
  } catch {
    if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
    return result
  }
  result.scanned = entries.length
  if (entries.length === 0) {
    if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
    return result
  }

  let heldPaths: Set<string>
  try {
    heldPaths = await enumerateHeldUnixSocketPaths()
  } catch (error) {
    // Holder state is mandatory evidence for removal. If it cannot be collected,
    // preserve every candidate rather than falling back to age-only cleanup.
    result.errors = entries.length
    writeServerLog('WARN', 'broker.renderer_control_socket_holder_enumeration_failed', {
      error,
      scanned: result.scanned,
    })
    if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
    return result
  }

  const now = Date.now()
  for (const entry of entries) {
    const socketPath = join(dir, entry)
    if (heldPaths.has(socketPath)) {
      result.skippedHeld += 1
      continue
    }

    try {
      const stats = await stat(socketPath)
      const ageMs = now - stats.mtimeMs
      if (ageMs < options.graceMs) {
        result.skippedWithinGrace += 1
        continue
      }
      if (!stats.isSocket()) {
        result.errors += 1
        writeServerLog('WARN', 'broker.renderer_control_socket_invalid_entry', { socketPath })
        continue
      }

      await rm(socketPath, { force: true })
      result.removed += 1
      writeServerLog('INFO', 'broker.renderer_control_socket_removed', {
        socketPath,
        ageMs,
        graceMs: options.graceMs,
      })
    } catch (error) {
      result.errors += 1
      writeServerLog('WARN', 'broker.renderer_control_socket_sweep_failed', {
        socketPath,
        error,
      })
    }
  }

  if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
  return result
}

async function enumerateHeldUnixSocketPaths(): Promise<Set<string>> {
  const proc = Bun.spawn(['lsof', '-U', '-Fn'], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(RENDERER_CONTROL_HOLDER_ENUMERATION_TIMEOUT_MS),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `lsof exited with status ${exitCode}`)
  }

  return parseLsofUnixSocketPaths(stdout)
}

export function parseLsofUnixSocketPaths(stdout: string): Set<string> {
  const heldPaths = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n/')) {
      heldPaths.add(line.slice(1).replace(/ type=\w+$/, ''))
    }
  }
  return heldPaths
}

function writeRendererControlSweepSummary(
  result: RendererControlSocketSweepResult,
  graceMs: number
): void {
  writeServerLog('INFO', 'broker.renderer_control_socket_sweep_complete', {
    ...result,
    graceMs,
  })
}

/**
 * Sweep leaked broker-tmux lease sockets under `<runtimeRoot>/btmux/`. A socket
 * is reclaimed only after its durable claim is proved dead or identity-stale
 * and it is past the grace threshold. A claim is evidence to inspect, not an
 * unconditional exemption: matching live substrates (including a recently
 * terminal passive continuation) are preserved, while claimed orphans are
 * staled and reaped. Multiple claims are conservative — any valid claim wins.
 */
export async function sweepOrphanedBrokerTmuxLeases(
  db: HrcDatabase,
  runtimeRoot: string,
  options: BrokerTmuxLeaseSweepOptions
): Promise<BrokerTmuxLeaseSweepResult> {
  const result: BrokerTmuxLeaseSweepResult = {
    scanned: 0,
    killedLiveLeaseServers: 0,
    removedDeadSocketFiles: 0,
    preservedClaimed: 0,
    reapedClaimedOrphans: 0,
    staledClaimedRuntimes: 0,
    removedBrokerIpcDirs: 0,
    skippedClaimed: 0,
    skippedWithinGrace: 0,
    errors: 0,
  }
  const dir = join(runtimeRoot, 'btmux')
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter(isBrokerTmuxLeaseSocketEntry)
  } catch {
    // No btmux directory yet. IPC directory GC is independent and still runs.
    entries = []
  }
  // Claims include terminal rows. A recently-terminal matching substrate may
  // still be serving a passive continuation, while an expired/mismatched claim
  // must not pin a lease forever.
  const claimsBySocket = new Map<string, HrcRuntimeSnapshot[]>()
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker') {
      continue
    }
    const hosting = parseBrokerRuntimeHostingState(runtime)
    const socketPath =
      hosting?.substrate.kind === 'leased-tmux'
        ? hosting.substrate.tmuxSocketPath
        : getBrokerRuntimeTmuxSocketPath(runtime)
    if (socketPath) {
      const claims = claimsBySocket.get(socketPath) ?? []
      claims.push(runtime)
      claimsBySocket.set(socketPath, claims)
    }
  }

  const now = options.now ?? Date.now()
  const terminalLeaseTtlMs =
    options.terminalLeaseTtlMs ?? resolvePositiveMs('HRC_BROKER_TERMINAL_LEASE_TTL_MS')
  const passiveTtlMs = terminalLeaseTtlMs ?? DEFAULT_TERMINAL_BROKER_LEASE_TTL_MS

  for (const entry of entries) {
    const socketPath = join(dir, entry)
    const claims = claimsBySocket.get(socketPath) ?? []
    result.scanned += 1
    // The whole classify+act body is wrapped so any REAL failure (stat after the
    // race window, listSessionNames, rm, killServer) increments `errors`. The
    // benign "socket vanished between readdir and stat" race is caught INSIDE
    // `classifyLeaseSocket` and surfaces as a `vanished` classification — it must
    // NOT touch `errors`.
    try {
      const classified = await classifyLeaseSocket(socketPath, now, options.graceMs)
      if (classified.kind === 'within-grace') {
        result.skippedWithinGrace += 1
        continue
      }
      if (classified.kind === 'vanished') {
        continue
      }
      if (classified.kind === 'unresponsive') {
        result.errors += 1
        logStartupIssue(
          'broker orphan lease socket unresponsive',
          {
            socketPath,
            ageMs: classified.ageMs,
            timeoutMs: LEASE_SOCKET_INSPECT_TIMEOUT_MS,
          },
          new Error(classified.error)
        )
        continue
      }

      if (claims.length > 0) {
        // lifecycleOwner is the authority boundary. Even a malformed/legacy
        // external row that projects leased-tmux metadata must protect the
        // claimed namespace from HRC teardown; registration GC owns cleanup.
        if (claims.some(isExternalLifecycleOwner)) {
          result.preservedClaimed += 1
          result.skippedClaimed = result.preservedClaimed
          continue
        }
        const matchingClaims: HrcRuntimeSnapshot[] = []
        const orphanReasons = new Map<string, string>()
        for (const claim of claims) {
          const identityMatches =
            classified.kind === 'live-orphan'
              ? await runtimeClaimMatchesObservedLease(claim, socketPath, runtimeRoot)
              : false
          const withinTerminalTtl =
            isRuntimeUnavailableStatus(claim.status) &&
            runtimeTerminalAgeMs(claim, now) < passiveTtlMs
          if (
            identityMatches &&
            (!isRuntimeUnavailableStatus(claim.status) || withinTerminalTtl) &&
            !isBrokerRecoveryExhausted(claim, now)
          ) {
            matchingClaims.push(claim)
          } else {
            orphanReasons.set(
              claim.runtimeId,
              classified.kind === 'dead'
                ? 'broker_claimed_lease_substrate_gone'
                : !identityMatches
                  ? 'broker_claimed_lease_identity_mismatch'
                  : isBrokerRecoveryExhausted(claim, now)
                    ? 'broker_claimed_lease_ipc_recovery_exhausted'
                    : 'broker_claimed_lease_orphaned'
            )
          }
        }

        // Any matching claim protects the shared socket. This handles duplicate
        // rows without tearing down a substrate still proved live by one owner.
        if (matchingClaims.length > 0) {
          result.preservedClaimed += 1
          result.skippedClaimed = result.preservedClaimed
          continue
        }

        await options.beforeClaimMutation?.()
        let raced = false
        for (const claim of claims) {
          const latest = db.runtimes.getByRuntimeId(claim.runtimeId)
          if (!latest || runtimeLeaseFingerprint(latest) !== runtimeLeaseFingerprint(claim)) {
            raced = true
            break
          }
        }
        if (raced) {
          result.preservedClaimed += 1
          result.skippedClaimed = result.preservedClaimed
          writeServerLog('INFO', 'broker.claimed_lease_sweep_race_preserved', {
            socketPath,
            runtimeIds: claims.map((runtime) => runtime.runtimeId),
          })
          continue
        }

        for (const claim of claims) {
          if (isRuntimeUnavailableStatus(claim.status)) {
            continue
          }
          markBrokerReattachStale(
            db,
            claim,
            orphanReasons.get(claim.runtimeId) ?? 'broker_claimed_lease_orphaned'
          )
          result.staledClaimedRuntimes += 1
        }
        result.reapedClaimedOrphans += 1
        const reasons = [...new Set(orphanReasons.values())]
        writeServerLog('INFO', 'broker.claimed_lease_orphan_swept', {
          socketPath,
          runtimeIds: claims.map((runtime) => runtime.runtimeId),
          reason: reasons[0] ?? 'broker_claimed_lease_orphaned',
          reasons,
        })
      }

      switch (classified.kind) {
        case 'dead':
          if (options.removeDeadSocketFiles) {
            await rm(socketPath, { force: true })
            result.removedDeadSocketFiles += 1
            writeServerLog('INFO', 'broker.dead_lease_socket_removed', {
              socketPath,
              ageMs: classified.ageMs,
              graceMs: options.graceMs,
            })
          }
          continue
        case 'live-orphan':
          if (!options.killLiveLeaseServers) {
            continue
          }
          await classified.leaseTmux.killServer()
          result.killedLiveLeaseServers += 1
          writeServerLog('INFO', 'broker.orphan_lease_swept', {
            socketPath,
            sessions: classified.sessions,
            ageMs: classified.ageMs,
            graceMs: options.graceMs,
          })
          continue
      }
    } catch (error) {
      result.errors += 1
      logStartupIssue('broker orphan lease sweep failed', { socketPath }, error)
    }
  }
  await sweepOrphanedBrokerIpcDirs(db, runtimeRoot, result, options, now, passiveTtlMs)
  result.skippedClaimed = result.preservedClaimed
  return result
}

async function runtimeClaimMatchesObservedLease(
  runtime: HrcRuntimeSnapshot,
  socketPath: string,
  runtimeRoot: string
): Promise<boolean> {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux') {
    const manager = createTmuxManager({ socketPath })
    const brokerWindow = await manager.inspectWindow({
      sessionName: hosting.substrate.sessionName,
      windowName: 'broker',
    })
    if (!brokerWindow) {
      return false
    }
    const tuiWindow =
      hosting.presentation.kind === 'tmux-tui'
        ? await manager.inspectWindow({
            sessionName: hosting.substrate.sessionName,
            windowName: 'tui',
          })
        : null
    return brokerLeaseIdentityMatches(runtime, {
      tmuxSocketPath: brokerWindow.socketPath,
      sessionName: brokerWindow.sessionName,
      brokerWindow: {
        sessionId: brokerWindow.sessionId,
        windowId: brokerWindow.windowId,
        paneId: brokerWindow.paneId,
      },
      ...(tuiWindow
        ? {
            tuiWindow: {
              sessionId: tuiWindow.sessionId,
              windowId: tuiWindow.windowId,
              paneId: tuiWindow.paneId,
            },
          }
        : {}),
    })
  }
  return await reassociateBrokerTmuxLease(runtime, runtimeRoot)
}

function runtimeTerminalAgeMs(runtime: HrcRuntimeSnapshot, now: number): number {
  const observedAt =
    runtime.statusChangedAt && runtime.statusChangedAt !== 'unknown'
      ? runtime.statusChangedAt
      : runtime.updatedAt
  const timestampMs = Date.parse(observedAt)
  return Number.isFinite(timestampMs) ? Math.max(0, now - timestampMs) : Number.POSITIVE_INFINITY
}

function runtimeLeaseFingerprint(runtime: HrcRuntimeSnapshot): string {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return JSON.stringify({
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    statusChangedAt: runtime.statusChangedAt,
    updatedAt: runtime.updatedAt,
    tmuxJson: runtime.tmuxJson,
    hosting,
    brokerRecovery: getBrokerRecoveryState(runtime),
  })
}

function resolvePositiveMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

type BrokerRecoveryState = {
  fingerprint: string
  count: number
  firstFailedAt: string
  lastFailedAt: string
  lastReason: string
}

export function getBrokerRecoveryState(
  runtime: HrcRuntimeSnapshot
): BrokerRecoveryState | undefined {
  const control = getRecord(runtime.runtimeStateJson?.['control'])
  const state = getRecord(control?.['brokerRecovery'])
  if (
    !state ||
    typeof state['fingerprint'] !== 'string' ||
    typeof state['count'] !== 'number' ||
    typeof state['firstFailedAt'] !== 'string' ||
    typeof state['lastFailedAt'] !== 'string' ||
    typeof state['lastReason'] !== 'string'
  ) {
    return undefined
  }
  return {
    fingerprint: state['fingerprint'],
    count: state['count'],
    firstFailedAt: state['firstFailedAt'],
    lastFailedAt: state['lastFailedAt'],
    lastReason: state['lastReason'],
  }
}

export function brokerRecoveryFingerprint(runtime: HrcRuntimeSnapshot): string {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return JSON.stringify({
    generation: runtime.generation,
    endpoint: hosting?.endpoint,
    substrate: hosting?.substrate,
  })
}

export function isBrokerRecoveryExhausted(runtime: HrcRuntimeSnapshot, now = Date.now()): boolean {
  const recovery = getBrokerRecoveryState(runtime)
  if (!recovery || recovery.fingerprint !== brokerRecoveryFingerprint(runtime)) {
    return false
  }
  const maxFailures = resolvePositiveMs('HRC_BROKER_RECOVERY_MAX_FAILURES') ?? 3
  const minElapsedMs = resolvePositiveMs('HRC_BROKER_RECOVERY_MIN_MS') ?? 60_000
  const firstFailedAt = Date.parse(recovery.firstFailedAt)
  return (
    recovery.count >= maxFailures &&
    Number.isFinite(firstFailedAt) &&
    now - firstFailedAt >= minElapsedMs
  )
}

export function recordBrokerRecoveryFailure(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  reason: string,
  now = timestamp()
): HrcRuntimeSnapshot {
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  const fingerprint = brokerRecoveryFingerprint(latest)
  const prior = getBrokerRecoveryState(latest)
  const next: BrokerRecoveryState =
    prior?.fingerprint === fingerprint
      ? {
          ...prior,
          count: prior.count + 1,
          lastFailedAt: now,
          lastReason: reason,
        }
      : {
          fingerprint,
          count: 1,
          firstFailedAt: now,
          lastFailedAt: now,
          lastReason: reason,
        }
  const control = getRecord(latest.runtimeStateJson?.['control']) ?? {}
  db.runtimes.update(latest.runtimeId, {
    runtimeStateJson: {
      ...(latest.runtimeStateJson ?? {}),
      control: { ...control, brokerRecovery: next },
      updatedAt: now,
    },
    ...runtimeActivityPatch(db, latest.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })
  return db.runtimes.getByRuntimeId(latest.runtimeId) ?? latest
}

export function clearBrokerRecovery(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  now = timestamp()
): void {
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  const control = getRecord(latest.runtimeStateJson?.['control'])
  if (!control || control['brokerRecovery'] === undefined) {
    return
  }
  const { brokerRecovery: _removed, ...rest } = control
  db.runtimes.update(latest.runtimeId, {
    runtimeStateJson: {
      ...(latest.runtimeStateJson ?? {}),
      control: rest,
      updatedAt: now,
    },
    ...runtimeActivityPatch(db, latest.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })
}

async function sweepOrphanedBrokerIpcDirs(
  db: HrcDatabase,
  runtimeRoot: string,
  result: BrokerTmuxLeaseSweepResult,
  options: BrokerTmuxLeaseSweepOptions,
  now: number,
  terminalLeaseTtlMs: number
): Promise<void> {
  const root = join(runtimeRoot, 'bipc')
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  const referencedPaths = new Set<string>()
  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      (!isExternalLifecycleOwner(runtime) &&
        isRuntimeUnavailableStatus(runtime.status) &&
        runtimeTerminalAgeMs(runtime, now) >= terminalLeaseTtlMs)
    ) {
      continue
    }
    const hosting = parseBrokerRuntimeHostingState(runtime)
    if (!hosting) continue
    if (hosting.endpoint.kind === 'unix-jsonrpc-ndjson') {
      referencedPaths.add(hosting.endpoint.socketPath)
      referencedPaths.add(hosting.endpoint.attachTokenRef.path)
    }
    if (hosting.substrate.kind === 'leased-tmux' && hosting.substrate.eventLedgerPath) {
      referencedPaths.add(hosting.substrate.eventLedgerPath)
    }
  }

  const commands = await (options.listBrokerProcessCommands ?? listProcessCommands)().catch(
    () => undefined
  )
  if (!commands) {
    // Process argv is mandatory negative evidence. Preserve everything when it
    // cannot be enumerated.
    result.errors += entries.filter((entry) => entry.isDirectory()).length
    return
  }
  const probe =
    options.probeBrokerHealth ??
    (async (socketPath: string) => {
      const module = await import('./broker-probe.js')
      return await module.probeBrokerHealth(socketPath)
    })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirPath = join(root, entry.name)
    try {
      const stats = await stat(dirPath)
      if (now - stats.mtimeMs < options.graceMs) {
        continue
      }
      if ([...referencedPaths].some((path) => pathWithinDirectory(path, dirPath))) {
        continue
      }
      if (commands.some((command) => command.includes(dirPath))) {
        continue
      }
      const children = await readdir(dirPath, { withFileTypes: true })
      const socketEntries = children.filter(
        (child) => child.isSocket() || child.name.endsWith('.sock')
      )
      let live = false
      for (const socket of socketEntries) {
        const health = await probe(join(dirPath, socket.name))
        if (health !== 'unreachable') {
          live = true
          break
        }
      }
      if (live) continue
      await rm(dirPath, { recursive: true, force: true })
      result.removedBrokerIpcDirs += 1
      writeServerLog('INFO', 'broker.orphan_ipc_dir_removed', { dirPath })
    } catch (error) {
      result.errors += 1
      writeServerLog('WARN', 'broker.orphan_ipc_dir_sweep_failed', { dirPath, error })
    }
  }
}

function pathWithinDirectory(path: string, directory: string): boolean {
  if (!isAbsolute(path)) return false
  const suffix = relative(directory, path)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

async function listProcessCommands(): Promise<string[]> {
  const process = Bun.spawn(['ps', '-axo', 'command='], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ps exited with status ${exitCode}`)
  }
  return stdout.split('\n').filter(Boolean)
}

function isBrokerTmuxLeaseSocketEntry(entry: string): boolean {
  if (!entry.endsWith('.sock')) {
    return false
  }
  return !NON_LEASE_BTMUX_SOCKET_PREFIXES.some((prefix) => entry.startsWith(prefix))
}

function isRendererControlSocketEntry(entry: string): boolean {
  return entry.startsWith(RENDERER_CONTROL_SOCKET_PREFIX) && entry.endsWith('.sock')
}

/** Outcome of inspecting one unclaimed lease socket during the orphan sweep. */
type LeaseSocketClassification =
  | { kind: 'vanished' }
  | { kind: 'within-grace' }
  | { kind: 'dead'; ageMs: number }
  | { kind: 'live-orphan'; ageMs: number; sessions: string[]; leaseTmux: TmuxManager }
  | { kind: 'unresponsive'; ageMs: number; error: string }

/**
 * Classify one unclaimed `.sock` lease for the orphan sweep WITHOUT mutating the
 * sweep counters or filesystem. The inner stat-catch maps the readdir↔stat race
 * to `vanished` (a benign skip, NOT an error); every other failure
 * (`listSessionNames`) propagates to the caller's error-counting catch. The
 * caller performs the side effects (rm / killServer / logging) per classification.
 */
async function classifyLeaseSocket(
  socketPath: string,
  now: number,
  graceMs: number
): Promise<LeaseSocketClassification> {
  let ageMs: number
  try {
    const stats = await stat(socketPath)
    ageMs = now - stats.mtimeMs
  } catch {
    // Socket vanished between readdir and stat -> nothing to sweep.
    return { kind: 'vanished' }
  }
  if (ageMs < graceMs) {
    return { kind: 'within-grace' }
  }

  const leaseTmux = createTmuxManager({ socketPath })
  let sessions: string[]
  try {
    sessions = await leaseTmux.listSessionNames({ timeoutMs: LEASE_SOCKET_INSPECT_TIMEOUT_MS })
  } catch (error) {
    if (isTmuxCommandTimeoutError(error)) {
      return { kind: 'unresponsive', ageMs, error: error.message }
    }
    throw error
  }
  const orphanLeaseSessions = sessions.filter((name) => name.startsWith('hrc-'))
  if (orphanLeaseSessions.length === 0) {
    return { kind: 'dead', ageMs }
  }
  return { kind: 'live-orphan', ageMs, sessions: orphanLeaseSessions, leaseTmux }
}

export async function reassociateBrokerTmuxLease(
  runtime: HrcRuntimeSnapshot,
  runtimeRoot: string
): Promise<boolean> {
  const rejectedPaths = rejectedBrokerAdoptionPaths(runtime, runtimeRoot)
  if (rejectedPaths.length > 0) {
    writeServerLog('WARN', 'broker.adoption.tmux_reassociation_rejected', {
      runtimeId: runtime.runtimeId,
      runtimeRoot,
      rejectedPaths,
      reason: BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
    })
    return false
  }
  const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
  if (!socketPath) {
    return false
  }
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  const leaseTmux = createTmuxManager({ socketPath })
  const persistedWindows = getPersistedBrokerWindows(runtime)
  if (!persistedWindows?.brokerWindow && !persistedWindows?.tuiWindow) {
    const inspected = await leaseTmux.inspectSession(sessionName)
    if (!inspected) {
      return false
    }
    return brokerLeaseIdsMatch(runtime, inspected)
  }
  return reassociateBrokerTmuxWindows(runtime, async () => ({
    brokerWindow: await leaseTmux.inspectWindow({ sessionName, windowName: 'broker' }),
    tuiWindow: await leaseTmux.inspectWindow({ sessionName, windowName: 'tui' }),
  }))
}

export async function reassociateBrokerTmuxWindows(
  runtime: HrcRuntimeSnapshot,
  inspect: (runtime: HrcRuntimeSnapshot) => Promise<BrokerWindowObservation>
): Promise<boolean> {
  return brokerLeaseWindowsMatch(runtime, await inspect(runtime))
}

export function brokerLeaseWindowsMatch(
  runtime: HrcRuntimeSnapshot,
  observed: BrokerWindowObservation
): boolean {
  const persisted = getPersistedBrokerWindows(runtime)
  if (!persisted?.brokerWindow || !persisted.tuiWindow) {
    return false
  }
  return (
    tmuxPaneIdentityMatches(persisted.brokerWindow, observed.brokerWindow) &&
    tmuxPaneIdentityMatches(persisted.tuiWindow, observed.tuiWindow)
  )
}

export function emitBrokerTmuxReassociated(db: HrcDatabase, runtime: HrcRuntimeSnapshot): void {
  const session = requireSession(db, runtime.hostSessionId)
  appendHrcEvent(db, 'runtime.reassociated', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: {
      runtimeId: runtime.runtimeId,
      reason: 'broker_tmux_lease_reassociated_on_restart',
      generation: runtime.generation,
    },
  })
}

export function brokerLeaseIdsMatch(runtime: HrcRuntimeSnapshot, observed: TmuxPaneState): boolean {
  const tmuxJson = runtime.tmuxJson
  if (!tmuxJson) {
    return false
  }
  for (const [key, value] of [
    ['sessionId', observed.sessionId],
    ['windowId', observed.windowId],
    ['paneId', observed.paneId],
  ] as const) {
    const persisted = tmuxJson[key]
    if (typeof persisted === 'string' && persisted !== value) {
      return false
    }
  }
  return true
}

export function brokerTuiWindowMatches(
  runtime: HrcRuntimeSnapshot,
  observed: TmuxPaneState | null
): boolean {
  const persisted = getPersistedBrokerWindows(runtime)
  return tmuxPaneIdentityMatches(persisted?.tuiWindow, observed)
}

export function getPersistedDurableBrokerEndpoint(
  runtime: HrcRuntimeSnapshot
): { socketPath: string } | undefined {
  const broker = getRuntimeStateBrokerRecord(runtime)
  const endpoint = extractBrokerEndpoint(getRecord(broker?.['endpoint']))
  return endpoint?.kind === 'unix-jsonrpc-ndjson' ? { socketPath: endpoint.socketPath } : undefined
}

export function getPersistedBrokerWindows(
  runtime: HrcRuntimeSnapshot
): { brokerWindow?: TmuxPaneState | undefined; tuiWindow?: TmuxPaneState | undefined } | undefined {
  const broker = getRuntimeStateBrokerRecord(runtime)
  if (!broker) {
    return undefined
  }
  return {
    brokerWindow: toTmuxPaneState(broker['brokerWindow']),
    tuiWindow: toTmuxPaneState(broker['tuiWindow']),
  }
}

export function getRuntimeStateBrokerRecord(
  runtime: HrcRuntimeSnapshot
): Record<string, unknown> | undefined {
  return getRecord(runtime.runtimeStateJson?.['broker'])
}

function toTmuxPaneState(value: unknown): TmuxPaneState | undefined {
  const record = getRecord(value)
  if (!record) {
    return undefined
  }
  const socketPath = record['socketPath']
  const sessionName = record['sessionName']
  const windowName = record['windowName']
  const sessionId = record['sessionId']
  const windowId = record['windowId']
  const paneId = record['paneId']
  if (
    typeof socketPath !== 'string' ||
    typeof sessionName !== 'string' ||
    typeof windowName !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof windowId !== 'string' ||
    typeof paneId !== 'string'
  ) {
    return undefined
  }
  return { socketPath, sessionName, windowName, sessionId, windowId, paneId }
}

function tmuxPaneIdentityMatches(
  persisted: TmuxPaneState | undefined,
  observed: TmuxPaneState | null
): boolean {
  if (!persisted || !observed) {
    return false
  }
  return (
    persisted.socketPath === observed.socketPath &&
    persisted.sessionName === observed.sessionName &&
    persisted.windowName === observed.windowName &&
    persisted.sessionId === observed.sessionId &&
    persisted.windowId === observed.windowId &&
    persisted.paneId === observed.paneId
  )
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function markBrokerReattachStale(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  reason: string,
  error?: unknown
): BrokerReattachOutcome {
  if (isExternalLifecycleOwner(runtime)) {
    return {
      runtimeId: runtime.runtimeId,
      state: 'broker-ipc-unavailable',
      brokerAttached: false,
      reason: 'external_lifecycle_owner',
    }
  }
  const session = requireSession(db, runtime.hostSessionId)
  markRuntimeStale(db, session, runtime, {
    runtimeId: runtime.runtimeId,
    reason,
    generation: runtime.generation,
    ...(error instanceof Error ? { error: error.message } : {}),
  })
  const now = timestamp()
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId)
  const previousControl = getRecord(
    (latest?.runtimeStateJson ?? runtime.runtimeStateJson)?.['control']
  )
  db.runtimes.update(runtime.runtimeId, {
    runtimeStateJson: {
      ...(latest?.runtimeStateJson ?? runtime.runtimeStateJson ?? {}),
      control: {
        ...(previousControl ?? {}),
        mode: 'broker-ipc',
        brokerAttached: false,
        lastAttachError: {
          code: reason,
          message: error instanceof Error ? error.message : reason,
        },
      },
      updatedAt: now,
    },
    ...runtimeActivityPatch(db, runtime.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })
  return {
    runtimeId: runtime.runtimeId,
    state: 'stale',
    brokerAttached: false,
    reason,
  }
}

export function gcBrokerRuntimeOnRestart(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  reason: string
): void {
  if (isExternalLifecycleOwner(runtime)) return
  const session = requireSession(db, runtime.hostSessionId)
  const now = timestamp()
  const invocationId = runtime.activeInvocationId
  if (invocationId !== undefined) {
    const invocation = db.brokerInvocations.getByInvocationId(invocationId)
    if (
      invocation &&
      invocation.invocationState !== 'disposed' &&
      invocation.invocationState !== 'exited' &&
      invocation.invocationState !== 'failed'
    ) {
      db.brokerInvocations.update(invocationId, {
        invocationState: 'disposed',
        updatedAt: now,
      })
    }
  }
  markRuntimeStale(db, session, runtime, {
    runtimeId: runtime.runtimeId,
    reason,
    generation: runtime.generation,
    ...(invocationId !== undefined ? { invocationId } : {}),
  })
}
