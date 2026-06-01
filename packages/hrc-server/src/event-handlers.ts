import type { HrcEventCategory, HrcLifecycleEvent } from 'hrc-core'
import { HRC_EVENTS_KEEPALIVE_MS, NDJSON_HEADERS } from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { matchesHrcLifecycleEventFilter, parseOptionalIntegerQuery } from './server-misc.js'
import { normalizeOptionalQuery, parseFromSeq } from './server-parsers.js'
import type { FollowSubscriber, HrcEventsRouteFilters } from './server-types.js'
import { encodeNdjson, json, serializeEvent } from './server-util.js'

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
    headers: NDJSON_HEADERS,
  })
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
  handleEvents,
  handleEventsLatestBySession,
}

export type EventHandlersMethods = typeof eventHandlersMethods
