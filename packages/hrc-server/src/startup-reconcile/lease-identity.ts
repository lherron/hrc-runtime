import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { getBrokerRuntimeTmuxSocketPath } from '../broker-decisions.js'
import {
  compareBrokerLeaseIdentity,
  parseBrokerRuntimeHostingState,
} from '../broker/runtime-hosting.js'
import type { BrokerLeaseIdentityComparison } from '../broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'
import { type TmuxManager, createTmuxManager, isTmuxCommandTimeoutError } from '../tmux.js'
import { sweepOrphanedBrokerIpcDirs } from './lease-identity-ipc-dirs.js'
import {
  getRuntimeStateBrokerRecord,
  markBrokerReattachStale,
  reassociateBrokerTmuxLease,
} from './lease-identity-reassociate.js'
import {
  isBrokerRecoveryExhausted,
  resolvePositiveMs,
  runtimeLeaseFingerprint,
  runtimeTerminalAgeMs,
} from './lease-identity-recovery.js'
import { RENDERER_CONTROL_SOCKET_PREFIX } from './lease-identity-renderer-control.js'
import { logStartupIssue } from './runtime-mutations.js'
import type { BrokerTmuxLeaseSweepOptions, BrokerTmuxLeaseSweepResult } from './types.js'

// Re-exported so every name this module has always exported stays importable
// from './lease-identity.js'.
export {
  HolderEnumerationAbortedError,
  LSOF_HELD_UNIX_SOCKET_ARGV,
  parseLsofUnixSocketPaths,
  sweepOrphanedRendererControlSockets,
} from './lease-identity-renderer-control.js'
export {
  brokerRecoveryFingerprint,
  clearBrokerRecovery,
  getBrokerRecoveryState,
  getRecord,
  isBrokerRecoveryExhausted,
  recordBrokerRecoveryFailure,
} from './lease-identity-recovery.js'
export {
  brokerLeaseIdsMatch,
  brokerLeaseWindowsMatch,
  brokerTuiWindowMatches,
  emitBrokerTmuxReassociated,
  gcBrokerRuntimeOnRestart,
  getPersistedBrokerWindows,
  getPersistedDurableBrokerEndpoint,
  getRuntimeStateBrokerRecord,
  markBrokerReattachStale,
  reassociateBrokerTmuxLease,
  reassociateBrokerTmuxWindows,
} from './lease-identity-reassociate.js'

const LEASE_SOCKET_INSPECT_TIMEOUT_MS = 750
// The btmux directory also contains Codex app renderer-control Unix sockets.
// They are not tmux servers, so the orphan lease sweeper must not probe them.
const NON_LEASE_BTMUX_SOCKET_PREFIXES = [RENDERER_CONTROL_SOCKET_PREFIX]
const DEFAULT_TERMINAL_BROKER_LEASE_TTL_MS = 15 * 60 * 1000

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
        const claimEvidence = new Map<string, Record<string, unknown>>()
        for (const claim of claims) {
          const observation =
            classified.kind === 'live-orphan'
              ? await observeRuntimeClaimedLease(
                  claim,
                  socketPath,
                  runtimeRoot,
                  classified.sessions
                )
              : {
                  disposition: 'orphan' as const,
                  reason: 'broker_claimed_lease_substrate_gone',
                  evidence: { socketPath, observedSessions: [] },
                }
          claimEvidence.set(claim.runtimeId, observation.evidence)
          const identityAccepted = observation.disposition !== 'orphan'
          const withinTerminalTtl =
            isRuntimeUnavailableStatus(claim.status) &&
            runtimeTerminalAgeMs(claim, now) < passiveTtlMs
          if (
            identityAccepted &&
            (!isRuntimeUnavailableStatus(claim.status) || withinTerminalTtl) &&
            !isBrokerRecoveryExhausted(claim, now)
          ) {
            matchingClaims.push(claim)
          } else {
            orphanReasons.set(
              claim.runtimeId,
              classified.kind === 'dead'
                ? 'broker_claimed_lease_substrate_gone'
                : observation.disposition === 'orphan'
                  ? observation.reason
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
          claimEvidence: Object.fromEntries(claimEvidence),
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

type RuntimeClaimedLeaseObservation = {
  disposition: 'match' | 'preserve' | 'orphan'
  reason: string
  evidence: Record<string, unknown>
}

async function observeRuntimeClaimedLease(
  runtime: HrcRuntimeSnapshot,
  socketPath: string,
  runtimeRoot: string,
  observedSessions: string[]
): Promise<RuntimeClaimedLeaseObservation> {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux') {
    const substrate = hosting.substrate
    const manager = createTmuxManager({ socketPath })
    if (socketPath !== substrate.tmuxSocketPath) {
      const comparison = compareBrokerLeaseIdentity(runtime, {
        tmuxSocketPath: socketPath,
        sessionName: substrate.sessionName,
      })
      return logClaimedLeaseIdentityObservation(runtime, socketPath, 'orphan', {
        reason: 'broker_claimed_lease_socket_path_mismatch',
        comparison,
        observedSessions,
      })
    }
    if (!observedSessions.includes(substrate.sessionName)) {
      const comparison = compareBrokerLeaseIdentity(runtime, {
        tmuxSocketPath: socketPath,
        sessionName: observedSessions[0] ?? '',
      })
      return logClaimedLeaseIdentityObservation(runtime, socketPath, 'orphan', {
        reason: 'broker_claimed_lease_session_name_mismatch',
        comparison,
        observedSessions,
      })
    }
    const brokerWindow = await manager.inspectWindow({
      sessionName: substrate.sessionName,
      windowName: 'broker',
    })
    const observedBrokerPane =
      brokerWindow ?? (await manager.inspectPane(substrate.brokerWindow.paneId))
    const tuiWindow =
      hosting.presentation.kind === 'tmux-tui'
        ? await manager.inspectWindow({
            sessionName: substrate.sessionName,
            windowName: 'tui',
          })
        : null
    const observedTuiPane =
      hosting.presentation.kind === 'tmux-tui' && !tuiWindow
        ? await manager.inspectPane(hosting.presentation.tuiWindow.paneId)
        : tuiWindow
    const observerWindow =
      hosting.presentation.kind === 'observer'
        ? await manager.inspectWindow({
            sessionName: substrate.sessionName,
            windowName: 'observer',
          })
        : null
    const observedObserverPane =
      hosting.presentation.kind === 'observer' && !observerWindow
        ? await manager.inspectPane(hosting.presentation.observerWindow.paneId)
        : observerWindow
    const comparison = compareBrokerLeaseIdentity(runtime, {
      tmuxSocketPath: socketPath,
      sessionName: substrate.sessionName,
      ...(observedBrokerPane
        ? {
            brokerWindowName: observedBrokerPane.windowName,
            brokerWindow: {
              sessionId: observedBrokerPane.sessionId,
              windowId: observedBrokerPane.windowId,
              paneId: observedBrokerPane.paneId,
            },
          }
        : {}),
      ...(observedTuiPane
        ? {
            tuiWindowName: observedTuiPane.windowName,
            tuiWindow: {
              sessionId: observedTuiPane.sessionId,
              windowId: observedTuiPane.windowId,
              paneId: observedTuiPane.paneId,
            },
          }
        : {}),
      ...(observedObserverPane
        ? {
            observerWindowName: observedObserverPane.windowName,
            observerWindow: {
              sessionId: observedObserverPane.sessionId,
              windowId: observedObserverPane.windowId,
              paneId: observedObserverPane.paneId,
            },
          }
        : {}),
    })
    const paneProcess = await manager.inspectPaneProcess(
      observedBrokerPane?.paneId ?? substrate.brokerWindow.paneId
    )
    const processCommand =
      paneProcess && paneProcess.pid > 0 && !paneProcess.dead
        ? await inspectProcessCommand(paneProcess.pid)
        : undefined
    const processIdentifiesBroker =
      paneProcess !== null &&
      !paneProcess.dead &&
      processCommandIdentifiesRuntimeBroker(runtime, paneProcess.pid, processCommand)
    const evidence = {
      comparison,
      observedSessions,
      observedBrokerWindow: observedBrokerPane,
      observedTuiWindow: observedTuiPane,
      observedObserverWindow: observedObserverPane,
      observedBrokerProcess: paneProcess,
      processIdentifiesBroker,
    }

    if (paneProcess?.dead) {
      return logClaimedLeaseIdentityObservation(runtime, socketPath, 'orphan', {
        reason: 'broker_claimed_lease_broker_pane_dead',
        ...evidence,
      })
    }
    if (comparison.matches) {
      return { disposition: 'match', reason: 'exact_identity_match', evidence }
    }

    // A strict identity miss is not ownership evidence. Tmux can transiently
    // fail a named-window lookup, the operator can rename/delete only the TUI
    // window, and pane ids can change across respawn. When the claimed session
    // still exists and no dead broker pane was observed, preserve the lease.
    // A process argv tied to this runtime is corroborating positive liveness;
    // failure to collect it remains inconclusive and therefore fail-safe.
    return logClaimedLeaseIdentityObservation(runtime, socketPath, 'preserve', {
      reason: processIdentifiesBroker
        ? 'broker_claimed_lease_live_broker_identity_drift'
        : 'broker_claimed_lease_identity_probe_inconclusive',
      ...evidence,
    })
  }
  const reassociated = await reassociateBrokerTmuxLease(runtime, runtimeRoot)
  if (reassociated) {
    return {
      disposition: 'match',
      reason: 'legacy_lease_reassociated',
      evidence: { socketPath, observedSessions },
    }
  }
  return logClaimedLeaseIdentityObservation(runtime, socketPath, 'preserve', {
    reason: 'broker_claimed_lease_legacy_probe_inconclusive',
    observedSessions,
  })
}

function logClaimedLeaseIdentityObservation(
  runtime: HrcRuntimeSnapshot,
  socketPath: string,
  disposition: 'preserve' | 'orphan',
  input: {
    reason: string
    comparison?: BrokerLeaseIdentityComparison | undefined
    [key: string]: unknown
  }
): RuntimeClaimedLeaseObservation {
  const evidence = { ...input }
  const event =
    input.comparison && !input.comparison.matches
      ? 'broker.claimed_lease_identity_mismatch_observed'
      : 'broker.claimed_lease_orphan_evidence'
  writeServerLog('WARN', event, {
    runtimeId: runtime.runtimeId,
    socketPath,
    disposition,
    ...evidence,
  })
  return { disposition, reason: input.reason, evidence }
}

async function inspectProcessCommand(pid: number): Promise<string | undefined> {
  const process = Bun.spawn(['ps', '-p', String(pid), '-o', 'command='], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ])
  if (exitCode !== 0) return undefined
  const command = stdout.trim()
  return command.length > 0 ? command : undefined
}

function processCommandIdentifiesRuntimeBroker(
  runtime: HrcRuntimeSnapshot,
  observedPid: number,
  command: string | undefined
): boolean {
  const broker = getRuntimeStateBrokerRecord(runtime)
  if (broker?.['brokerPid'] === observedPid) return true
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.endpoint.kind !== 'unix-jsonrpc-ndjson' || !command) return false
  return (
    command.includes('harness-broker') &&
    command.includes(`--runtime-id ${runtime.runtimeId}`) &&
    command.includes(`--socket ${hosting.endpoint.socketPath}`)
  )
}

function isBrokerTmuxLeaseSocketEntry(entry: string): boolean {
  if (!entry.endsWith('.sock')) {
    return false
  }
  return !NON_LEASE_BTMUX_SOCKET_PREFIXES.some((prefix) => entry.startsWith(prefix))
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
