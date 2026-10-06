/**
 * T-10418 — scope-home routing for session, event and run READS.
 *
 * `routeScopeRead` is the one decision every scope-keyed read makes before it
 * touches local continuity: home authority first, never "a local row exists".
 * A shadow continuity on a node whose scope is bound elsewhere is never
 * served, a locally retired scope is never read locally, and a registry that
 * cannot answer is a retryable refusal rather than `found:false`.
 *
 * Forwarding stays inside HRC: the peer token egresses only through
 * `buildPeerProtocolHeaders`, and the home answers its peer surface localOnly,
 * so a forwarded read can never take a second hop.
 *
 * The bounded-stream relay is record-level (hrc-runtime.bounded-lifecycle-
 * event-observation): one peer record per downstream pull, an idle bound only
 * while a peer read is outstanding, and exactly one terminal per stream.
 */

import { HrcDomainError, HrcErrorCode, formatCanonicalScopeRef } from 'hrc-core'
import type { HrcBoundedEventStreamRecord } from 'hrc-core'

import {
  HRC_BOUNDED_EVENTS_MAX_BYTES,
  HRC_EVENTS_KEEPALIVE_MS,
  STREAMING_NDJSON_HEADERS,
} from '../server-constants.js'
import { writeServerLog } from '../server-log.js'
import type { FederationConfig, PeerEntry } from './federation-config.js'
import { homeAuthorityDeps, resolveHomeAuthority } from './home-authority.js'
import type { HomeAuthorityDeps } from './home-authority.js'
import { buildPeerProtocolHeaders } from './peer-request.js'

export const HOME_NODE_HEADER = 'x-hrc-home-node'
/** Connecting and receiving response headers from the home. */
export const SCOPE_READ_CONNECT_TIMEOUT_MS = 10_000
/** Idle bound on ONE outstanding peer read: three missed keepalives. */
export const SCOPE_READ_IDLE_TIMEOUT_MS = 3 * HRC_EVENTS_KEEPALIVE_MS

export type ScopeReadTimeouts = {
  readonly connectMs?: number | undefined
  readonly idleMs?: number | undefined
}

export type ScopeReadServer = Parameters<typeof homeAuthorityDeps>[0] & {
  readonly options: {
    readonly federationConfig?: FederationConfig | undefined
    /** Tests shorten the relay timers; production never sets these. */
    readonly scopeReadTimeouts?: ScopeReadTimeouts | undefined
  }
}

export type ScopeReadRoute =
  | { readonly kind: 'local' }
  | { readonly kind: 'forward'; readonly homeNodeId: string; readonly peer: PeerEntry }

/** Only agent scopes are ever placed; anything else (e.g. `server:hrc`) reads locally. */
function placeableScope(scopeRef: string): string | undefined {
  try {
    return formatCanonicalScopeRef({ scopeRef })
  } catch {
    return undefined
  }
}

function homeDeps(server: ScopeReadServer): HomeAuthorityDeps {
  const deps = homeAuthorityDeps(server, (scopeRef, error) => {
    writeServerLog('WARN', 'federation.scope_read.home_consult_failed', {
      scopeRef,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  // An unconfigured node has no other node to learn about: nothing is foreign.
  return server.options.federationConfig?.sourceExists === true
    ? deps
    : { ...deps, registry: undefined }
}

/**
 * The §1 table. Throws the retryable 503 refusals; returns local or forward.
 */
export async function routeScopeRead(
  server: ScopeReadServer,
  rawScopeRef: string
): Promise<ScopeReadRoute> {
  const scopeRef = placeableScope(rawScopeRef)
  if (scopeRef === undefined) return { kind: 'local' }
  const { local, authority } = await resolveHomeAuthority(homeDeps(server), scopeRef)
  if (authority.state === 'unknown') {
    throw new HrcDomainError(
      HrcErrorCode.SESSION_HOME_UNKNOWN,
      'the registry could not say where this scope is homed',
      { scopeRef, detail: authority.detail, retryable: true }
    )
  }
  if (authority.state === 'unbound') {
    if (local?.state === 'retired') {
      throw new HrcDomainError(
        HrcErrorCode.SESSION_HOME_PENDING,
        'this node retired the scope and no current home is bound yet',
        { scopeRef, retiredAt: local.retiredAt, retryable: true }
      )
    }
    return { kind: 'local' }
  }
  if (authority.isLocal) return { kind: 'local' }
  const homeNodeId = authority.record.homeNodeId
  const peer = [...(server.options.federationConfig?.peers.values() ?? [])].find(
    (candidate) => String(candidate.nodeId) === homeNodeId
  )
  if (peer === undefined) {
    throw homeUnreachable(scopeRef, homeNodeId, 'home peer is not declared in federation.json')
  }
  return { kind: 'forward', homeNodeId, peer }
}

function homeUnreachable(scopeRef: string, homeNodeId: string, detail: string): HrcDomainError {
  return new HrcDomainError(
    HrcErrorCode.SESSION_HOME_UNREACHABLE,
    `session home ${homeNodeId} is unreachable`,
    { scopeRef, homeNodeId, detail, retryable: true }
  )
}

type ForwardInput = {
  readonly route: Extract<ScopeReadRoute, { kind: 'forward' }>
  readonly scopeRef: string
  readonly url: URL
  readonly method?: 'GET' | 'POST' | 'PATCH' | undefined
  readonly body?: string | undefined
  readonly principalRef?: string | null | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * Connect and receive headers within the bound. Any failure in that window is
 * `session_home_unreachable`; the returned abort controller owns the body.
 */
async function openPeer(
  server: ScopeReadServer,
  input: ForwardInput
): Promise<{ response: Response; abort: AbortController }> {
  const abort = new AbortController()
  const onClientAbort = () => abort.abort()
  if (input.signal?.aborted) abort.abort()
  input.signal?.addEventListener('abort', onClientAbort, { once: true })
  const connectMs = server.options.scopeReadTimeouts?.connectMs ?? SCOPE_READ_CONNECT_TIMEOUT_MS
  const timer = setTimeout(() => abort.abort(), connectMs)
  try {
    const response = await fetch(
      new URL(input.url.pathname + input.url.search, input.route.peer.endpoint),
      {
        method: input.method ?? 'GET',
        headers: {
          ...buildPeerProtocolHeaders(input.route.peer, {
            contentType: input.body === undefined ? undefined : 'application/json',
          }),
          ...(input.principalRef ? { 'x-hrc-principal-ref': input.principalRef } : {}),
        },
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: abort.signal,
      }
    )
    return { response, abort }
  } catch (error) {
    abort.abort()
    throw homeUnreachable(
      input.scopeRef,
      input.route.homeNodeId,
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Read a whole body, refusing past the page ceiling instead of buffering it. */
async function readCappedText(
  response: Response,
  input: ForwardInput,
  maxBytes: number
): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HrcDomainError(
          HrcErrorCode.SESSION_HOME_MALFORMED,
          `session home ${input.route.homeNodeId} returned a page over the relay ceiling`,
          {
            scopeRef: input.scopeRef,
            homeNodeId: input.route.homeNodeId,
            maxBytes,
            retryable: true,
          }
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof HrcDomainError) throw error
    throw homeUnreachable(
      input.scopeRef,
      input.route.homeNodeId,
      error instanceof Error ? error.message : String(error)
    )
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A peer-protocol refusal (`{ok:false,...}`: auth, missing route, read-only)
 * is not an answer about the session. It means the home could not serve it.
 */
function isPeerProtocolRefusal(body: unknown): boolean {
  return (
    body !== null && typeof body === 'object' && (body as Record<string, unknown>)['ok'] === false
  )
}

/**
 * Forward one JSON read (or the existing metadata PATCH) to the home and
 * relay its status and body, tagged with the home node.
 */
export async function forwardScopeJson(
  server: ScopeReadServer,
  input: ForwardInput & {
    readonly decorate?: ((body: unknown, status: number) => unknown) | undefined
  }
): Promise<Response> {
  const { response, abort } = await openPeer(server, input)
  let text: string
  try {
    text = await readCappedText(response, input, HRC_BOUNDED_EVENTS_MAX_BYTES)
  } finally {
    abort.abort()
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HrcDomainError(
      HrcErrorCode.SESSION_HOME_MALFORMED,
      `session home ${input.route.homeNodeId} returned a non-JSON body`,
      { scopeRef: input.scopeRef, homeNodeId: input.route.homeNodeId, status: response.status }
    )
  }
  if (isPeerProtocolRefusal(body)) {
    throw homeUnreachable(
      input.scopeRef,
      input.route.homeNodeId,
      `peer refused with ${response.status}: ${JSON.stringify((body as { error?: unknown }).error ?? null)}`
    )
  }
  return new Response(JSON.stringify(input.decorate?.(body, response.status) ?? body), {
    status: response.status,
    headers: {
      'content-type': 'application/json',
      [HOME_NODE_HEADER]: input.route.homeNodeId,
    },
  })
}

type RelayTerminalReason = Extract<
  HrcBoundedEventStreamRecord,
  { type: 'home_unreachable' }
>['reason']

const NEWLINE = 0x0a
const KEEPALIVE = new Uint8Array([NEWLINE])

/**
 * Relay the home's bounded follow stream record by record. Non-200 answers
 * (cursor_invalid and friends) relay as JSON before any stream exists.
 */
export async function forwardBoundedStream(
  server: ScopeReadServer,
  input: ForwardInput
): Promise<Response> {
  const { response, abort } = await openPeer(server, input)
  if (response.status !== 200 || response.body === null) {
    let text: string
    try {
      text = await readCappedText(response, input, HRC_BOUNDED_EVENTS_MAX_BYTES)
    } finally {
      abort.abort()
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (body === undefined || isPeerProtocolRefusal(body)) {
      throw homeUnreachable(
        input.scopeRef,
        input.route.homeNodeId,
        `peer answered ${response.status} before the stream`
      )
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'content-type': 'application/json', [HOME_NODE_HEADER]: input.route.homeNodeId },
    })
  }

  const homeNodeId = input.route.homeNodeId
  const idleMs = server.options.scopeReadTimeouts?.idleMs ?? SCOPE_READ_IDLE_TIMEOUT_MS
  const maxBytes = HRC_BOUNDED_EVENTS_MAX_BYTES
  const reader = response.body.getReader()
  let pending = new Uint8Array(0)
  let finished = false

  const release = () => {
    finished = true
    pending = new Uint8Array(0)
    abort.abort()
    reader.cancel().catch(() => undefined)
  }

  const terminal = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: RelayTerminalReason
  ) => {
    writeServerLog('WARN', 'federation.scope_read.relay_terminal', {
      scopeRef: input.scopeRef,
      homeNodeId,
      reason,
    })
    const record: HrcBoundedEventStreamRecord = {
      type: 'home_unreachable',
      homeNodeId,
      retryable: true,
      reason,
    }
    release()
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify(record)}\n`))
    controller.close()
  }

  /** One outstanding peer read, bounded by the idle timer. */
  const readOnce = async (): Promise<
    { kind: 'chunk'; value: Uint8Array } | { kind: 'done' } | { kind: 'idle' } | { kind: 'error' }
  > => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<{ kind: 'idle' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'idle' }), idleMs)
    })
    try {
      return await Promise.race([
        reader.read().then(
          (result) =>
            result.done
              ? ({ kind: 'done' } as const)
              : ({ kind: 'chunk', value: result.value } as const),
          () => ({ kind: 'error' }) as const
        ),
        idle,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const pull = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (finished) return
    for (;;) {
      const newline = pending.indexOf(NEWLINE)
      if (newline >= 0) {
        const line = pending.subarray(0, newline)
        pending = pending.slice(newline + 1)
        if (line.byteLength === 0) {
          controller.enqueue(KEEPALIVE)
          return
        }
        if (line.byteLength + 1 > maxBytes) return terminal(controller, 'oversize')
        let record: unknown
        try {
          record = JSON.parse(new TextDecoder().decode(line))
        } catch {
          return terminal(controller, 'malformed')
        }
        const type =
          record !== null && typeof record === 'object' && !Array.isArray(record)
            ? (record as Record<string, unknown>)['type']
            : undefined
        if (typeof type !== 'string') return terminal(controller, 'malformed')
        // Event and gap records pass through byte-for-byte; the relay never rewrites them.
        const bytes = new Uint8Array(line.byteLength + 1)
        bytes.set(line)
        bytes[line.byteLength] = NEWLINE
        controller.enqueue(bytes)
        if (type === 'ledger_replaced' || type === 'home_unreachable') {
          release()
          controller.close()
        }
        return
      }
      if (pending.byteLength > maxBytes) return terminal(controller, 'oversize')
      const next = await readOnce()
      if (finished) return
      if (next.kind === 'idle') return terminal(controller, 'idle_timeout')
      if (next.kind === 'done' || next.kind === 'error') {
        if (input.signal?.aborted) {
          release()
          return
        }
        return terminal(controller, 'disconnected')
      }
      const merged = new Uint8Array(pending.byteLength + next.value.byteLength)
      merged.set(pending)
      merged.set(next.value, pending.byteLength)
      pending = merged
    }
  }

  input.signal?.addEventListener('abort', release, { once: true })
  const stream = new ReadableStream<Uint8Array>(
    { pull, cancel: release },
    { highWaterMark: 1, size: () => 1 }
  )
  return new Response(stream, {
    status: 200,
    headers: { ...STREAMING_NDJSON_HEADERS, [HOME_NODE_HEADER]: homeNodeId },
  })
}

/**
 * The shared door for the three GET reads: route by the filter's scopeRef and
 * forward when foreign. `undefined` means "serve locally". A hostSessionId-only
 * filter carries no scope and is never forwarded.
 */
export async function forwardScopedGet(
  server: ScopeReadServer,
  url: URL,
  options: { readonly stream?: boolean | undefined; readonly signal?: AbortSignal | undefined } = {}
): Promise<Response | undefined> {
  const scopeRef = url.searchParams.get('scopeRef')?.trim()
  if (!scopeRef) return undefined
  const route = await routeScopeRead(server, scopeRef)
  if (route.kind === 'local') return undefined
  const input: ForwardInput = { route, scopeRef, url, signal: options.signal }
  return options.stream === true
    ? forwardBoundedStream(server, input)
    : forwardScopeJson(server, input)
}
