import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  persistedEventLedgerPath,
  recordUnboundBeforeSweep,
  retainedEvidenceHold,
} from '../broker/offline-evidence'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'
import { runtimeTerminalAgeMs } from './lease-identity-recovery.js'
import type { BrokerTmuxLeaseSweepOptions, BrokerTmuxLeaseSweepResult } from './types.js'

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
  const unboundLedgerOwners = new Map<string, { runtimeId: string; outcome: string }>()
  for (const runtime of db.runtimes.listAll()) {
    const hold = retainedEvidenceHold(db, runtime)
    if (hold.held && hold.ledgerPath !== undefined) {
      referencedPaths.add(hold.ledgerPath)
      continue
    }
    const unbound = recordUnboundBeforeSweep(db, runtime, recordedAt)
    const ledgerPath = unbound !== undefined ? persistedEventLedgerPath(runtime) : undefined
    if (unbound !== undefined && ledgerPath !== undefined) {
      unboundLedgerOwners.set(dirname(ledgerPath), {
        runtimeId: runtime.runtimeId,
        outcome: unbound,
      })
    }
  }
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
      const owner = unboundLedgerOwners.get(dirPath)
      writeServerLog('INFO', 'broker.orphan_ipc_dir_removed', {
        dirPath,
        ...(owner !== undefined ? { runtimeId: owner.runtimeId, outcome: owner.outcome } : {}),
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

export async function listProcessCommands(): Promise<string[]> {
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
