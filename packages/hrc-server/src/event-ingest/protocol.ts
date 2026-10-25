/**
 * The observational ingest wire contract both daemons agree on (T-06838): frame
 * and batch limits, the one route, and how an operator declares the listener
 * port and the forward target.
 */

import type { HrcEventIngestBatch } from 'hrc-core'

export const HRC_INGEST_MAX_BODY_BYTES = 1_048_576
export const HRC_INGEST_MAX_BATCH_EVENTS = 100
/** One addressed tool-result blob part carries at most this many UTF-8 bytes. */
export const HRC_INGEST_MAX_BLOB_CHUNK_BYTES = 256 * 1024
export const HRC_EVENT_FORWARD_SOURCE_REF_ENV = 'HRC_EVENT_FORWARD_SOURCE_REF'
export const HRC_EVENT_INGEST_SOCKET_ENV = 'HRC_EVENT_INGEST_SOCKET'
export const HRC_EVENT_FORWARD_URL_ENV = 'HRC_EVENT_FORWARD_URL'
export const HRC_EVENT_INGEST_TCP_PORT_ENV = 'HRC_EVENT_INGEST_TCP_PORT'
export const HRC_EVENT_INGEST_TCP_HOST = '127.0.0.1'
/** The ingest listener's whole route table, for request metrics (T-11541). */
export const EVENT_INGEST_ROUTE_KEYS: ReadonlySet<string> = new Set(['POST /v1/ingest'])

export type IngestFeed = HrcEventIngestBatch['feed']

export type EventForwardTarget = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; url: string }

/** The origin sequence an item is acked and refused by; blob parts carry none. */
export function itemOriginSeq(feed: IngestFeed, item: unknown): number | undefined {
  return feed === 'tool_result_blobs'
    ? undefined
    : (item as { originSeq: number } | undefined)?.originSeq
}

export function isTcpPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
}

export function resolveEventIngestTcpPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const port = Number(value)
  if (!/^[0-9]+$/.test(value) || !isTcpPort(port)) {
    throw new Error(`${HRC_EVENT_INGEST_TCP_PORT_ENV} must be an integer from 1 to 65535`)
  }
  return port
}

export function resolveEventForwardTarget(options: {
  socketPath?: string | undefined
  tcpUrl?: string | undefined
}): EventForwardTarget {
  const socketPath = options.socketPath?.trim()
  const tcpUrl = options.tcpUrl?.trim()
  if (Boolean(socketPath) === Boolean(tcpUrl)) {
    throw new Error(
      `forwarder mode requires exactly one of ${HRC_EVENT_INGEST_SOCKET_ENV} or ${HRC_EVENT_FORWARD_URL_ENV}`
    )
  }
  if (socketPath) return { kind: 'unix', socketPath }
  if (!tcpUrl) throw new Error('forwarder target declaration is missing')

  let parsed: URL
  try {
    parsed = new URL(tcpUrl)
  } catch {
    throw new Error(`${HRC_EVENT_FORWARD_URL_ENV} must be an HTTP origin with an explicit port`)
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port === '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`${HRC_EVENT_FORWARD_URL_ENV} must be an HTTP origin with an explicit port`)
  }
  return { kind: 'tcp', url: parsed.origin }
}
