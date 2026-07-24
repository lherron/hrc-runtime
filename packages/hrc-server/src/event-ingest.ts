import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  HrcBrokerInvocationEventRecord,
  HrcEventIngestAck,
  HrcEventIngestBatch,
  HrcLifecycleEvent,
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
const CURSOR_FILE = 'event-forward-cursors.json'
const serveIngest = Bun.serve

type IngestCounters = {
  accepted: number
  duplicates: number
  divergentDuplicates: number
  rejected: number
}

export type EventIngestListener = {
  socketPath: string
  counters: IngestCounters
  stop(): Promise<void>
}

export type EventForwarder = {
  sourceRef: string
  cursorPath: string
  stop(): Promise<void>
}

type ForwardCursors = {
  version: 1
  hrcEvents: number
  brokerInvocationEvents: number
}

const INITIAL_CURSORS: ForwardCursors = {
  version: 1,
  hrcEvents: 0,
  brokerInvocationEvents: 0,
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
  if (batch.feed !== 'hrc_events' && batch.feed !== 'broker_invocation_events') {
    throw new Error('unknown ingest feed')
  }
  if (!Array.isArray(batch.events) || batch.events.length < 1) {
    throw new Error('events must be a non-empty array')
  }
  if (batch.events.length > HRC_INGEST_MAX_BATCH_EVENTS) {
    throw new Error('ingest batch exceeds event limit')
  }
  let prior = 0
  for (const item of batch.events) {
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

export async function startEventIngestListener(options: {
  db: HrcDatabase
  runtimeRoot: string
  socketPath?: string
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
  let activeRequests = 0
  const server = serveIngest({
    unix: socketPath,
    idleTimeout: 30,
    fetch: (request: Request) => {
      if (activeRequests >= 64) {
        counters.rejected += 1
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
          counters.rejected += 1
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
        for (const item of batch.events) {
          try {
            if (batch.feed === 'hrc_events') {
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
              counters.divergentDuplicates += 1
              return jsonResponse(
                {
                  ok: false,
                  feed: batch.feed,
                  code: 'divergent_duplicate',
                  message: error.message,
                  rejectedOriginSeq: item.originSeq,
                },
                409
              )
            }
            counters.rejected += 1
            return jsonResponse(
              {
                ok: false,
                feed: batch.feed,
                code: 'ingest_error',
                message: error instanceof Error ? error.message : String(error),
                rejectedOriginSeq: item.originSeq,
              },
              500
            )
          }
        }
        counters.accepted += inserted
        counters.duplicates += duplicates
        const ackedThrough = batch.events.at(-1)?.originSeq
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
    },
  } as unknown as Parameters<typeof Bun.serve>[0])
  writeServerLog('INFO', 'server.start.event_ingest_listener', { socketPath })
  return {
    socketPath,
    counters,
    async stop() {
      server.stop(true)
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
      return parsed as ForwardCursors
    }
  } catch {
    // Missing or invalid cursor state starts at the ledger beginning.
  }
  return { ...INITIAL_CURSORS }
}

async function writeCursors(path: string, cursors: ForwardCursors): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(cursors)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function postBatch(
  socketPath: string,
  batch: HrcEventIngestBatch
): Promise<HrcEventIngestAck> {
  const response = await fetch('http://hrc/v1/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
    unix: socketPath,
  } as RequestInit & { unix: string })
  return (await response.json()) as HrcEventIngestAck
}

export async function forwardAvailableEvents(options: {
  db: HrcDatabase
  sourceRef: string
  socketPath: string
  cursorPath: string
  batchSize?: number
}): Promise<{ cursors: ForwardCursors; forwarded: number }> {
  const batchSize = Math.min(
    HRC_INGEST_MAX_BATCH_EVENTS,
    Math.max(1, options.batchSize ?? HRC_INGEST_MAX_BATCH_EVENTS)
  )
  const cursors = await readCursors(options.cursorPath)
  let forwarded = 0

  const lifecycle = options.db.hrcEvents.listFromStreamSeq(cursors.hrcEvents + 1, {
    sourceRef: null,
    limit: batchSize,
  })
  if (lifecycle.length > 0) {
    const ack = await postBatch(options.socketPath, {
      version: 1,
      sourceRef: options.sourceRef,
      feed: 'hrc_events',
      events: lifecycle.map((event) => ({ originSeq: event.streamSeq, event })),
    })
    if (!ack.ok) throw new Error(`${ack.code}: ${ack.message}`)
    cursors.hrcEvents = ack.ackedThrough
    forwarded += lifecycle.length
    await writeCursors(options.cursorPath, cursors)
  }

  const broker = options.db.brokerInvocationEvents.listLocalFromId(
    cursors.brokerInvocationEvents,
    batchSize
  )
  if (broker.length > 0) {
    const events = broker.map((event) => {
      if (event.id === undefined) throw new Error('local broker row is missing its table id')
      return { originSeq: event.id, event }
    })
    const ack = await postBatch(options.socketPath, {
      version: 1,
      sourceRef: options.sourceRef,
      feed: 'broker_invocation_events',
      events,
    })
    if (!ack.ok) throw new Error(`${ack.code}: ${ack.message}`)
    cursors.brokerInvocationEvents = ack.ackedThrough
    forwarded += broker.length
    await writeCursors(options.cursorPath, cursors)
  }

  return { cursors, forwarded }
}

export function startEventForwarder(options: {
  db: HrcDatabase
  stateRoot: string
  sourceRef: string
  socketPath?: string
  retryMs?: number
}): EventForwarder {
  const socketPath = options.socketPath ?? resolveIngestSocketPath()
  const cursorPath = join(options.stateRoot, CURSOR_FILE)
  const retryMs = Math.max(100, options.retryMs ?? 1_000)
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()

  const run = async (): Promise<void> => {
    while (!stopping) {
      try {
        const result = await forwardAvailableEvents({
          db: options.db,
          sourceRef: options.sourceRef,
          socketPath,
          cursorPath,
        })
        if (result.forwarded === 0) break
      } catch (error) {
        writeServerLog('WARN', 'event_forwarder.retry', {
          sourceRef: options.sourceRef,
          socketPath,
          error,
        })
        break
      }
    }
    if (!stopping) timer = setTimeout(schedule, retryMs)
  }
  const schedule = (): void => {
    running = run()
  }
  schedule()

  return {
    sourceRef: options.sourceRef,
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
        socketPath: options.socketPath ?? resolveIngestSocketPath(),
        cursorPath,
      })
      forwarded += result.forwarded
      if (result.forwarded === 0) return { forwarded, cursors: result.cursors }
    }
  } finally {
    db.close()
  }
}
