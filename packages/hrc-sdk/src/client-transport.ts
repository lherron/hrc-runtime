import type { HrcHttpError, HrcLifecycleEvent } from 'hrc-core'
import { HrcDomainError, HrcErrorCode, getHrcCliRpcMetricsHook } from 'hrc-core'
import type {
  HrcSubscriberReceiptAckRequest,
  HrcSubscriberReceiptAckResponse,
  WatchOptions,
} from './types.js'

export const BASE_URL = 'http://hrc'

/**
 * Single source of truth for the event-filter projection shared by
 * `watch`, `listLatestEventBySession`, and `matchesWatchOptions`. Adding a new
 * filter field requires editing only this array (provided it exists on both
 * `WatchOptions`/`LatestEventBySessionFilter` and `HrcLifecycleEvent`).
 */
export const EVENT_FILTER_FIELDS = [
  'hostSessionId',
  'generation',
  'scopeRef',
  'laneRef',
  'runtimeId',
  'runId',
  'category',
  'eventKind',
  'sourceRef',
] as const satisfies ReadonlyArray<keyof HrcLifecycleEvent & keyof WatchOptions>

/** Maximum number of characters of a non-JSON error body to include in the thrown error. */
export const ERROR_BODY_EXCERPT_MAX = 200
/** Suffix appended when an error-body excerpt is truncated. */
export const ELLIPSIS = '…'

/**
 * Bun's `fetch` accepts a non-standard `unix` field to route a request over a
 * unix-domain socket. Modeling it here lets every fetch in this client inject
 * the socket path without an `as RequestInit` cast at each call site.
 */
export type BunRequestInit = RequestInit & { unix?: string }

export type QueryValue = string | number | boolean | readonly string[] | undefined

/** Coerce an empty string (or other falsy value) to `undefined` so `buildPath` drops it. */
export function emptyToUndefined<T extends string>(value: T | null | undefined): T | undefined {
  return value || undefined
}

export function boolField(value: boolean | null | undefined): 'true' | undefined {
  return value ? 'true' : undefined
}

/**
 * Build a path with an optional query string. Skips `undefined` values, joins
 * array values with commas, and only appends `?` when at least one param is set.
 */
/** Named delivery-consumer header for the commit-ordinal follow route (T-08608). */
export const SUBSCRIBER_NAME_HEADER = 'x-hrc-subscriber-name'

export function buildPath(base: string, params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      search.set(name, value.join(','))
    } else {
      search.set(name, String(value))
    }
  }
  const qs = search.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * Project the shared event-filter fields off a filter/options object into a
 * `buildPath`-compatible record. Undefined fields are carried through and
 * dropped by `buildPath`.
 */
export function eventFilterParams(
  source: Partial<Pick<WatchOptions, (typeof EVENT_FILTER_FIELDS)[number]>> | undefined
): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {}
  for (const field of EVENT_FILTER_FIELDS) {
    out[field] = source?.[field]
  }
  return out
}

export function matchesWatchOptions(
  event: HrcLifecycleEvent,
  options: WatchOptions | undefined
): boolean {
  if (!options) return true
  for (const field of EVENT_FILTER_FIELDS) {
    const expected = options[field]
    if (expected !== undefined && event[field] !== expected) {
      return false
    }
  }
  return true
}

export class HrcClientTransport {
  protected readonly socketPath: string

  constructor(socketPath: string | { socketPath: string }) {
    this.socketPath = typeof socketPath === 'string' ? socketPath : socketPath.socketPath
  }

  // -- HTTP primitives -------------------------------------------------------

  /**
   * Single transport choke-point: joins `path` onto `BASE_URL` and routes the
   * request over the unix socket. The Bun-specific `unix` field is injected
   * here so no call site needs an `as RequestInit` cast. Returns the raw
   * `Response` so streaming callers can consume `res.body` directly.
   */
  protected unixFetch(path: string, init: BunRequestInit = {}): Promise<Response> {
    const metrics = getHrcCliRpcMetricsHook()
    if (!metrics) {
      return fetch(`${BASE_URL}${path}`, { ...init, unix: this.socketPath })
    }

    const span = metrics.start(path, (init.method ?? 'GET').toUpperCase())
    const headers = new Headers(init.headers)
    headers.set('x-hrc-request-id', span.id)
    return fetch(`${BASE_URL}${path}`, { ...init, headers, unix: this.socketPath }).then(
      (response) => {
        span.finish(response.status, Number(response.headers.get('content-length')) || 0)
        void response
          .clone()
          .arrayBuffer()
          .then(
            (body) => span.finish(response.status, body.byteLength),
            () => undefined
          )
        return response
      },
      (error: unknown) => {
        span.finish(0, 0)
        throw error
      }
    )
  }

  protected async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.unixFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })

    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as T
  }

  protected async getJson<T>(path: string): Promise<T> {
    const res = await this.unixFetch(path, { method: 'GET' })

    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as T
  }

  protected async deleteJson<T>(path: string): Promise<T> {
    const res = await this.unixFetch(path, { method: 'DELETE' })
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as T
  }

  protected async throwTypedError(res: Response): Promise<never> {
    const cloned = res.clone()
    let body: HrcHttpError | undefined
    try {
      body = (await res.json()) as HrcHttpError
    } catch {
      let excerpt = ''
      try {
        const text = await cloned.text()
        excerpt =
          text.length > ERROR_BODY_EXCERPT_MAX
            ? `${text.slice(0, ERROR_BODY_EXCERPT_MAX)}${ELLIPSIS}`
            : text
      } catch {
        // ignore text extraction failure
      }
      const suffix = excerpt ? `: ${excerpt}` : ''
      throw new Error(`HRC request failed with status ${res.status}${suffix}`)
    }

    if (body?.error) {
      throw new HrcDomainError(body.error.code, typedResponseErrorMessage(body), body.error.detail)
    }
    throw new Error(`HRC request failed with status ${res.status}`)
  }

  /**
   * Shared NDJSON streaming loop: opens a streaming fetch, decodes/buffers/splits
   * on `\n`, JSON-parses each complete line (swallowing malformed lines), honors
   * the optional AbortSignal, and flushes any trailing partial line at the end.
   * An optional `predicate` filters which parsed values are yielded.
   */
  protected async *streamNdjson<T>(
    path: string,
    init: BunRequestInit,
    signal?: AbortSignal,
    predicate?: ((value: T) => boolean) | undefined,
    receiptSeq?: ((value: T) => number | undefined) | undefined
  ): AsyncIterable<T> {
    const res = await this.unixFetch(path, init)

    if (!res.ok) {
      await this.throwTypedError(res)
    }

    const body = res.body
    if (!body) return

    const subscriberId = res.headers.get('x-hrc-subscriber-id')?.trim()
    const receiptToken = res.headers.get('x-hrc-receipt-token')?.trim()
    const receiptAckPath = res.headers.get('x-hrc-receipt-ack-path')?.trim()
    const receiptEnabled =
      subscriberId !== undefined &&
      subscriberId.length > 0 &&
      receiptToken !== undefined &&
      receiptToken.length > 0 &&
      receiptAckPath !== undefined &&
      receiptAckPath.length > 0 &&
      receiptSeq !== undefined

    // Malformed lines are skipped (M-10). A receipt ACK is sent only after a
    // complete NDJSON value is decoded; ACK failure leaves the daemon's receipt
    // cursor honestly behind and a later cumulative ACK can catch it up.
    const parse = (raw: string): T | undefined => {
      const trimmed = raw.trim()
      if (trimmed.length === 0) return undefined
      try {
        return JSON.parse(trimmed) as T
      } catch {
        return undefined
      }
    }
    const acknowledge = async (value: T): Promise<void> => {
      if (
        !receiptEnabled ||
        subscriberId === undefined ||
        receiptToken === undefined ||
        receiptAckPath === undefined ||
        receiptSeq === undefined
      ) {
        return
      }
      const seq = receiptSeq(value)
      if (seq === undefined || !Number.isSafeInteger(seq) || seq < 1) return
      await this.postJson<HrcSubscriberReceiptAckResponse>(receiptAckPath, {
        subscriberId,
        receiptToken,
        seq,
      } satisfies HrcSubscriberReceiptAckRequest).catch(() => undefined)
    }

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of body) {
      if (signal?.aborted) return
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const value = parse(line)
        if (value === undefined) continue
        await acknowledge(value)
        if (!predicate || predicate(value)) yield value
        if (signal?.aborted) return
      }
    }

    // Flush any remaining content
    const value = parse(buffer)
    if (value !== undefined) {
      await acknowledge(value)
      if (!predicate || predicate(value)) yield value
    }
  }
}

function typedResponseErrorMessage(body: HrcHttpError): string {
  const { code, message, detail } = body.error
  if (code !== HrcErrorCode.INTERNAL_ERROR) {
    return message
  }

  const cause = boundedDetailString(detail['cause'])
  const requestId = boundedDetailString(detail['requestId'])
  return `${message} [${code}]${cause ? `: ${cause}` : ''}${
    requestId ? ` (requestId=${requestId})` : ''
  }`
}

function boundedDetailString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.length > ERROR_BODY_EXCERPT_MAX
    ? `${trimmed.slice(0, ERROR_BODY_EXCERPT_MAX)}${ELLIPSIS}`
    : trimmed
}
