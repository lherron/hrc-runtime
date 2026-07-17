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
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let replayHighWater = fromSeq - 1
  const subscriber: FollowSubscriber = (event) => {
    if (!('hrcSeq' in event) || event.hrcSeq < fromSeq) {
      return
    }
    if (!matchesHrcLifecycleEventFilter(event, filters)) {
      return
    }

    if (controllerRef) {
      if (event.hrcSeq > replayHighWater) {
        controllerRef.enqueue(encodeNdjson(event))
      }
      return
    }

    bufferedEvents.push(event)
  }

  this.followSubscribers.add(subscriber)
  const close = () => {
    this.activeStreamClosers.delete(close)
    this.followSubscribers.delete(subscriber)
    bufferedEvents.length = 0
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    try {
      controllerRef?.close()
    } catch {
      // Stream may already be closed by Bun on disconnect.
    } finally {
      controllerRef = null
    }
  }
  this.activeStreamClosers.add(close)

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  const keepaliveBytes = new TextEncoder().encode('\n')

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const replayEvents = this.db.hrcEvents.listFromHrcSeq(fromSeq, filters)
      replayHighWater = replayEvents.at(-1)?.hrcSeq ?? replayHighWater
      controllerRef = controller
      controller.enqueue(keepaliveBytes)

      for (const event of replayEvents) {
        controller.enqueue(encodeNdjson(event))
      }

      for (const event of bufferedEvents) {
        if (event.hrcSeq > replayHighWater) {
          controller.enqueue(encodeNdjson(event))
        }
      }

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(keepaliveBytes)
        } catch {
          // Stream closed
        }
      }, HRC_EVENTS_KEEPALIVE_MS)

      request.signal.addEventListener('abort', close, { once: true })
    },
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
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let replayHighWater = selector.afterSeq
  const subscriber = (notification: {
    envelope: InvocationEventEnvelope
    record: HrcBrokerInvocationEventRecord
  }) => {
    if (!matchesBrokerEventsSelector(notification.record, selector)) {
      return
    }
    const envelope = parseBrokerEnvelopeRow(notification.record)

    if (controllerRef) {
      if (envelope.seq > replayHighWater) {
        controllerRef.enqueue(encodeNdjson(envelope))
      }
      return
    }

    bufferedEvents.push(envelope)
  }

  this.rawBrokerSubscribers.add(subscriber)
  const close = () => {
    this.activeStreamClosers.delete(close)
    this.rawBrokerSubscribers.delete(subscriber)
    bufferedEvents.length = 0
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    try {
      controllerRef?.close()
    } catch {
      // Stream may already be closed by Bun on disconnect.
    } finally {
      controllerRef = null
    }
  }
  this.activeStreamClosers.add(close)

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  const keepaliveBytes = new TextEncoder().encode('\n')

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const replayEvents = listBrokerEventsFromAfterSeq(this, selector)
      replayHighWater = replayEvents.at(-1)?.seq ?? replayHighWater
      controllerRef = controller
      controller.enqueue(keepaliveBytes)

      for (const event of replayEvents) {
        controller.enqueue(encodeNdjson(event))
      }

      for (const event of bufferedEvents) {
        if (event.seq > replayHighWater) {
          controller.enqueue(encodeNdjson(event))
        }
      }

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(keepaliveBytes)
        } catch {
          // Stream closed
        }
      }, HRC_EVENTS_KEEPALIVE_MS)

      request.signal.addEventListener('abort', close, { once: true })
    },
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
