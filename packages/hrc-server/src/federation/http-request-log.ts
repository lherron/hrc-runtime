import type { Server } from 'bun'

import { writeServerLog } from '../server-log.js'

/**
 * L3 of the Praesidium logging standard: one `http.request` line per request
 * on a federation HTTP listener, written at completion. Shape and exclusions
 * follow ACP's `acp-server/src/request-log.ts`: method, path (no query
 * string), status, duration and remote address; never bodies or headers. For
 * a non-2xx JSON response only the error `code` and `message` are lifted.
 * Federation listeners serve no streams, so there is no stream open/close.
 */
export function withRequestLog(
  handler: (request: Request) => Promise<Response>
): (request: Request, server: Server<unknown>) => Promise<Response> {
  return async (request, server) => {
    const startedAt = performance.now()
    const line = (status: number) => ({
      method: request.method,
      path: new URL(request.url).pathname,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      remote: server.requestIP(request)?.address ?? null,
    })
    let response: Response
    try {
      response = await handler(request)
    } catch (error) {
      // Bun answers an escaped throw with its own 500; the line still lands.
      writeServerLog('ERROR', 'http.request', line(500))
      throw error
    }
    const data: Record<string, unknown> = line(response.status)
    if (response.ok) {
      writeServerLog('INFO', 'http.request', data)
      return response
    }
    const errorFields = await readErrorFields(response)
    writeServerLog(response.status >= 500 ? 'ERROR' : 'WARN', 'http.request', {
      ...data,
      ...errorFields,
    })
    return response
  }
}

async function readErrorFields(response: Response): Promise<Record<string, unknown>> {
  if (response.headers.get('content-type')?.includes('json') !== true) return {}
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return {}
  }
  if (typeof body !== 'object' || body === null) return {}
  // Two error shapes: the peer protocol's `{error: {code, message}}` and the
  // registry's `{error: '<code>'}`.
  const error = (body as Record<string, unknown>)['error']
  if (typeof error === 'string') return { code: error }
  if (typeof error !== 'object' || error === null) return {}
  const fields: Record<string, unknown> = {}
  const { code, message } = error as Record<string, unknown>
  if (typeof code === 'string') fields['code'] = code
  if (typeof message === 'string') fields['message'] = message.slice(0, 500)
  return fields
}
