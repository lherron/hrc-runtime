import { EVENT_INGEST_ROUTE_KEYS } from './event-ingest.js'
import { PEER_PROTOCOL_ROUTE_KEYS } from './federation/peer-protocol.js'
import { BINDING_REGISTRY_ROUTE_KEYS } from './federation/registry-endpoint.js'
import type { HrcServerInstance } from './index.js'
import { mainPatternRoutes } from './request-metrics.js'
import type { RequestMetricListener } from './request-metrics.js'
import { createRuntimeListRoutes } from './runtime-list-handlers.js'
import { buildExactRouteHandlers } from './server-exact-routes.js'

export type RequestRouteInventoryEntry = {
  listener: RequestMetricListener
  method: string
  route: string
}

function splitKey(listener: RequestMetricListener, key: string): RequestRouteInventoryEntry {
  const separator = key.indexOf(' ')
  return { listener, method: key.slice(0, separator), route: key.slice(separator + 1) }
}

/**
 * Every route each daemon listener answers, in the vocabulary request metrics
 * record (T-11541), so a rollup can name the routes nobody called. The main
 * socket's table is the real one: route builders only close over the instance,
 * so building them against an empty one runs no handler.
 */
export function listRequestRouteInventory(): RequestRouteInventoryEntry[] {
  const unbuilt = {} as HrcServerInstance
  const mainKeys = new Set(Object.keys(buildExactRouteHandlers(unbuilt)))
  for (const route of createRuntimeListRoutes(
    unbuilt as unknown as Parameters<typeof createRuntimeListRoutes>[0]
  )) {
    mainKeys.add(`${route.method} ${route.pathname}`)
  }
  return [
    ...[...mainKeys].map((key) => splitKey('main', key)),
    ...mainPatternRoutes().map(({ method, route }) => ({
      listener: 'main' as const,
      method,
      route,
    })),
    ...[...EVENT_INGEST_ROUTE_KEYS].map((key) => splitKey('ingest', key)),
    ...[...PEER_PROTOCOL_ROUTE_KEYS].map((key) => splitKey('peer', key)),
    ...[...BINDING_REGISTRY_ROUTE_KEYS].map((key) => splitKey('registry', key)),
  ]
}
