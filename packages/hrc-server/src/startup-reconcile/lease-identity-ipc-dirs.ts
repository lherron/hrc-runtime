import { existsSync } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  classifyRetainedOutcome,
  persistedEventLedgerPath,
  recordUnboundBeforeSweep,
  retainedEvidenceHold,
} from '../broker/offline-evidence'
import { REVIVABLE_STATUSES, holdExpiredAgeMs } from '../broker/offline-evidence-outcomes'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { listProcessCommands } from '../process-commands.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'
import { runtimeTerminalAgeMs } from './lease-identity-recovery.js'
import type { BrokerTmuxLeaseSweepOptions, BrokerTmuxLeaseSweepResult } from './types.js'

type DirOwner = {
  runtimeId: string
  reason: 'revivable_expired' | 'external_hold_expired' | 'unbound_outcome'
  outcome?: string | undefined
  ageMs?: number | undefined
}

/** T-10632: `retained_evidence.revivable_expired` is logged once per runtime per daemon process. */
const revivableExpiryLogged = new WeakMap<HrcDatabase, Set<string>>()

function logRevivableExpiryOnce(db: HrcDatabase, runtime: HrcRuntimeSnapshot, ageMs: number) {
  let logged = revivableExpiryLogged.get(db)
  if (logged === undefined) {
    logged = new Set()
    revivableExpiryLogged.set(db, logged)
  }
  if (logged.has(runtime.runtimeId)) return
  logged.add(runtime.runtimeId)
  writeServerLog('INFO', 'retained_evidence.revivable_expired', {
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    ageMs,
  })
}

/**
 * T-10632 R2: an expired external runtime still pins its endpoint while a
 * participant attempt could re-read it — an ACTIVE attempt (the only state a
 * reconnect re-arms) or establishment work the scheduler will still drive.
 */
function externalAttemptCanReattach(db: HrcDatabase, runtimeId: string): boolean {
  return db.participantRegistrations
    .listAttemptsByRuntimeId(runtimeId)
    .some(
      (attempt) =>
        attempt.state === 'ACTIVE' ||
        attempt.establishmentWorkState === 'pending' ||
        attempt.establishmentWorkState === 'retry_wait'
    )
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else total += (await lstat(child).catch(() => undefined))?.size ?? 0
  }
  return total
}

export async function sweepOrphanedBrokerIpcDirs(
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
  // T-08566 §4.2: a bound runtime's ledger directory is held until its retained
  // evidence is recovered or explicitly disposed, regardless of terminal age or
  // substrate kind. Unbound terminal runtimes get their unrecoverable-by-design
  // outcome recorded here, before this pass may remove their directory.
  const recordedAt = new Date(now).toISOString()
  const dirOwners = new Map<string, DirOwner>()
  const heldByOutcome = new Map<string, number>()
  for (const runtime of db.runtimes.listAll()) {
    const hold = retainedEvidenceHold(db, runtime, now)
    const ledgerPath = hold.ledgerPath
    const expiredAgeMs = REVIVABLE_STATUSES.has(runtime.status)
      ? holdExpiredAgeMs(runtime, now)
      : undefined
    if (ledgerPath !== undefined && expiredAgeMs !== undefined && existsSync(dirname(ledgerPath))) {
      // R1: only bound runtimes reach here (an unbound one has no hold at all).
      const ageMs = expiredAgeMs
      logRevivableExpiryOnce(db, runtime, ageMs)
      dirOwners.set(dirname(ledgerPath), {
        runtimeId: runtime.runtimeId,
        reason: 'revivable_expired',
        ageMs,
      })
    }
    if (hold.held && ledgerPath !== undefined) {
      referencedPaths.add(ledgerPath)
      // R3: incomplete and paused outcomes wait for an operator; keep them visible.
      const outcomeClass = hold.reason ? classifyRetainedOutcome(hold.reason) : undefined
      if (
        hold.reason !== 'revivable' &&
        hold.reason !== 'not_attempted' &&
        (outcomeClass === 'incomplete' || outcomeClass === 'paused')
      ) {
        heldByOutcome.set(dirname(ledgerPath), runtimeTerminalAgeMs(runtime, now))
      }
      continue
    }
    const unbound = recordUnboundBeforeSweep(db, runtime, recordedAt)
    const unboundLedgerPath = unbound !== undefined ? persistedEventLedgerPath(runtime) : undefined
    if (unbound !== undefined && unboundLedgerPath !== undefined) {
      dirOwners.set(dirname(unboundLedgerPath), {
        runtimeId: runtime.runtimeId,
        reason: 'unbound_outcome',
        outcome: unbound,
      })
    }
  }
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker') continue
    const external = isExternalLifecycleOwner(runtime)
    if (
      !external &&
      isRuntimeUnavailableStatus(runtime.status) &&
      runtimeTerminalAgeMs(runtime, now) >= terminalLeaseTtlMs
    ) {
      continue
    }
    const hosting = parseBrokerRuntimeHostingState(runtime)
    if (!hosting) continue
    const paths: string[] = []
    if (hosting.endpoint.kind === 'unix-jsonrpc-ndjson') {
      paths.push(hosting.endpoint.socketPath, hosting.endpoint.attachTokenRef.path)
    }
    if (hosting.substrate.kind === 'leased-tmux' && hosting.substrate.eventLedgerPath) {
      paths.push(hosting.substrate.eventLedgerPath)
    }
    // R2: the external-lifecycle hold ends at the age bound unless an attempt
    // could still reattach through this endpoint.
    const externalAgeMs =
      external && isRuntimeUnavailableStatus(runtime.status)
        ? holdExpiredAgeMs(runtime, now)
        : undefined
    if (externalAgeMs !== undefined && !externalAttemptCanReattach(db, runtime.runtimeId)) {
      for (const path of paths) {
        dirOwners.set(dirname(path), {
          runtimeId: runtime.runtimeId,
          reason: 'external_hold_expired',
          ageMs: externalAgeMs,
        })
      }
      continue
    }
    for (const path of paths) referencedPaths.add(path)
  }

  if (heldByOutcome.size > 0) {
    let bytes = 0
    for (const dir of heldByOutcome.keys()) bytes += await directoryBytes(dir)
    writeServerLog('INFO', 'broker.ipc_dirs_held_by_outcome', {
      count: heldByOutcome.size,
      bytes,
      oldestAgeMs: Math.max(...heldByOutcome.values()),
    })
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
      const owner = dirOwners.get(dirPath)
      writeServerLog('INFO', 'broker.orphan_ipc_dir_removed', {
        dirPath,
        reason: owner?.reason ?? 'unreferenced',
        ...(owner !== undefined ? { runtimeId: owner.runtimeId } : {}),
        ...(owner?.outcome !== undefined ? { outcome: owner.outcome } : {}),
        ...(owner?.ageMs !== undefined ? { ageMs: owner.ageMs } : {}),
      })
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
