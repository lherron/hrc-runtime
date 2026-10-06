import { HrcBadRequestError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import { canonicalLaneRef } from 'hrc-store-sqlite'
import { forwardScopeJson, routeScopeRead } from './federation/scope-read-routing.js'
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
/**
 * T-10418: home authority decides before any continuity read. A shadow row
 * here for a scope bound elsewhere is never served, and an unknown or pending
 * home refuses retryably instead of answering from local state.
 */
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
  if (typeof scopeRef !== 'string') return undefined
  const route = await routeScopeRead(server, scopeRef)
  if (route.kind === 'local') return undefined
  return forwardScopeJson(server, {
    route,
    scopeRef,
    url,
    method: request?.method === 'PATCH' ? 'PATCH' : 'GET',
    ...(request ? { body: await request.text() } : {}),
    principalRef: request?.headers.get('x-hrc-principal-ref'),
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
