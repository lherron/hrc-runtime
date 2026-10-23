import type { RequestMetricListener } from './request-metrics.js'
import { writeServerLog } from './server-log.js'

/**
 * L3 of the Praesidium logging standard (var/agents/references/logging.md,
 * "L3 — Request line"): one `http.request` line per request on every daemon
 * listener, at completion, `component: http`. Shape follows ACP's
 * `acp-server/src/request-log.ts`. Never logged: bodies, query strings, or any
 * header but the client name; for a non-2xx JSON response only the error
 * `code` and `message` are lifted. Streams log `http.stream.open` and
 * `http.stream.close`, never per frame.
 */

export type SuppressedPollRoute = {
  readonly listener: RequestMetricListener
  readonly method: string
  readonly route: string
}

/**
 * THE L3 poll-suppression allowlist: the only routes whose SUCCESSFUL,
 * non-stream responses write no `http.request` line. One entry per listener +
 * method + route template; nothing else may suppress a request line. These are
 * the 16 polling routes behind 53.35M of the 53.66M main-socket requests in the
 * 14 days to 2026-10-23 (T-11541 audit); everything else is ~22k lines a day.
 * A failing poll (>= 400) and a stream are always logged, and the sampled
 * request metrics still count every request, weighted. Consumers (service-API
 * §6 route marking, `hrc admin metrics routes`) read this table, so an absent
 * log line on these routes means "suppressed poll", never "dead route".
 */
export const L3_SUPPRESSED_SUCCESSFUL_POLL_ROUTES: readonly SuppressedPollRoute[] = [
  { listener: 'main', method: 'GET', route: '/v1/broker-events/follow' },
  { listener: 'main', method: 'GET', route: '/v1/events' },
  { listener: 'main', method: 'POST', route: '/v1/server/subscribers' },
  { listener: 'main', method: 'GET', route: '/v1/sessions/by-host/:hostSessionId' },
  { listener: 'main', method: 'GET', route: '/v1/targets/by-session-ref' },
  { listener: 'main', method: 'GET', route: '/v1/federation/locate' },
  { listener: 'main', method: 'GET', route: '/v1/broker-events/query' },
  { listener: 'main', method: 'GET', route: '/v1/runtimes' },
  { listener: 'main', method: 'POST', route: '/v1/runtimes/inspect' },
  { listener: 'main', method: 'GET', route: '/v1/sessions' },
  { listener: 'main', method: 'GET', route: '/v1/events/latest-by-session' },
  { listener: 'main', method: 'GET', route: '/v1/runs' },
  { listener: 'main', method: 'POST', route: '/v1/server/subscribers/ack' },
  { listener: 'main', method: 'GET', route: '/v1/events/page' },
  { listener: 'main', method: 'GET', route: '/v1/status' },
  { listener: 'main', method: 'GET', route: '/v1/presentation/runtimes' },
]

const SUPPRESSED_POLL_KEYS = new Set(
  L3_SUPPRESSED_SUCCESSFUL_POLL_ROUTES.map(
    ({ listener, method, route }) => `${listener} ${method} ${route}`
  )
)

/** Whether a successful, non-stream request on this route writes no request line. */
export function isSuppressedPollRoute(listener: string, method: string, route: string): boolean {
  return SUPPRESSED_POLL_KEYS.has(`${listener} ${method} ${route}`)
}

export type RequestLogEntry = {
  listener: RequestMetricListener
  method: string
  route: string
  /** Pathname only: never the query string. */
  path: string
  client: string
  requestId?: string | undefined
  /** TCP listeners only. */
  remote?: string | undefined
  /** Federation listeners: the node the request's bearer token authenticated as. */
  peer?: string | undefined
  /** `performance.now()` when the request arrived; a stream's close measures from it. */
  startedAt: number
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/**
 * Log one completed request and return the response to send. A stream's body
 * is wrapped so its close is logged with the stream's full duration.
 */
export function logRequestCompletion(entry: RequestLogEntry, response: Response): Response {
  const base = (status: number): Record<string, unknown> => ({
    listener: entry.listener,
    method: entry.method,
    route: entry.route,
    path: entry.path,
    status,
    durationMs: elapsedMs(entry),
    client: entry.client,
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    ...(entry.remote ? { remote: entry.remote } : {}),
    ...(entry.peer ? { peer: entry.peer } : {}),
  })

  if (response.status < 400) {
    if (isStream(response)) {
      emit('INFO', 'http.stream.open', base(response.status))
      return wrapStreamClose(response, base)
    }
    if (!isSuppressedPollRoute(entry.listener, entry.method, entry.route)) {
      emit('INFO', 'http.request', base(response.status))
    }
    return response
  }

  const level: LogLevel = response.status >= 500 ? 'ERROR' : 'WARN'
  if (response.headers.get('content-type')?.includes('json') !== true) {
    emit(level, 'http.request', base(response.status))
    return response
  }
  void response
    .clone()
    .json()
    .then(
      (body: unknown) =>
        emit(level, 'http.request', { ...base(response.status), ...errorFields(body) }),
      () => emit(level, 'http.request', base(response.status))
    )
  return response
}

/** A handler threw past every catch: Bun answers with its own 500; the line still lands. */
export function logRequestEscaped(entry: RequestLogEntry): void {
  emit('ERROR', 'http.request', {
    listener: entry.listener,
    method: entry.method,
    route: entry.route,
    path: entry.path,
    status: 500,
    durationMs: elapsedMs(entry),
    client: entry.client,
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    ...(entry.remote ? { remote: entry.remote } : {}),
    ...(entry.peer ? { peer: entry.peer } : {}),
  })
}

function wrapStreamClose(
  response: Response,
  base: (status: number) => Record<string, unknown>
): Response {
  const source = response.body
  if (source === null) return response
  const reader = source.getReader()
  let closed = false
  const close = (outcome: 'end' | 'cancel' | 'error') => {
    if (closed) return
    closed = true
    emit(outcome === 'error' ? 'WARN' : 'INFO', 'http.stream.close', {
      ...base(response.status),
      outcome,
    })
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          close('end')
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        close('error')
        controller.error(error)
      }
    },
    async cancel(reason) {
      close('cancel')
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Two error shapes: HRC's `{error: {code, message}}` and the federation
 * registry's `{error: '<code>'}`. Nothing else is lifted from a body.
 */
function errorFields(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}
  const error = (body as Record<string, unknown>)['error']
  if (typeof error === 'string') return { code: error }
  if (typeof error !== 'object' || error === null) return {}
  const fields: Record<string, unknown> = {}
  const { code, message } = error as Record<string, unknown>
  if (typeof code === 'string') fields['code'] = code
  if (typeof message === 'string') fields['message'] = message.slice(0, 500)
  return fields
}

function isStream(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  return (
    response.body !== null &&
    (response.headers.get('x-hrc-streaming') === '1' || contentType.includes('text/event-stream'))
  )
}

function elapsedMs(entry: RequestLogEntry): number {
  return Number((performance.now() - entry.startedAt).toFixed(1))
}

function emit(level: LogLevel, event: string, data: Record<string, unknown>): void {
  writeServerLog(level, event, data, { component: 'http' })
}
