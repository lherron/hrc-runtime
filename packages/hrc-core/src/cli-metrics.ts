import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { resolveStateRoot } from './paths.js'

const METRICS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const MAX_RECORD_BYTES = 4096
const METRICS_FILE_PATTERN = /^cli-\d{4}-\d{2}-\d{2}\.ndjson$/

type CliCommandOption = {
  long?: string | undefined
  short?: string | undefined
  required: boolean
  optional: boolean
}

type CliCommand = {
  aliases(): string[]
  commands: readonly CliCommand[]
  name(): string
  options: readonly CliCommandOption[]
}

export type HrcCliRpcMetric = {
  id: string
  path: string
  method: string
  ms: number
  status: number
  bytes: number
}

export type HrcCliRpcMetricsHook = {
  start(
    path: string,
    method: string
  ): {
    id: string
    finish(status: number, bytes: number): void
  }
}

type CliMetricRecord = {
  v: 1
  kind: 'cli'
  ts: string
  bin: 'hrc' | 'hrcchat'
  cmd: string
  flags: string[]
  exitCode: number
  durMs: number
  stdoutBytes: number
  tty: boolean
  agent?: string
  project?: string
  pid: number
  rpc: HrcCliRpcMetric[]
}

export type CliMetricsRecorder = {
  setCommandTree(command: CliCommand): void
}

let rpcMetricsHook: HrcCliRpcMetricsHook | undefined

export function getHrcCliRpcMetricsHook(): HrcCliRpcMetricsHook | undefined {
  return rpcMetricsHook
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function optionForToken(command: CliCommand, token: string): CliCommandOption | undefined {
  return command.options.find((option) => {
    if (option.long && (token === option.long || token.startsWith(`${option.long}=`))) return true
    return option.short === token
  })
}

function childForToken(command: CliCommand, token: string): CliCommand | undefined {
  return command.commands.find(
    (candidate) => candidate.name() === token || candidate.aliases().includes(token)
  )
}

function commandPath(argv: readonly string[], root: CliCommand | undefined): string {
  if (!root) return ''

  const path: string[] = []
  let command = root
  let skipNext = false

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    if (token === '--') break

    if (token.startsWith('-')) {
      const option = optionForToken(command, token) ?? optionForToken(root, token)
      if (option && !token.includes('=') && (option.required || option.optional)) {
        const next = argv[index + 1]
        skipNext =
          option.required ||
          (next !== undefined &&
            !next.startsWith('-') &&
            childForToken(command, next) === undefined)
      }
      continue
    }

    const child = childForToken(command, token)
    if (child) {
      path.push(child.name())
      command = child
    }
  }

  return path.join(' ')
}

function flagNames(argv: readonly string[]): string[] {
  const flags: string[] = []
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') break
    if (token?.startsWith('-') && token !== '-') {
      flags.push(token.split('=', 1)[0] ?? token)
    }
  }
  return flags
}

function serializeBounded(record: CliMetricRecord): string {
  let line = JSON.stringify(record)
  while (Buffer.byteLength(line) >= MAX_RECORD_BYTES && record.rpc.length > 0) {
    record.rpc.pop()
    line = JSON.stringify(record)
  }
  while (Buffer.byteLength(line) >= MAX_RECORD_BYTES && record.flags.length > 0) {
    record.flags.pop()
    line = JSON.stringify(record)
  }
  if (Buffer.byteLength(line) >= MAX_RECORD_BYTES) {
    const { agent: _agent, project: _project, ...recordWithoutContext } = record
    line = JSON.stringify(recordWithoutContext)
  }
  return line
}

function pruneOldMetricsFiles(metricsDir: string, now: number): void {
  const todayFile = `cli-${new Date(now).toISOString().slice(0, 10)}.ndjson`
  for (const name of readdirSync(metricsDir)) {
    if (!METRICS_FILE_PATTERN.test(name) || name === todayFile) continue
    const path = join(metricsDir, name)
    if (now - statSync(path).mtimeMs > METRICS_RETENTION_MS) {
      unlinkSync(path)
    }
  }
}

function writeMetric(record: CliMetricRecord, now: Date): void {
  try {
    const metricsDir = join(resolveStateRoot(), 'metrics')
    mkdirSync(metricsDir, { recursive: true })
    try {
      pruneOldMetricsFiles(metricsDir, now.getTime())
    } catch {
      // Retention is best-effort and must never affect the invoking command.
    }
    const file = join(metricsDir, `cli-${now.toISOString().slice(0, 10)}.ndjson`)
    appendFileSync(file, `${serializeBounded(record)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // Metrics are observational; storage failures must never affect CLI behavior.
  }
}

/**
 * Install process-wide CLI metrics at a true bin entry. This module lives in
 * hrc-core so both CLIs and hrc-sdk share one optional hook without adding a
 * reverse dependency from hrc-core to the SDK.
 */
export function installCliMetricsRecorder(options: {
  bin: 'hrc' | 'hrcchat'
  argv?: readonly string[]
}): CliMetricsRecorder {
  if (process.env['HRC_METRICS'] === '0') {
    return { setCommandTree: () => undefined }
  }

  const argv = options.argv ?? process.argv
  const startedAt = new Date()
  const startedHrtime = process.hrtime.bigint()
  const rpc: HrcCliRpcMetric[] = []
  let stdoutBytes = 0
  let commandTree: CliCommand | undefined

  const originalWrite = process.stdout.write
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
    const [chunk, encodingOrCallback] = args
    if (typeof chunk === 'string') {
      const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
      stdoutBytes += Buffer.byteLength(chunk, encoding)
    } else {
      stdoutBytes += chunk.byteLength
    }
    return originalWrite.apply(process.stdout, args)
  }) as typeof process.stdout.write

  rpcMetricsHook = {
    start(path, method) {
      const started = process.hrtime.bigint()
      const metric: HrcCliRpcMetric = {
        id: randomUUID(),
        path: path.split('?', 1)[0] ?? path,
        method,
        ms: 0,
        status: 0,
        bytes: 0,
      }
      rpc.push(metric)
      return {
        id: metric.id,
        finish(status, bytes) {
          metric.ms = elapsedMs(started)
          metric.status = status
          metric.bytes = bytes
        },
      }
    },
  }

  process.on('exit', (exitCode) => {
    const agent = process.env['ASP_AGENT_ID']?.trim()
    const project = process.env['ASP_PROJECT']?.trim()
    const record: CliMetricRecord = {
      v: 1,
      kind: 'cli',
      ts: startedAt.toISOString(),
      bin: options.bin,
      cmd: commandPath(argv, commandTree),
      flags: flagNames(argv),
      exitCode,
      durMs: elapsedMs(startedHrtime),
      stdoutBytes,
      tty: process.stdout.isTTY === true,
      ...(agent ? { agent } : {}),
      ...(project ? { project } : {}),
      pid: process.pid,
      rpc,
    }
    writeMetric(record, new Date())
  })

  return {
    setCommandTree(command) {
      commandTree = command
    },
  }
}
