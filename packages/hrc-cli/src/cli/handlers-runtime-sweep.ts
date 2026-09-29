import { readFile } from 'node:fs/promises'

import type {
  PruneRuntimesRequest,
  PruneRuntimesResponse,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
  RecoverUnstartedRunRequest,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
} from 'hrc-core'

import { printJson } from '../print.js'
import { hasFlag, parseFlag, parseTransportFlag, splitCsv } from './argv.js'
import { requireArg } from './argv.js'
import { createClient, fatal } from './shared.js'

function resolveMutationGate(
  args: string[],
  noun: string
): { dryRunFlag: boolean; yes: boolean; jsonOutput: boolean; dryRun: boolean } {
  const dryRunFlag = hasFlag(args, '--dry-run')
  const yes = hasFlag(args, '--yes')
  const jsonOutput = hasFlag(args, '--json')
  if (!dryRunFlag && !yes && !process.stdout.isTTY) {
    fatal(`${noun} requires --yes to mutate when stdout is not a TTY`)
  }
  return {
    dryRunFlag,
    yes,
    jsonOutput,
    dryRun: dryRunFlag || (!yes && Boolean(process.stdout.isTTY)),
  }
}

export async function cmdRuntimeSweep(args: string[]): Promise<void> {
  const transport = parseTransportFlag(args)

  const { dryRunFlag, yes, jsonOutput, dryRun } = resolveMutationGate(args, 'runtime sweep')
  if (transport === 'tmux' && !yes && !dryRunFlag) {
    fatal('runtime sweep --transport tmux requires --yes')
  }

  const statusRaw = parseFlag(args, '--status')
  const scope = parseFlag(args, '--scope')
  const request: SweepRuntimesRequest = {
    ...(transport ? { transport } : {}),
    olderThan: parseFlag(args, '--older-than') ?? '24h',
    ...(statusRaw ? { status: splitCsv(statusRaw) } : {}),
    ...(scope ? { scope } : {}),
    ...(hasFlag(args, '--drop-continuation') ? { dropContinuation: true } : {}),
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.sweepRuntimes(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printSweepHuman(result, request.dryRun === true)
}

/**
 * Emit a `{ results, summary }` mutation result as NDJSON: one line per result
 * row followed by a final summary line. Shared by the runtime-sweep,
 * zombie-sweep, and active-reconcile commands (the per-command Human formatters
 * remain distinct).
 */
function printResultsNdjson(result: { results: readonly unknown[]; summary: unknown }): void {
  for (const row of result.results) {
    process.stdout.write(`${JSON.stringify(row)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result.summary)}\n`)
}

function printSweepHuman(result: SweepRuntimesResponse, dryRun: boolean): void {
  process.stdout.write(`runtime sweep${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : row.reason ? ` ${row.reason}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(10)} ${row.runtimeId} ${row.transport} dropContinuation=${
        row.droppedContinuation
      }${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} stale=${result.summary.stale} terminated=${result.summary.terminated} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

/**
 * Record-level GC for orphaned runtime store rows (T-05441). Distinct from
 * `runtime sweep`, which marks aged ready/busy rows stale without terminating
 * processes or tmux: prune DELETES the store row for genuinely orphaned
 * records. Dry-run by default; mutation requires `--yes`, mirroring the sweep
 * mutation gate.
 */
export async function cmdRuntimePrune(args: string[]): Promise<void> {
  const { dryRunFlag, yes, jsonOutput, dryRun } = resolveMutationGate(args, 'runtime prune')
  if (!yes && !dryRunFlag) {
    fatal('runtime prune requires --yes to delete records (use --dry-run to preview)')
  }

  const disposeRetainedEvidence = hasFlag(args, '--dispose-retained-evidence')
  const dispositionReason = parseFlag(args, '--reason')
  const exactRuntimeId = parseFlag(args, '--runtime-id')
  if (disposeRetainedEvidence) {
    if (dispositionReason === undefined || dispositionReason.trim().length === 0) {
      fatal('--dispose-retained-evidence requires --reason <text>')
    }
    if (exactRuntimeId === undefined || exactRuntimeId.length === 0) {
      fatal('--dispose-retained-evidence requires --runtime-id <id>')
    }
  } else if (dispositionReason !== undefined || exactRuntimeId !== undefined) {
    fatal('--reason and --runtime-id are only valid with --dispose-retained-evidence')
  }

  const runtimeIdsFile = parseFlag(args, '--runtime-ids-file')
  const includeLedgers = hasFlag(args, '--include-ledgers')
  if ((runtimeIdsFile !== undefined) !== includeLedgers) {
    fatal('--runtime-ids-file and --include-ledgers must be supplied together')
  }

  let runtimeIds: string[] | undefined
  if (runtimeIdsFile) {
    if (!yes) {
      fatal('ledger-inclusive manifest prune requires --yes, including with --dry-run')
    }
    let rawManifest: string
    try {
      rawManifest = await readFile(runtimeIdsFile, 'utf8')
    } catch (error) {
      fatal(
        `failed to read --runtime-ids-file ${runtimeIdsFile}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    runtimeIds = rawManifest
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (runtimeIds.length === 0) {
      fatal('--runtime-ids-file must contain at least one runtime ID')
    }
    if (new Set(runtimeIds).size !== runtimeIds.length) {
      fatal('--runtime-ids-file must not contain duplicate runtime IDs')
    }
  }

  const transport = parseTransportFlag(args)

  const statusRaw = parseFlag(args, '--status')
  const scope = parseFlag(args, '--scope')
  const request: PruneRuntimesRequest = {
    ...(disposeRetainedEvidence
      ? {
          runtimeIds: [exactRuntimeId as string],
          disposeRetainedEvidence: true,
          reason: dispositionReason,
        }
      : runtimeIds
        ? { runtimeIds, includeLedgers: true }
        : {
            ...(transport ? { transport } : {}),
            olderThan: parseFlag(args, '--older-than') ?? '24h',
            ...(statusRaw ? { status: splitCsv(statusRaw) } : {}),
            ...(scope ? { scope } : {}),
          }),
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.pruneRuntimes(request)
  if (jsonOutput) {
    for (const row of result.results) {
      process.stdout.write(`${JSON.stringify(row)}\n`)
    }
    if (result.deleteCounts) {
      process.stdout.write(
        `${JSON.stringify({ type: 'delete_counts', counts: result.deleteCounts })}\n`
      )
    }
    process.stdout.write(`${JSON.stringify(result.summary)}\n`)
    return
  }

  printPruneHuman(result, request.dryRun === true, runtimeIdsFile)
}

function printPruneHuman(
  result: PruneRuntimesResponse,
  dryRun: boolean,
  runtimeIdsFile?: string | undefined
): void {
  process.stdout.write(`runtime prune${dryRun ? ' (dry-run)' : ''}\n`)
  if (runtimeIdsFile) {
    process.stdout.write(`  manifest ${runtimeIdsFile}\n`)
    if (result.deleteCounts) {
      process.stdout.write(`${dryRun ? 'would-delete' : 'deleted'} by table\n`)
      for (const [table, count] of Object.entries(result.deleteCounts)) {
        process.stdout.write(`  ${table.padEnd(28)} ${count}\n`)
      }
    }
  } else {
    for (const row of result.results) {
      const detail = row.errorMessage ?? row.reason
      const suffix = detail ? ` ${detail}` : ''
      process.stdout.write(`  ${row.status.padEnd(8)} ${row.runtimeId} ${row.transport}${suffix}\n`)
    }
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} pruned=${result.summary.pruned} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

export async function cmdRunSweepZombies(args: string[]): Promise<void> {
  const { yes, jsonOutput, dryRun } = resolveMutationGate(args, 'run sweep-zombies')

  const request: SweepZombieRunsRequest = {
    olderThan: parseFlag(args, '--older-than') ?? '30m',
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.sweepZombieRuns(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printZombieSweepHuman(result, request.dryRun === true)
}

function printZombieSweepHuman(result: SweepZombieRunsResponse, dryRun: boolean): void {
  process.stdout.write(`run zombie sweep${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(8)} ${row.runId} observed=${row.observedAt} source=${
        row.observedSource
      } ownershipCleared=${row.runtimeOwnershipCleared}${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} zombied=${result.summary.zombied} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

export async function cmdRunReconcileActive(args: string[]): Promise<void> {
  const { yes, jsonOutput, dryRun } = resolveMutationGate(args, 'run reconcile-active')

  const request: ReconcileActiveRunsRequest = {
    olderThan: parseFlag(args, '--older-than') ?? '30m',
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.reconcileActiveRuns(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printReconcileActiveHuman(result, request.dryRun === true)
}

export async function cmdRunRecoverUnstarted(args: string[]): Promise<void> {
  const runId = requireArg(args, 0, 'runId')
  const { yes, jsonOutput, dryRun } = resolveMutationGate(args, 'run recover-unstarted')
  const request: RecoverUnstartedRunRequest = {
    runId,
    dryRun,
    ...(yes ? { yes } : {}),
  }
  const result = await createClient().recoverUnstartedRun(request)
  if (jsonOutput) {
    printJson(result)
    return
  }
  const suffix = result.reason ? ` reason=${result.reason}` : ''
  process.stdout.write(`run recovery ${result.status} ${result.runId}${suffix}\n`)
}

function printReconcileActiveHuman(result: ReconcileActiveRunsResponse, dryRun: boolean): void {
  process.stdout.write(`run active reconcile${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(8)} ${row.runId} ${row.transport} runtime=${
        row.runtimeStatus
      } reason=${row.reason} ownershipCleared=${row.runtimeOwnershipCleared}${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} reaped=${result.summary.reaped} suspect=${result.summary.suspect} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}
