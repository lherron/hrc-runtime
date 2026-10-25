/**
 * The receiving daemon's ingest listener: applies an admitted batch to the store
 * item by item, maps the outcome onto the ack contract, and serves it over the
 * runtime's unix socket plus an opt-in loopback TCP port.
 */

import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  HrcBrokerInvocationEventRecord,
  HrcEventIngestAck,
  HrcEventIngestBatch,
  HrcLifecycleEvent,
  HrcToolResultBlobPart,
} from 'hrc-core'
import {
  BrokerInvocationEventConflictError,
  ImportedHrcLifecycleEventConflictError,
} from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { withRequestObservation } from '../request-metrics.js'
import type { RequestMetricsSink } from '../request-metrics.js'
import { writeServerLog } from '../server-log.js'
import { IngestBatchValidationError, readBoundedBody, validateBatch } from './frame-admission.js'
import {
  EVENT_INGEST_ROUTE_KEYS,
  HRC_EVENT_INGEST_TCP_HOST,
  isTcpPort,
  itemOriginSeq,
} from './protocol.js'

const serveIngest = Bun.serve
const MAX_ACTIVE_REQUESTS = 64

type IngestCounters = {
  accepted: number
  duplicates: number
  divergentDuplicates: number
  rejected: number
}

type IngestFanOut = {
  onLifecycleEvent?: (event: HrcLifecycleEvent) => void
  onBrokerEvent?: (event: HrcBrokerInvocationEventRecord) => void
}

export type EventIngestListener = {
  socketPath: string
  tcpUrl?: string
  counters: IngestCounters
  stop(): Promise<void>
}

function jsonResponse(body: HrcEventIngestAck, status: number): Response {
  return Response.json(body, { status })
}

function applyItem(
  db: HrcDatabase,
  fanOut: IngestFanOut,
  batch: HrcEventIngestBatch,
  rawItem: unknown
): 'inserted' | 'duplicate' {
  if (batch.feed === 'tool_result_blobs') {
    const result = db.toolResultBlobs.ingestPart(rawItem as HrcToolResultBlobPart)
    return result.duplicate ? 'duplicate' : 'inserted'
  }
  if (batch.feed === 'hrc_events') {
    const item = rawItem as { originSeq: number; event: HrcLifecycleEvent }
    const result = db.hrcEvents.appendImported({
      sourceRef: batch.sourceRef,
      originSeq: item.originSeq,
      event: item.event,
    })
    if (result.idempotent) return 'duplicate'
    fanOut.onLifecycleEvent?.(result.event)
    return 'inserted'
  }
  const item = rawItem as { originSeq: number; event: HrcBrokerInvocationEventRecord }
  const result = db.brokerInvocationEvents.appendImported({
    sourceRef: batch.sourceRef,
    originSeq: item.originSeq,
    event: item.event,
  })
  if (result.idempotent) return 'duplicate'
  // T-08566 receiver fence: retained broker history is persisted but
  // never reaches broker actuators (mail landing observation).
  if (result.record.evidenceOrigin === undefined) fanOut.onBrokerEvent?.(result.record)
  return 'inserted'
}

async function ingestBatch(
  request: Request,
  options: IngestFanOut & { db: HrcDatabase; counters: IngestCounters }
): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/ingest') {
    return new Response('not found', { status: 404 })
  }
  let batch: HrcEventIngestBatch
  try {
    batch = validateBatch(JSON.parse(await readBoundedBody(request)))
  } catch (error) {
    options.counters.rejected += 1
    return jsonResponse(
      {
        ok: false,
        code: 'invalid_batch',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof IngestBatchValidationError && error.rejectedOriginSeq !== undefined
          ? { rejectedOriginSeq: error.rejectedOriginSeq }
          : {}),
      },
      400
    )
  }

  let inserted = 0
  let duplicates = 0
  for (const rawItem of batch.events) {
    try {
      if (applyItem(options.db, options, batch, rawItem) === 'duplicate') duplicates += 1
      else inserted += 1
    } catch (error) {
      const rejectedOriginSeq = itemOriginSeq(batch.feed, rawItem)
      if (
        error instanceof ImportedHrcLifecycleEventConflictError ||
        error instanceof BrokerInvocationEventConflictError
      ) {
        options.counters.divergentDuplicates += 1
        return jsonResponse(
          {
            ok: false,
            feed: batch.feed,
            code: 'divergent_duplicate',
            message: error.message,
            rejectedOriginSeq,
          },
          409
        )
      }
      options.counters.rejected += 1
      return jsonResponse(
        {
          ok: false,
          feed: batch.feed,
          code: 'ingest_error',
          message: error instanceof Error ? error.message : String(error),
          rejectedOriginSeq,
        },
        500
      )
    }
  }
  options.counters.accepted += inserted
  options.counters.duplicates += duplicates
  const last = batch.events.at(-1)
  const ackedThrough =
    batch.feed === 'tool_result_blobs'
      ? (last as HrcToolResultBlobPart | undefined)?.part
      : itemOriginSeq(batch.feed, last)
  if (ackedThrough === undefined) throw new Error('validated ingest batch was empty')
  return jsonResponse({ ok: true, feed: batch.feed, ackedThrough, inserted, duplicates }, 200)
}

function createIngestHandler(
  options: IngestFanOut & { db: HrcDatabase; counters: IngestCounters }
): (request: Request) => Response | Promise<Response> {
  let activeRequests = 0
  return (request: Request) => {
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      options.counters.rejected += 1
      return jsonResponse(
        { ok: false, code: 'ingest_busy', message: 'ingest concurrency limit reached' },
        503
      )
    }
    activeRequests += 1
    return ingestBatch(request, options).finally(() => {
      activeRequests -= 1
    })
  }
}

export async function startEventIngestListener(
  options: IngestFanOut & {
    db: HrcDatabase
    runtimeRoot: string
    socketPath?: string
    tcpPort?: number
    metrics?: RequestMetricsSink | undefined
  }
): Promise<EventIngestListener> {
  const socketPath = options.socketPath ?? join(options.runtimeRoot, 'ingest', 'events.sock')
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  await rm(socketPath, { force: true })
  const counters: IngestCounters = {
    accepted: 0,
    duplicates: 0,
    divergentDuplicates: 0,
    rejected: 0,
  }
  const fetch = withRequestObservation(createIngestHandler({ ...options, counters }), {
    listener: 'ingest',
    routeKeys: EVENT_INGEST_ROUTE_KEYS,
    sink: options.metrics,
  })
  const unixServer = serveIngest({
    unix: socketPath,
    idleTimeout: 30,
    fetch,
  } as unknown as Parameters<typeof Bun.serve>[0])
  let tcpServer: ReturnType<typeof Bun.serve> | undefined
  let tcpUrl: string | undefined
  try {
    if (options.tcpPort !== undefined) {
      if (!isTcpPort(options.tcpPort)) {
        throw new Error('event ingest TCP port must be an integer from 1 to 65535')
      }
      tcpServer = serveIngest({
        hostname: HRC_EVENT_INGEST_TCP_HOST,
        port: options.tcpPort,
        idleTimeout: 30,
        fetch,
      } as unknown as Parameters<typeof Bun.serve>[0])
      tcpUrl = `http://${HRC_EVENT_INGEST_TCP_HOST}:${options.tcpPort}`
    }
  } catch (error) {
    unixServer.stop(true)
    await rm(socketPath, { force: true })
    throw error
  }
  writeServerLog('INFO', 'server.start.event_ingest_listener', { socketPath, tcpUrl })
  return {
    socketPath,
    ...(tcpUrl ? { tcpUrl } : {}),
    counters,
    async stop() {
      tcpServer?.stop(true)
      unixServer.stop(true)
      await rm(socketPath, { force: true })
    },
  }
}
