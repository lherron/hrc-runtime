import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  HrcBrokerInvocationEventRecord,
  HrcEventIngestAck,
  HrcEventIngestBatch,
  HrcLifecycleEvent,
  HrcToolResultBlobPart,
} from 'hrc-core'
import { resolveIngestSocketPath } from 'hrc-core'
import {
  BrokerInvocationEventConflictError,
  ImportedHrcLifecycleEventConflictError,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from './server-log.js'

export const HRC_INGEST_MAX_BODY_BYTES = 1_048_576
export const HRC_INGEST_MAX_BATCH_EVENTS = 100
export const HRC_EVENT_FORWARD_SOURCE_REF_ENV = 'HRC_EVENT_FORWARD_SOURCE_REF'
export const HRC_EVENT_INGEST_SOCKET_ENV = 'HRC_EVENT_INGEST_SOCKET'
export const HRC_EVENT_FORWARD_URL_ENV = 'HRC_EVENT_FORWARD_URL'
export const HRC_EVENT_INGEST_TCP_PORT_ENV = 'HRC_EVENT_INGEST_TCP_PORT'
export const HRC_EVENT_INGEST_TCP_HOST = '127.0.0.1'
const CURSOR_FILE = 'event-forward-cursors.json'
const EVENT_FORWARD_MAX_RETRY_MS = 60_000
const serveIngest = Bun.serve

type IngestCounters = {
  accepted: number
  duplicates: number
  divergentDuplicates: number
  rejected: number
}

export type EventIngestListener = {
  socketPath: string
  tcpUrl?: string
  counters: IngestCounters
  stop(): Promise<void>
}

export type EventForwardTarget = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; url: string }

export type EventForwarder = {
  sourceRef: string
  target: EventForwardTarget
  cursorPath: string
  stop(): Promise<void>
}

type ForwardCursors = {
  version: 1
  toolResultBlobs: number
  hrcEvents: number
  brokerInvocationEvents: number
  deadLetters: ForwardDeadLetter[]
}

type ForwardFeed = HrcEventIngestBatch['feed']
type ForwardCursorKey = 'toolResultBlobs' | 'hrcEvents' | 'brokerInvocationEvents'
type ForwardDeadLetterCode = 'invalid_batch' | 'divergent_duplicate' | 'oversized_event'

type ForwardDeadLetter = {
  sourceRef: string
  feed: ForwardFeed
  cursor: number
  code: ForwardDeadLetterCode
  message: string
  deadLetteredAt: string
}

function initialCursors(): ForwardCursors {
  return {
    version: 1,
    toolResultBlobs: 0,
    hrcEvents: 0,
    brokerInvocationEvents: 0,
    deadLetters: [],
  }
}

class OversizedForwardEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OversizedForwardEventError'
  }
}

function jsonResponse(body: HrcEventIngestAck, status: number): Response {
  return Response.json(body, { status })
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > HRC_INGEST_MAX_BODY_BYTES) throw new Error('ingest frame exceeds byte limit')
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > HRC_INGEST_MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('ingest frame exceeds byte limit')
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function validateBatch(value: unknown): HrcEventIngestBatch {
  if (!value || typeof value !== 'object') throw new Error('batch must be an object')
  const batch = value as Partial<HrcEventIngestBatch>
  if (batch.version !== 1) throw new Error('unsupported ingest version')
  if (typeof batch.sourceRef !== 'string' || batch.sourceRef.trim().length === 0) {
    throw new Error('sourceRef must be non-empty')
  }
  if (
    batch.feed !== 'tool_result_blobs' &&
    batch.feed !== 'hrc_events' &&
    batch.feed !== 'broker_invocation_events'
  ) {
    throw new Error('unknown ingest feed')
  }
  if (!Array.isArray(batch.events) || batch.events.length < 1) {
    throw new Error('events must be a non-empty array')
  }
  if (batch.events.length > HRC_INGEST_MAX_BATCH_EVENTS) {
    throw new Error('ingest batch exceeds event limit')
  }
  if (batch.feed === 'tool_result_blobs') {
    for (const item of batch.events) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.blobId !== 'string' ||
        item.blobId.length === 0 ||
        typeof item.runtimeId !== 'string' ||
        item.runtimeId.length === 0 ||
        (item.kind !== 'broker_raw' && item.kind !== 'lifecycle_canonical') ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        !Number.isSafeInteger(item.part) ||
        item.part < 0 ||
        !Number.isSafeInteger(item.parts) ||
        item.parts < 1 ||
        item.part >= item.parts ||
        typeof item.chunk !== 'string' ||
        Buffer.byteLength(item.chunk, 'utf8') > 256 * 1024
      ) {
        throw new Error(
          'each blob event requires valid addressed part metadata and a <=256 KiB chunk'
        )
      }
    }
    return batch as HrcEventIngestBatch
  }
  let prior = 0
  for (const item of batch.events as Array<{ originSeq: number; event: unknown }>) {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isSafeInteger(item.originSeq) ||
      item.originSeq < 1 ||
      !item.event ||
      typeof item.event !== 'object'
    ) {
      throw new Error('each event requires a positive originSeq and event object')
    }
    if (item.originSeq <= prior) throw new Error('originSeq values must be strictly increasing')
    prior = item.originSeq
    const event = item.event as HrcLifecycleEvent | HrcBrokerInvocationEventRecord
    if (event.sourceRef !== undefined || event.originSeq !== undefined) {
      throw new Error('forwarding an already-imported event is not allowed')
    }
  }
  return batch as HrcEventIngestBatch
}

export function resolveEventIngestTcpPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${HRC_EVENT_INGEST_TCP_PORT_ENV} must be an integer from 1 to 65535`)
  }
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
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

function createIngestHandler(options: {
  db: HrcDatabase
  counters: IngestCounters
  onLifecycleEvent?: (event: HrcLifecycleEvent) => void
  onBrokerEvent?: (event: HrcBrokerInvocationEventRecord) => void
}): (request: Request) => Response | Promise<Response> {
  let activeRequests = 0
  return (request: Request) => {
    if (activeRequests >= 64) {
      options.counters.rejected += 1
      return jsonResponse(
        { ok: false, code: 'ingest_busy', message: 'ingest concurrency limit reached' },
        503
      )
    }
    activeRequests += 1
    return (async () => {
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
          },
          400
        )
      }

      let inserted = 0
      let duplicates = 0
      for (const rawItem of batch.events) {
        try {
          if (batch.feed === 'tool_result_blobs') {
            const item = rawItem as HrcToolResultBlobPart
            const result = options.db.toolResultBlobs.ingestPart(item)
            if (result.duplicate) duplicates += 1
            else inserted += 1
          } else if (batch.feed === 'hrc_events') {
            const item = rawItem as { originSeq: number; event: HrcLifecycleEvent }
            const result = options.db.hrcEvents.appendImported({
              sourceRef: batch.sourceRef,
              originSeq: item.originSeq,
              event: item.event as HrcLifecycleEvent,
            })
            if (result.idempotent) duplicates += 1
            else {
              inserted += 1
              options.onLifecycleEvent?.(result.event)
            }
          } else {
            const item = rawItem as {
              originSeq: number
              event: HrcBrokerInvocationEventRecord
            }
            const result = options.db.brokerInvocationEvents.appendImported({
              sourceRef: batch.sourceRef,
              originSeq: item.originSeq,
              event: item.event as HrcBrokerInvocationEventRecord,
            })
            if (result.idempotent) duplicates += 1
            else {
              inserted += 1
              options.onBrokerEvent?.(result.record)
            }
          }
        } catch (error) {
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
                rejectedOriginSeq:
                  batch.feed === 'tool_result_blobs'
                    ? undefined
                    : (rawItem as { originSeq: number }).originSeq,
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
              rejectedOriginSeq:
                batch.feed === 'tool_result_blobs'
                  ? undefined
                  : (rawItem as { originSeq: number }).originSeq,
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
          : (last as { originSeq: number } | undefined)?.originSeq
      if (ackedThrough === undefined) throw new Error('validated ingest batch was empty')
      return jsonResponse(
        {
          ok: true,
          feed: batch.feed,
          ackedThrough,
          inserted,
          duplicates,
        },
        200
      )
    })().finally(() => {
      activeRequests -= 1
    })
  }
}

export async function startEventIngestListener(options: {
  db: HrcDatabase
  runtimeRoot: string
  socketPath?: string
  tcpPort?: number
  onLifecycleEvent?: (event: HrcLifecycleEvent) => void
  onBrokerEvent?: (event: HrcBrokerInvocationEventRecord) => void
}): Promise<EventIngestListener> {
  const socketPath = options.socketPath ?? join(options.runtimeRoot, 'ingest', 'events.sock')
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  await rm(socketPath, { force: true })
  const counters: IngestCounters = {
    accepted: 0,
    duplicates: 0,
    divergentDuplicates: 0,
    rejected: 0,
  }
  const fetch = createIngestHandler({ ...options, counters })
  const unixServer = serveIngest({
    unix: socketPath,
    idleTimeout: 30,
    fetch,
  } as unknown as Parameters<typeof Bun.serve>[0])
  let tcpServer: ReturnType<typeof Bun.serve> | undefined
  let tcpUrl: string | undefined
  try {
    if (options.tcpPort !== undefined) {
      if (
        !Number.isSafeInteger(options.tcpPort) ||
        options.tcpPort < 1 ||
        options.tcpPort > 65_535
      ) {
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

async function readCursors(path: string): Promise<ForwardCursors> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ForwardCursors>
    if (
      parsed.version === 1 &&
      Number.isSafeInteger(parsed.hrcEvents) &&
      Number.isSafeInteger(parsed.brokerInvocationEvents)
    ) {
      return {
        version: 1,
        toolResultBlobs: Number.isSafeInteger(parsed.toolResultBlobs)
          ? (parsed.toolResultBlobs as number)
          : 0,
        hrcEvents: parsed.hrcEvents as number,
        brokerInvocationEvents: parsed.brokerInvocationEvents as number,
        deadLetters: Array.isArray(parsed.deadLetters) ? parsed.deadLetters : [],
      }
    }
  } catch {
    // Missing or invalid cursor state starts at the ledger beginning.
  }
  return initialCursors()
}

async function writeCursors(path: string, cursors: ForwardCursors): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(cursors)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function serializeBatch(batch: HrcEventIngestBatch): string {
  return JSON.stringify(batch)
}

function takeBatchPrefix(batch: HrcEventIngestBatch, eventCount: number): HrcEventIngestBatch {
  if (batch.feed === 'tool_result_blobs') {
    return { ...batch, events: batch.events.slice(0, eventCount) }
  }
  if (batch.feed === 'hrc_events') {
    return { ...batch, events: batch.events.slice(0, eventCount) }
  }
  return { ...batch, events: batch.events.slice(0, eventCount) }
}

function dropBatchPrefix(batch: HrcEventIngestBatch, eventCount: number): HrcEventIngestBatch {
  if (batch.feed === 'tool_result_blobs') {
    return { ...batch, events: batch.events.slice(eventCount) }
  }
  if (batch.feed === 'hrc_events') {
    return { ...batch, events: batch.events.slice(eventCount) }
  }
  return { ...batch, events: batch.events.slice(eventCount) }
}

function chunkUtf8(value: string, maximumBytes = 256 * 1024): string[] {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length === 0) return ['']
  const chunks: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + maximumBytes)
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
    if (end === start) throw new Error('failed to split UTF-8 tool-result blob')
    chunks.push(bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return chunks
}

function prepareBoundedBatch(batch: HrcEventIngestBatch): {
  batch: HrcEventIngestBatch
  body: string
} {
  const fullBody = serializeBatch(batch)
  if (Buffer.byteLength(fullBody) <= HRC_INGEST_MAX_BODY_BYTES) {
    return { batch, body: fullBody }
  }

  let lower = 1
  let upper = batch.events.length
  let best:
    | {
        batch: HrcEventIngestBatch
        body: string
      }
    | undefined
  while (lower <= upper) {
    const eventCount = Math.floor((lower + upper) / 2)
    const candidate = takeBatchPrefix(batch, eventCount)
    const body = serializeBatch(candidate)
    if (Buffer.byteLength(body) <= HRC_INGEST_MAX_BODY_BYTES) {
      best = { batch: candidate, body }
      lower = eventCount + 1
    } else {
      upper = eventCount - 1
    }
  }

  if (best === undefined) {
    const originSeq =
      batch.feed === 'tool_result_blobs'
        ? undefined
        : (batch.events[0] as { originSeq: number } | undefined)?.originSeq
    throw new OversizedForwardEventError(
      `ingest event${originSeq === undefined ? '' : ` at originSeq ${originSeq}`} exceeds byte limit and cannot be split`
    )
  }
  return best
}

async function postBatch(
  target: EventForwardTarget,
  batch: HrcEventIngestBatch
): Promise<{ ack: HrcEventIngestAck; eventCount: number }> {
  const prepared = prepareBoundedBatch(batch)
  const init: RequestInit & { unix?: string } = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: prepared.body,
  }
  const endpoint =
    target.kind === 'unix'
      ? 'http://hrc/v1/ingest'
      : new URL('/v1/ingest', `${target.url}/`).toString()
  if (target.kind === 'unix') init.unix = target.socketPath
  const response = await fetch(endpoint, init)
  return {
    ack: (await response.json()) as HrcEventIngestAck,
    eventCount: prepared.batch.events.length,
  }
}

function refusalMessage(ack: Extract<HrcEventIngestAck, { ok: false }>): string {
  return `${ack.code}: ${ack.message}`
}

function isPermanentRefusal(ack: HrcEventIngestAck): ack is Extract<
  HrcEventIngestAck,
  { ok: false }
> & {
  code: 'invalid_batch' | 'divergent_duplicate'
} {
  return !ack.ok && (ack.code === 'invalid_batch' || ack.code === 'divergent_duplicate')
}

async function deadLetterAndAdvance(options: {
  cursorPath: string
  cursors: ForwardCursors
  cursorKey: ForwardCursorKey
  sourceRef: string
  feed: ForwardFeed
  cursor: number
  code: ForwardDeadLetterCode
  message: string
}): Promise<void> {
  options.cursors[options.cursorKey] = Math.max(options.cursors[options.cursorKey], options.cursor)
  if (
    !options.cursors.deadLetters.some(
      (letter) => letter.feed === options.feed && letter.cursor === options.cursor
    )
  ) {
    options.cursors.deadLetters.push({
      sourceRef: options.sourceRef,
      feed: options.feed,
      cursor: options.cursor,
      code: options.code,
      message: options.message,
      deadLetteredAt: new Date().toISOString(),
    })
  }
  await writeCursors(options.cursorPath, options.cursors)
  writeServerLog('WARN', 'event_forwarder.dead_letter', {
    sourceRef: options.sourceRef,
    feed: options.feed,
    cursor: options.cursor,
    code: options.code,
    message: options.message,
  })
}

async function forwardSequencedBatch(options: {
  batch: Extract<HrcEventIngestBatch, { feed: 'hrc_events' | 'broker_invocation_events' }>
  target: EventForwardTarget
  cursorPath: string
  cursors: ForwardCursors
  cursorKey: 'hrcEvents' | 'brokerInvocationEvents'
}): Promise<{ forwarded: number; deadLettered: number }> {
  let forwarded = 0
  let deadLettered = 0

  const forward = async (
    batch: Extract<HrcEventIngestBatch, { feed: 'hrc_events' | 'broker_invocation_events' }>
  ): Promise<void> => {
    if (batch.events.length === 0) return

    let posted: { ack: HrcEventIngestAck; eventCount: number }
    try {
      posted = await postBatch(options.target, batch)
    } catch (error) {
      if (!(error instanceof OversizedForwardEventError)) throw error
      const first = batch.events[0]
      if (first === undefined) throw error
      await deadLetterAndAdvance({
        cursorPath: options.cursorPath,
        cursors: options.cursors,
        cursorKey: options.cursorKey,
        sourceRef: batch.sourceRef,
        feed: batch.feed,
        cursor: first.originSeq,
        code: 'oversized_event',
        message: error.message,
      })
      deadLettered += 1
      await forward(dropBatchPrefix(batch, 1) as typeof batch)
      return
    }

    if (posted.ack.ok) {
      options.cursors[options.cursorKey] = posted.ack.ackedThrough
      forwarded += posted.eventCount
      await writeCursors(options.cursorPath, options.cursors)
      await forward(dropBatchPrefix(batch, posted.eventCount) as typeof batch)
      return
    }
    const refusal = posted.ack
    if (!isPermanentRefusal(refusal)) {
      throw new Error(refusalMessage(refusal))
    }

    const sent = batch.events.slice(0, posted.eventCount)
    let rejectedIndex =
      refusal.rejectedOriginSeq === undefined
        ? -1
        : sent.findIndex((event) => event.originSeq === refusal.rejectedOriginSeq)
    if (rejectedIndex < 0 && posted.eventCount > 1) {
      await forward(takeBatchPrefix(batch, 1) as typeof batch)
      await forward(dropBatchPrefix(batch, 1) as typeof batch)
      return
    }
    if (rejectedIndex < 0) rejectedIndex = 0
    const rejected = sent[rejectedIndex]
    if (rejected === undefined) throw new Error('permanent ingest refusal identified no event')

    forwarded += rejectedIndex
    await deadLetterAndAdvance({
      cursorPath: options.cursorPath,
      cursors: options.cursors,
      cursorKey: options.cursorKey,
      sourceRef: batch.sourceRef,
      feed: batch.feed,
      cursor: rejected.originSeq,
      code: refusal.code,
      message: refusal.message,
    })
    deadLettered += 1
    await forward(dropBatchPrefix(batch, rejectedIndex + 1) as typeof batch)
  }

  await forward(options.batch)
  return { forwarded, deadLettered }
}

export async function forwardAvailableEvents(options: {
  db: HrcDatabase
  sourceRef: string
  target: EventForwardTarget
  cursorPath: string
  batchSize?: number
}): Promise<{ cursors: ForwardCursors; forwarded: number; deadLettered: number }> {
  const batchSize = Math.min(
    HRC_INGEST_MAX_BATCH_EVENTS,
    Math.max(1, options.batchSize ?? HRC_INGEST_MAX_BATCH_EVENTS)
  )
  const cursors = await readCursors(options.cursorPath)
  let forwarded = 0
  let deadLettered = 0

  const blobs = options.db.toolResultBlobs.listLocalFromRowid(cursors.toolResultBlobs, batchSize)
  for (const blob of blobs) {
    const chunks = chunkUtf8(blob.resultJson)
    let blobDeadLettered = false
    for (const [part, chunk] of chunks.entries()) {
      let posted: { ack: HrcEventIngestAck; eventCount: number }
      try {
        posted = await postBatch(options.target, {
          version: 1,
          sourceRef: options.sourceRef,
          feed: 'tool_result_blobs',
          events: [
            {
              blobId: blob.blobId,
              runtimeId: blob.runtimeId,
              kind: blob.kind,
              bytes: blob.bytes,
              part,
              parts: chunks.length,
              chunk,
            },
          ],
        })
      } catch (error) {
        if (!(error instanceof OversizedForwardEventError)) throw error
        await deadLetterAndAdvance({
          cursorPath: options.cursorPath,
          cursors,
          cursorKey: 'toolResultBlobs',
          sourceRef: options.sourceRef,
          feed: 'tool_result_blobs',
          cursor: blob.rowid,
          code: 'oversized_event',
          message: error.message,
        })
        deadLettered += 1
        blobDeadLettered = true
        break
      }
      if (!posted.ack.ok) {
        if (!isPermanentRefusal(posted.ack)) throw new Error(refusalMessage(posted.ack))
        await deadLetterAndAdvance({
          cursorPath: options.cursorPath,
          cursors,
          cursorKey: 'toolResultBlobs',
          sourceRef: options.sourceRef,
          feed: 'tool_result_blobs',
          cursor: blob.rowid,
          code: posted.ack.code,
          message: posted.ack.message,
        })
        deadLettered += 1
        blobDeadLettered = true
        break
      }
      forwarded += 1
    }
    if (blobDeadLettered) continue
    cursors.toolResultBlobs = blob.rowid
    await writeCursors(options.cursorPath, cursors)
  }

  const lifecycle = options.db.hrcEvents.listFromStreamSeq(
    cursors.hrcEvents + 1,
    {
      sourceRef: null,
      limit: batchSize,
    },
    { hydrate: false }
  )
  if (lifecycle.length > 0) {
    const result = await forwardSequencedBatch({
      batch: {
        version: 1,
        sourceRef: options.sourceRef,
        feed: 'hrc_events',
        events: lifecycle.map((event) => ({ originSeq: event.streamSeq, event })),
      },
      target: options.target,
      cursorPath: options.cursorPath,
      cursors,
      cursorKey: 'hrcEvents',
    })
    forwarded += result.forwarded
    deadLettered += result.deadLettered
  }

  const broker = options.db.brokerInvocationEvents.listLocalFromId(
    cursors.brokerInvocationEvents,
    batchSize,
    { hydrate: false }
  )
  if (broker.length > 0) {
    const events = broker.map((event) => {
      if (event.id === undefined) throw new Error('local broker row is missing its table id')
      return { originSeq: event.id, event }
    })
    const result = await forwardSequencedBatch({
      batch: {
        version: 1,
        sourceRef: options.sourceRef,
        feed: 'broker_invocation_events',
        events,
      },
      target: options.target,
      cursorPath: options.cursorPath,
      cursors,
      cursorKey: 'brokerInvocationEvents',
    })
    forwarded += result.forwarded
    deadLettered += result.deadLettered
  }

  return { cursors, forwarded, deadLettered }
}

export function eventForwardRetryDelayMs(
  consecutiveFailures: number,
  baseMs = 1_000,
  maxMs = EVENT_FORWARD_MAX_RETRY_MS
): number {
  const cap = Number.isFinite(maxMs) ? Math.max(1, Math.trunc(maxMs)) : 1
  const base = Number.isFinite(baseMs) ? Math.min(cap, Math.max(1, Math.trunc(baseMs))) : cap
  const failureCount = Number.isFinite(consecutiveFailures) ? Math.trunc(consecutiveFailures) : 1
  const exponent = Math.max(0, Math.min(30, failureCount - 1))
  return Math.min(cap, base * 2 ** exponent)
}

export function startEventForwarder(options: {
  db: HrcDatabase
  stateRoot: string
  sourceRef: string
  target: EventForwardTarget
  retryMs?: number
  maxRetryMs?: number
}): EventForwarder {
  const cursorPath = join(options.stateRoot, CURSOR_FILE)
  const retryMs = Math.max(100, options.retryMs ?? 1_000)
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? EVENT_FORWARD_MAX_RETRY_MS)
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()
  let consecutiveFailures = 0

  const run = async (): Promise<void> => {
    let nextDelayMs = retryMs
    while (!stopping) {
      try {
        const result = await forwardAvailableEvents({
          db: options.db,
          sourceRef: options.sourceRef,
          target: options.target,
          cursorPath,
        })
        consecutiveFailures = 0
        if (result.forwarded === 0 && result.deadLettered === 0) break
      } catch (error) {
        consecutiveFailures += 1
        nextDelayMs = eventForwardRetryDelayMs(consecutiveFailures, retryMs, maxRetryMs)
        writeServerLog('WARN', 'event_forwarder.retry', {
          sourceRef: options.sourceRef,
          target: options.target,
          consecutiveFailures,
          retryInMs: nextDelayMs,
          error,
        })
        break
      }
    }
    if (!stopping) timer = setTimeout(schedule, nextDelayMs)
  }
  const schedule = (): void => {
    running = run()
  }
  schedule()

  return {
    sourceRef: options.sourceRef,
    target: options.target,
    cursorPath,
    async stop() {
      stopping = true
      if (timer) clearTimeout(timer)
      await running
    },
  }
}

export async function drainEventDatabase(options: {
  dbPath: string
  sourceRef: string
  socketPath?: string
}): Promise<{ forwarded: number; cursors: ForwardCursors }> {
  const db = openHrcDatabase(options.dbPath)
  const cursorPath = join(dirname(options.dbPath), CURSOR_FILE)
  let forwarded = 0
  try {
    while (true) {
      const result = await forwardAvailableEvents({
        db,
        sourceRef: options.sourceRef,
        target: {
          kind: 'unix',
          socketPath: options.socketPath ?? resolveIngestSocketPath(),
        },
        cursorPath,
      })
      forwarded += result.forwarded
      if (result.forwarded === 0 && result.deadLettered === 0) {
        return { forwarded, cursors: result.cursors }
      }
    }
  } finally {
    db.close()
  }
}
