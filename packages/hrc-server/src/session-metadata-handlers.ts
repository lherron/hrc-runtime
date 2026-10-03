import { HrcBadRequestError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import { canonicalLaneRef } from 'hrc-store-sqlite'
import { locateScopeOnServer } from './federation/locate-server.js'
import { buildPeerProtocolHeaders } from './federation/peer-request.js'
import type { HrcServerInstance } from './index.js'
import { parseJsonBody, parseSessionRef } from './server-parsers.js'
import { json } from './server-util.js'

function target(server: HrcServerInstance, scopeRef: unknown, laneRef: unknown) {
  if (typeof scopeRef !== 'string' || (laneRef !== undefined && typeof laneRef !== 'string'))
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'scopeRef and optional laneRef must be strings'
    )
  const parsed = parseSessionRef(
    `${scopeRef}/lane:${typeof laneRef === 'string' ? laneRef.replace(/^lane:/, '') : 'main'}`
  )
  const continuity = server.db.continuities.getByKey(parsed.scopeRef, parsed.laneRef)
  if (!continuity)
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_HOST_SESSION, 'unknown continuity', parsed)
  return continuity
}
async function forward(
  server: HrcServerInstance,
  scopeRef: unknown,
  url: URL,
  request?: {
    method: string
    text(): Promise<string>
    headers: { get(name: string): string | null }
  }
): Promise<Response | undefined> {
  if (typeof scopeRef !== 'string' || !server.options.federationConfig?.sourceExists)
    return undefined
  const location = await locateScopeOnServer(server, scopeRef)
  if (location.authority.state !== 'bound' || location.authority.isLocal) return undefined
  const homeNodeId = location.authority.record.homeNodeId
  const peer = [...server.options.federationConfig.peers.values()].find(
    (p) => String(p.nodeId) === homeNodeId
  )
  if (!peer)
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_HOST_SESSION, 'session home peer unavailable')
  const remote = new URL(url.pathname + url.search, peer.endpoint)
  const principalRef = request?.headers.get('x-hrc-principal-ref')
  const response = await fetch(remote, {
    method: request?.method ?? 'GET',
    headers: {
      ...buildPeerProtocolHeaders(peer, { contentType: 'application/json' }),
      ...(principalRef ? { 'x-hrc-principal-ref': principalRef } : {}),
    },
    ...(request ? { body: await request.text() } : {}),
    signal: AbortSignal.timeout(10000),
  })
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  })
}
export async function handleGetSessionMetadata(
  server: HrcServerInstance,
  url: URL,
  localOnly = false
): Promise<Response> {
  if (!localOnly) {
    const remote = await forward(server, url.searchParams.get('scopeRef'), url)
    if (remote) return remote
  }
  const c = target(
    server,
    url.searchParams.get('scopeRef'),
    url.searchParams.get('laneRef') ?? undefined
  )
  return json(server.db.sessionMetadata.get(c.scopeRef, c.laneRef))
}
export async function handlePatchSessionMetadata(
  server: HrcServerInstance,
  request: Request,
  localOnly = false
): Promise<Response> {
  const body = await parseJsonBody(request.clone() as Request)
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be an object')
  const b = body as Record<string, unknown>
  if (!localOnly) {
    const remote = await forward(server, b['scopeRef'], new URL(request.url), request.clone())
    if (remote) return remote
  }
  const c = target(server, b['scopeRef'], b['laneRef'])
  if (
    b['clear'] !== undefined &&
    (!Array.isArray(b['clear']) || !b['clear'].every((v) => typeof v === 'string'))
  )
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'clear must be an array of keys')
  const result = server.db.sessionMetadata.write({
    scopeRef: c.scopeRef,
    laneRef: c.laneRef,
    source: 'api',
    set: b['set'] === undefined ? {} : b['set'],
    clear: b['clear'] as string[] | undefined,
    updatedBy: request.headers.get('x-hrc-principal-ref') ?? 'unknown',
  })
  return json({ metadata: result.metadata, metadataSources: result.metadataSources })
}
export async function handleGetSessionContinuity(
  server: HrcServerInstance,
  url: URL,
  localOnly = false
): Promise<Response> {
  if (!localOnly) {
    const remote = await forward(server, url.searchParams.get('scopeRef'), url)
    if (remote) return remote
  }
  const c = target(
    server,
    url.searchParams.get('scopeRef'),
    url.searchParams.get('laneRef') ?? undefined
  )
  const s = server.db.sessions.getByHostSessionId(c.activeHostSessionId)
  if (!s) throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_HOST_SESSION, 'unknown active session')
  const facts = server.db.sessionIndex
    .listPage({ filters: { q: c.scopeRef, laneRef: c.laneRef }, limit: 200 })
    .items.find((row) => row.scopeRef === c.scopeRef)
  return json({
    continuity: { scopeRef: c.scopeRef, laneRef: canonicalLaneRef(c.laneRef) },
    identity: c.identity,
    generation: {
      hostSessionId: s.hostSessionId,
      generation: s.generation,
      status: s.status,
      createdAt: s.createdAt,
      lastAppliedIntent: s.lastAppliedIntentJson ?? {},
      continuation: s.continuation ?? {},
    },
    facts: {
      effectiveStatus: facts?.effectiveStatus ?? 'inactive',
      executionMode: facts?.executionMode ?? 'nonInteractive',
      lastActivityAt: facts?.lastActivityAt ?? s.updatedAt,
    },
    ...server.db.sessionMetadata.get(c.scopeRef, c.laneRef),
  })
}
