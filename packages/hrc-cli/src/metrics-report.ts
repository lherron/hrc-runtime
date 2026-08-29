import { createReadStream, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { resolveStateRoot } from 'hrc-core'
import { parseDurationMs } from 'hrc-server'
import type { ServerMetricRecord } from 'hrc-server'

type ServerRequestMetricRecord = Extract<ServerMetricRecord, { kind: 'server' }>
type ServerCounterMetricRecord = Extract<ServerMetricRecord, { kind: 'counter' }>

type CliRpcMetric = {
  id: string
  path: string
  method: string
  ms: number
  status: number
  bytes: number
}

type CliMetricRecord = {
  v: 1
  kind: 'cli'
  ts: string
  bin: 'hrc' | 'hrcchat'
  cmd: string
  durMs: number
  stdoutBytes: number
  rpc: CliRpcMetric[]
}

type LaunchRecord = {
  v: 1
  kind: 'launch'
  ts: string
  bin: 'hrc' | 'hrcchat'
  cmd: string
  startupMs: number
  phases: { phase: string; ms: number }[]
}

type LaunchSpanRecord = {
  v: 1
  kind: 'launch_span'
  ts: string
  phase: string
  transport?: 'headless' | 'interactive' | 'preview'
  runtimeId: string
  ms: number
}

type NumberStats = { p50: number; p95: number; max: number }
type ByteStats = { total: number; max: number }

export type CommandMetricGroup = {
  command: string
  count: number
  durMs: NumberStats
  stdoutBytes: ByteStats
}

export type RouteMetricGroup = {
  route: string
  count: number
  ms: NumberStats
  bytes: ByteStats
}

export type CounterMetricGroup = { name: string; count: number }

export type LaunchStartupGroup = {
  command: string
  count: number
  startupMs: NumberStats
}

export type LaunchPhaseGroup = {
  phase: string
  count: number
  ms: NumberStats
}

/**
 * Startup cost, split by which side of the wire measured it. `client` is the
 * end-to-end number an operator actually waits through; `clientPhases` and
 * `serverPhases` localize where it went.
 */
export type LaunchMetricSection = {
  client: LaunchStartupGroup[]
  clientPhases: LaunchPhaseGroup[]
  serverPhases: LaunchPhaseGroup[]
}

export type SlowInvocation = {
  command: string
  ts: string
  durMs: number
  serverMs: number
  transportMs: number
  renderMs: number
}

export type LargestCliMetric = {
  command: string
  ts: string
  durMs: number
  stdoutBytes: number
}

export type LargestServerMetric = {
  route: string
  ts: string
  ms: number
  bytes: number
  reqId?: string
}

export type MetricsReport = {
  diagnostics: {
    metricsDirExists: boolean
    filesScanned: number
  }
  commands: CommandMetricGroup[]
  routes: RouteMetricGroup[]
  counters: CounterMetricGroup[]
  launch: LaunchMetricSection
  slowest: SlowInvocation[]
  largest: { cli: LargestCliMetric[]; server: LargestServerMetric[] }
  uncorrelatedServerCount: number
}

export type ReadMetricsReportOptions = {
  since?: string
  slowest?: number
  largest?: number
  now?: Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseCliRpc(value: unknown): CliRpcMetric | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value['id'] !== 'string' ||
    typeof value['path'] !== 'string' ||
    typeof value['method'] !== 'string' ||
    !isFiniteNonNegative(value['ms']) ||
    !isFiniteNonNegative(value['status']) ||
    !isFiniteNonNegative(value['bytes'])
  ) {
    return undefined
  }
  return {
    id: value['id'],
    path: value['path'],
    method: value['method'],
    ms: value['ms'],
    status: value['status'],
    bytes: value['bytes'],
  }
}

function parseCliMetric(value: unknown): CliMetricRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'cli') return undefined
  if (
    typeof value['ts'] !== 'string' ||
    (value['bin'] !== 'hrc' && value['bin'] !== 'hrcchat') ||
    typeof value['cmd'] !== 'string' ||
    !isFiniteNonNegative(value['durMs']) ||
    !isFiniteNonNegative(value['stdoutBytes']) ||
    !Array.isArray(value['rpc'])
  ) {
    return undefined
  }
  const rpc = value['rpc'].map(parseCliRpc)
  if (rpc.some((entry) => entry === undefined)) return undefined
  return {
    v: 1,
    kind: 'cli',
    ts: value['ts'],
    bin: value['bin'],
    cmd: value['cmd'],
    durMs: value['durMs'],
    stdoutBytes: value['stdoutBytes'],
    rpc: rpc as CliRpcMetric[],
  }
}

function parseLaunchMetric(value: unknown): LaunchRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'launch') return undefined
  if (
    typeof value['ts'] !== 'string' ||
    (value['bin'] !== 'hrc' && value['bin'] !== 'hrcchat') ||
    typeof value['cmd'] !== 'string' ||
    !isFiniteNonNegative(value['startupMs']) ||
    !Array.isArray(value['phases'])
  ) {
    return undefined
  }
  const phases: { phase: string; ms: number }[] = []
  for (const entry of value['phases']) {
    if (!isRecord(entry) || typeof entry['phase'] !== 'string' || !isFiniteNonNegative(entry['ms']))
      return undefined
    phases.push({ phase: entry['phase'], ms: entry['ms'] })
  }
  return {
    v: 1,
    kind: 'launch',
    ts: value['ts'],
    bin: value['bin'],
    cmd: value['cmd'],
    startupMs: value['startupMs'],
    phases,
  }
}

function parseLaunchSpanMetric(value: unknown): LaunchSpanRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'launch_span') return undefined
  const transport = value['transport']
  if (
    typeof value['ts'] !== 'string' ||
    typeof value['phase'] !== 'string' ||
    typeof value['runtimeId'] !== 'string' ||
    !isFiniteNonNegative(value['ms']) ||
    (transport !== undefined &&
      transport !== 'headless' &&
      transport !== 'interactive' &&
      transport !== 'preview')
  ) {
    return undefined
  }
  return {
    v: 1,
    kind: 'launch_span',
    ts: value['ts'],
    phase: value['phase'],
    ...(transport === undefined ? {} : { transport }),
    runtimeId: value['runtimeId'],
    ms: value['ms'],
  }
}

function parseServerMetric(value: unknown): ServerRequestMetricRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'server') return undefined
  if (
    typeof value['ts'] !== 'string' ||
    typeof value['route'] !== 'string' ||
    typeof value['method'] !== 'string' ||
    !isFiniteNonNegative(value['ms']) ||
    !isFiniteNonNegative(value['status']) ||
    (value['bytes'] !== undefined && !isFiniteNonNegative(value['bytes'])) ||
    (value['stream'] !== undefined && value['stream'] !== true) ||
    (value['reqId'] !== undefined && typeof value['reqId'] !== 'string')
  ) {
    return undefined
  }
  return {
    v: 1,
    kind: 'server',
    ts: value['ts'],
    route: value['route'],
    method: value['method'],
    ms: value['ms'],
    status: value['status'],
    ...(value['bytes'] === undefined ? {} : { bytes: value['bytes'] }),
    ...(value['stream'] === true ? { stream: true as const } : {}),
    ...(value['reqId'] === undefined ? {} : { reqId: value['reqId'] }),
  }
}

function parseCounterMetric(value: unknown): ServerCounterMetricRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'counter') return undefined
  if (
    typeof value['ts'] !== 'string' ||
    value['name'] !== 'ledger.blob_miss' ||
    !isFiniteNonNegative(value['value'])
  ) {
    return undefined
  }
  return {
    v: 1,
    kind: 'counter',
    ts: value['ts'],
    name: value['name'],
    value: value['value'],
  }
}

function percentileStats(samples: number[]): NumberStats {
  const sorted = [...samples].sort((a, b) => a - b)
  if (sorted.length === 0) return { p50: 0, p95: 0, max: 0 }
  const nearestRank = (percent: number): number => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)
    )
    return sorted[index] ?? 0
  }
  return { p50: nearestRank(50), p95: nearestRank(95), max: sorted.at(-1) ?? 0 }
}

function byteStats(samples: number[]): ByteStats {
  return {
    total: samples.reduce((total, value) => total + value, 0),
    max: samples.reduce((maximum, value) => Math.max(maximum, value), 0),
  }
}

function fileCouldContainWindow(name: string, cutoff: number): boolean {
  const match = /^(?:cli|server)-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name)
  if (!match?.[1]) return false
  return match[1] >= new Date(cutoff).toISOString().slice(0, 10)
}

type MetricSink = {
  cli: CliMetricRecord[]
  server: ServerRequestMetricRecord[]
  counters: ServerCounterMetricRecord[]
  launches: LaunchRecord[]
  launchSpans: LaunchSpanRecord[]
}

async function readMetricFile(path: string, cutoff: number, sink: MetricSink): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const record =
        parseCliMetric(parsed) ??
        parseServerMetric(parsed) ??
        parseCounterMetric(parsed) ??
        parseLaunchMetric(parsed) ??
        parseLaunchSpanMetric(parsed)
      if (!record) continue
      const timestamp = Date.parse(record.ts)
      if (!Number.isFinite(timestamp) || timestamp < cutoff) continue
      if (record.kind === 'cli') sink.cli.push(record)
      else if (record.kind === 'server') sink.server.push(record)
      else if (record.kind === 'counter') sink.counters.push(record)
      else if (record.kind === 'launch') sink.launches.push(record)
      else sink.launchSpans.push(record)
    }
  } catch {
    // Metrics files are observational and may rotate or disappear while reading.
  } finally {
    lines.close()
  }
}

function groupCommands(records: CliMetricRecord[]): CommandMetricGroup[] {
  const groups = new Map<string, CliMetricRecord[]>()
  for (const record of records) {
    const key = `${record.bin} ${record.cmd}`
    const group = groups.get(key)
    if (group) group.push(record)
    else groups.set(key, [record])
  }
  return [...groups.entries()]
    .map(([command, group]) => ({
      command,
      count: group.length,
      durMs: percentileStats(group.map((record) => record.durMs)),
      stdoutBytes: byteStats(group.map((record) => record.stdoutBytes)),
    }))
    .sort((a, b) => a.command.localeCompare(b.command))
}

function groupRoutes(records: ServerRequestMetricRecord[]): RouteMetricGroup[] {
  const groups = new Map<string, ServerRequestMetricRecord[]>()
  for (const record of records) {
    const key = `${record.method} ${record.route}`
    const group = groups.get(key)
    if (group) group.push(record)
    else groups.set(key, [record])
  }
  return [...groups.entries()]
    .map(([route, group]) => ({
      route,
      count: group.length,
      ms: percentileStats(group.map((record) => record.ms)),
      bytes: byteStats(
        group.flatMap((record) =>
          record.stream === true || record.bytes === undefined ? [] : [record.bytes]
        )
      ),
    }))
    .sort((a, b) => a.route.localeCompare(b.route))
}

function groupLaunchPhases(samples: Map<string, number[]>): LaunchPhaseGroup[] {
  return [...samples.entries()]
    .map(([phase, values]) => ({ phase, count: values.length, ms: percentileStats(values) }))
    .sort((a, b) => b.ms.p50 - a.ms.p50 || a.phase.localeCompare(b.phase))
}

function groupLaunches(launches: LaunchRecord[], spans: LaunchSpanRecord[]): LaunchMetricSection {
  const byCommand = new Map<string, number[]>()
  const clientPhases = new Map<string, number[]>()
  for (const record of launches) {
    const key = `${record.bin} ${record.cmd}`
    byCommand.set(key, [...(byCommand.get(key) ?? []), record.startupMs])
    for (const phase of record.phases) {
      clientPhases.set(phase.phase, [...(clientPhases.get(phase.phase) ?? []), phase.ms])
    }
  }
  const serverPhases = new Map<string, number[]>()
  for (const span of spans) {
    // Transport is part of the identity: a headless precompile and an
    // interactive one are different populations that happen to share a name.
    const key = span.transport ? `${span.phase} (${span.transport})` : span.phase
    serverPhases.set(key, [...(serverPhases.get(key) ?? []), span.ms])
  }
  return {
    client: [...byCommand.entries()]
      .map(([command, values]) => ({
        command,
        count: values.length,
        startupMs: percentileStats(values),
      }))
      .sort((a, b) => a.command.localeCompare(b.command)),
    clientPhases: groupLaunchPhases(clientPhases),
    serverPhases: groupLaunchPhases(serverPhases),
  }
}

export async function readMetricsReport(
  options: ReadMetricsReportOptions = {}
): Promise<MetricsReport> {
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - parseDurationMs(options.since ?? '7d')
  const metricsDir = join(resolveStateRoot(), 'metrics')
  const metricsDirExists = existsSync(metricsDir)
  const names = await readdir(metricsDir).catch(() => [])
  const sink: MetricSink = { cli: [], server: [], counters: [], launches: [], launchSpans: [] }

  const selectedNames = names.filter((entry) => fileCouldContainWindow(entry, cutoff)).sort()
  for (const name of selectedNames) {
    await readMetricFile(join(metricsDir, name), cutoff, sink)
  }
  const { cli, server, counters: counterRecords } = sink

  const cliRpcIds = new Set(cli.flatMap((record) => record.rpc.map((rpc) => rpc.id)))
  const serverByReqId = new Map<string, number>()
  for (const record of server) {
    if (!record.reqId) continue
    serverByReqId.set(record.reqId, (serverByReqId.get(record.reqId) ?? 0) + record.ms)
  }

  const slowestLimit = Math.max(0, options.slowest ?? 10)
  const slowest = [...cli]
    .sort((a, b) => b.durMs - a.durMs)
    .slice(0, slowestLimit)
    .map((record): SlowInvocation => {
      const rpcMs = record.rpc.reduce((total, rpc) => total + rpc.ms, 0)
      const serverMs = record.rpc.reduce(
        (total, rpc) => total + (serverByReqId.get(rpc.id) ?? 0),
        0
      )
      return {
        command: `${record.bin} ${record.cmd}`,
        ts: record.ts,
        durMs: record.durMs,
        serverMs,
        transportMs: rpcMs - serverMs,
        renderMs: record.durMs - rpcMs,
      }
    })

  const largestLimit = Math.max(0, options.largest ?? 10)
  const largestCli = [...cli]
    .sort((a, b) => b.stdoutBytes - a.stdoutBytes)
    .slice(0, largestLimit)
    .map(
      (record): LargestCliMetric => ({
        command: `${record.bin} ${record.cmd}`,
        ts: record.ts,
        durMs: record.durMs,
        stdoutBytes: record.stdoutBytes,
      })
    )
  const largestServer = server
    .filter(
      (record): record is ServerRequestMetricRecord & { bytes: number } =>
        record.stream !== true && record.bytes !== undefined
    )
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, largestLimit)
    .map(
      (record): LargestServerMetric => ({
        route: `${record.method} ${record.route}`,
        ts: record.ts,
        ms: record.ms,
        bytes: record.bytes,
        ...(record.reqId === undefined ? {} : { reqId: record.reqId }),
      })
    )

  return {
    diagnostics: {
      metricsDirExists,
      filesScanned: selectedNames.length,
    },
    commands: groupCommands(cli),
    routes: groupRoutes(server),
    counters: [
      ...counterRecords.reduce((groups, record) => {
        groups.set(record.name, (groups.get(record.name) ?? 0) + record.value)
        return groups
      }, new Map<string, number>()),
    ]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    launch: groupLaunches(sink.launches, sink.launchSpans),
    slowest,
    largest: { cli: largestCli, server: largestServer },
    uncorrelatedServerCount: server.filter(
      (record) => !record.reqId || !cliRpcIds.has(record.reqId)
    ).length,
  }
}
