import type { HrcMessageFilter, HrcMessageRecord, WaitMessageResponse } from 'hrc-core'
import { matchesMessageFilter, parseMessageFilter } from './messages.js'
import { NDJSON_HEADERS } from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import type { MessageSubscriber } from './server-types.js'
import { encodeNdjson, json } from './server-util.js'

export async function waitForMessage(
  this: HrcServerInstanceForHandlers,
  filter: HrcMessageFilter,
  timeoutMs: number
): Promise<WaitMessageResponse> {
  // Use buffered subscriber pattern to avoid replay/subscribe race
  const buffered: HrcMessageRecord[] = []
  let resolveWait: ((result: WaitMessageResponse) => void) | null = null
  let settled = false

  const subscriber: MessageSubscriber = (record) => {
    if (settled) return
    if (matchesMessageFilter(record, filter)) {
      if (resolveWait) {
        settled = true
        resolveWait({ matched: true, record })
      } else {
        buffered.push(record)
      }
    }
  }

  this.messageSubscribers.add(subscriber)

  try {
    // Replay existing messages that match
    const existing = this.db.messages.query(filter)
    const first = existing[0]
    if (first) {
      return { matched: true, record: first }
    }

    // Check buffered messages that arrived during replay
    for (const record of buffered) {
      if (matchesMessageFilter(record, filter)) {
        return { matched: true, record }
      }
    }

    // Block until match or timeout
    return await new Promise<WaitMessageResponse>((resolve) => {
      resolveWait = resolve
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve({ matched: false, reason: 'timeout' })
        }
      }, timeoutMs)
    })
  } finally {
    this.messageSubscribers.delete(subscriber)
  }
}

export async function handleWaitMessage(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  const filter = parseMessageFilter(isRecord(body) ? body : {})
  const timeoutMs =
    isRecord(body) && typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : 30_000

  const result = await this.waitForMessage(filter, timeoutMs)
  return json(result satisfies WaitMessageResponse)
}

export async function handleWatchMessages(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request).catch(() => ({}))
  const parsedBody = isRecord(body) ? body : {}
  const filter = parseMessageFilter(parsedBody)
  const follow = parsedBody['follow'] === true
  const timeoutMs =
    typeof parsedBody['timeoutMs'] === 'number' ? parsedBody['timeoutMs'] : undefined

  if (!follow) {
    const messages = this.db.messages.query(filter)
    return new Response(messages.map((m) => `${JSON.stringify(m)}\n`).join(''), {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  // Streaming follow mode — mirrors handleEvents pattern
  const bufferedMessages: HrcMessageRecord[] = []
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let replayHighWater = (filter.afterSeq ?? 0) - 1
  let closed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const subscriber: MessageSubscriber = (record) => {
    if (closed) return
    if (!matchesMessageFilter(record, filter)) return

    if (controllerRef) {
      if (record.messageSeq > replayHighWater) {
        controllerRef.enqueue(encodeNdjson(record))
      }
      return
    }

    bufferedMessages.push(record)
  }

  this.messageSubscribers.add(subscriber)
  const close = () => {
    if (closed) return
    closed = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    this.messageSubscribers.delete(subscriber)
    bufferedMessages.length = 0
    try {
      controllerRef?.close()
    } catch {
      // Stream may already be closed
    } finally {
      controllerRef = null
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const replayMessages = this.db.messages.query(filter)
      replayHighWater = replayMessages.at(-1)?.messageSeq ?? replayHighWater
      controllerRef = controller
      controller.enqueue(new TextEncoder().encode('\n'))

      for (const msg of replayMessages) {
        controller.enqueue(encodeNdjson(msg))
      }

      for (const msg of bufferedMessages) {
        if (msg.messageSeq > replayHighWater) {
          controller.enqueue(encodeNdjson(msg))
        }
      }

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutTimer = setTimeout(close, timeoutMs)
      }

      request.signal.addEventListener('abort', close, { once: true })
    },
    cancel: () => close(),
  })

  return new Response(stream, {
    status: 200,
    headers: NDJSON_HEADERS,
  })
}

export const selectorWaitHandlersMethods = {
  waitForMessage,
  handleWaitMessage,
  handleWatchMessages,
}

export type SelectorWaitHandlersMethods = typeof selectorWaitHandlersMethods
