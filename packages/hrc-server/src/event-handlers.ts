import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  BrokerForensicsEvent,
  BrokerForensicsResponse,
  HrcBrokerInvocationEventRecord,
  HrcEventCategory,
  HrcLifecycleEvent,
} from 'hrc-core'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import {
  HRC_EVENTS_KEEPALIVE_MS,
  NDJSON_HEADERS,
  STREAMING_NDJSON_HEADERS,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { matchesHrcLifecycleEventFilter, parseOptionalIntegerQuery } from './server-misc.js'
import { normalizeOptionalQuery, parseFromSeq } from './server-parsers.js'
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
  const filters = this.parseEventsRouteFilters(url.searchParams)

  if (!follow) {
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
    headers: STREAMING_NDJSON_HEADERS,
  })
}

export function handleBrokerEvents(
  this: HrcServerInstanceForHandlers,
  url: URL,
  request: Request
): Response {
  const selector = parseBrokerEventsRouteSelector(url.searchParams)
  const follow = url.searchParams.get('follow') === 'true'
  this.assertBrokerEventsRuntimeFence(selector)

  if (!follow) {
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
    headers: STREAMING_NDJSON_HEADERS,
  })
}

function parseForensicsRow(row: HrcBrokerInvocationEventRecord): BrokerForensicsEvent {
  let turnId: string | undefined
  if (row.brokerEnvelopeJson) {
    try {
      const envelope = JSON.parse(row.brokerEnvelopeJson) as Record<string, unknown>
      if (typeof envelope['turnId'] === 'string') turnId = envelope['turnId']
    } catch {
      // The payload row remains useful even if optional envelope metadata is damaged.
    }
  }

  const base = {
    invocationId: row.invocationId,
    runtimeId: row.runtimeId,
    ...(row.runId !== undefined ? { runId: row.runId } : {}),
    seq: row.seq,
    time: row.time,
    type: row.type,
    ...(turnId !== undefined ? { turnId } : {}),
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
  const targetId = requireQuery(url.searchParams, 'targetId')
  const invocation = this.db.brokerInvocations.getByInvocationId(targetId)

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
    const runtime = this.db.runtimes.getByRuntimeId(targetId)
    if (!runtime) {
      throw new HrcBadRequestError(
        HrcErrorCode.INVALID_SELECTOR,
        `no persisted broker runtime or invocation matched "${targetId}"`,
        { targetId }
      )
    }
    targetKind = 'runtime'
    rows = this.db.brokerInvocationEvents.listByRuntimeId(runtime.runtimeId)
    runtimeIds = [runtime.runtimeId]
    invocationIds = this.db.brokerInvocations
      .listByRuntimeId(runtime.runtimeId)
      .map((entry) => entry.invocationId)
  }

  return json({
    targetKind,
    targetId,
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
  handleBrokerEvents,
  handleBrokerForensics,
  handleEventsLatestBySession,
}

export type EventHandlersMethods = typeof eventHandlersMethods
