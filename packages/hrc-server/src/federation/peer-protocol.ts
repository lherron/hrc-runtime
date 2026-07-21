/**
 * Federation v1's dedicated peer HTTP surface (§2/§6).
 *
 * This handler is intentionally independent from HrcServer's Unix-socket
 * router. Its entire network-visible route table is accept, locate, health.
 */

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { writeServerLog } from '../server-log.js'
import type { PeerEntry } from './federation-config.js'
import { isTailnetHost } from './registry-bind.js'

export const PEER_PROTOCOL_VERSION = '1.0'
export const PEER_PROTOCOL_MAJOR = 1
export const PEER_PROTOCOL_VERSION_HEADER = 'x-hrc-peer-protocol-version'

export type PeerProtocolListenerConfig = {
  readonly bind: string
}

export type PeerProtocolHealth = {
  readonly startedAt: string
  /** Timestamp at which this node read its local projection. */
  readonly observedAt?: string | undefined
  readonly capabilities: {
    readonly accept: boolean
    readonly locate: true
    readonly health: true
    readonly runtimeProjection?: boolean | undefined
  }
  /** Additive F3 projection, returned only when the caller asks for it. */
  readonly runtimes?: readonly HrcRuntimeSnapshot[] | undefined
}

export type PeerProtocolHealthRequest = {
  readonly includeRuntimes: boolean
  readonly url: URL
}

export type PeerAcceptRequest = {
  readonly authenticatedNodeId: string
  readonly protocolVersion: string
  /** T-06618 owns the envelope schema and durable/idempotent acceptance. */
  readonly envelope: Readonly<Record<string, unknown>>
}

export type PeerAcceptResult =
  | {
      readonly outcome: 'accepted' | 'duplicate'
      readonly messageId: string
      /** Internal effect queued only after the durable ACK response is built. */
      readonly afterAck?: (() => Promise<void> | void) | undefined
    }
  | {
      readonly outcome: 'refused'
      readonly code: string
      readonly retryable: boolean
      readonly status?: number | undefined
      readonly redirect?:
        | { readonly homeNodeId: string; readonly placementEpoch: number }
        | undefined
    }

export type PeerAcceptHandler = (request: PeerAcceptRequest) => Promise<PeerAcceptResult>

export type PeerProtocolRequestHandlerOptions = {
  readonly localNodeId: string
  readonly peers: ReadonlyMap<string, PeerEntry>
  readonly locate: (scopeRef: string) => Promise<unknown>
  readonly health: (
    request: PeerProtocolHealthRequest
  ) => Promise<PeerProtocolHealth> | PeerProtocolHealth
  readonly accept?: PeerAcceptHandler | undefined
}

export type PeerProtocolEndpointControl = {
  readonly url: string
  stop(): void
}

class InvalidPeerRequest extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseJson(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [PEER_PROTOCOL_VERSION_HEADER]: PEER_PROTOCOL_VERSION,
    },
  })
}

function refusal(status: number, code: string, detail: Record<string, unknown> = {}): Response {
  return responseJson(
    {
      ok: false,
      protocolVersion: PEER_PROTOCOL_VERSION,
      error: { code, ...detail },
    },
    status
  )
}

function authenticate(
  request: Request,
  peers: ReadonlyMap<string, PeerEntry>
): PeerEntry | undefined {
  const header = request.headers.get('authorization')
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const candidate = match?.[1]
  if (candidate === undefined || candidate.length === 0) return undefined

  // Evaluate every configured token before returning. PeerToken performs the
  // comparison internally, so no stored secret becomes a plain string here.
  let authenticated: PeerEntry | undefined
  for (const peer of peers.values()) {
    for (const token of peer.acceptedTokens ?? [peer.token]) {
      if (token.matches(candidate)) authenticated = peer
    }
  }
  return authenticated
}

function requireCompatibleVersion(request: Request): string | Response {
  const raw = request.headers.get(PEER_PROTOCOL_VERSION_HEADER)
  if (raw === null || raw.trim().length === 0) {
    return refusal(400, 'protocol_version_required')
  }
  const match = /^(\d+)\.(\d+)$/.exec(raw.trim())
  if (match === null) return refusal(400, 'invalid_protocol_version')
  const receivedMajor = Number(match[1])
  if (!Number.isSafeInteger(receivedMajor)) return refusal(400, 'invalid_protocol_version')
  if (receivedMajor !== PEER_PROTOCOL_MAJOR) {
    return refusal(426, 'incompatible_protocol_major', {
      supportedMajor: PEER_PROTOCOL_MAJOR,
      receivedMajor,
    })
  }
  return raw.trim()
}

async function requestRecord(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new InvalidPeerRequest()
  }
  if (!isRecord(value)) throw new InvalidPeerRequest()
  return value
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidPeerRequest()
  }
  return value.trim()
}

export function createPeerProtocolRequestHandler(
  options: PeerProtocolRequestHandlerOptions
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const peer = authenticate(request, options.peers)
    if (peer === undefined) return refusal(401, 'unauthorized')

    const requestVersion = requireCompatibleVersion(request)
    if (requestVersion instanceof Response) return requestVersion

    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/v1/federation/health') {
        const health = await options.health({
          includeRuntimes: url.searchParams.get('includeRuntimes') === 'true',
          url,
        })
        return responseJson(
          {
            ok: true,
            protocolVersion: PEER_PROTOCOL_VERSION,
            nodeId: options.localNodeId,
            ...health,
          },
          200
        )
      }

      if (request.method === 'POST' && url.pathname === '/v1/federation/locate') {
        const body = await requestRecord(request)
        const location = await options.locate(requiredString(body, 'scopeRef'))
        return responseJson({ ok: true, protocolVersion: PEER_PROTOCOL_VERSION, location }, 200)
      }

      if (request.method === 'POST' && url.pathname === '/v1/federation/accept') {
        const body = await requestRecord(request)
        if (!isRecord(body['envelope'])) throw new InvalidPeerRequest()
        if (options.accept === undefined) {
          return refusal(501, 'accept_not_enabled', { retryable: false })
        }
        const result = await options.accept({
          authenticatedNodeId: peer.nodeId,
          protocolVersion: requestVersion,
          envelope: body['envelope'],
        })
        if (result.outcome === 'refused') {
          return refusal(result.status ?? 409, result.code, {
            retryable: result.retryable,
            ...(result.redirect === undefined ? {} : { redirect: result.redirect }),
          })
        }
        const response = responseJson(
          {
            ok: true,
            protocolVersion: PEER_PROTOCOL_VERSION,
            ack: { outcome: result.outcome, messageId: result.messageId },
          },
          200
        )
        writeServerLog('INFO', 'federation.accept.ack', {
          localNodeId: options.localNodeId,
          peerNodeId: peer.nodeId,
          messageId: result.messageId,
          outcome: result.outcome,
        })
        if (result.outcome === 'accepted' && result.afterAck !== undefined) {
          setTimeout(() => {
            Promise.resolve(result.afterAck?.()).catch((error: unknown) => {
              // The message is already durable and ACKed. The row remains the
              // receiver's queue; never turn a post-ACK local-delivery failure
              // into a transport retry or an unhandled rejection.
              writeServerLog('WARN', 'federation.accept.post_ack_delivery_failed', {
                messageId: result.messageId,
                peerNodeId: peer.nodeId,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }, 0)
        }
        return response
      }

      return refusal(404, 'not_found')
    } catch (error) {
      if (error instanceof InvalidPeerRequest) return refusal(400, 'invalid_request')
      // Do not reflect request-controlled values, authorization material, or
      // downstream exception text across the network boundary.
      return refusal(500, 'internal_error', { retryable: true })
    }
  }
}

/** Rejects wildcard, loopback, LAN, and public binds; only a concrete tailnet host is valid. */
export function parsePeerProtocolBind(raw: string, where: string): PeerProtocolListenerConfig {
  const bind = raw.trim()
  let url: URL
  try {
    url = new URL(bind)
  } catch {
    throw new Error(`${where} bind is not a valid URL: ${JSON.stringify(bind)}`)
  }
  if (url.protocol !== 'http:') {
    throw new Error(`${where} bind must use http: (tailnet supplies transport encryption)`)
  }
  if (url.port.length === 0) throw new Error(`${where} bind must include an explicit port`)
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${where} bind port must be between 1 and 65535`)
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new Error(`${where} bind must contain only a specific tailnet host and explicit port`)
  }
  if (!isTailnetHost(url.hostname)) {
    throw new Error(
      `${where} bind must name a specific tailnet host (100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net), got ${JSON.stringify(url.hostname)}`
    )
  }
  return { bind: url.toString() }
}

export function startPeerProtocolEndpoint(input: {
  readonly listener: PeerProtocolListenerConfig
  readonly options: PeerProtocolRequestHandlerOptions
}): PeerProtocolEndpointControl {
  const bind = new URL(input.listener.bind)
  const server = Bun.serve({
    hostname: bind.hostname.replace(/^\[|\]$/g, ''),
    port: Number(bind.port),
    fetch: createPeerProtocolRequestHandler(input.options),
  })
  return {
    url: input.listener.bind,
    stop() {
      server.stop(true)
    },
  }
}
