import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { extractBrokerEndpoint } from '../broker/runtime-state.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { requireSession } from '../require-helpers.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from '../server-util.js'
import { type TmuxPaneState, createTmuxManager } from '../tmux.js'
import { logStartupIssue, markRuntimeStale } from './runtime-mutations.js'
import type {
  BrokerReattachOutcome,
  BrokerTmuxLeaseSweepOptions,
  BrokerTmuxLeaseSweepResult,
  BrokerWindowObservation,
} from './types.js'

/**
 * Sweep leaked broker-tmux lease sockets under `<runtimeRoot>/btmux/`. A socket
 * is reclaimed only when no non-terminal broker-tmux runtime claims it and it is
 * past the grace threshold. Live orphan servers are killed; dead socket files
 * are removed when requested. Claimed sockets are always preserved.
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
    skippedClaimed: 0,
    skippedWithinGrace: 0,
    errors: 0,
  }
  const dir = join(runtimeRoot, 'btmux')
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith('.sock'))
  } catch {
    // No btmux directory yet -> nothing to sweep.
    return result
  }
  if (entries.length === 0) {
    return result
  }

  // Lease sockets claimed by a still-live (non-terminal) harness-broker runtime.
  // T-01875: derive the claim from the hosting-state SUBSTRATE (leased-tmux), NOT
  // from runtime.transport — a durable HEADLESS runtime (transport='headless')
  // legitimately claims a leased tmux substrate and must not be swept. Fall back
  // to the legacy tmuxJson lease socket for pre-durable broker-tmux runtimes that
  // have no parseable broker hosting state.
  const claimedSockets = new Set<string>()
  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.controllerKind !== 'harness-broker' ||
      runtime.status === 'terminated' ||
      runtime.status === 'dead' ||
      isRuntimeUnavailableStatus(runtime.status)
    ) {
      continue
    }
    const hosting = parseBrokerRuntimeHostingState(runtime)
    const socketPath =
      hosting?.substrate.kind === 'leased-tmux'
        ? hosting.substrate.tmuxSocketPath
        : getBrokerRuntimeTmuxSocketPath(runtime)
    if (socketPath) {
      claimedSockets.add(socketPath)
    }
  }

  const now = Date.now()

  for (const entry of entries) {
    const socketPath = join(dir, entry)
    result.scanned += 1
    if (claimedSockets.has(socketPath)) {
      result.skippedClaimed += 1
      continue
    }
    try {
      let ageMs: number
      try {
        const stats = await stat(socketPath)
        ageMs = now - stats.mtimeMs
      } catch {
        // Socket vanished between readdir and stat -> nothing to sweep.
        continue
      }
      if (ageMs < options.graceMs) {
        // Still within grace: a live other daemon may be allocating/draining it.
        result.skippedWithinGrace += 1
        continue
      }

      const leaseTmux = createTmuxManager({ socketPath })
      const sessions = await leaseTmux.listSessionNames()
      const orphanLeaseSessions = sessions.filter((name) => name.startsWith('hrc-'))
      if (orphanLeaseSessions.length === 0) {
        if (options.removeDeadSocketFiles) {
          await rm(socketPath, { force: true })
          result.removedDeadSocketFiles += 1
          writeServerLog('INFO', 'broker.dead_lease_socket_removed', {
            socketPath,
            ageMs,
            graceMs: options.graceMs,
          })
        }
        continue
      }

      if (!options.killLiveLeaseServers) {
        continue
      }
      await leaseTmux.killServer()
      result.killedLiveLeaseServers += 1
      writeServerLog('INFO', 'broker.orphan_lease_swept', {
        socketPath,
        sessions: orphanLeaseSessions,
        ageMs,
        graceMs: options.graceMs,
      })
    } catch (error) {
      result.errors += 1
      logStartupIssue('broker orphan lease sweep failed', { socketPath }, error)
    }
  }
  return result
}

export async function reassociateBrokerTmuxLease(runtime: HrcRuntimeSnapshot): Promise<boolean> {
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
  const session = requireSession(db, runtime.hostSessionId)
  markRuntimeStale(db, session, runtime, {
    runtimeId: runtime.runtimeId,
    reason,
    generation: runtime.generation,
    ...(error instanceof Error ? { error: error.message } : {}),
  })
  const now = timestamp()
  const latest = db.runtimes.getByRuntimeId(runtime.runtimeId)
  db.runtimes.update(runtime.runtimeId, {
    runtimeStateJson: {
      ...(latest?.runtimeStateJson ?? runtime.runtimeStateJson ?? {}),
      control: {
        mode: 'broker-ipc',
        brokerAttached: false,
        lastAttachError: {
          code: reason,
          message: error instanceof Error ? error.message : reason,
        },
      },
      updatedAt: now,
    },
    updatedAt: now,
    lastActivityAt: now,
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
