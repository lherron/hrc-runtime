#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { parseArgs } from './reap-headless-ghostmux/cli'
import {
  eventKindColor,
  formatDurationAgo,
  handleFromScope,
  isQuitEligible,
  projectHandleFromScope,
  shortRun,
  shortRuntime,
  skipReasons,
  statusColor,
} from './reap-headless-ghostmux/eligibility'
import {
  listPanes,
  queryStatuses,
  selectHeadlessPanes,
  statusSql,
} from './reap-headless-ghostmux/panes'
import {
  phaseStats,
  quantile,
  requireCommand,
  spawnStats,
  timePhase,
  timePhaseAsync,
} from './reap-headless-ghostmux/process'
import { classifyReapExec, isAlreadyTerminatedError, sendReap } from './reap-headless-ghostmux/reap'
import {
  type DiscoveredPane,
  HEADLESS_PANE_ROLE,
  MIN_IDLE_MINUTES,
  type Options,
  type PaneStatus,
  color,
} from './reap-headless-ghostmux/types'

// Wall time from process start to the status table being printed. 0 until the
// listing is rendered (e.g. the sweep threw during discovery).
let timeToListMs = 0

function printStatus(statuses: PaneStatus[], options: Options): void {
  console.log(color.bold('HRC Headless Ghostty Cleanup'))
  const titleNote = options.titleRegex ? `  title=${options.titleRegex}` : ''
  const reapTimeoutNote =
    options.reapTimeoutMs > 0 ? `${Math.round(options.reapTimeoutMs / 1000)}s` : 'off'
  console.log(
    color.dim(
      `role=${options.paneRole}${titleNote}  reap-timeout=${reapTimeoutNote}  db=${options.hrcDbPath}`
    )
  )
  if (options.dryRun) console.log(color.yellow('Mode: dry run, nothing will be terminated'))
  console.log()

  if (statuses.length === 0) {
    console.log(color.dim('No matching panes.'))
    return
  }

  console.log(color.bold(`Matched panes (${statuses.length})`))
  statuses.forEach((status, index) => {
    const duration = formatDurationAgo(status.lastActivityUtc)
    const reasons = skipReasons(status)
    const heading = [
      color.dim(`${String(index + 1).padStart(2)}.`),
      color.cyan(status.id),
      color.bold(projectHandleFromScope(status.scopeRef)),
      statusColor(status.runtimeStatus),
      color.dim('/'),
      statusColor(status.turnStatus),
      color.bold(color.cyan(duration)),
      reasons.length === 0 ? color.green('eligible') : color.yellow('skipped'),
    ].join(' ')

    console.log(heading)
    console.log(`    ${color.dim('scope')}      ${color.dim(handleFromScope(status.scopeRef))}`)
    console.log(
      `    ${color.dim('run')}        ${color.dim(shortRun(status.runId))} ${color.dim(
        shortRuntime(status.runtimeId)
      )}`
    )
    console.log(`    ${color.dim('turn event')} ${eventKindColor(status.latestTurnEventKind)}`)
    console.log(`    ${color.dim('title')}      ${color.dim(status.title)}`)
    // Explain exactly why a skipped pane is ineligible — one line per failed
    // guard, so the operator never has to reverse-engineer the predicate.
    reasons.forEach((reason, reasonIndex) => {
      const label = reasonIndex === 0 ? 'skipped' : ''
      console.log(`    ${color.yellow(label.padEnd(10))} ${color.yellow(reason)}`)
    })
  })
}

async function confirm(eligibleStatuses: PaneStatus[], options: Options): Promise<void> {
  if (eligibleStatuses.length === 0) return
  if (options.dryRun) {
    console.log()
    console.log(color.dim('Confirmation skipped for dry-run.'))
    return
  }
  if (options.assumeYes) {
    console.log()
    console.log(color.dim('Confirmation skipped: --yes supplied.'))
    return
  }
  if (!process.stdin.isTTY) {
    throw Object.assign(
      new Error('confirmation required, but stdin is not a TTY; rerun with --yes to confirm'),
      { exitCode: 3 }
    )
  }

  console.log()
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (
    await readline.question(
      color.yellow(
        `Reap ${eligibleStatuses.length} runtime(s) via hrc runtime terminate? Press Enter to continue: `
      )
    )
  ).trim()
  readline.close()
  if (answer !== '') {
    throw Object.assign(new Error('aborted before reaping'), { exitCode: 130 })
  }
  console.log(color.green('Confirmation accepted.'))
}

// `cached` is the pane list from the initial discovery. Pass it ONLY when the
// sweep provably mutated nothing (dry-run, or no reap and no close) — re-running
// discovery costs a full round of ghostmux metadata round-trips (1.6-5.0s
// measured) purely to reprint a list that cannot have changed.
function printRemaining(options: Options, cached?: DiscoveredPane[]): void {
  const remaining = cached ?? listPanes(options)
  console.log()
  console.log(color.bold('Remaining panes'))
  if (remaining.length === 0) {
    console.log(`  ${color.green('none')}`)
  } else {
    for (const pane of remaining) {
      console.log(`  ${color.cyan(pane.id)} ${pane.title}`)
    }
  }
}

// Render the phase/spawn ledger to stderr so it never contaminates the pane
// listing on stdout.
function printTimingReport(totalMs: number, loadStart: number, loadEnd: number): void {
  const stats = [...spawnStats.values()].sort((a, b) => b.totalMs - a.totalMs)
  const spawnTotalMs = stats.reduce((sum, stat) => sum + stat.totalMs, 0)
  const spawnCount = stats.reduce((sum, stat) => sum + stat.count, 0)

  const lines: string[] = []
  lines.push('')
  lines.push(color.bold('Timing'))
  lines.push(
    color.dim(
      `  load avg (1m): ${loadStart.toFixed(2)} at start → ${loadEnd.toFixed(2)} at end` +
        `  ·  ${spawnCount} subprocess spawns`
    )
  )
  lines.push('')
  lines.push(color.dim('  phase                          ms'))
  for (const phase of phaseStats) {
    lines.push(`  ${phase.name.padEnd(28)} ${phase.ms.toFixed(0).padStart(7)}`)
  }
  lines.push(`  ${color.bold('TOTAL'.padEnd(28))} ${color.bold(totalMs.toFixed(0).padStart(7))}`)
  lines.push(
    color.dim(
      `  time to list printed:        ${timeToListMs.toFixed(0).padStart(7)}  ` +
        `(${totalMs > 0 ? ((timeToListMs / totalMs) * 100).toFixed(0) : '0'}% of wall)`
    )
  )
  lines.push('')
  lines.push(color.dim('  spawn bucket                count    total ms     avg     p50     p95'))
  for (const stat of stats) {
    const sorted = [...stat.samples].sort((a, b) => a - b)
    lines.push(
      `  ${stat.key.padEnd(26)} ${String(stat.count).padStart(5)} ${stat.totalMs
        .toFixed(0)
        .padStart(11)} ${(stat.totalMs / stat.count).toFixed(0).padStart(7)} ${quantile(sorted, 0.5)
        .toFixed(0)
        .padStart(7)} ${quantile(sorted, 0.95).toFixed(0).padStart(7)}`
    )
  }
  const spawnShare = totalMs > 0 ? (spawnTotalMs / totalMs) * 100 : 0
  lines.push(
    color.dim(
      `  subprocess time = ${spawnTotalMs.toFixed(0)}ms of ${totalMs.toFixed(0)}ms wall ` +
        `(${spawnShare.toFixed(1)}%)`
    )
  )
  process.stderr.write(`${lines.join('\n')}\n`)
}

const METRICS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const METRICS_FILE_PATTERN = /^script-\d{4}-\d{2}-\d{2}\.ndjson$/

// Durable per-run record alongside the hrc CLI metrics (same `<stateRoot>/metrics`
// directory, distinct `script-*` file so `hrc admin metrics report`'s cli-* reader is
// unaffected). Best-effort: instrumentation must never fail the sweep.
function emitTimingMetrics(
  options: Options,
  totalMs: number,
  loadStart: number,
  loadEnd: number,
  paneCount: number,
  exitCode: number
): void {
  try {
    const metricsDir = join(dirname(options.hrcDbPath), 'metrics')
    mkdirSync(metricsDir, { recursive: true })
    const now = new Date()
    const record = {
      v: 1,
      kind: 'script',
      ts: now.toISOString(),
      script: 'reap-headless-ghostmux',
      cmd: process.argv.slice(2).join(' '),
      exitCode,
      durMs: Math.round(totalMs),
      timeToListMs: Math.round(timeToListMs),
      pid: process.pid,
      panes: paneCount,
      loadStart: Number(loadStart.toFixed(2)),
      loadEnd: Number(loadEnd.toFixed(2)),
      phases: phaseStats.map((phase) => ({ name: phase.name, ms: Math.round(phase.ms) })),
      spawns: [...spawnStats.values()]
        .sort((a, b) => b.totalMs - a.totalMs)
        .map((stat) => {
          const sorted = [...stat.samples].sort((a, b) => a - b)
          return {
            key: stat.key,
            count: stat.count,
            totalMs: Math.round(stat.totalMs),
            avgMs: Math.round(stat.totalMs / stat.count),
            p50Ms: Math.round(quantile(sorted, 0.5)),
            p95Ms: Math.round(quantile(sorted, 0.95)),
          }
        }),
    }
    appendFileSync(
      join(metricsDir, `script-${now.toISOString().slice(0, 10)}.ndjson`),
      `${JSON.stringify(record)}\n`
    )
    for (const name of readdirSync(metricsDir)) {
      if (!METRICS_FILE_PATTERN.test(name)) continue
      const path = join(metricsDir, name)
      if (now.getTime() - statSync(path).mtimeMs > METRICS_RETENTION_MS) unlinkSync(path)
    }
  } catch {
    // Instrumentation is never load-bearing.
  }
}

// Returns the number of discovered panes (for the metrics record).
async function sweep(options: Options): Promise<number> {
  timePhase('preflight', () => {
    if (!options.simulate) {
      requireCommand('ghostmux')
      requireCommand('sqlite3')
      requireCommand('hrc')
    }
  })

  const panes = timePhase('discover', () => listPanes(options))
  const statuses = timePhase('query-status', () => queryStatuses(panes, options))
  const eligibleStatuses = statuses.filter(isQuitEligible)
  timePhase('print-status', () => printStatus(statuses, options))
  // The user-perceived "how long until I see the list" figure: everything up to
  // and including the status table hitting stdout. Everything after this point
  // is post-list work the operator is not waiting on to read the listing.
  timeToListMs = phaseStats.reduce((sum, phase) => sum + phase.ms, 0)
  if (statuses.length > 0) {
    const skipped = statuses.length - eligibleStatuses.length
    console.log()
    console.log(
      color.dim(
        `Reap eligibility: ${eligibleStatuses.length} eligible, ${skipped} skipped (requires scope task!=primary, agent!=chief, controllerKind=harness-broker, a tmux TUI window (transport=tmux OR headless+leased-tmux+presentation=tmux-tui), runtime=ready, no active run, latest turn=completed (a coalesced turn resolves to its owner run), idle>${MIN_IDLE_MINUTES}m).`
      )
    )
  }
  // Includes human think-time at the prompt — labelled so it is never mistaken
  // for script cost when reading the ledger.
  await timePhaseAsync('confirm (human)', () => confirm(eligibleStatuses, options))

  if (eligibleStatuses.length === 0) {
    console.log(color.yellow('No eligible runtimes; nothing to do.'))
    // Nothing was reaped on this path, so the discovered list is still current —
    // reuse it rather than paying for a second discovery.
    timePhase('print-remaining', () => printRemaining(options, panes))
    return statuses.length
  }

  console.log()
  console.log(color.bold('Reaping (hrc runtime terminate --reason operator_reap)'))
  // A failure on any single runtime warns and continues — never aborts the
  // sweep, so the remaining eligible panes still get reaped.
  let reapSent = 0
  let reapWarned = 0
  const reapStarted = performance.now()
  for (const status of eligibleStatuses) {
    const result = sendReap(status, options)
    const suffix = `${color.dim(handleFromScope(status.scopeRef))} ${color.dim(shortRuntime(status.runtimeId))}`
    if (result.kind === 'already-terminated') {
      reapWarned += 1
      console.log(`  ${color.cyan(status.id)} ${color.yellow('already terminated')} ${suffix}`)
    } else if (result.kind === 'timed-out') {
      reapWarned += 1
      console.log(
        `  ${color.cyan(status.id)} ${color.yellow(
          `reap timed out after ${result.seconds}s`
        )} ${suffix}`
      )
      console.log(
        `    ${color.dim(
          'broker likely wedged — left ready, continuation intact; investigate or retry'
        )}`
      )
    } else if (result.kind === 'error') {
      reapWarned += 1
      console.log(`  ${color.cyan(status.id)} ${color.red('reap failed')} ${suffix}`)
      console.log(`    ${color.red(result.message)}`)
    } else {
      reapSent += 1
      console.log(`  ${color.cyan(status.id)} ${color.green('reap sent')} ${suffix}`)
    }
  }
  phaseStats.push({ name: 'reap', ms: performance.now() - reapStarted })
  if (reapWarned > 0) {
    console.log(color.dim(`Reap summary: sent=${reapSent}, warned=${reapWarned}`))
  }
  console.log()
  console.log(color.dim('Panes are left to hrc-viewer, which reaps each after its linger window.'))

  // A dry run issued no terminate, so nothing can have changed; reuse the
  // discovered list. A real sweep must re-discover to show what is left.
  timePhase('print-remaining', () => printRemaining(options, options.dryRun ? panes : undefined))
  return statuses.length
}

async function main(): Promise<void> {
  const startedAt = performance.now()
  const loadStart = loadavg()[0] ?? 0
  const options = parseArgs(process.argv.slice(2))
  let paneCount = 0
  let exitCode = 0
  try {
    paneCount = await sweep(options)
  } catch (error) {
    exitCode = 1
    throw error
  } finally {
    const totalMs = performance.now() - startedAt
    const loadEnd = loadavg()[0] ?? 0
    if (options.timing) printTimingReport(totalMs, loadStart, loadEnd)
    emitTimingMetrics(options, totalMs, loadStart, loadEnd, paneCount, exitCode)
  }
}

// Only run as a CLI; guarded so importing the module for unit tests
// (e.g. the `isQuitEligible` predicate fixture) does not execute the reaper.
if (import.meta.main) {
  main().catch((error) => {
    console.error(color.red(error instanceof Error ? error.message : String(error)))
    process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 1)
  })
}

export {
  HEADLESS_PANE_ROLE,
  classifyReapExec,
  isAlreadyTerminatedError,
  isQuitEligible,
  selectHeadlessPanes,
  skipReasons,
  statusSql,
}
export type { DiscoveredPane, PaneStatus }
