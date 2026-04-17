/**
 * OTLP/HTTP JSON log ingest for HRC.
 *
 * Per CODEX_OTEL_HRC_SPEC.md §2, §6-§10. Listens on 127.0.0.1:<port>, accepts
 * OTLP/HTTP JSON at POST /v1/logs, validates per-launch auth against the
 * persisted launch artifact, normalizes OTLP log records, and appends one
 * HRC event per LogRecord with source='otel'.
 */

import { timingSafeEqual } from 'node:crypto'

import type { HrcLaunchArtifact, HrcLaunchRecord } from 'hrc-core'

export const OTLP_DEFAULT_PREFERRED_PORT = 4318
export const OTLP_LOGS_PATH = '/v1/logs'
export const OTEL_AUTH_HEADER = 'x-hrc-launch-auth'
/** Grace window (ms) after launch.exitedAt during which OTEL requests still authenticate. */
export const OTEL_POST_EXIT_GRACE_MS = 30_000

export type OtlpListenerEndpoint = {
  host: string
  port: number
  path: string
  url: string
}

export type OtlpListenerControl = {
  endpoint: OtlpListenerEndpoint
  stop(): void
}

/**
 * Start a Bun HTTP server on 127.0.0.1. Tries the preferred port first; on
 * EADDRINUSE falls back to an OS-chosen ephemeral port.
 */
export function startOtlpListener(
  preferredPort: number | undefined,
  handle: (request: Request) => Response | Promise<Response>
): OtlpListenerControl {
  const host = '127.0.0.1'
  const tryPorts: number[] = []
  if (typeof preferredPort === 'number' && Number.isFinite(preferredPort) && preferredPort > 0) {
    tryPorts.push(preferredPort)
  }
  tryPorts.push(0)

  let lastError: unknown
  for (const port of tryPorts) {
    try {
      const server = Bun.serve({
        hostname: host,
        port,
        fetch: handle,
      })
      const boundPort = server.port
      if (boundPort === undefined) {
        throw new Error('OTLP listener did not report a bound port')
      }
      return {
        endpoint: {
          host,
          port: boundPort,
          path: OTLP_LOGS_PATH,
          url: `http://${host}:${boundPort}${OTLP_LOGS_PATH}`,
        },
        stop: () => {
          server.stop(true)
        },
      }
    } catch (error) {
      lastError = error
      // fall through and try the next candidate port
    }
  }
  throw new Error(
    `failed to bind OTLP listener on 127.0.0.1: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

// -----------------------------------------------------------------------------
// OTLP JSON normalization
// -----------------------------------------------------------------------------

export type NormalizedOtelLogRecord = {
  resource?: { attributes?: Record<string, unknown> } | undefined
  scope?: { name?: string; version?: string; attributes?: Record<string, unknown> } | undefined
  logRecord: {
    timeUnixNano?: string | undefined
    observedTimeUnixNano?: string | undefined
    severityNumber?: number | undefined
    severityText?: string | undefined
    body?: unknown
    attributes?: Record<string, unknown> | undefined
    droppedAttributesCount?: number | undefined
    flags?: number | undefined
    traceId?: string | undefined
    spanId?: string | undefined
  }
}

export type NormalizeResult = {
  records: NormalizedOtelLogRecord[]
  rejected: number
  errorMessage?: string | undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function decodeAnyValue(v: unknown): unknown {
  if (!isObject(v)) return null
  if ('stringValue' in v) return typeof v['stringValue'] === 'string' ? v['stringValue'] : null
  if ('boolValue' in v) return typeof v['boolValue'] === 'boolean' ? v['boolValue'] : null
  if ('intValue' in v) {
    const raw = v['intValue']
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string') {
      // OTLP JSON permits int64 as decimal string. Preserve as number when safe, else keep string.
      const n = Number(raw)
      return Number.isSafeInteger(n) ? n : raw
    }
    return null
  }
  if ('doubleValue' in v) return typeof v['doubleValue'] === 'number' ? v['doubleValue'] : null
  if ('bytesValue' in v) {
    // Keep base64 string as-is per spec §7.
    return typeof v['bytesValue'] === 'string' ? v['bytesValue'] : null
  }
  if ('arrayValue' in v) {
    const arr = v['arrayValue']
    if (isObject(arr) && Array.isArray(arr['values'])) {
      return arr['values'].map((item) => decodeAnyValue(item))
    }
    return []
  }
  if ('kvlistValue' in v) {
    return decodeKeyValueList(v['kvlistValue'])
  }
  return null
}

function decodeKeyValueList(v: unknown): Record<string, unknown> {
  if (!isObject(v)) return {}
  const values = v['values']
  if (!Array.isArray(values)) return {}
  const out: Record<string, unknown> = {}
  for (const kv of values) {
    if (!isObject(kv)) continue
    const key = kv['key']
    if (typeof key !== 'string') continue
    out[key] = decodeAnyValue(kv['value'])
  }
  return out
}

function decodeAttributes(attrs: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(attrs)) return undefined
  const out: Record<string, unknown> = {}
  for (const attr of attrs) {
    if (!isObject(attr)) continue
    const key = attr['key']
    if (typeof key !== 'string') continue
    out[key] = decodeAnyValue(attr['value'])
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function decodeResource(v: unknown): NormalizedOtelLogRecord['resource'] {
  if (!isObject(v)) return undefined
  const attributes = decodeAttributes(v['attributes'])
  return attributes ? { attributes } : undefined
}

function decodeScope(v: unknown): NormalizedOtelLogRecord['scope'] {
  if (!isObject(v)) return undefined
  const name = typeof v['name'] === 'string' ? v['name'] : undefined
  const version = typeof v['version'] === 'string' ? v['version'] : undefined
  const attributes = decodeAttributes(v['attributes'])
  if (!name && !version && !attributes) return undefined
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(attributes ? { attributes } : {}),
  }
}

function decodeLogRecord(v: unknown): NormalizedOtelLogRecord['logRecord'] | null {
  if (!isObject(v)) return null
  const out: NormalizedOtelLogRecord['logRecord'] = {}
  if (typeof v['timeUnixNano'] === 'string') out.timeUnixNano = v['timeUnixNano']
  else if (typeof v['timeUnixNano'] === 'number') out.timeUnixNano = String(v['timeUnixNano'])
  if (typeof v['observedTimeUnixNano'] === 'string')
    out.observedTimeUnixNano = v['observedTimeUnixNano']
  else if (typeof v['observedTimeUnixNano'] === 'number')
    out.observedTimeUnixNano = String(v['observedTimeUnixNano'])
  if (typeof v['severityNumber'] === 'number') out.severityNumber = v['severityNumber']
  if (typeof v['severityText'] === 'string') out.severityText = v['severityText']
  if ('body' in v) out.body = decodeAnyValue(v['body'])
  const attributes = decodeAttributes(v['attributes'])
  if (attributes) out.attributes = attributes
  if (typeof v['droppedAttributesCount'] === 'number')
    out.droppedAttributesCount = v['droppedAttributesCount']
  if (typeof v['flags'] === 'number') out.flags = v['flags']
  if (typeof v['traceId'] === 'string') out.traceId = v['traceId']
  if (typeof v['spanId'] === 'string') out.spanId = v['spanId']
  return out
}

/**
 * Normalize an OTLP/HTTP JSON ExportLogsServiceRequest into a flat list of
 * records. Invalid records contribute to `rejected` but do not abort the batch.
 * A completely malformed request body (not an object / missing resourceLogs)
 * returns records=[] with rejected=0; callers should 400 on that shape.
 */
export function normalizeOtlpJsonRequest(body: unknown): NormalizeResult {
  if (!isObject(body)) {
    return { records: [], rejected: 0, errorMessage: 'body is not a JSON object' }
  }
  const resourceLogs = body['resourceLogs']
  if (!Array.isArray(resourceLogs)) {
    return { records: [], rejected: 0, errorMessage: 'missing resourceLogs array' }
  }

  const records: NormalizedOtelLogRecord[] = []
  let rejected = 0
  const errorMessages: string[] = []

  for (const rl of resourceLogs) {
    if (!isObject(rl)) {
      rejected += 1
      errorMessages.push('resourceLogs entry is not an object')
      continue
    }
    const resource = decodeResource(rl['resource'])
    const scopeLogs = rl['scopeLogs']
    if (!Array.isArray(scopeLogs)) {
      rejected += 1
      errorMessages.push('resourceLogs entry missing scopeLogs array')
      continue
    }
    for (const sl of scopeLogs) {
      if (!isObject(sl)) {
        rejected += 1
        errorMessages.push('scopeLogs entry is not an object')
        continue
      }
      const scope = decodeScope(sl['scope'])
      const logRecords = sl['logRecords']
      if (!Array.isArray(logRecords)) {
        rejected += 1
        errorMessages.push('scopeLogs entry missing logRecords array')
        continue
      }
      for (const lr of logRecords) {
        const decoded = decodeLogRecord(lr)
        if (!decoded) {
          rejected += 1
          errorMessages.push('logRecord is not an object')
          continue
        }
        records.push({
          ...(resource ? { resource } : {}),
          ...(scope ? { scope } : {}),
          logRecord: decoded,
        })
      }
    }
  }

  return rejected > 0
    ? { records, rejected, errorMessage: errorMessages.slice(0, 5).join('; ') }
    : { records, rejected: 0 }
}

// -----------------------------------------------------------------------------
// Auth validation
// -----------------------------------------------------------------------------

export type OtlpLaunchContext = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  artifact: HrcLaunchArtifact
}

export class OtelAuthError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a constant-time compare on fixed-length buffers so timing doesn't
    // reveal whether mismatch is due to length vs. content.
    const filler = Buffer.alloc(Math.max(a.length, b.length, 1))
    const bufA = Buffer.from(a.padEnd(filler.length, '\0'))
    const bufB = Buffer.from(b.padEnd(filler.length, '\0'))
    timingSafeEqual(bufA, bufB)
    return false
  }
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return timingSafeEqual(bufA, bufB)
}

export function parseOtelAuthHeader(header: string | null): {
  launchId: string
  secret: string
} | null {
  if (!header) return null
  const idx = header.indexOf('.')
  if (idx <= 0 || idx >= header.length - 1) return null
  return {
    launchId: header.slice(0, idx),
    secret: header.slice(idx + 1),
  }
}

/**
 * Validate `x-hrc-launch-auth` against persisted launch + artifact. Enforces
 * a 30-second grace window after launch.exitedAt to tolerate Codex's async
 * exporter flush on shutdown.
 */
export async function validateOtelLaunchAuth(params: {
  authHeader: string | null
  getLaunch: (launchId: string) => HrcLaunchRecord | null
  readArtifact: (path: string) => Promise<HrcLaunchArtifact>
  now?: Date
}): Promise<OtlpLaunchContext> {
  const parsed = parseOtelAuthHeader(params.authHeader)
  if (!parsed) {
    throw new OtelAuthError(401, 'missing or malformed x-hrc-launch-auth header')
  }

  const launch = params.getLaunch(parsed.launchId)
  if (!launch) {
    throw new OtelAuthError(403, 'launch not found')
  }

  if (launch.exitedAt) {
    const exitedMs = Date.parse(launch.exitedAt)
    const nowMs = (params.now ?? new Date()).getTime()
    if (Number.isFinite(exitedMs) && nowMs - exitedMs > OTEL_POST_EXIT_GRACE_MS) {
      throw new OtelAuthError(403, 'launch exited beyond OTEL grace window')
    }
  }

  let artifact: HrcLaunchArtifact
  try {
    artifact = await params.readArtifact(launch.launchArtifactPath)
  } catch {
    throw new OtelAuthError(403, 'launch artifact unavailable')
  }

  if (!artifact.otel || artifact.otel.transport !== 'otlp-http-json') {
    throw new OtelAuthError(403, 'launch does not have OTEL ingest enabled')
  }

  if (!constantTimeEqual(parsed.secret, artifact.otel.secret)) {
    throw new OtelAuthError(403, 'invalid launch secret')
  }

  return {
    launchId: launch.launchId,
    hostSessionId: launch.hostSessionId,
    generation: launch.generation,
    ...(launch.runtimeId !== undefined ? { runtimeId: launch.runtimeId } : {}),
    ...(artifact.runId !== undefined ? { runId: artifact.runId } : {}),
    artifact,
  }
}

// -----------------------------------------------------------------------------
// LogRecord -> HRC event mapping
// -----------------------------------------------------------------------------

export type HrcEventFromOtel = {
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  source: 'otel'
  eventKind: string
  eventJson: unknown
}

/**
 * Extract event.name from attributes or body with the fallback chain from
 * spec §8.2.
 */
export function extractEventKind(record: NormalizedOtelLogRecord): string {
  const attrs = record.logRecord.attributes
  if (attrs) {
    if (typeof attrs['event.name'] === 'string') return attrs['event.name']
    if (typeof attrs['event_name'] === 'string') return attrs['event_name']
  }
  const body = record.logRecord.body
  if (isObject(body)) {
    if (typeof body['eventName'] === 'string') return body['eventName']
    if (typeof body['event_name'] === 'string') return body['event_name']
  }
  return 'otel.log'
}

function nanoStringToIso(raw: string | undefined): string | null {
  if (!raw) return null
  let bi: bigint
  try {
    bi = BigInt(raw)
  } catch {
    return null
  }
  // Codex sometimes emits timeUnixNano: "0" for synthetic log records. Treat
  // zero (epoch) as "missing" and let the caller fall back.
  if (bi <= 0n) return null
  const ms = Number(bi / 1_000_000n)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function pickTimestamp(record: NormalizedOtelLogRecord, fallback: string): string {
  const lr = record.logRecord
  return nanoStringToIso(lr.timeUnixNano) ?? nanoStringToIso(lr.observedTimeUnixNano) ?? fallback
}

/**
 * Build scope/lane/runtime correlation fields + eventJson. Requires session
 * info (scopeRef, laneRef) because launch records don't carry it directly;
 * caller supplies those from a fresh session lookup.
 */
export function buildHrcEventFromOtelRecord(params: {
  record: NormalizedOtelLogRecord
  launchCtx: OtlpLaunchContext
  scopeRef: string
  laneRef: string
  fallbackTimestamp: string
}): HrcEventFromOtel {
  const { record, launchCtx, scopeRef, laneRef, fallbackTimestamp } = params
  const ts = pickTimestamp(record, fallbackTimestamp)
  const eventKind = extractEventKind(record)

  const attrs = record.logRecord.attributes ?? {}
  const codexBlock: Record<string, unknown> = { eventName: eventKind }
  if (typeof attrs['conversation.id'] === 'string')
    codexBlock['conversationId'] = attrs['conversation.id']
  if (typeof attrs['model'] === 'string') codexBlock['model'] = attrs['model']
  if (typeof attrs['app.version'] === 'string') codexBlock['appVersion'] = attrs['app.version']
  if (typeof attrs['environment'] === 'string') codexBlock['environment'] = attrs['environment']

  const eventJson = {
    otel: {
      ...(record.resource ? { resource: record.resource } : {}),
      ...(record.scope ? { scope: record.scope } : {}),
      logRecord: record.logRecord,
    },
    codex: codexBlock,
    hrc: {
      launchId: launchCtx.launchId,
      hostSessionId: launchCtx.hostSessionId,
      ...(launchCtx.runtimeId ? { runtimeId: launchCtx.runtimeId } : {}),
      ...(launchCtx.runId ? { runId: launchCtx.runId } : {}),
    },
  }

  return {
    ts,
    hostSessionId: launchCtx.hostSessionId,
    scopeRef,
    laneRef,
    generation: launchCtx.generation,
    ...(launchCtx.runtimeId ? { runtimeId: launchCtx.runtimeId } : {}),
    ...(launchCtx.runId ? { runId: launchCtx.runId } : {}),
    source: 'otel' as const,
    eventKind,
    eventJson,
  }
}
