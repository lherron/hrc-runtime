import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { exactRouteKey, matchLaunchSubroute, matchSessionTitleRoute } from './server-routing.js'

const METRICS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const SERVER_METRICS_FILE_PATTERN = /^server-\d{4}-\d{2}-\d{2}\.ndjson$/

export type ServerRequestMetricRecord = {
  v: 1
  kind: 'server'
  ts: string
  route: string
  method: string
  ms: number
  status: number
  bytes?: number
  stream?: true
  reqId?: string
}

export type SqliteSlowStatementMetricRecord = {
  v: 1
  kind: 'sqlite_slow_statement'
  ts: string
  sql: string
  ms: number
  callerTag: string
}

/**
 * One launch phase span, durably recorded so `hrc admin metrics report` can
 * aggregate startup cost. These spans are ALSO written to hrc-server.err.log as
 * `broker.timing` lines; the log is the human breadcrumb, this is the
 * population. The log rotates, so a grep over it is a lossy sample - anything
 * that needs a p50/p95 must read these records instead.
 */
export type LaunchSpanMetricRecord = {
  v: 1
  kind: 'launch_span'
  ts: string
  phase: string
  transport?: 'headless' | 'interactive' | 'preview'
  runtimeId: string
  ms: number
}

export type ServerCounterMetricRecord = {
  v: 1
  kind: 'counter'
  ts: string
  name: 'ledger.blob_miss'
  value: number
}

export type ServerMetricRecord =
  | ServerRequestMetricRecord
  | SqliteSlowStatementMetricRecord
  | ServerCounterMetricRecord
  | LaunchSpanMetricRecord

export type ResponseByteMeasurement = { bytes: number } | { stream: true }

export function normalizeRoute(
  method: string,
  pathname: string,
  knownExactKeys: Set<string>
): string {
  if (knownExactKeys.has(exactRouteKey(method, pathname))) {
    return pathname
  }
  if (method === 'GET' && pathname.startsWith('/v1/sessions/by-host/')) {
    return '/v1/sessions/by-host/:hostSessionId'
  }
  if (method === 'GET' && pathname.startsWith('/v1/active-run-contributions/')) {
    return '/v1/active-run-contributions/:inputApplicationId'
  }
  if (matchSessionTitleRoute(method, pathname)) {
    return '/v1/sessions/:hostSessionId/title'
  }
  const launchSubroute = matchLaunchSubroute(method, pathname)
  if (launchSubroute) {
    return `/v1/internal/launches/:launchId/${launchSubroute.suffix}`
  }
  return 'unmatched'
}

export async function measureResponseBytes(response: Response): Promise<ResponseByteMeasurement> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (
    contentType.includes('text/event-stream') ||
    response.headers.get('x-hrc-streaming') === '1'
  ) {
    return { stream: true }
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return { bytes: parsed }
    }
  }

  return { bytes: (await response.clone().arrayBuffer()).byteLength }
}

export function pruneServerMetricFiles(metricsDir: string, now: number): void {
  try {
    const todayFile = `server-${new Date(now).toISOString().slice(0, 10)}.ndjson`
    for (const name of readdirSync(metricsDir)) {
      if (!SERVER_METRICS_FILE_PATTERN.test(name) || name === todayFile) continue
      const path = join(metricsDir, name)
      if (now - statSync(path).mtimeMs > METRICS_RETENTION_MS) {
        unlinkSync(path)
      }
    }
  } catch {
    // Retention is best-effort and must never affect request handling.
  }
}

export function writeServerMetric(record: ServerMetricRecord, now: Date, stateRoot: string): void {
  try {
    const metricsDir = join(stateRoot, 'metrics')
    mkdirSync(metricsDir, { recursive: true })
    pruneServerMetricFiles(metricsDir, now.getTime())
    const file = join(metricsDir, `server-${now.toISOString().slice(0, 10)}.ndjson`)
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // Metrics are observational; storage failures must never affect responses.
  }
}

/**
 * Record a launch phase span. Never throws: a launch must not fail because its
 * own instrumentation could not be persisted.
 */
export function recordLaunchSpan(
  span: {
    phase: string
    runtimeId: string
    ms: number
    transport?: 'headless' | 'interactive' | 'preview' | undefined
  },
  stateRoot: string
): void {
  const now = new Date()
  writeServerMetric(
    {
      v: 1,
      kind: 'launch_span',
      ts: now.toISOString(),
      phase: span.phase,
      ...(span.transport ? { transport: span.transport } : {}),
      runtimeId: span.runtimeId,
      // Sub-microsecond precision is noise in a launch budget and makes the
      // rendered report unreadable; one decimal millisecond is the useful unit.
      ms: Number(span.ms.toFixed(1)),
    },
    now,
    stateRoot
  )
}
