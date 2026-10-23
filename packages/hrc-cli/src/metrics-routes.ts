import { createReadStream, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { resolveStateRoot } from 'hrc-core'
import { isSuppressedPollRoute, listRequestRouteInventory, parseDurationMs } from 'hrc-server'
import type { RequestMetricListener, RequestRouteInventoryEntry } from 'hrc-server'

import { fileCouldContainWindow, parseServerMetric } from './metrics-report.js'

/** What a row is keyed by: a route (listener + method + path), a caller, or both. */
export type RouteUsageDimension = 'route' | 'client'

export type RouteUsageRow = {
  listener?: RequestMetricListener
  method?: string
  route?: string
  /** `unattributed` for records written before T-11541 added callers. */
  client?: string
  /**
   * On `L3_SUPPRESSED_SUCCESSFUL_POLL_ROUTES`: its successful requests write no
   * `http.request` log line by design, so log silence there is not disuse.
   */
  suppressedPoll?: true
  /** Requests represented: a sampled record counts at its `sampleWeight`. */
  count: number
  /** Records actually on disk behind `count`. */
  records: number
  /** Requests answered >= 400, weighted like `count`. */
  errors: number
  errorRate: number
  ms: { p50: number; p95: number; max: number }
  firstSeen: string
  lastSeen: string
}

export type RouteUsageReport = {
  diagnostics: {
    metricsDirExists: boolean
    filesScanned: number
    recordsScanned: number
    since: string
  }
  by: RouteUsageDimension[]
  rows: RouteUsageRow[]
  /** Present with `idle`: inventory routes no request reached in the window. */
  idle?: (RequestRouteInventoryEntry & { suppressedPoll?: true })[]
}

export type ReadRouteUsageOptions = {
  since?: string
  by?: RouteUsageDimension[]
  listener?: RequestMetricListener
  idle?: boolean
  now?: Date
}

type Accumulator = {
  key: Pick<RouteUsageRow, 'listener' | 'method' | 'route' | 'client'>
  count: number
  records: number
  errors: number
  /** Latency histogram at 0.1ms resolution, weighted: bounded memory over any window. */
  ms: Map<number, number>
  firstSeen: string
  lastSeen: string
}

function weightedPercentile(
  histogram: Map<number, number>,
  total: number,
  percent: number
): number {
  const rank = Math.max(1, (percent / 100) * total)
  let seen = 0
  const values = [...histogram.keys()].sort((a, b) => a - b)
  for (const value of values) {
    seen += histogram.get(value) ?? 0
    if (seen >= rank) return value
  }
  return values.at(-1) ?? 0
}

/**
 * Streaming rollup of the daemon's request metric day files: one pass, one
 * accumulator per key, nothing held per record (T-11541).
 */
export async function readRouteUsage(
  options: ReadRouteUsageOptions = {}
): Promise<RouteUsageReport> {
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - parseDurationMs(options.since ?? '7d')
  const cutoffIso = new Date(cutoff).toISOString()
  const by = options.by ?? ['route']
  const byRoute = by.includes('route')
  const byClient = by.includes('client')
  const metricsDir = join(resolveStateRoot(), 'metrics')
  const metricsDirExists = existsSync(metricsDir)
  const names = (await readdir(metricsDir).catch(() => []))
    .filter((name) => name.startsWith('server-') && fileCouldContainWindow(name, cutoff))
    .sort()

  const groups = new Map<string, Accumulator>()
  const seenRoutes = new Set<string>()
  let recordsScanned = 0
  for (const name of names) {
    const lines = createInterface({
      input: createReadStream(join(metricsDir, name)),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    try {
      for await (const line of lines) {
        // Cheap reject before JSON.parse: most lines of a day file are requests,
        // but stalls, spans and counters share it.
        if (!line.includes('"kind":"server"')) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const record = parseServerMetric(parsed)
        if (!record || record.ts < cutoffIso) continue
        const listener: RequestMetricListener = record.listener ?? 'main'
        if (options.listener !== undefined && listener !== options.listener) continue
        recordsScanned += 1
        seenRoutes.add(`${listener} ${record.method} ${record.route}`)
        const key: Accumulator['key'] = {
          ...(byRoute ? { listener, method: record.method, route: record.route } : {}),
          ...(byClient ? { client: record.client ?? 'unattributed' } : {}),
        }
        const id = JSON.stringify(key)
        let group = groups.get(id)
        if (!group) {
          group = {
            key,
            count: 0,
            records: 0,
            errors: 0,
            ms: new Map<number, number>(),
            firstSeen: record.ts,
            lastSeen: record.ts,
          }
          groups.set(id, group)
        }
        const weight = record.sampleWeight ?? 1
        group.count += weight
        group.records += 1
        if (record.status >= 400) group.errors += weight
        const ms = Math.round(record.ms * 10) / 10
        group.ms.set(ms, (group.ms.get(ms) ?? 0) + weight)
        if (record.ts < group.firstSeen) group.firstSeen = record.ts
        if (record.ts > group.lastSeen) group.lastSeen = record.ts
      }
    } catch {
      // Day files are observational and may be pruned while being read.
    } finally {
      lines.close()
    }
  }

  const rows = [...groups.values()]
    .map(
      (group): RouteUsageRow => ({
        ...group.key,
        ...(group.key.route !== undefined &&
        isSuppressedPollRoute(group.key.listener ?? 'main', group.key.method ?? '', group.key.route)
          ? { suppressedPoll: true as const }
          : {}),
        count: group.count,
        records: group.records,
        errors: group.errors,
        errorRate: Number((group.errors / group.count).toFixed(4)),
        ms: {
          p50: weightedPercentile(group.ms, group.count, 50),
          p95: weightedPercentile(group.ms, group.count, 95),
          max: Math.max(...group.ms.keys()),
        },
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
      })
    )
    .sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)))

  return {
    diagnostics: {
      metricsDirExists,
      filesScanned: names.length,
      recordsScanned,
      since: cutoffIso,
    },
    by,
    rows,
    ...(options.idle
      ? {
          idle: listRequestRouteInventory()
            .filter(
              (entry) =>
                (options.listener === undefined || entry.listener === options.listener) &&
                !seenRoutes.has(`${entry.listener} ${entry.method} ${entry.route}`)
            )
            .map((entry) =>
              isSuppressedPollRoute(entry.listener, entry.method, entry.route)
                ? { ...entry, suppressedPoll: true as const }
                : entry
            )
            .sort(
              (a, b) =>
                a.listener.localeCompare(b.listener) ||
                a.route.localeCompare(b.route) ||
                a.method.localeCompare(b.method)
            ),
        }
      : {}),
  }
}
