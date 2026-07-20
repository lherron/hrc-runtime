import { dirname, join } from 'node:path'

import {
  type BindingRegistry,
  type BirthAuthorityProvenance,
  type EstablishmentProvenance,
  type FederationBirthClass,
  openBindingRegistry,
} from 'hrc-store-sqlite'

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

function parseBirthClass(value: unknown): FederationBirthClass {
  if (value === 'policy-born' || value === 'mechanism-born') return value
  throw new InvalidRegistryRequest()
}

function parseEstablishmentProvenance(value: unknown): Exclude<EstablishmentProvenance, 'rebind'> {
  if (
    value === 'pin' ||
    value === 'default_home_node' ||
    value === 'default_home_node(local)' ||
    value === 'explicit_local'
  ) {
    return value
  }
  throw new InvalidRegistryRequest()
}

function parseAuthorityProvenance(value: unknown): BirthAuthorityProvenance {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || value['kind'].trim().length === 0) {
    throw new InvalidRegistryRequest()
  }
  return value as BirthAuthorityProvenance
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

export function createBindingRegistryRequestHandler(input: {
  registry: BindingRegistry
  peers: ReadonlyMap<string, RegistryAuthPeer>
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
        const binding = input.registry.get(scopeRef)
        if (binding === undefined) {
          return responseJson(
            { ok: false, error: 'unbound', authenticatedNodeId: peer.nodeId },
            404
          )
        }
        return responseJson({ ok: true, authenticatedNodeId: peer.nodeId, binding })
      }

      if (request.method === 'POST' && url.pathname === '/v1/federation/registry/establish') {
        const body = await requestRecord(request)
        const homeNodeId = requiredString(body, 'homeNodeId')
        if (homeNodeId !== peer.nodeId) {
          return responseJson({ ok: false, error: 'authenticated_node_mismatch' }, 403)
        }
        const result = input.registry.establish({
          scopeRef: requiredString(body, 'scopeRef'),
          homeNodeId,
          placementEpoch: 1,
          birthClass: parseBirthClass(body['birthClass']),
          authorityProvenance: parseAuthorityProvenance(body['authorityProvenance']),
          establishmentProvenance: parseEstablishmentProvenance(body['establishmentProvenance']),
          now: now(),
        })
        return responseJson({ ok: true, authenticatedNodeId: peer.nodeId, ...result })
      }

      if (request.method === 'POST' && url.pathname === '/v1/federation/registry/cas') {
        const body = await requestRecord(request)
        const newHomeNodeId = requiredString(body, 'newHomeNodeId')
        if (newHomeNodeId !== peer.nodeId) {
          return responseJson({ ok: false, error: 'authenticated_node_mismatch' }, 403)
        }
        const expectedPlacementEpoch = body['expectedPlacementEpoch']
        if (!Number.isSafeInteger(expectedPlacementEpoch) || Number(expectedPlacementEpoch) < 1) {
          throw new InvalidRegistryRequest()
        }
        const result = input.registry.compareAndSwap({
          scopeRef: requiredString(body, 'scopeRef'),
          expectedHomeNodeId: requiredString(body, 'expectedHomeNodeId'),
          expectedPlacementEpoch: Number(expectedPlacementEpoch),
          newHomeNodeId,
          now: now(),
        })
        const status =
          result.outcome === 'conflict' ? 409 : result.outcome === 'not_found' ? 404 : 200
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
}): BindingRegistryEndpointControl {
  if (input.peers.size === 0) {
    throw new Error('federation registry listener requires at least one authenticated peer')
  }
  const bind = new URL(input.listener.bind)
  const registry = openBindingRegistry(input.registryPath)
  try {
    const server = Bun.serve({
      hostname: bind.hostname.replace(/^\[|\]$/g, ''),
      port: Number(bind.port),
      fetch: createBindingRegistryRequestHandler({ registry, peers: input.peers }),
    })
    return {
      url: input.listener.bind,
      registryClient: createLocalBindingRegistryClient(registry, input.localNodeId),
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
