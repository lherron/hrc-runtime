import { CliUsageError } from 'cli-kit'
import type { Command } from 'commander'

import { readMetricsReport } from '../metrics-report.js'
import type { MetricsReport } from '../metrics-report.js'
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

function printNdjson(report: MetricsReport): void {
  for (const row of report.commands)
    process.stdout.write(`${JSON.stringify({ kind: 'command', ...row })}\n`)
  for (const row of report.routes)
    process.stdout.write(`${JSON.stringify({ kind: 'route', ...row })}\n`)
  for (const row of report.slowest)
    process.stdout.write(`${JSON.stringify({ kind: 'slowest', ...row })}\n`)
  for (const row of report.largest.cli) {
    process.stdout.write(`${JSON.stringify({ kind: 'largest-cli', ...row })}\n`)
  }
  for (const row of report.largest.server) {
    process.stdout.write(`${JSON.stringify({ kind: 'largest-server', ...row })}\n`)
  }
  process.stdout.write(
    `${JSON.stringify({ kind: 'summary', uncorrelatedServerCount: report.uncorrelatedServerCount })}\n`
  )
}

function printHuman(report: MetricsReport): void {
  process.stdout.write('Commands\n')
  for (const row of report.commands) {
    process.stdout.write(
      `${row.command} count=${row.count} durMs[p50=${row.durMs.p50} p95=${row.durMs.p95} max=${row.durMs.max}] stdoutBytes[total=${row.stdoutBytes.total} max=${row.stdoutBytes.max}]\n`
    )
  }
  process.stdout.write('\nRoutes\n')
  for (const row of report.routes) {
    process.stdout.write(
      `${row.route} count=${row.count} ms[p50=${row.ms.p50} p95=${row.ms.p95} max=${row.ms.max}] bytes[total=${row.bytes.total} max=${row.bytes.max}]\n`
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
  const metrics = program.command('metrics').description('inspect local HRC performance metrics')
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
}
