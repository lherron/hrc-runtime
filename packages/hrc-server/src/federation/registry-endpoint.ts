import { dirname, join } from 'node:path'

import {
  type BindingRegistry,
  type BirthDesignationEstablishmentDecision,
  type BirthDesignationSupersededBy,
  openBindingRegistry,
} from 'hrc-store-sqlite'

import type { BirthEnvelopeReader } from './birth-designation.js'
import { BirthEnvelopeUnavailableError, designateBirthOnHost } from './birth-designation.js'
import type { RegistryListenerConfig } from './registry-bind.js'
import type { BindingRegistryClient } from './registry-client.js'
import { createLocalBindingRegistryClient } from './registry-client.js'

export const BINDING_REGISTRY_BASENAME = 'binding-registry.sqlite'

export type RegistryAuthToken = {
  /** Constant-time comparison that does not expose the stored secret. */
  matches(candidate: string): boolean
}

export type RegistryAuthPeer = {
  readonly nodeId: string
  readonly token: RegistryAuthToken
}

export type BindingRegistryEndpointControl = {
  readonly url: string
  /** In-process authority path for the node hosting this registry. */
  readonly registryClient: BindingRegistryClient
  stop(): void
}

class InvalidRegistryRequest extends Error {}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRegistryRequest()
  }
  return value.trim()
}

async function requestRecord(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new InvalidRegistryRequest()
  }
  if (!isRecord(value)) throw new InvalidRegistryRequest()
  return value
}

function parseBirthDesignationSupersededBy(value: unknown): BirthDesignationSupersededBy {
  if (
    value === 'pin' ||
    value === 'task_default' ||
    value === 'default_home_node' ||
    value === 'explicit_local'
  ) {
    return value
  }
  throw new InvalidRegistryRequest()
}

function parseBirthDesignationDecision(
  value: unknown
): BirthDesignationEstablishmentDecision | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new InvalidRegistryRequest()
  if (value['action'] === 'enforce-designated-home') {
    return { action: 'enforce-designated-home' }
  }
  if (value['action'] === 'supersede') {
    return {
      action: 'supersede',
      supersededBy: parseBirthDesignationSupersededBy(value['supersededBy']),
    }
  }
  throw new InvalidRegistryRequest()
}

function authenticate(
  request: Request,
  peers: ReadonlyMap<string, RegistryAuthPeer>
): RegistryAuthPeer | undefined {
  const header = request.headers.get('authorization')
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match === null || match[1] === undefined || match[1].length === 0) return undefined

  // Evaluate every configured token even after a match so token order does not
  // become a remotely observable short-circuit. PeerToken owns the constant-
  // time, length-safe secret comparison; this layer never calls reveal().
  let authenticated: RegistryAuthPeer | undefined
  for (const peer of peers.values()) {
    if (peer.token.matches(match[1])) authenticated = peer
  }
  return authenticated
}

/**
 * The designation routes, extracted so the router's own complexity does not
 * grow with every placement question the collective learns to answer. Returns
 * undefined when the request is not one of them.
 */
async function handleDesignationRoute(
  request: Request,
  url: URL,
  peer: RegistryAuthPeer,
  input: {
    registry: BindingRegistry
    birthEnvelopeFor?: BirthEnvelopeReader | undefined
  },
  now: () => string
): Promise<Response | undefined> {
  // Read-only companion to designate-birth, for `hrc target locate`. Locate
  // must never MINT a designation as a side effect of reporting, so it cannot
  // reuse the POST: a read that decided placement would be a report that
  // changes what it reports.
  if (request.method === 'GET' && url.pathname === '/v1/federation/registry/designation') {
    const scopeRef = url.searchParams.get('scopeRef')
    if (scopeRef === null || scopeRef.trim().length === 0) throw new InvalidRegistryRequest()
    const record = input.registry.latestDesignation(scopeRef)
    return responseJson({
      ok: true,
      authenticatedNodeId: peer.nodeId,
      outcome:
        record === undefined ? 'none' : record.state === 'live' ? 'designated' : 'superseded',
      ...(record === undefined ? {} : { designation: record }),
    })
  }

  // T-07661 — the virgin births one node still owes, so its kicker's periodic
  // sweep has a candidate set for scopes NOBODY seats.
  //
  // A node may only ask about ITSELF. That is not access control for its own
  // sake: an answer scoped to the caller cannot become an instruction to birth
  // somebody else's scope, which keeps this a READ of a decision the host
  // already took rather than a second, weaker, way to route a birth.
  if (request.method === 'GET' && url.pathname === '/v1/federation/registry/unborn-designations') {
    const homeNodeId = url.searchParams.get('homeNodeId')
    if (homeNodeId === null || homeNodeId.trim().length === 0) throw new InvalidRegistryRequest()
    if (homeNodeId.trim() !== peer.nodeId) {
      return responseJson({ ok: false, error: 'authenticated_node_mismatch' }, 403)
    }
    return responseJson({
      ok: true,
      authenticatedNodeId: peer.nodeId,
      designations: input.registry.listUnbornDesignationsForNode(peer.nodeId),
    })
  }

  if (request.method !== 'POST' || url.pathname !== '/v1/federation/registry/designate-birth') {
    return undefined
  }

  // No `authenticated_node_mismatch` check, and that is the point: the request
  // names only the TARGET scope. There is no node field to compare, because a
  // caller supplying placement input is exactly what this designation is built
  // to make impossible. Any authenticated peer may ask, and all get one answer.
  const body = await requestRecord(request)
  try {
    const result = await designateBirthOnHost(
      {
        registry: input.registry,
        ...(input.birthEnvelopeFor === undefined
          ? {}
          : { birthEnvelopeFor: input.birthEnvelopeFor }),
        now,
      },
      requiredString(body, 'scopeRef')
    )
    return responseJson({ ok: true, authenticatedNodeId: peer.nodeId, ...result })
  } catch (error) {
    if (error instanceof BirthEnvelopeUnavailableError) {
      // 503, never a 200 `none`: an unread ledger is not evidence that nothing
      // designated this scope, and reporting it as `none` would send every node
      // back to a local birth at the same instant.
      return responseJson({ ok: false, error: 'runtime_unavailable', retryable: true }, 503)
    }
    throw error
  }
}

export function createBindingRegistryRequestHandler(input: {
  registry: BindingRegistry
  peers: ReadonlyMap<string, RegistryAuthPeer>
  /** The host's own wrkq read for `designate-birth` (T-07655). */
  birthEnvelopeFor?: BirthEnvelopeReader | undefined
  now?: (() => string) | undefined
}): (request: Request) => Promise<Response> {
  const now = input.now ?? (() => new Date().toISOString())

  return async (request: Request): Promise<Response> => {
    const peer = authenticate(request, input.peers)
    if (peer === undefined) {
      return responseJson({ ok: false, error: 'unauthorized' }, 401)
    }

    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/v1/federation/registry/consult') {
        const scopeRef = url.searchParams.get('scopeRef')
        if (scopeRef === null || scopeRef.trim().length === 0) throw new InvalidRegistryRequest()
        const record = input.registry.get(scopeRef)
        if (record === undefined) {
          return responseJson(
            { ok: false, error: 'unbound', authenticatedNodeId: peer.nodeId },
            404
          )
        }
        return responseJson({
          ok: true,
          outcome: 'bound',
          authenticatedNodeId: peer.nodeId,
          binding: record,
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/federation/registry/establish') {
        const body = await requestRecord(request)
        const homeNodeId = requiredString(body, 'homeNodeId')
        if (homeNodeId !== peer.nodeId) {
          return responseJson({ ok: false, error: 'authenticated_node_mismatch' }, 403)
        }
        if ('placementSource' in body || 'establishmentProvenance' in body) {
          throw new InvalidRegistryRequest()
        }
        const birthDesignation = parseBirthDesignationDecision(body['birthDesignation'])
        const result = input.registry.establish({
          scopeRef: requiredString(body, 'scopeRef'),
          homeNodeId,
          ...(birthDesignation === undefined ? {} : { birthDesignation }),
          now: now(),
        })
        return responseJson({ ok: true, authenticatedNodeId: peer.nodeId, ...result })
      }

      const designationResponse = await handleDesignationRoute(request, url, peer, input, now)
      if (designationResponse !== undefined) return designationResponse

      if (request.method === 'POST' && url.pathname === '/v1/federation/registry/delete') {
        const body = await requestRecord(request)
        const expectedHomeNodeId = requiredString(body, 'expectedHomeNodeId')
        if (expectedHomeNodeId !== peer.nodeId) {
          return responseJson({ ok: false, error: 'authenticated_node_mismatch' }, 403)
        }
        const result = input.registry.deleteBinding({
          scopeRef: requiredString(body, 'scopeRef'),
          expectedHomeNodeId,
          retiredAt: requiredString(body, 'retiredAt'),
        })
        const status = result.outcome === 'conflict' ? 409 : 200
        return responseJson(
          { ok: status === 200, authenticatedNodeId: peer.nodeId, ...result },
          status
        )
      }

      return responseJson({ ok: false, error: 'not_found' }, 404)
    } catch {
      // Intentionally generic: request-controlled values and bearer material
      // are never reflected through validation or SQLite error messages.
      return responseJson({ ok: false, error: 'invalid_request' }, 400)
    }
  }
}

/**
 * HRC state lives at `<state tree>/hrc`; the registry is deliberately its
 * backed-up sibling at `<state tree>/federation/binding-registry.sqlite`.
 */
export function resolveBindingRegistryPath(stateRoot: string): string {
  return join(dirname(stateRoot), 'federation', BINDING_REGISTRY_BASENAME)
}

export function startBindingRegistryEndpoint(input: {
  listener: RegistryListenerConfig
  peers: ReadonlyMap<string, RegistryAuthPeer>
  registryPath: string
  localNodeId: string
  /**
   * The host's wrkq birth-envelope read (T-07655). Passed as a thunk-friendly
   * function because the daemon's ledger client is constructed AFTER this
   * endpoint; the closure resolves it at call time, not at construction.
   */
  birthEnvelopeFor?: BirthEnvelopeReader | undefined
  sqliteBusyTimeoutMs?: number | undefined
}): BindingRegistryEndpointControl {
  const bind = new URL(input.listener.bind)
  const registry = openBindingRegistry(input.registryPath, {
    busyTimeoutMs: input.sqliteBusyTimeoutMs,
  })
  try {
    // A zero-peer listener is the valid single-node authority shape. The local
    // gate uses registryClient below; the request handler still authenticates
    // before routing, so an empty auth map makes every network request a 401.
    const server = Bun.serve({
      hostname: bind.hostname.replace(/^\[|\]$/g, ''),
      port: Number(bind.port),
      fetch: createBindingRegistryRequestHandler({
        registry,
        peers: input.peers,
        ...(input.birthEnvelopeFor === undefined
          ? {}
          : { birthEnvelopeFor: input.birthEnvelopeFor }),
      }),
    })
    return {
      url: input.listener.bind,
      registryClient: createLocalBindingRegistryClient(registry, input.localNodeId, {
        ...(input.birthEnvelopeFor === undefined
          ? {}
          : { birthEnvelopeFor: input.birthEnvelopeFor }),
      }),
      stop() {
        server.stop(true)
        registry.close()
      },
    }
  } catch (error) {
    registry.close()
    throw error
  }
}
