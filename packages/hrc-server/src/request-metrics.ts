import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { resolveStateRoot } from 'hrc-core'

import { exactRouteKey, matchLaunchSubroute } from './server-routing.js'

const METRICS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const SERVER_METRICS_FILE_PATTERN = /^server-\d{4}-\d{2}-\d{2}\.ndjson$/

export type ServerMetricRecord = {
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

export function writeServerMetric(
  record: ServerMetricRecord,
  now = new Date(),
  stateRoot = resolveStateRoot()
): void {
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
