import { createHash } from 'node:crypto'

import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  SessionIndexCursor,
  SessionIndexFacetCounts,
  SessionIndexFilters,
  SessionIndexRecord,
} from 'hrc-store-sqlite'
import type { PeerEntry } from './federation/federation-config.js'
import { PEER_PROTOCOL_VERSION } from './federation/peer-protocol.js'
import { buildPeerProtocolHeaders } from './federation/peer-request.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { normalizeOptionalQuery } from './server-parsers.js'
import { json } from './server-util.js'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
const PEER_PAGE_TIMEOUT_MS = 1_500
const CURSOR_VERSION = 5

type SessionNodeCursor = { t: string; h: string }
type SessionCompositeCursor = {
  v: 5
  f: string
  n: Record<string, SessionNodeCursor>
}

type SessionPeerStatus = {
  state: 'healthy' | 'invalid-response' | 'refused' | 'unreachable'
  checkedAt: string
  detail?: string | undefined
}

export type SessionPageItem = SessionIndexRecord & { nodeId: string }
export type SessionPageResponse = {
  items: SessionPageItem[]
  nextCursor?: string | undefined
  eventHighWater: Record<string, number>
  complete: boolean
  peerStatus: Record<string, SessionPeerStatus>
}

export type SessionFacetsResponse = {
  total: number
  byEffectiveStatus: Record<string, number>
  byExecutionMode: Record<string, number>
  byAgentId: Record<string, number>
  byNodeId: Record<string, number>
  complete: boolean
  peerStatus: Record<string, SessionPeerStatus>
}

type ParsedSessionQuery = {
  filters: SessionIndexFilters
  selectedNodeIds: string[]
  knownNodeIds: string[]
  limit: number
  cursor?: SessionCompositeCursor | undefined
  fingerprint: string
}

type NodePageResult = {
  nodeId: string
  items: SessionPageItem[]
  hasMore: boolean
  eventHighWater?: number | undefined
  status: SessionPeerStatus
}

type NodeFacetsResult = {
  nodeId: string
  facets?: SessionIndexFacetCounts | undefined
  status: SessionPeerStatus
}

function badRequest(message: string, detail: Record<string, unknown> = {}): never {
  throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, message, detail)
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_LIMIT
  if (!/^\d+$/.test(raw))
    badRequest('limit must be an integer between 1 and 200', { field: 'limit' })
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    badRequest('limit must be an integer between 1 and 200', { field: 'limit' })
  }
  return limit
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string
): T | undefined {
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) {
    badRequest(`${field} is invalid`, { field, value, allowed })
  }
  return value as T
}

function allKnownNodeIds(server: HrcServerInstanceForHandlers): string[] {
  const config = server.options.federationConfig
  const localNodeId = config?.nodeId ?? 'local'
  return [String(localNodeId), ...[...(config?.peers.keys() ?? [])].map(String)].sort()
}

function localNodeId(server: HrcServerInstanceForHandlers): string {
  return String(server.options.federationConfig?.nodeId ?? 'local')
}

function parseSelectedNodes(
  raw: string | undefined,
  local: string,
  known: readonly string[]
): string[] {
  if (raw === undefined || raw === 'all') return [...known]
  if (raw === 'local') return [local]
  const selected = [...new Set(raw.split(',').map((value) => value.trim()))]
  if (selected.length === 0 || selected.some((value) => value.length === 0)) {
    badRequest('nodes must be all, local, or a comma-separated exact nodeId list', {
      field: 'nodes',
    })
  }
  const unknown = selected.filter((nodeId) => !known.includes(nodeId))
  if (unknown.length > 0) {
    badRequest('nodes contains an unknown nodeId', { field: 'nodes', unknown, known })
  }
  return selected.sort()
}

function filterFingerprint(
  filters: SessionIndexFilters,
  selectedNodeIds: readonly string[]
): string {
  const canonical = JSON.stringify({
    q: filters.q ?? null,
    agentId: filters.agentId ?? null,
    projectId: filters.projectId ?? null,
    laneRef: filters.laneRef ?? null,
    effectiveStatus: filters.effectiveStatus ?? null,
    executionMode: filters.executionMode ?? null,
    nodes: [...selectedNodeIds].sort(),
  })
  return createHash('sha256').update(canonical).digest('base64url')
}

function encodeCursor(cursor: SessionCompositeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function isNodeCursor(value: unknown): value is SessionNodeCursor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    Object.keys(row).length === 2 &&
    typeof row['t'] === 'string' &&
    row['t'].length > 0 &&
    typeof row['h'] === 'string' &&
    row['h'].length > 0
  )
}

function decodeCursor(
  raw: string,
  fingerprint: string,
  selectedNodeIds: readonly string[]
): SessionCompositeCursor {
  let parsed: unknown
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    if (Buffer.from(decoded).toString('base64url') !== raw) throw new Error('non-canonical')
    parsed = JSON.parse(decoded)
  } catch {
    badRequest('cursor is malformed', { field: 'cursor' })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    badRequest('cursor is malformed', { field: 'cursor' })
  }
  const value = parsed as Record<string, unknown>
  if (
    value['v'] !== CURSOR_VERSION ||
    typeof value['f'] !== 'string' ||
    value['n'] === null ||
    typeof value['n'] !== 'object' ||
    Array.isArray(value['n']) ||
    Object.keys(value).some((key) => !['v', 'f', 'n'].includes(key))
  ) {
    badRequest('cursor is malformed', { field: 'cursor' })
  }
  if (value['f'] !== fingerprint) {
    badRequest('cursor does not match the active filters', { field: 'cursor' })
  }
  const nodes = value['n'] as Record<string, unknown>
  if (
    Object.keys(nodes).some((nodeId) => !selectedNodeIds.includes(nodeId)) ||
    Object.values(nodes).some((component) => !isNodeCursor(component))
  ) {
    badRequest('cursor contains invalid node components', { field: 'cursor' })
  }
  return value as SessionCompositeCursor
}

function parseSessionQuery(
  server: HrcServerInstanceForHandlers,
  url: URL,
  options: { includeCursorAndLimit: boolean }
): ParsedSessionQuery {
  const filters: SessionIndexFilters = {
    ...(normalizeOptionalQuery(url.searchParams.get('q')) === undefined
      ? {}
      : { q: normalizeOptionalQuery(url.searchParams.get('q')) }),
    ...(normalizeOptionalQuery(url.searchParams.get('agentId')) === undefined
      ? {}
      : { agentId: normalizeOptionalQuery(url.searchParams.get('agentId')) }),
    ...(normalizeOptionalQuery(url.searchParams.get('projectId')) === undefined
      ? {}
      : { projectId: normalizeOptionalQuery(url.searchParams.get('projectId')) }),
    ...(normalizeOptionalQuery(url.searchParams.get('laneRef')) === undefined
      ? {}
      : { laneRef: normalizeOptionalQuery(url.searchParams.get('laneRef')) }),
    ...(parseEnum(
      normalizeOptionalQuery(url.searchParams.get('effectiveStatus')),
      ['active', 'detached', 'inactive', 'stale'] as const,
      'effectiveStatus'
    ) === undefined
      ? {}
      : {
          effectiveStatus: parseEnum(
            normalizeOptionalQuery(url.searchParams.get('effectiveStatus')),
            ['active', 'detached', 'inactive', 'stale'] as const,
            'effectiveStatus'
          ),
        }),
    ...(parseEnum(
      normalizeOptionalQuery(url.searchParams.get('executionMode')),
      ['headless', 'interactive', 'nonInteractive'] as const,
      'executionMode'
    ) === undefined
      ? {}
      : {
          executionMode: parseEnum(
            normalizeOptionalQuery(url.searchParams.get('executionMode')),
            ['headless', 'interactive', 'nonInteractive'] as const,
            'executionMode'
          ),
        }),
  }
  const knownNodeIds = allKnownNodeIds(server)
  const selectedNodeIds = parseSelectedNodes(
    normalizeOptionalQuery(url.searchParams.get('nodes')),
    localNodeId(server),
    knownNodeIds
  )
  const fingerprint = filterFingerprint(filters, selectedNodeIds)
  const rawCursor = normalizeOptionalQuery(url.searchParams.get('cursor'))
  if (!options.includeCursorAndLimit && rawCursor !== undefined) {
    badRequest('cursor is not accepted by the facets endpoint', { field: 'cursor' })
  }
  if (!options.includeCursorAndLimit && url.searchParams.has('limit')) {
    badRequest('limit is not accepted by the facets endpoint', { field: 'limit' })
  }
  return {
    filters,
    selectedNodeIds,
    knownNodeIds,
    limit: options.includeCursorAndLimit ? parseLimit(url.searchParams.get('limit')) : 0,
    ...(rawCursor === undefined
      ? {}
      : { cursor: decodeCursor(rawCursor, fingerprint, selectedNodeIds) }),
    fingerprint,
  }
}

function healthyStatus(): SessionPeerStatus {
  return { state: 'healthy', checkedAt: new Date().toISOString() }
}

function peerFailure(
  state: SessionPeerStatus['state'],
  detail: string,
  checkedAt: string
): SessionPeerStatus {
  return { state, checkedAt, detail }
}

function compareItems(lhs: SessionPageItem, rhs: SessionPageItem): number {
  const time = rhs.lastActivityAt.localeCompare(lhs.lastActivityAt)
  if (time !== 0) return time
  const node = lhs.nodeId.localeCompare(rhs.nodeId)
  if (node !== 0) return node
  return rhs.hostSessionId.localeCompare(lhs.hostSessionId)
}

function localPage(
  server: HrcServerInstanceForHandlers,
  parsed: ParsedSessionQuery,
  nodeId: string
): NodePageResult {
  // Capture first: consumers may safely begin watching at high-water + 1 after
  // reading the snapshot. Events racing after this read can only be replayed,
  // never missed.
  const eventHighWater = server.db.hrcEvents.maxHrcSeq()
  const component = parsed.cursor?.n[nodeId]
  const page = server.db.sessionIndex.listPage({
    filters: parsed.filters,
    limit: parsed.limit,
    ...(component === undefined
      ? {}
      : {
          cursor: {
            lastActivityAt: component.t,
            hostSessionId: component.h,
          } satisfies SessionIndexCursor,
        }),
  })
  return {
    nodeId,
    items: page.items.map((item) => ({ nodeId, ...item })),
    hasMore: page.hasMore,
    eventHighWater,
    status: healthyStatus(),
  }
}

function queryParams(filters: SessionIndexFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, value)
  }
  params.set('nodes', 'local')
  return params
}

async function fetchPeerJson(peer: PeerEntry, url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: buildPeerProtocolHeaders(peer, PEER_PROTOCOL_VERSION),
    signal: AbortSignal.timeout(PEER_PAGE_TIMEOUT_MS),
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw Object.assign(new Error(`peer returned non-JSON HTTP ${response.status}`), {
      state: 'invalid-response' as const,
    })
  }
  if (!response.ok) {
    throw Object.assign(new Error(`peer refused request (HTTP ${response.status})`), {
      state: 'refused' as const,
    })
  }
  return body
}

function isPageResponse(value: unknown, expectedNodeId: string): value is SessionPageResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const eventHighWater = response['eventHighWater']
  if (
    !Array.isArray(response['items']) ||
    typeof response['complete'] !== 'boolean' ||
    eventHighWater === null ||
    typeof eventHighWater !== 'object' ||
    Array.isArray(eventHighWater) ||
    typeof (eventHighWater as Record<string, unknown>)[expectedNodeId] !== 'number'
  ) {
    return false
  }
  return response['items'].every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>)['nodeId'] === expectedNodeId &&
      typeof (item as Record<string, unknown>)['hostSessionId'] === 'string' &&
      typeof (item as Record<string, unknown>)['lastActivityAt'] === 'string'
  )
}

async function peerPage(parsed: ParsedSessionQuery, peer: PeerEntry): Promise<NodePageResult> {
  const checkedAt = new Date().toISOString()
  try {
    const params = queryParams(parsed.filters)
    params.set('limit', String(parsed.limit))
    const component = parsed.cursor?.n[String(peer.nodeId)]
    if (component !== undefined) {
      params.set(
        'cursor',
        encodeCursor({
          v: CURSOR_VERSION,
          f: filterFingerprint(parsed.filters, [String(peer.nodeId)]),
          n: { [String(peer.nodeId)]: component },
        })
      )
    }
    const url = new URL('/v1/sessions/page', peer.endpoint)
    url.search = params.toString()
    const body = await fetchPeerJson(peer, url)
    if (!isPageResponse(body, String(peer.nodeId))) {
      return {
        nodeId: String(peer.nodeId),
        items: [],
        hasMore: true,
        status: peerFailure(
          'invalid-response',
          'peer returned a malformed session page',
          checkedAt
        ),
      }
    }
    return {
      nodeId: String(peer.nodeId),
      items: body.items,
      hasMore: body.nextCursor !== undefined,
      eventHighWater: body.eventHighWater[String(peer.nodeId)],
      status: healthyStatus(),
    }
  } catch (error) {
    const tagged = error as { state?: SessionPeerStatus['state'] }
    return {
      nodeId: String(peer.nodeId),
      items: [],
      hasMore: true,
      status: peerFailure(
        tagged.state ?? 'unreachable',
        error instanceof Error ? error.message : String(error),
        checkedAt
      ),
    }
  }
}

function mergeCountMaps(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count
}

function isFacetsResponse(value: unknown): value is SessionFacetsResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return (
    typeof response['total'] === 'number' &&
    response['byEffectiveStatus'] !== null &&
    typeof response['byEffectiveStatus'] === 'object' &&
    response['byExecutionMode'] !== null &&
    typeof response['byExecutionMode'] === 'object' &&
    response['byAgentId'] !== null &&
    typeof response['byAgentId'] === 'object' &&
    response['byNodeId'] !== null &&
    typeof response['byNodeId'] === 'object'
  )
}

async function peerFacets(
  filters: SessionIndexFilters,
  peer: PeerEntry
): Promise<NodeFacetsResult> {
  const checkedAt = new Date().toISOString()
  try {
    const url = new URL('/v1/sessions/facets', peer.endpoint)
    url.search = queryParams(filters).toString()
    const body = await fetchPeerJson(peer, url)
    if (!isFacetsResponse(body)) {
      return {
        nodeId: String(peer.nodeId),
        status: peerFailure(
          'invalid-response',
          'peer returned malformed session facets',
          checkedAt
        ),
      }
    }
    return {
      nodeId: String(peer.nodeId),
      facets: {
        total: body.total,
        nodeFacetCount: body.byNodeId[String(peer.nodeId)] ?? body.total,
        byEffectiveStatus: body.byEffectiveStatus,
        byExecutionMode: body.byExecutionMode,
        byAgentId: body.byAgentId,
      },
      status: healthyStatus(),
    }
  } catch (error) {
    const tagged = error as { state?: SessionPeerStatus['state'] }
    return {
      nodeId: String(peer.nodeId),
      status: peerFailure(
        tagged.state ?? 'unreachable',
        error instanceof Error ? error.message : String(error),
        checkedAt
      ),
    }
  }
}

export async function handleSessionPage(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const parsed = parseSessionQuery(this, url, { includeCursorAndLimit: true })
  const local = localNodeId(this)
  const config = this.options.federationConfig
  const results = await Promise.all(
    parsed.selectedNodeIds.map((nodeId) => {
      if (nodeId === local) return Promise.resolve(localPage(this, parsed, local))
      const peer = config?.peers.get(nodeId as never)
      if (peer === undefined) badRequest('nodes contains an unknown nodeId', { nodeId })
      return peerPage(parsed, peer)
    })
  )
  const candidates = results.flatMap((result) => result.items).sort(compareItems)
  const emitted = candidates.slice(0, parsed.limit)
  const components: Record<string, SessionNodeCursor> = { ...(parsed.cursor?.n ?? {}) }
  for (const item of emitted) {
    components[item.nodeId] = { t: item.lastActivityAt, h: item.hostSessionId }
  }
  const emittedKeys = new Set(emitted.map((item) => `${item.nodeId}\0${item.hostSessionId}`))
  const complete = results.every((result) => result.status.state === 'healthy')
  const remaining =
    !complete ||
    results.some(
      (result) =>
        result.hasMore ||
        result.items.some((item) => !emittedKeys.has(`${item.nodeId}\0${item.hostSessionId}`))
    )
  const peerStatus = Object.fromEntries(results.map((result) => [result.nodeId, result.status]))
  const eventHighWater = Object.fromEntries(
    results.flatMap((result) =>
      result.status.state === 'healthy' && result.eventHighWater !== undefined
        ? [[result.nodeId, result.eventHighWater] as const]
        : []
    )
  )
  return json({
    items: emitted,
    ...(remaining
      ? {
          nextCursor: encodeCursor({
            v: CURSOR_VERSION,
            f: parsed.fingerprint,
            n: components,
          }),
        }
      : {}),
    eventHighWater,
    complete,
    peerStatus,
  } satisfies SessionPageResponse)
}

export async function handleSessionFacets(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const parsed = parseSessionQuery(this, url, { includeCursorAndLimit: false })
  const local = localNodeId(this)
  const config = this.options.federationConfig
  // byNodeId excludes the node filter, so every known node must be queried even
  // when total and the other dimensions are restricted to a selected subset.
  const results = await Promise.all(
    parsed.knownNodeIds.map((nodeId): Promise<NodeFacetsResult> => {
      if (nodeId === local) {
        return Promise.resolve({
          nodeId,
          facets: this.db.sessionIndex.facets(parsed.filters),
          status: healthyStatus(),
        })
      }
      const peer = config?.peers.get(nodeId as never)
      if (peer === undefined) badRequest('unknown configured peer nodeId', { nodeId })
      return peerFacets(parsed.filters, peer)
    })
  )
  const selected = new Set(parsed.selectedNodeIds)
  const response: SessionFacetsResponse = {
    total: 0,
    byEffectiveStatus: {},
    byExecutionMode: {},
    byAgentId: {},
    byNodeId: {},
    complete: results.every((result) => result.status.state === 'healthy'),
    peerStatus: Object.fromEntries(results.map((result) => [result.nodeId, result.status])),
  }
  for (const result of results) {
    if (result.facets === undefined) continue
    response.byNodeId[result.nodeId] = result.facets.nodeFacetCount
    if (!selected.has(result.nodeId)) continue
    response.total += result.facets.total
    mergeCountMaps(response.byEffectiveStatus, result.facets.byEffectiveStatus)
    mergeCountMaps(response.byExecutionMode, result.facets.byExecutionMode)
    mergeCountMaps(response.byAgentId, result.facets.byAgentId)
  }
  return json(response)
}

export async function handleSessionFacetsLocal(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const parsed = parseSessionQuery(this, url, { includeCursorAndLimit: false })
  const nodeId = localNodeId(this)
  const facets = this.db.sessionIndex.facets(parsed.filters)
  return json({
    ...facets,
    byNodeId: { [nodeId]: facets.nodeFacetCount },
    complete: true,
    peerStatus: { [nodeId]: healthyStatus() },
  } satisfies SessionFacetsResponse)
}

export const sessionIndexHandlersMethods = {
  handleSessionPage,
  handleSessionFacets,
  handleSessionFacetsLocal,
}

export type SessionIndexHandlersMethods = typeof sessionIndexHandlersMethods
