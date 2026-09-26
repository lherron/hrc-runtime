import { HrcBadRequestError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type {
  GetInputResponse,
  HrcEventEnvelope,
  HrcLifecycleEvent,
  WatchInputEvent,
} from 'hrc-core'

import {
  HRC_EVENTS_KEEPALIVE_MS,
  NDJSON_HEADERS,
  STREAMING_NDJSON_HEADERS,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseFromSeq } from './server-parsers.js'
import { encodeNdjson, json } from './server-util.js'

export type InputRoute = {
  inputId: string
  watch: boolean
}

/** Recognize the two exact input routes without treating an encoded slash as an id. */
export function matchInputRoute(method: string, pathname: string): InputRoute | undefined {
  if (method !== 'GET' || !pathname.startsWith('/v1/inputs/')) return undefined

  const suffix = pathname.slice('/v1/inputs/'.length)
  const watch = suffix.endsWith('/watch')
  const encodedInputId = watch ? suffix.slice(0, -'/watch'.length) : suffix
  if (encodedInputId.length === 0 || encodedInputId.includes('/')) return undefined

  let inputId: string
  try {
    inputId = decodeURIComponent(encodedInputId)
  } catch {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'input id is not URI encoded')
  }
  if (inputId.length === 0 || inputId.includes('/')) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'input id is required')
  }
  return { inputId, watch }
}

function requireInput(this: HrcServerInstanceForHandlers, inputId: string) {
  const input = this.db.inputs.getByInputId(inputId)
  if (input === null) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_INPUT, `unknown input ${inputId}`, { inputId })
  }
  return input
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function inputEventFromLifecycle(
  event: HrcLifecycleEvent,
  inputId: string
): WatchInputEvent | undefined {
  if (event.category !== 'input') return undefined
  const payload = event.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const fields = payload as Record<string, unknown>
  if (fields['inputId'] !== inputId) return undefined

  switch (event.eventKind) {
    case 'input.landed': {
      const kind = fields['kind']
      const carrierRunId = stringField(fields, 'carrierRunId')
      const turnId = stringField(fields, 'turnId')
      const brokerSubmissionId = stringField(fields, 'brokerSubmissionId')
      const runStartedHrcSeq = fields['runStartedHrcSeq']
      if (
        (kind !== 'initiating' && kind !== 'joined') ||
        carrierRunId === undefined ||
        turnId === undefined ||
        brokerSubmissionId === undefined ||
        typeof runStartedHrcSeq !== 'number' ||
        !Number.isSafeInteger(runStartedHrcSeq) ||
        runStartedHrcSeq < 1
      ) {
        return undefined
      }
      return {
        type: 'landing',
        inputId,
        kind,
        carrierRunId,
        turnId,
        brokerSubmissionId,
        runStartedHrcSeq,
      }
    }
    case 'input.terminal': {
      const terminal = fields['terminal']
      if (terminal !== 'rejected' && terminal !== 'withdrawn') return undefined
      const error = fields['error']
      const errorObject =
        error !== null && typeof error === 'object' && !Array.isArray(error)
          ? (error as Record<string, unknown>)
          : undefined
      const code = errorObject === undefined ? undefined : stringField(errorObject, 'code')
      const message = errorObject === undefined ? undefined : stringField(errorObject, 'message')
      return {
        type: 'terminal',
        inputId,
        terminal,
        ...(code === undefined && message === undefined
          ? {}
          : {
              error: {
                ...(code === undefined ? {} : { code }),
                ...(message === undefined ? {} : { message }),
              },
            }),
      }
    }
    case 'input.correlation': {
      const fact = fields['fact']
      if (
        fact !== 'lost' &&
        fact !== 'expired' &&
        fact !== 'cancelled' &&
        fact !== 'invocation_failed' &&
        fact !== 'invocation_exited'
      ) {
        return undefined
      }
      const detail = fields['detail']
      return {
        type: 'correlation',
        inputId,
        fact,
        ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
      }
    }
    default:
      return undefined
  }
}

function replayInputEvents(
  this: HrcServerInstanceForHandlers,
  inputId: string,
  fromSeq: number
): Array<{ hrcSeq: number; event: WatchInputEvent }> {
  return this.db.hrcEvents.listFromHrcSeq(fromSeq).flatMap((event) => {
    const inputEvent = inputEventFromLifecycle(event, inputId)
    return inputEvent === undefined ? [] : [{ hrcSeq: event.hrcSeq, event: inputEvent }]
  })
}

export function handleGetInput(this: HrcServerInstanceForHandlers, inputId: string): Response {
  return json({ input: requireInput.call(this, inputId) } satisfies GetInputResponse)
}

export function handleWatchInput(
  this: HrcServerInstanceForHandlers,
  inputId: string,
  url: URL,
  request: Request
): Response {
  requireInput.call(this, inputId)
  const fromSeq = parseFromSeq(url.searchParams.get('fromSeq'))
  const follow = url.searchParams.get('follow') === 'true'

  if (!follow) {
    const replay = replayInputEvents.call(this, inputId, fromSeq)
    return new Response(replay.map(({ event }) => `${JSON.stringify(event)}\n`).join(''), {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  let replayHighWater = fromSeq - 1
  const buffered: Array<{ hrcSeq: number; event: WatchInputEvent }> = []
  let keepalive: ReturnType<typeof setInterval> | undefined

  const enqueue = (event: WatchInputEvent): void => {
    if (!closed && controller !== undefined) controller.enqueue(encodeNdjson(event))
  }
  const subscriber = (event: HrcLifecycleEvent | HrcEventEnvelope): void => {
    if (!('hrcSeq' in event)) return
    if (event.hrcSeq < fromSeq) return
    const inputEvent = inputEventFromLifecycle(event, inputId)
    if (inputEvent === undefined) return
    if (controller === undefined) {
      buffered.push({ hrcSeq: event.hrcSeq, event: inputEvent })
    } else if (event.hrcSeq > replayHighWater) {
      enqueue(inputEvent)
    }
  }
  const close = (): void => {
    if (closed) return
    closed = true
    this.followSubscribers.delete(subscriber)
    this.activeStreamClosers.delete(close)
    if (keepalive !== undefined) clearInterval(keepalive)
    try {
      controller?.close()
    } catch {
      // Client cancellation may have already closed the stream.
    }
  }

  this.followSubscribers.add(subscriber)
  this.activeStreamClosers.add(close)

  const stream = new ReadableStream<Uint8Array>({
    start: (nextController) => {
      controller = nextController
      const replay = replayInputEvents.call(this, inputId, fromSeq)
      replayHighWater = this.db.hrcEvents.maxHrcSeq()
      for (const { event } of replay) enqueue(event)
      for (const { hrcSeq, event } of buffered) {
        if (hrcSeq > replayHighWater) enqueue(event)
      }
      buffered.length = 0
      keepalive = setInterval(() => {
        if (!closed) enqueueKeepalive(controller)
      }, HRC_EVENTS_KEEPALIVE_MS)
      request.signal.addEventListener('abort', close, { once: true })
    },
    cancel: close,
  })
  return new Response(stream, { status: 200, headers: STREAMING_NDJSON_HEADERS })
}

function enqueueKeepalive(
  controller: ReadableStreamDefaultController<Uint8Array> | undefined
): void {
  try {
    controller?.enqueue(new TextEncoder().encode('\n'))
  } catch {
    // The transport is closed; its cancellation path clears the subscription.
  }
}
