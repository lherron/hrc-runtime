import { HrcBadRequestError, HrcConflictError, HrcErrorCode } from 'hrc-core'
import type {
  BrokerForensicsEvent,
  BrokerForensicsResponse,
  HrcBrokerInvocationEventRecord,
  HrcEventCategory,
  HrcLifecycleEvent,
  HrcSubscriberReceiptAckRequest,
} from 'hrc-core'
import { HrcEventLedgerIncarnationMismatchError } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import {
  BoundedEventRecordQueue,
  BoundedEventStreamDelivery,
  createBoundedReplayCollector,
} from './bounded-event-stream.js'
import type { EncodedBoundedEventRecord } from './bounded-event-stream.js'
import {
  HRC_EVENTS_KEEPALIVE_MS,
  NDJSON_HEADERS,
  STREAMING_NDJSON_HEADERS,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { matchesHrcLifecycleEventFilter, parseOptionalIntegerQuery } from './server-misc.js'
import { isRecord, normalizeOptionalQuery, parseFromSeq, parseJsonBody } from './server-parsers.js'
import type { FollowSubscriber, HrcEventsRouteFilters } from './server-types.js'
import { encodeNdjson, json, serializeEvent } from './server-util.js'
import type { SubscriberAdmissionHandle } from './subscriber-admission-accounting.js'

type AdmissionQueueItem =
  | { kind: 'event'; bytes: Uint8Array; seq: number }
  | { kind: 'keepalive'; bytes: Uint8Array }

type AdmissionQueueNode = {
  item: AdmissionQueueItem
  next: AdmissionQueueNode | null
}

const CONSUMER_RECEIPT_MODE = 'consumer-ack-v1'
const CONSUMER_RECEIPT_ACK_PATH = '/v1/server/subscribers/ack'

function parseSubscriberReceiptMode(searchParams: URLSearchParams): 'none' | 'consumer-ack-v1' {
  const value = normalizeOptionalQuery(searchParams.get('receipt'))
  if (value === undefined) return 'none'
  if (value === CONSUMER_RECEIPT_MODE) return value
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    `receipt must be ${CONSUMER_RECEIPT_MODE}`,
    { field: 'receipt', value }
  )
}

function streamingHeaders(admission: SubscriberAdmissionHandle): Record<string, string> {
  if (admission.receiptMode !== CONSUMER_RECEIPT_MODE || !admission.receiptToken) {
    return STREAMING_NDJSON_HEADERS
  }
  return {
    ...STREAMING_NDJSON_HEADERS,
    'x-hrc-subscriber-id': admission.subscriberId,
    'x-hrc-receipt-token': admission.receiptToken,
    'x-hrc-receipt-ack-path': CONSUMER_RECEIPT_ACK_PATH,
  }
}

function createStreamAdmissionQueue(admission: SubscriberAdmissionHandle): {
  attach(controller: ReadableStreamDefaultController<Uint8Array>): void
  enqueueEvent(bytes: Uint8Array, seq: number): void
  enqueueKeepalive(bytes: Uint8Array): void
  drain(): void
  close(): void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let first: AdmissionQueueNode | null = null
  let last: AdmissionQueueNode | null = null
  let closed = false

  const append = (item: AdmissionQueueItem): void => {
    const node: AdmissionQueueNode = { item, next: null }
    if (last) last.next = node
    else first = node
    last = node
  }

  const drain = (): void => {
    while (!closed && controller !== null && (controller.desiredSize ?? 0) > 0 && first) {
      const node = first
      first = node.next
      if (first === null) last = null
      controller.enqueue(node.item.bytes)
      const desiredSize = controller.desiredSize
      if (node.item.kind === 'event') {
        admission.recordStreamAccepted(node.item.seq, desiredSize)
      } else {
        admission.recordKeepalive(desiredSize)
      }
    }
  }

  return {
    attach(nextController) {
      if (closed) {
        nextController.close()
        return
      }
      controller = nextController
      drain()
    },
    enqueueEvent(bytes, seq) {
      if (closed) return
      admission.recordEnqueued(seq, controller?.desiredSize ?? null)
      append({ kind: 'event', bytes, seq })
      drain()
    },
    enqueueKeepalive(bytes) {
      if (closed) return
      append({ kind: 'keepalive', bytes })
      drain()
    },
    drain,
    close() {
      if (closed) return
      closed = true
      first = null
      last = null
      try {
        controller?.close()
      } catch {
        // Stream may already be closed by Bun on disconnect.
      } finally {
        controller = null
      }
    },
  }
}

export type BrokerEventsRouteSelector = {
  invocationId: string
  runId?: string | undefined
  runtimeId: string
  generation: number
  afterSeq: number
}

function requireQuery(searchParams: URLSearchParams, field: string): string {
  const value = normalizeOptionalQuery(searchParams.get(field))
  if (value === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }
  return value
}

export function parseBrokerEventsRouteSelector(
  searchParams: URLSearchParams
): BrokerEventsRouteSelector {
  const generation = parseOptionalIntegerQuery(searchParams.get('generation'), 'generation')
  const afterSeq = parseOptionalIntegerQuery(searchParams.get('afterSeq'), 'afterSeq')
  if (generation === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'generation is required', {
      field: 'generation',
    })
  }
  if (afterSeq === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'afterSeq is required', {
      field: 'afterSeq',
    })
  }

  return {
    invocationId: requireQuery(searchParams, 'invocationId'),
    ...(normalizeOptionalQuery(searchParams.get('runId')) !== undefined
      ? { runId: normalizeOptionalQuery(searchParams.get('runId')) }
      : {}),
    runtimeId: requireQuery(searchParams, 'runtimeId'),
    generation,
    afterSeq,
  }
}

function assertBrokerEventsRuntimeFence(
  this: HrcServerInstanceForHandlers,
  selector: BrokerEventsRouteSelector
): void {
  const runtime = this.db.runtimes.getByRuntimeId(selector.runtimeId)
  if (!runtime) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, 'runtimeId was not found', {
      runtimeId: selector.runtimeId,
    })
  }
  if (runtime.generation !== selector.generation) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_FENCE, 'generation does not match runtime', {
      runtimeId: selector.runtimeId,
      generation: selector.generation,
      actualGeneration: runtime.generation,
    })
  }
}

function matchesBrokerEventsSelector(
  record: HrcBrokerInvocationEventRecord,
  selector: BrokerEventsRouteSelector
): boolean {
  return (
    record.invocationId === selector.invocationId &&
    (selector.runId === undefined || record.runId === selector.runId) &&
    record.runtimeId === selector.runtimeId &&
    record.seq > selector.afterSeq
  )
}

function parseBrokerEnvelopeRow(row: HrcBrokerInvocationEventRecord): InvocationEventEnvelope {
  if (!row.brokerEnvelopeJson) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      `broker event ${row.invocationId}/${row.seq} has no full envelope JSON`,
      { invocationId: row.invocationId, seq: row.seq }
    )
  }
  return JSON.parse(row.brokerEnvelopeJson) as InvocationEventEnvelope
}

function listBrokerEventsFromAfterSeq(
  server: HrcServerInstanceForHandlers,
  selector: BrokerEventsRouteSelector
): InvocationEventEnvelope[] {
  return server.db.brokerInvocationEvents
    .listFromAfterSeq({
      invocationId: selector.invocationId,
      ...(selector.runId !== undefined ? { runId: selector.runId } : {}),
      runtimeId: selector.runtimeId,
      afterSeq: selector.afterSeq,
    })
    .map((row) => parseBrokerEnvelopeRow(row))
}

export function parseEventsRouteFilters(
  this: HrcServerInstanceForHandlers,
  searchParams: URLSearchParams
): HrcEventsRouteFilters {
  const generation = parseOptionalIntegerQuery(searchParams.get('generation'), 'generation')

  return {
    ...(normalizeOptionalQuery(searchParams.get('sourceRef')) !== undefined
      ? { sourceRef: normalizeOptionalQuery(searchParams.get('sourceRef')) }
      : {}),
    ...(normalizeOptionalQuery(searchParams.get('hostSessionId')) !== undefined
      ? { hostSessionId: normalizeOptionalQuery(searchParams.get('hostSessionId')) }
      : {}),
    ...(generation !== undefined ? { generation } : {}),
    ...(normalizeOptionalQuery(searchParams.get('scopeRef')) !== undefined
      ? { scopeRef: normalizeOptionalQuery(searchParams.get('scopeRef')) }
      : {}),
    ...(normalizeOptionalQuery(searchParams.get('laneRef')) !== undefined
      ? { laneRef: normalizeOptionalQuery(searchParams.get('laneRef')) }
      : {}),
    ...(normalizeOptionalQuery(searchParams.get('runtimeId')) !== undefined
      ? { runtimeId: normalizeOptionalQuery(searchParams.get('runtimeId')) }
      : {}),
    ...(normalizeOptionalQuery(searchParams.get('runId')) !== undefined
      ? { runId: normalizeOptionalQuery(searchParams.get('runId')) }
      : {}),
    ...(normalizeOptionalQuery(searchParams.get('category')) !== undefined
      ? { category: normalizeOptionalQuery(searchParams.get('category')) as HrcEventCategory }
      : {}),
    ...(normalizeOptionalQuery(searchParams.get('eventKind')) !== undefined
      ? { eventKind: normalizeOptionalQuery(searchParams.get('eventKind')) }
      : {}),
  }
}

export function handleEvents(
  this: HrcServerInstanceForHandlers,
  url: URL,
  request: Request
): Response {
  const fromSeq = parseFromSeq(url.searchParams.get('fromSeq'))
  const follow = url.searchParams.get('follow') === 'true'
  const receiptMode = parseSubscriberReceiptMode(url.searchParams)
  const filters = this.parseEventsRouteFilters(url.searchParams)

  if (!follow) {
    if (receiptMode !== 'none') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'consumer receipt requires follow=true',
        { field: 'follow' }
      )
    }
    const events = this.db.hrcEvents.listFromHrcSeq(fromSeq, filters)
    return new Response(events.map(serializeEvent).join(''), {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  const bufferedEvents: HrcLifecycleEvent[] = []
  let replayHighWater = fromSeq - 1
  const admission = this.subscriberAdmissions.open({
    route: 'events',
    selector: { fromSeq, ...filters },
    openedAt: new Date().toISOString(),
    receiptMode,
  })
  const admissionQueue = createStreamAdmissionQueue(admission)
  let streamStarted = false
  const subscriber: FollowSubscriber = (event) => {
    if (!('hrcSeq' in event) || event.hrcSeq < fromSeq) {
      return
    }
    if (!matchesHrcLifecycleEventFilter(event, filters)) {
      return
    }

    if (streamStarted) {
      if (event.hrcSeq > replayHighWater) {
        admissionQueue.enqueueEvent(encodeNdjson(event), event.hrcSeq)
      }
      return
    }

    bufferedEvents.push(event)
  }

  this.followSubscribers.add(subscriber)
  const close = () => {
    this.activeStreamClosers.delete(close)
    this.followSubscribers.delete(subscriber)
    admission.close()
    bufferedEvents.length = 0
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    admissionQueue.close()
  }
  this.activeStreamClosers.add(close)

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  const keepaliveBytes = new TextEncoder().encode('\n')

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const replayEvents = this.db.hrcEvents.listFromHrcSeq(fromSeq, filters)
      replayHighWater = replayEvents.at(-1)?.hrcSeq ?? replayHighWater
      streamStarted = true
      admissionQueue.attach(controller)
      admissionQueue.enqueueKeepalive(keepaliveBytes)

      for (const event of replayEvents) {
        admissionQueue.enqueueEvent(encodeNdjson(event), event.hrcSeq)
      }

      for (const event of bufferedEvents) {
        if (event.hrcSeq > replayHighWater) {
          admissionQueue.enqueueEvent(encodeNdjson(event), event.hrcSeq)
        }
      }

      keepaliveTimer = setInterval(() => {
        try {
          admissionQueue.enqueueKeepalive(keepaliveBytes)
        } catch {
          // Stream closed
        }
      }, HRC_EVENTS_KEEPALIVE_MS)

      request.signal.addEventListener('abort', close, { once: true })
    },
    pull: () => admissionQueue.drain(),
    cancel: () => close(),
  })

  return new Response(stream, {
    status: 200,
    headers: streamingHeaders(admission),
  })
}

const HRC_EVENTS_TAIL_MAX_LIMIT = 500

function parseRequiredSafeInteger(
  searchParams: URLSearchParams,
  field: string,
  minimum: number
): number {
  const raw = normalizeOptionalQuery(searchParams.get(field))
  if (raw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a safe integer greater than or equal to ${minimum}`,
      { field, value: raw }
    )
  }
  return value
}

function parseOptionalSafeInteger(
  searchParams: URLSearchParams,
  field: string,
  minimum: number
): number | undefined {
  const raw = normalizeOptionalQuery(searchParams.get(field))
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a safe integer greater than or equal to ${minimum}`,
      { field, value: raw }
    )
  }
  return value
}

/**
 * Bounded lifecycle-event tail, head page or exclusive-before reverse page.
 *
 * Omitting `beforeHrcSeq` keeps the pre-existing head-page behavior verbatim.
 * A reverse page must carry the `ledgerIncarnationId` it was minted against —
 * paging backwards through a replaced ledger would silently return rows from a
 * different history — and a mismatch is a typed `cursor_invalid` conflict with
 * no event payload. The cursor is deliberately named apart from the bounded
 * live stream's `afterSeq`: it walks history backwards and never advances a
 * consumer's forward position.
 */
export function handleEventsTail(this: HrcServerInstanceForHandlers, url: URL): Response {
  const limit = parseRequiredSafeInteger(url.searchParams, 'limit', 1)
  if (limit > HRC_EVENTS_TAIL_MAX_LIMIT) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `limit must be between 1 and ${HRC_EVENTS_TAIL_MAX_LIMIT}`,
      { field: 'limit', value: limit }
    )
  }
  const beforeHrcSeq = parseOptionalSafeInteger(url.searchParams, 'beforeHrcSeq', 1)
  const expectedLedgerIncarnationId = normalizeOptionalQuery(
    url.searchParams.get('ledgerIncarnationId')
  )
  if (beforeHrcSeq !== undefined && expectedLedgerIncarnationId === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'beforeHrcSeq requires the ledgerIncarnationId it was minted against',
      { field: 'ledgerIncarnationId' }
    )
  }
  const filters = this.parseEventsRouteFilters(url.searchParams)
  try {
    return json(
      this.db.hrcEvents.tail(limit, filters, {
        ...(beforeHrcSeq !== undefined ? { beforeHrcSeq } : {}),
        ...(expectedLedgerIncarnationId !== undefined ? { expectedLedgerIncarnationId } : {}),
      })
    )
  } catch (error) {
    if (error instanceof HrcEventLedgerIncarnationMismatchError) {
      throw new HrcConflictError(
        HrcErrorCode.CURSOR_INVALID,
        'event ledger incarnation is no longer current',
        {
          expectedLedgerIncarnationId: error.expectedLedgerIncarnationId,
          currentLedgerIncarnationId: error.currentLedgerIncarnationId,
        }
      )
    }
    throw error
  }
}

export function handleBoundedEvents(
  this: HrcServerInstanceForHandlers,
  url: URL,
  request: Request
): Response {
  const expectedLedgerIncarnationId = requireQuery(url.searchParams, 'ledgerIncarnationId')
  const afterHrcSeq = parseRequiredSafeInteger(url.searchParams, 'afterSeq', 0)
  if (url.searchParams.get('follow') !== 'true') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'bounded event stream requires follow=true',
      { field: 'follow' }
    )
  }
  const filters = this.parseEventsRouteFilters(url.searchParams)
  const seam = new BoundedEventRecordQueue(expectedLedgerIncarnationId, afterHrcSeq)
  let admitted = false
  let replayHeadHrcSeq = afterHrcSeq
  let delivery: BoundedEventStreamDelivery | undefined
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let closed = false
  const activeCloser = () => delivery?.close()

  const close = () => {
    if (closed) return
    closed = true
    this.activeStreamClosers.delete(activeCloser)
    this.followSubscribers.delete(subscriber)
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    seam.clear()
  }

  const replaceLedger = (currentLedgerIncarnationId: string): void => {
    this.followSubscribers.delete(subscriber)
    delivery?.ledgerReplaced(currentLedgerIncarnationId)
  }

  const subscriber: FollowSubscriber = (candidate) => {
    try {
      if (!('hrcSeq' in candidate)) return
      const currentLedgerIncarnationId = this.db.hrcEvents.ledgerIncarnationId()
      if (currentLedgerIncarnationId !== expectedLedgerIncarnationId) {
        replaceLedger(currentLedgerIncarnationId)
        return
      }
      if (candidate.hrcSeq <= afterHrcSeq) return
      if (!matchesHrcLifecycleEventFilter(candidate, filters)) return
      if (!admitted) {
        seam.appendEvent(candidate)
        return
      }
      if (candidate.hrcSeq > replayHeadHrcSeq) delivery?.appendEvent(candidate)
    } catch {
      // Observation must never make the lifecycle-event producer fail.
      delivery?.close()
    }
  }

  this.followSubscribers.add(subscriber)
  const replayCollector = createBoundedReplayCollector(expectedLedgerIncarnationId, afterHrcSeq)
  let replayRecords: EncodedBoundedEventRecord[]
  try {
    const snapshot = this.db.hrcEvents.scanReplayNewestFirst(
      {
        expectedLedgerIncarnationId,
        afterHrcSeq,
        filters,
      },
      replayCollector.visitNewestFirst
    )
    replayHeadHrcSeq = snapshot.headHrcSeq
    replayRecords = replayCollector.finish(snapshot.complete)
  } catch (error) {
    close()
    if (error instanceof HrcEventLedgerIncarnationMismatchError) {
      throw new HrcConflictError(
        HrcErrorCode.CURSOR_INVALID,
        'event ledger incarnation is no longer current',
        {
          expectedLedgerIncarnationId: error.expectedLedgerIncarnationId,
          currentLedgerIncarnationId: error.currentLedgerIncarnationId,
        }
      )
    }
    throw error
  }

  admitted = true
  const queue = new BoundedEventRecordQueue(expectedLedgerIncarnationId, afterHrcSeq)
  for (const record of replayRecords) queue.appendEncoded(record)
  seam.discardThrough(replayHeadHrcSeq)
  for (const record of seam.drain()) queue.appendEncoded(record)

  delivery = new BoundedEventStreamDelivery(
    {
      type: 'ready',
      ledgerIncarnationId: expectedLedgerIncarnationId,
      acceptedAfterHrcSeq: afterHrcSeq,
      replayHeadHrcSeq,
    },
    queue,
    close
  )
  this.activeStreamClosers.add(activeCloser)

  // Re-check after the admission transaction before exposing a 200 response.
  // A replacement at this seam must never make the numeric cursor admissible.
  const currentLedgerIncarnationId = this.db.hrcEvents.ledgerIncarnationId()
  if (currentLedgerIncarnationId !== expectedLedgerIncarnationId) {
    delivery.close()
    throw new HrcConflictError(
      HrcErrorCode.CURSOR_INVALID,
      'event ledger incarnation changed during stream admission',
      { expectedLedgerIncarnationId, currentLedgerIncarnationId }
    )
  }

  const keepaliveBytes = new TextEncoder().encode('\n')
  keepaliveTimer = setInterval(() => {
    try {
      const current = this.db.hrcEvents.ledgerIncarnationId()
      if (current !== expectedLedgerIncarnationId) {
        replaceLedger(current)
        return
      }
      delivery?.keepalive(keepaliveBytes)
    } catch {
      delivery?.close()
    }
  }, HRC_EVENTS_KEEPALIVE_MS)
  request.signal.addEventListener('abort', () => delivery?.close(), { once: true })

  const stream = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => delivery?.pull(controller),
      cancel: () => delivery?.close(),
    },
    { highWaterMark: 1, size: () => 1 }
  )
  return new Response(stream, { status: 200, headers: STREAMING_NDJSON_HEADERS })
}

export function handleBrokerEvents(
  this: HrcServerInstanceForHandlers,
  url: URL,
  request: Request
): Response {
  const selector = parseBrokerEventsRouteSelector(url.searchParams)
  const follow = url.searchParams.get('follow') === 'true'
  const receiptMode = parseSubscriberReceiptMode(url.searchParams)
  this.assertBrokerEventsRuntimeFence(selector)

  if (!follow) {
    if (receiptMode !== 'none') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'consumer receipt requires follow=true',
        { field: 'follow' }
      )
    }
    const events = listBrokerEventsFromAfterSeq(this, selector)
    return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(''), {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  const bufferedEvents: InvocationEventEnvelope[] = []
  let replayHighWater = selector.afterSeq
  const admission = this.subscriberAdmissions.open({
    route: 'broker-events',
    selector: { ...selector },
    openedAt: new Date().toISOString(),
    receiptMode,
  })
  const admissionQueue = createStreamAdmissionQueue(admission)
  let streamStarted = false
  const subscriber = (notification: {
    envelope: InvocationEventEnvelope
    record: HrcBrokerInvocationEventRecord
  }) => {
    if (!matchesBrokerEventsSelector(notification.record, selector)) {
      return
    }
    const envelope = parseBrokerEnvelopeRow(notification.record)

    if (streamStarted) {
      if (envelope.seq > replayHighWater) {
        admissionQueue.enqueueEvent(encodeNdjson(envelope), envelope.seq)
      }
      return
    }

    bufferedEvents.push(envelope)
  }

  this.rawBrokerSubscribers.add(subscriber)
  const close = () => {
    this.activeStreamClosers.delete(close)
    this.rawBrokerSubscribers.delete(subscriber)
    admission.close()
    bufferedEvents.length = 0
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    admissionQueue.close()
  }
  this.activeStreamClosers.add(close)

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  const keepaliveBytes = new TextEncoder().encode('\n')

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const replayEvents = listBrokerEventsFromAfterSeq(this, selector)
      replayHighWater = replayEvents.at(-1)?.seq ?? replayHighWater
      streamStarted = true
      admissionQueue.attach(controller)
      admissionQueue.enqueueKeepalive(keepaliveBytes)

      for (const event of replayEvents) {
        admissionQueue.enqueueEvent(encodeNdjson(event), event.seq)
      }

      for (const event of bufferedEvents) {
        if (event.seq > replayHighWater) {
          admissionQueue.enqueueEvent(encodeNdjson(event), event.seq)
        }
      }

      keepaliveTimer = setInterval(() => {
        try {
          admissionQueue.enqueueKeepalive(keepaliveBytes)
        } catch {
          // Stream closed
        }
      }, HRC_EVENTS_KEEPALIVE_MS)

      request.signal.addEventListener('abort', close, { once: true })
    },
    pull: () => admissionQueue.drain(),
    cancel: () => close(),
  })

  return new Response(stream, {
    status: 200,
    headers: streamingHeaders(admission),
  })
}

function parseSubscriberReceiptAckRequest(value: unknown): HrcSubscriberReceiptAckRequest {
  if (!isRecord(value)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'subscriber receipt ACK body must be an object'
    )
  }
  const subscriberId = normalizeOptionalQuery(
    typeof value['subscriberId'] === 'string' ? value['subscriberId'] : null
  )
  const receiptToken = normalizeOptionalQuery(
    typeof value['receiptToken'] === 'string' ? value['receiptToken'] : null
  )
  if (subscriberId === undefined || receiptToken === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'subscriberId and receiptToken are required'
    )
  }
  return {
    subscriberId,
    receiptToken,
    seq: typeof value['seq'] === 'number' ? value['seq'] : Number.NaN,
  }
}

export async function handleSubscriberReceiptAck(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const input = parseSubscriberReceiptAckRequest(await parseJsonBody(request))
  return json(this.subscriberAdmissions.acknowledge(input))
}

type BrokerForensicsEventWithProvenance = BrokerForensicsEvent & {
  provenance?: InvocationEventEnvelope['provenance'] | undefined
}

function parseForensicsRow(
  row: HrcBrokerInvocationEventRecord
): BrokerForensicsEventWithProvenance {
  let turnId: string | undefined
  let provenance: InvocationEventEnvelope['provenance']
  if (row.brokerEnvelopeJson) {
    try {
      const envelope = JSON.parse(row.brokerEnvelopeJson) as Record<string, unknown>
      if (typeof envelope['turnId'] === 'string') turnId = envelope['turnId']
      if (envelope['provenance'] !== undefined) {
        // The protocol validator and BrokerEventMapper are the sole envelope
        // interpreters. This query projection carries the accepted value through.
        provenance = envelope['provenance'] as InvocationEventEnvelope['provenance']
      }
    } catch {
      // The payload row remains useful even if optional envelope metadata is damaged.
    }
  }

  const base = {
    invocationId: row.invocationId,
    runtimeId: row.runtimeId,
    ...(row.runId !== undefined ? { runId: row.runId } : {}),
    ...(row.sourceRef !== undefined ? { sourceRef: row.sourceRef } : {}),
    ...(row.originSeq !== undefined ? { originSeq: row.originSeq } : {}),
    seq: row.seq,
    time: row.time,
    type: row.type,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  }

  try {
    const decoded = JSON.parse(row.brokerEventJson) as unknown
    const decodedRecord =
      decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : undefined
    // Both shapes exist in persisted ledgers: the current payload-only form and
    // an older envelope-like `{ payload: ... }` form.
    const envelopeLike =
      decodedRecord !== undefined &&
      Object.hasOwn(decodedRecord, 'payload') &&
      (Object.keys(decodedRecord).length === 1 ||
        ['invocationId', 'seq', 'time', 'type'].some((key) => Object.hasOwn(decodedRecord, key)))
    if (turnId === undefined && envelopeLike && typeof decodedRecord['turnId'] === 'string') {
      turnId = decodedRecord['turnId']
    }
    const payload = envelopeLike && decodedRecord !== undefined ? decodedRecord['payload'] : decoded
    return { ...base, ...(turnId !== undefined ? { turnId } : {}), payload }
  } catch (error) {
    return {
      ...base,
      parseError: error instanceof Error ? error.message : String(error),
      rawPayload: row.brokerEventJson,
    }
  }
}

/** Read-only post-mortem projection of persisted broker rows. */
export function handleBrokerForensics(this: HrcServerInstanceForHandlers, url: URL): Response {
  const sourceRef = normalizeOptionalQuery(url.searchParams.get('sourceRef'))
  const targetId = normalizeOptionalQuery(url.searchParams.get('targetId'))
  if ((sourceRef === undefined) === (targetId === undefined)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'exactly one of targetId or sourceRef is required'
    )
  }
  if (sourceRef !== undefined) {
    const rows = this.db.brokerInvocationEvents.listBySourceRef(sourceRef)
    return json({
      targetKind: 'source_ref',
      targetId: sourceRef,
      runtimeIds: [...new Set(rows.map((row) => row.runtimeId))],
      invocationIds: [...new Set(rows.map((row) => row.invocationId))],
      events: rows.map(parseForensicsRow),
    } satisfies BrokerForensicsResponse)
  }
  if (targetId === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'targetId is required')
  }
  const resolvedTargetId = targetId
  const invocation = this.db.brokerInvocations.getByInvocationId(resolvedTargetId)

  let targetKind: BrokerForensicsResponse['targetKind']
  let rows: HrcBrokerInvocationEventRecord[]
  let runtimeIds: string[]
  let invocationIds: string[]

  if (invocation) {
    targetKind = 'invocation'
    rows = this.db.brokerInvocationEvents.listByInvocationId(invocation.invocationId)
    runtimeIds = [invocation.runtimeId]
    invocationIds = [invocation.invocationId]
  } else {
    const runtime = this.db.runtimes.getByRuntimeId(resolvedTargetId)
    const ledgerInvocationRows = runtime
      ? []
      : this.db.brokerInvocationEvents.listByInvocationId(resolvedTargetId)
    const ledgerRuntimeRows =
      runtime || ledgerInvocationRows.length > 0
        ? []
        : this.db.brokerInvocationEvents.listByRuntimeId(resolvedTargetId)
    if (!runtime && ledgerInvocationRows.length === 0 && ledgerRuntimeRows.length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.INVALID_SELECTOR,
        `no persisted broker runtime or invocation matched "${resolvedTargetId}"`,
        { targetId: resolvedTargetId }
      )
    }
    if (ledgerInvocationRows.length > 0) {
      targetKind = 'invocation'
      rows = ledgerInvocationRows
      runtimeIds = [...new Set(rows.map((row) => row.runtimeId))]
      invocationIds = [resolvedTargetId]
    } else {
      targetKind = 'runtime'
      rows = runtime
        ? this.db.brokerInvocationEvents.listByRuntimeId(runtime.runtimeId)
        : ledgerRuntimeRows
      runtimeIds = [resolvedTargetId]
      invocationIds = [...new Set(rows.map((row) => row.invocationId))]
    }
  }

  return json({
    targetKind,
    targetId: resolvedTargetId,
    runtimeIds,
    invocationIds,
    events: rows.map(parseForensicsRow),
  } satisfies BrokerForensicsResponse)
}

export function handleEventsLatestBySession(
  this: HrcServerInstanceForHandlers,
  url: URL
): Response {
  const filters = this.parseEventsRouteFilters(url.searchParams)
  const events = this.db.hrcEvents.listLatestPerSession(filters)
  return json(events)
}

export const eventHandlersMethods = {
  parseEventsRouteFilters,
  parseBrokerEventsRouteSelector,
  assertBrokerEventsRuntimeFence,
  handleEvents,
  handleEventsTail,
  handleBoundedEvents,
  handleBrokerEvents,
  handleSubscriberReceiptAck,
  handleBrokerForensics,
  handleEventsLatestBySession,
}

export type EventHandlersMethods = typeof eventHandlersMethods
