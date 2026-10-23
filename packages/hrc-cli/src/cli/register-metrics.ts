import { CliUsageError } from 'cli-kit'
import type { Command } from 'commander'

import { readMetricsReport } from '../metrics-report.js'
import type { MetricsReport } from '../metrics-report.js'
import { readRouteUsage } from '../metrics-routes.js'
import type { RouteUsageDimension, RouteUsageReport } from '../metrics-routes.js'
import { printJson } from '../print.js'

type MetricsReportFlags = {
  since: string
  slowest: string
  largest: string
  json?: boolean | undefined
  ndjson?: boolean | undefined
}

function parseLimit(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`${flag} must be a non-negative integer`)
  }
  return parsed
}

type MetricsRoutesFlags = {
  since: string
  by: string
  listener?: string | undefined
  idle?: boolean | undefined
  json?: boolean | undefined
}

const ROUTE_USAGE_LISTENERS = ['main', 'ingest', 'peer', 'registry'] as const

function parseBy(value: string): RouteUsageDimension[] {
  const parts = value.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.some((part) => part !== 'route' && part !== 'client')) {
    throw new CliUsageError('--by takes route, client, or route,client')
  }
  return [...new Set(parts)] as RouteUsageDimension[]
}

function parseListener(
  value: string | undefined
): (typeof ROUTE_USAGE_LISTENERS)[number] | undefined {
  if (value === undefined) return undefined
  const listener = ROUTE_USAGE_LISTENERS.find((candidate) => candidate === value)
  if (!listener) throw new CliUsageError(`--listener takes ${ROUTE_USAGE_LISTENERS.join(', ')}`)
  return listener
}

function printRouteUsage(report: RouteUsageReport): void {
  const { diagnostics } = report
  process.stdout.write(
    `Request metrics since ${diagnostics.since}: files=${diagnostics.filesScanned} records=${diagnostics.recordsScanned}${diagnostics.metricsDirExists ? '' : ' (no metrics dir)'}\n`
  )
  process.stdout.write(
    `${'count'.padStart(10)} ${'err%'.padStart(6)} ${'p50ms'.padStart(8)} ${'p95ms'.padStart(8)}  ${'last seen'.padEnd(16)}  ${report.by.map((dimension) => (dimension === 'route' ? 'listener route' : 'client')).join('  ')}\n`
  )
  for (const row of report.rows) {
    const key = [
      ...(row.route === undefined ? [] : [`${row.listener} ${row.method} ${row.route}`]),
      ...(row.client === undefined ? [] : [row.client]),
      ...(row.suppressedPoll ? ['(suppressed poll: no log line on success)'] : []),
    ].join('  ')
    process.stdout.write(
      `${String(row.count).padStart(10)} ${(row.errorRate * 100).toFixed(1).padStart(6)} ${String(row.ms.p50).padStart(8)} ${String(row.ms.p95).padStart(8)}  ${row.lastSeen.slice(0, 16).padEnd(16)}  ${key}\n`
    )
  }
  if (report.idle) {
    process.stdout.write(`\nIdle routes (no request in window): ${report.idle.length}\n`)
    for (const entry of report.idle) {
      process.stdout.write(
        `  ${entry.listener} ${entry.method} ${entry.route}${entry.suppressedPoll ? '  (suppressed poll)' : ''}\n`
      )
    }
  }
}

function printNdjson(report: MetricsReport): void {
  for (const row of report.commands)
    process.stdout.write(`${JSON.stringify({ kind: 'command', ...row })}\n`)
  for (const row of report.routes)
    process.stdout.write(`${JSON.stringify({ kind: 'route', ...row })}\n`)
  for (const row of report.counters)
    process.stdout.write(`${JSON.stringify({ kind: 'counter', ...row })}\n`)
  for (const row of report.launch.client)
    process.stdout.write(`${JSON.stringify({ kind: 'launch', ...row })}\n`)
  for (const row of report.launch.clientPhases)
    process.stdout.write(`${JSON.stringify({ kind: 'launch-client-phase', ...row })}\n`)
  for (const row of report.launch.serverPhases)
    process.stdout.write(`${JSON.stringify({ kind: 'launch-server-phase', ...row })}\n`)
  for (const row of report.slowest)
    process.stdout.write(`${JSON.stringify({ kind: 'slowest', ...row })}\n`)
  for (const row of report.largest.cli) {
    process.stdout.write(`${JSON.stringify({ kind: 'largest-cli', ...row })}\n`)
  }
  for (const row of report.largest.server) {
    process.stdout.write(`${JSON.stringify({ kind: 'largest-server', ...row })}\n`)
  }
  process.stdout.write(
    `${JSON.stringify({
      kind: 'summary',
      uncorrelatedServerCount: report.uncorrelatedServerCount,
      diagnostics: report.diagnostics,
    })}\n`
  )
}

function printHuman(report: MetricsReport): void {
  process.stdout.write(
    `Metrics source: exists=${report.diagnostics.metricsDirExists} filesScanned=${report.diagnostics.filesScanned}\n\n`
  )
  process.stdout.write('Commands\n')
  for (const row of report.commands) {
    process.stdout.write(
      `${row.command} count=${row.count} durMs[p50=${row.durMs.p50} p95=${row.durMs.p95} max=${row.durMs.max}] stdoutBytes[total=${row.stdoutBytes.total} max=${row.stdoutBytes.max}]\n`
    )
  }
  process.stdout.write('\nRoutes\n')
  for (const row of report.routes) {
    process.stdout.write(
      `${row.route} count=${row.count}${row.sampled ? ` sampled=${row.sampled}` : ''} ms[p50=${row.ms.p50} p95=${row.ms.p95} max=${row.ms.max}] bytes[total=${row.bytes.total} max=${row.bytes.max}]\n`
    )
  }
  process.stdout.write('\nCounters\n')
  for (const row of report.counters) {
    process.stdout.write(`${row.name} count=${row.count}\n`)
  }
  process.stdout.write('\nStartup (end-to-end, command entry -> attach handoff)\n')
  for (const row of report.launch.client) {
    process.stdout.write(
      `${row.command} count=${row.count} startupMs[p50=${row.startupMs.p50} p95=${row.startupMs.p95} max=${row.startupMs.max}]\n`
    )
  }
  process.stdout.write('\nStartup phases (client)\n')
  for (const row of report.launch.clientPhases) {
    process.stdout.write(
      `${row.phase} count=${row.count} ms[p50=${row.ms.p50} p95=${row.ms.p95} max=${row.ms.max}]\n`
    )
  }
  process.stdout.write('\nStartup phases (server)\n')
  for (const row of report.launch.serverPhases) {
    process.stdout.write(
      `${row.phase} count=${row.count} ms[p50=${row.ms.p50} p95=${row.ms.p95} max=${row.ms.max}]\n`
    )
  }
  process.stdout.write('\nSlowest invocations\n')
  for (const row of report.slowest) {
    process.stdout.write(
      `${row.command} durMs=${row.durMs} serverMs=${row.serverMs} transportMs=${row.transportMs} renderMs=${row.renderMs}\n`
    )
  }
  process.stdout.write('\nLargest CLI payloads\n')
  for (const row of report.largest.cli) {
    process.stdout.write(`${row.command} stdoutBytes=${row.stdoutBytes} durMs=${row.durMs}\n`)
  }
  process.stdout.write('\nLargest server payloads\n')
  for (const row of report.largest.server) {
    process.stdout.write(`${row.route} bytes=${row.bytes} ms=${row.ms}\n`)
  }
  process.stdout.write(`\nUncorrelated server requests: ${report.uncorrelatedServerCount}\n`)
}

export function registerMetricsCommands(program: Command): void {
  const admin = program.commands.find((command) => command.name() === 'admin')
  if (!admin) throw new Error('hrc command registration order error: missing admin')
  const metrics = admin.command('metrics').description('inspect local HRC performance metrics')
  metrics
    .command('report')
    .description('report CLI and server latency and payload metrics')
    .option('--since <duration>', 'include records within this duration', '7d')
    .option('--slowest <n>', 'number of slowest CLI invocations', '10')
    .option('--largest <n>', 'number of largest payload records', '10')
    .option('--json', 'output one structured JSON object')
    .option('--ndjson', 'output one NDJSON object per row')
    .action(async (options: MetricsReportFlags) => {
      if (options.json && options.ndjson) {
        throw new CliUsageError('--json and --ndjson are mutually exclusive')
      }
      const report = await readMetricsReport({
        since: options.since,
        slowest: parseLimit(options.slowest, '--slowest'),
        largest: parseLimit(options.largest, '--largest'),
      })
      if (options.json) printJson(report)
      else if (options.ndjson) printNdjson(report)
      else printHuman(report)
    })
  metrics
    .command('routes')
    .description('request counts per route and caller across every daemon listener (read-only)')
    .option('--since <duration>', 'include records within this duration', '7d')
    .option('--by <dimensions>', 'group rows by route, client, or route,client', 'route')
    .option('--listener <name>', 'only one listener: main, ingest, peer or registry')
    .option('--idle', 'also list registered routes with no request in the window')
    .option('--json', 'output one structured JSON object')
    .action(async (options: MetricsRoutesFlags) => {
      const listener = parseListener(options.listener)
      const report = await readRouteUsage({
        since: options.since,
        by: parseBy(options.by),
        ...(listener === undefined ? {} : { listener }),
        ...(options.idle ? { idle: true } : {}),
      })
      if (options.json) printJson(report)
      else printRouteUsage(report)
    })
}
