import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { writeServerLog } from './server-log.js'
import { exactRouteKey, matchLaunchSubroute, matchSessionTitleRoute } from './server-routing.js'

const METRICS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const SERVER_METRICS_FILE_PATTERN = /^server-\d{4}-\d{2}-\d{2}\.ndjson$/

/**
 * Metrics are observational and must never be able to exhaust the volume that
 * holds the registry and runtime ledger. A healthy node writes far below this
 * ceiling; a hot/reconnecting stream is sampled until the next UTC day.
 */
export const SERVER_METRICS_MAX_FILE_BYTES = 128 * 1024 * 1024

/**
 * Metric lines are buffered in memory and appended asynchronously (T-08784):
 * no request pays for a filesystem call. A crash loses at most one interval;
 * a clean stop flushes. Past the buffer bound, records are dropped and counted
 * as a `metrics.dropped` counter on the next flush - never unbounded memory.
 */
export const SERVER_METRICS_FLUSH_INTERVAL_MS = 1000
export const SERVER_METRICS_MAX_BUFFERED_LINES = 20_000
export const SERVER_METRICS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/**
 * Request records are stratified-sampled so a day file covers 24h under the
 * polling load (~35 req/s). A record is always kept at weight 1 when it carries
 * a reqId, failed (>= 400), was slow (>= ALWAYS_KEEP_MS), or is among the first
 * UNSAMPLED_PER_MINUTE of its route in the current minute. The remaining
 * (eligible) stream is sampled systematically 1-in-SAMPLE_EVERY and each kept
 * record carries `sampleWeight`, so weights sum to the true count.
 */
export const SERVER_METRIC_SAMPLE_EVERY = 20
export const SERVER_METRIC_UNSAMPLED_PER_MINUTE = 10
export const SERVER_METRIC_ALWAYS_KEEP_MS = 25

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
  /** Present (> 1) only on a sampled record: the number of requests it stands for. */
  sampleWeight?: number
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
  name: 'ledger.blob_miss' | 'metrics.dropped'
  value: number
}

/** One event-loop stall (T-08786); the log line is the breadcrumb, this is the population. */
export type EventLoopStallMetricRecord = {
  v: 1
  kind: 'event_loop_stall'
  ts: string
  lagMs: number
  activities: { tag: string; count: number; ms: number }[]
}

export type ServerMetricRecord =
  | ServerRequestMetricRecord
  | EventLoopStallMetricRecord
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

type RouteSampleState = { minute: number; keptThisMinute: number; eligible: number }

export class ServerRequestMetricSampler {
  private readonly routes = new Map<string, RouteSampleState>()

  /** Returns the weight to record the request at, or 0 to skip it. */
  weight(
    request: { method: string; route: string; ms: number; status: number; reqId?: string | null },
    nowMs: number
  ): number {
    if (request.reqId || request.status >= 400 || request.ms >= SERVER_METRIC_ALWAYS_KEEP_MS) {
      return 1
    }
    const key = `${request.method} ${request.route}`
    const minute = Math.floor(nowMs / 60_000)
    let state = this.routes.get(key)
    if (!state) {
      state = { minute, keptThisMinute: 0, eligible: 0 }
      this.routes.set(key, state)
    }
    if (state.minute !== minute) {
      state.minute = minute
      state.keptThisMinute = 0
    }
    if (state.keptThisMinute < SERVER_METRIC_UNSAMPLED_PER_MINUTE) {
      state.keptThisMinute += 1
      return 1
    }
    // Only the eligible stream advances the systematic counter, so the kept
    // records' weights sum to the eligible count.
    state.eligible += 1
    return state.eligible % SERVER_METRIC_SAMPLE_EVERY === 0 ? SERVER_METRIC_SAMPLE_EVERY : 0
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export async function pruneServerMetricFiles(metricsDir: string, now: number): Promise<void> {
  try {
    const todayFile = `server-${utcDay(now)}.ndjson`
    for (const name of await readdir(metricsDir)) {
      if (!SERVER_METRICS_FILE_PATTERN.test(name) || name === todayFile) continue
      const path = join(metricsDir, name)
      if (now - (await stat(path)).mtimeMs > METRICS_RETENTION_MS) {
        await unlink(path)
      }
    }
  } catch {
    // Retention is best-effort and must never affect request handling.
  }
}

type PendingMetricLine = { day: string; line: string; bytes: number }

class ServerMetricsWriter {
  private readonly metricsDir: string
  private pending: PendingMetricLine[] = []
  private pendingBytes = 0
  private dropped = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  private dirReady = false
  private prunedDay: string | undefined
  private readonly daySizes = new Map<string, number>()
  private capWarnedDay: string | undefined

  constructor(stateRoot: string) {
    this.metricsDir = join(stateRoot, 'metrics')
  }

  enqueue(record: ServerMetricRecord, now: Date): void {
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (
      this.pending.length >= SERVER_METRICS_MAX_BUFFERED_LINES ||
      this.pendingBytes + bytes > SERVER_METRICS_MAX_BUFFERED_BYTES
    ) {
      this.dropped += 1
      return
    }
    this.pending.push({ day: utcDay(now.getTime()), line, bytes })
    this.pendingBytes += bytes
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, SERVER_METRICS_FLUSH_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.chain = this.chain.then(() => this.drain()).catch(() => {})
    return this.chain
  }

  private async drain(): Promise<void> {
    const batch = this.pending
    this.pending = []
    this.pendingBytes = 0
    if (this.dropped > 0) {
      const now = new Date()
      const line = `${JSON.stringify({
        v: 1,
        kind: 'counter',
        ts: now.toISOString(),
        name: 'metrics.dropped',
        value: this.dropped,
      } satisfies ServerCounterMetricRecord)}\n`
      batch.push({ day: utcDay(now.getTime()), line, bytes: Buffer.byteLength(line, 'utf8') })
      this.dropped = 0
    }
    if (batch.length === 0) return

    const byDay = new Map<string, PendingMetricLine[]>()
    for (const entry of batch) {
      const lines = byDay.get(entry.day)
      if (lines) lines.push(entry)
      else byDay.set(entry.day, [entry])
    }
    try {
      if (!this.dirReady) {
        await mkdir(this.metricsDir, { recursive: true })
        this.dirReady = true
      }
      const today = utcDay(Date.now())
      if (this.prunedDay !== today) {
        this.prunedDay = today
        await pruneServerMetricFiles(this.metricsDir, Date.now())
      }
    } catch {
      this.dropped += batch.length
      return
    }
    for (const [day, lines] of byDay) {
      await this.appendDay(day, lines)
    }
  }

  private async appendDay(day: string, lines: PendingMetricLine[]): Promise<void> {
    const file = join(this.metricsDir, `server-${day}.ndjson`)
    let size = this.daySizes.get(day)
    if (size === undefined) {
      size = await stat(file).then(
        (stats) => stats.size,
        () => 0
      )
    }
    let chunk = ''
    let chunkBytes = 0
    let capped = 0
    for (const entry of lines) {
      if (size + chunkBytes + entry.bytes > SERVER_METRICS_MAX_FILE_BYTES) {
        capped += 1
        continue
      }
      chunk += entry.line
      chunkBytes += entry.bytes
    }
    if (capped > 0 && this.capWarnedDay !== day) {
      // The capped file cannot hold its own drop counter; the log carries it.
      this.capWarnedDay = day
      writeServerLog('WARN', 'server.metrics.day_cap_reached', {
        file,
        maxBytes: SERVER_METRICS_MAX_FILE_BYTES,
      })
    }
    if (chunkBytes === 0) {
      this.daySizes.set(day, size)
      return
    }
    try {
      await appendFile(file, chunk, { encoding: 'utf8', flag: 'a' })
      this.daySizes.set(day, size + chunkBytes)
    } catch {
      // Unknown on-disk size after a failed append: re-stat next time.
      this.daySizes.delete(day)
      this.dirReady = false
      this.dropped += lines.length - capped
    }
  }
}

const writers = new Map<string, ServerMetricsWriter>()

/** Queue one metric record. Never touches the filesystem on the caller's stack. */
export function writeServerMetric(record: ServerMetricRecord, now: Date, stateRoot: string): void {
  try {
    let writer = writers.get(stateRoot)
    if (!writer) {
      writer = new ServerMetricsWriter(stateRoot)
      writers.set(stateRoot, writer)
    }
    writer.enqueue(record, now)
  } catch {
    // Metrics are observational; failures must never affect responses.
  }
}

/** Write every queued record (for `stateRoot`, or all roots). Never rejects. */
export async function flushServerMetrics(stateRoot?: string): Promise<void> {
  if (stateRoot !== undefined) {
    await writers.get(stateRoot)?.flush()
    return
  }
  await Promise.all([...writers.values()].map((writer) => writer.flush()))
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
