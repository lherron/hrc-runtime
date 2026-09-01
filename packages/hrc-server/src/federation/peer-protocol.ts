/**
 * Federation v1's dedicated peer HTTP surface (§2/§6).
 *
 * This handler is intentionally independent from HrcServer's Unix-socket
 * router. Its entire network-visible route table is the explicit set documented
 * in docs/federation-peer-protocol.md.
 */

import { HrcDomainError } from 'hrc-core'
import type {
  FederationPlacementBinding,
  HrcRuntimeSnapshot,
  ListMessagesResponse,
  StartRuntimeResponse,
} from 'hrc-core'
import { writeServerLog } from '../server-log.js'
import type { PeerEntry } from './federation-config.js'
import { isTailnetHost } from './registry-bind.js'

export type PeerProtocolListenerConfig = {
  readonly bind: string
}

export type PeerProtocolHealth = {
  readonly startedAt: string
  /** Timestamp at which this node read its local projection. */
  readonly observedAt?: string | undefined
  readonly capabilities: {
    readonly establish?: boolean | undefined
    readonly rosterStart?: boolean | undefined
    readonly exactStart?: boolean | undefined
    readonly locate: true
    readonly health: true
    readonly runtimeProjection?: boolean | undefined
    readonly collectiveHistory?: boolean | undefined
    readonly semanticTurnHandoff?: boolean | undefined
  }
  /** Additive F3 projection, returned only when the caller asks for it. */
  readonly runtimes?: readonly HrcRuntimeSnapshot[] | undefined
}

export type PeerProtocolHealthRequest = {
  readonly includeRuntimes: boolean
  readonly url: URL
}

export type PeerEstablishRequest = {
  readonly authenticatedNodeId: string
  readonly scopeRef: string
  readonly intent: 'implicit'
  readonly correlationId: string
}

export type PeerEstablishResult =
  | {
      readonly outcome: 'established' | 'existing'
      readonly correlationId: string
      readonly binding: FederationPlacementBinding
    }
  | {
      readonly outcome: 'refused'
      readonly status: number
      readonly code: 'stale_context' | 'runtime_unavailable'
      readonly message: string
      readonly reason: string
      readonly retryable: boolean
      readonly homeNodeId?: string | undefined
    }

export type PeerEstablishHandler = (request: PeerEstablishRequest) => Promise<PeerEstablishResult>

export type PeerRosterStartHandler = (request: {
  readonly authenticatedNodeId: string
  readonly body: Readonly<Record<string, unknown>>
}) => Promise<StartRuntimeResponse>

/** T-07302 — exact-scope claim-and-start on the authoritative home. */
export type PeerExactStartHandler = PeerRosterStartHandler

export type PeerCollectiveHistoryReplicateHandler = (request: {
  readonly authenticatedNodeId: string
  readonly body: Readonly<Record<string, unknown>>
}) =>
  | Promise<{ readonly outcome: 'accepted'; readonly messageId: string }>
  | {
      readonly outcome: 'accepted'
      readonly messageId: string
    }

export type PeerCollectiveHistoryCheckpointHandler = (request: {
  readonly authenticatedNodeId: string
  readonly body: Readonly<Record<string, unknown>>
}) =>
  | Promise<{ readonly outcome: 'accepted'; readonly nodeId: string }>
  | {
      readonly outcome: 'accepted'
      readonly nodeId: string
    }

export type PeerCollectiveHistoryQueryHandler = (request: {
  readonly authenticatedNodeId: string
  readonly filter: Readonly<Record<string, unknown>>
}) => Promise<ListMessagesResponse> | ListMessagesResponse

export type PeerProtocolRequestHandlerOptions = {
  readonly localNodeId: string
  readonly peers: ReadonlyMap<string, PeerEntry>
  readonly locate: (scopeRef: string) => Promise<unknown>
  readonly health: (
    request: PeerProtocolHealthRequest
  ) => Promise<PeerProtocolHealth> | PeerProtocolHealth
  readonly sessionPage?: ((request: { readonly url: URL }) => Promise<Response>) | undefined
  readonly sessionFacets?: ((request: { readonly url: URL }) => Promise<Response>) | undefined
  readonly establish?: PeerEstablishHandler | undefined
  readonly rosterStart?: PeerRosterStartHandler | undefined
  /**
   * T-07302 — a DISTINCT route and capability from `rosterStart`. The two verbs
   * differ in occupancy semantics (walk a family versus refuse), so a peer that
   * predates this one must 404 rather than have its roster verb reused.
   */
  readonly exactStart?: PeerExactStartHandler | undefined
  readonly collectiveHistoryReplicate?: PeerCollectiveHistoryReplicateHandler | undefined
  readonly collectiveHistoryCheckpoint?: PeerCollectiveHistoryCheckpointHandler | undefined
  readonly collectiveHistoryQuery?: PeerCollectiveHistoryQueryHandler | undefined
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
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function refusal(status: number, code: string, detail: Record<string, unknown> = {}): Response {
  return responseJson(
    {
      ok: false,
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

async function handleCollectiveHistoryRequest(input: {
  request: Request
  url: URL
  options: PeerProtocolRequestHandlerOptions
  peerNodeId: string
}): Promise<Response | undefined> {
  if (
    input.request.method !== 'POST' ||
    !input.url.pathname.startsWith('/v1/federation/history/')
  ) {
    return undefined
  }

  if (input.url.pathname === '/v1/federation/history/replicate') {
    const body = await requestRecord(input.request)
    if (Object.keys(body).some((key) => key !== 'record') || !isRecord(body['record'])) {
      throw new InvalidPeerRequest()
    }
    if (input.options.collectiveHistoryReplicate === undefined) {
      return refusal(404, 'collective_history_not_authoritative', { retryable: true })
    }
    const result = await input.options.collectiveHistoryReplicate({
      authenticatedNodeId: input.peerNodeId,
      body,
    })
    return responseJson(
      {
        ok: true,
        ack: result,
      },
      200
    )
  }

  if (input.url.pathname === '/v1/federation/history/query') {
    const body = await requestRecord(input.request)
    if (Object.keys(body).some((key) => key !== 'filter') || !isRecord(body['filter'])) {
      throw new InvalidPeerRequest()
    }
    if (input.options.collectiveHistoryQuery === undefined) {
      return refusal(404, 'collective_history_not_authoritative', { retryable: true })
    }
    return responseJson(
      await input.options.collectiveHistoryQuery({
        authenticatedNodeId: input.peerNodeId,
        filter: body['filter'],
      }),
      200
    )
  }

  if (input.url.pathname === '/v1/federation/history/checkpoint') {
    const body = await requestRecord(input.request)
    if (Object.keys(body).some((key) => key !== 'checkpoint') || !isRecord(body['checkpoint'])) {
      throw new InvalidPeerRequest()
    }
    if (input.options.collectiveHistoryCheckpoint === undefined) {
      return refusal(404, 'collective_history_not_authoritative', { retryable: true })
    }
    const result = await input.options.collectiveHistoryCheckpoint({
      authenticatedNodeId: input.peerNodeId,
      body,
    })
    return responseJson(
      {
        ok: true,
        ack: result,
      },
      200
    )
  }

  return undefined
}

async function handleSessionIndexRequest(input: {
  request: Request
  url: URL
  options: PeerProtocolRequestHandlerOptions
}): Promise<Response | undefined> {
  if (input.request.method !== 'GET') return undefined
  if (input.url.pathname === '/v1/sessions/page') {
    if (input.options.sessionPage === undefined) {
      return refusal(404, 'peer_upgrade_required', { retryable: false })
    }
    return input.options.sessionPage({ url: input.url })
  }
  if (input.url.pathname === '/v1/sessions/facets') {
    if (input.options.sessionFacets === undefined) {
      return refusal(404, 'peer_upgrade_required', { retryable: false })
    }
    return input.options.sessionFacets({ url: input.url })
  }
  return undefined
}

async function handleHealthRequest(input: {
  request: Request
  url: URL
  options: PeerProtocolRequestHandlerOptions
}): Promise<Response | undefined> {
  if (input.request.method !== 'GET' || input.url.pathname !== '/v1/federation/health') {
    return undefined
  }
  const health = await input.options.health({
    includeRuntimes: input.url.searchParams.get('includeRuntimes') === 'true',
    url: input.url,
  })
  return responseJson(
    {
      ok: true,
      nodeId: input.options.localNodeId,
      ...health,
    },
    200
  )
}

async function handleLocateRequest(input: {
  request: Request
  url: URL
  options: PeerProtocolRequestHandlerOptions
}): Promise<Response | undefined> {
  if (input.request.method !== 'POST' || input.url.pathname !== '/v1/federation/locate') {
    return undefined
  }
  const body = await requestRecord(input.request)
  const location = await input.options.locate(requiredString(body, 'scopeRef'))
  return responseJson({ ok: true, location }, 200)
}

const ROSTER_START_FIELDS = new Set([
  'baseSessionRef',
  'runtimeIntent',
  'conflictPolicy',
  'idempotencyKey',
  'restartStyle',
  'summonIntent',
])

/** T-07302 — the exact shape names ONE scope and never a base or a host session. */
const EXACT_START_FIELDS = new Set([
  'sessionRef',
  'runtimeIntent',
  'conflictPolicy',
  'idempotencyKey',
  'restartStyle',
  'summonIntent',
])

type ClaimStartRoute = {
  readonly path: string
  readonly fields: ReadonlySet<string>
  readonly handler: (
    options: PeerProtocolRequestHandlerOptions
  ) => PeerRosterStartHandler | undefined
  readonly logEvent: string
  readonly unavailable: string
}

const CLAIM_START_ROUTES: readonly ClaimStartRoute[] = [
  {
    path: '/v1/federation/roster-start',
    fields: ROSTER_START_FIELDS,
    handler: (options) => options.rosterStart,
    logEvent: 'federation.roster_start.unexpected_failure',
    unavailable: 'remote suffix-roster provisioning is temporarily unavailable',
  },
  {
    path: '/v1/federation/exact-start',
    fields: EXACT_START_FIELDS,
    handler: (options) => options.exactStart,
    logEvent: 'federation.exact_start.unexpected_failure',
    unavailable: 'remote exact-scope provisioning is temporarily unavailable',
  },
]

async function handleClaimStartRequest(input: {
  request: Request
  url: URL
  options: PeerProtocolRequestHandlerOptions
  peerNodeId: string
}): Promise<Response | undefined> {
  const route = CLAIM_START_ROUTES.find((candidate) => candidate.path === input.url.pathname)
  if (input.request.method !== 'POST' || route === undefined) {
    return undefined
  }
  const body = await requestRecord(input.request)
  if (Object.keys(body).some((key) => !route.fields.has(key))) {
    throw new InvalidPeerRequest()
  }
  const handler = route.handler(input.options)
  if (handler === undefined) {
    return refusal(404, 'peer_upgrade_required', { retryable: false })
  }
  try {
    return responseJson(
      await handler({
        authenticatedNodeId: input.peerNodeId,
        body,
      }),
      200
    )
  } catch (error) {
    if (error instanceof HrcDomainError) {
      return refusal(error.status, error.code, {
        message: error.message,
        detail: error.detail,
        retryable: error.detail['retryable'] === true || error.status === 503,
      })
    }
    writeServerLog('ERROR', route.logEvent, {
      localNodeId: input.options.localNodeId,
      peerNodeId: input.peerNodeId,
      error: error instanceof Error ? error.message : String(error),
    })
    return refusal(503, 'runtime_unavailable', {
      message: route.unavailable,
      detail: { retryable: true },
      retryable: true,
    })
  }
}

export function createPeerProtocolRequestHandler(
  options: PeerProtocolRequestHandlerOptions
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const peer = authenticate(request, options.peers)
    if (peer === undefined) return refusal(401, 'unauthorized')

    const url = new URL(request.url)
    try {
      const healthResponse = await handleHealthRequest({ request, url, options })
      if (healthResponse !== undefined) return healthResponse

      const sessionIndexResponse = await handleSessionIndexRequest({ request, url, options })
      if (sessionIndexResponse !== undefined) return sessionIndexResponse

      const locateResponse = await handleLocateRequest({ request, url, options })
      if (locateResponse !== undefined) return locateResponse

      if (request.method === 'POST' && url.pathname === '/v1/federation/establish') {
        const body = await requestRecord(request)
        if (
          Object.keys(body).some(
            (key) => key !== 'scopeRef' && key !== 'intent' && key !== 'correlationId'
          ) ||
          body['intent'] !== 'implicit'
        ) {
          throw new InvalidPeerRequest()
        }
        if (options.establish === undefined) {
          return refusal(404, 'peer_upgrade_required', { retryable: false })
        }
        const correlationId = requiredString(body, 'correlationId')
        let result: PeerEstablishResult
        try {
          result = await options.establish({
            authenticatedNodeId: peer.nodeId,
            scopeRef: requiredString(body, 'scopeRef'),
            intent: 'implicit',
            correlationId,
          })
        } catch (error) {
          writeServerLog('ERROR', 'federation.establish.unexpected_failure', {
            localNodeId: options.localNodeId,
            peerNodeId: peer.nodeId,
            correlationId,
            error: error instanceof Error ? error.message : String(error),
          })
          result = {
            outcome: 'refused',
            status: 503,
            code: 'runtime_unavailable',
            message: 'remote policy establishment is temporarily unavailable',
            reason: 'registry-unreachable',
            retryable: true,
            homeNodeId: options.localNodeId,
          }
        }
        if (result.outcome === 'refused') {
          return refusal(result.status, result.code, {
            message: result.message,
            reason: result.reason,
            retryable: result.retryable,
            ...(result.homeNodeId === undefined ? {} : { homeNodeId: result.homeNodeId }),
            context: { scopeRef: body['scopeRef'], correlationId },
          })
        }
        return responseJson(
          {
            ok: true,
            correlationId: result.correlationId,
            outcome: result.outcome,
            binding: result.binding,
          },
          200
        )
      }

      const claimStartResponse = await handleClaimStartRequest({
        request,
        url,
        options,
        peerNodeId: peer.nodeId,
      })
      if (claimStartResponse !== undefined) return claimStartResponse

      // T-07612 §10 (flag day T-07616): the federation MESSAGE routes
      // (/v1/federation/accept and /v1/federation/accept-urgent) are DELETED,
      // not disabled. Cross-node agent talk is the shared wrkq ledger, which
      // both nodes already read over rpc://; federation keeps birth, placement,
      // summon and locate authority only. A peer still on the old build gets the
      // unmatched-path 404 below, which its outbox treats as a terminal refusal
      // rather than a retry.
      const historyResponse = await handleCollectiveHistoryRequest({
        request,
        url,
        options,
        peerNodeId: peer.nodeId,
      })
      if (historyResponse !== undefined) return historyResponse

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
