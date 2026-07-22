import type {
  FederationPeerCapabilities,
  FederationPeerHealthObservation,
  HrcRuntimeSnapshot,
  LocatePeerResolution,
  ScopeLocation,
} from 'hrc-core'

import type { PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import { buildPeerProtocolHeaders } from './peer-request.js'

export const FEDERATION_PEER_OBSERVE_TIMEOUT_MS = 1_500

export type PeerHealthProbe = {
  readonly health: FederationPeerHealthObservation
  readonly runtimes?: readonly HrcRuntimeSnapshot[] | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function elapsedMs(startedMs: number): number {
  return Math.max(0, Math.round(performance.now() - startedMs))
}

function detail(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'probe timed out'
  return error instanceof Error ? error.message : String(error)
}

function parseCapabilities(value: unknown): FederationPeerCapabilities | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value['accept'] !== 'boolean' ||
    typeof value['locate'] !== 'boolean' ||
    typeof value['health'] !== 'boolean'
  ) {
    return undefined
  }
  return {
    accept: value['accept'],
    locate: value['locate'],
    health: value['health'],
    ...(typeof value['establish'] === 'boolean' ? { establish: value['establish'] } : {}),
    ...(typeof value['runtimeProjection'] === 'boolean'
      ? { runtimeProjection: value['runtimeProjection'] }
      : {}),
  }
}

function parseRuntimes(value: unknown): HrcRuntimeSnapshot[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const result: HrcRuntimeSnapshot[] = []
  for (const row of value) {
    if (
      !isRecord(row) ||
      nonEmptyString(row['runtimeId']) === undefined ||
      nonEmptyString(row['scopeRef']) === undefined ||
      nonEmptyString(row['laneRef']) === undefined ||
      nonEmptyString(row['status']) === undefined
    ) {
      return undefined
    }
    result.push(row as HrcRuntimeSnapshot)
  }
  return result
}

function refusedDetail(response: Response, body: unknown): string {
  const code =
    isRecord(body) && isRecord(body['error']) ? nonEmptyString(body['error']['code']) : undefined
  return code === undefined
    ? `peer refused health probe (HTTP ${response.status})`
    : `${code} (HTTP ${response.status})`
}

/** One bounded authenticated health request, optionally carrying a filtered runtime projection. */
export async function probePeerHealth(
  peer: PeerEntry,
  options: {
    readonly includeRuntimes?: boolean | undefined
    readonly filter?: URLSearchParams | undefined
    readonly fetch?: typeof globalThis.fetch | undefined
    readonly timeoutMs?: number | undefined
  } = {}
): Promise<PeerHealthProbe> {
  const checkedAt = new Date().toISOString()
  const startedMs = performance.now()
  const url = new URL('/v1/federation/health', peer.endpoint)
  if (options.includeRuntimes === true) url.searchParams.set('includeRuntimes', 'true')
  for (const [name, value] of options.filter ?? []) url.searchParams.append(name, value)
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      headers: buildPeerProtocolHeaders(peer, PEER_PROTOCOL_VERSION),
      signal: AbortSignal.timeout(options.timeoutMs ?? FEDERATION_PEER_OBSERVE_TIMEOUT_MS),
    })
    const body = (await response.json()) as unknown
    if (!response.ok) {
      return {
        health: {
          nodeId: peer.nodeId,
          state: 'refused',
          checkedAt,
          latencyMs: elapsedMs(startedMs),
          detail: refusedDetail(response, body),
        },
      }
    }
    const nodeId = isRecord(body) ? nonEmptyString(body['nodeId']) : undefined
    const capabilities = isRecord(body) ? parseCapabilities(body['capabilities']) : undefined
    const protocolVersion = isRecord(body) ? nonEmptyString(body['protocolVersion']) : undefined
    const startedAt = isRecord(body) ? nonEmptyString(body['startedAt']) : undefined
    const answeredAt = isRecord(body) ? nonEmptyString(body['observedAt']) : undefined
    const runtimes = isRecord(body) ? parseRuntimes(body['runtimes']) : undefined
    if (
      nodeId !== peer.nodeId ||
      capabilities === undefined ||
      protocolVersion === undefined ||
      startedAt === undefined ||
      (options.includeRuntimes === true && runtimes === undefined)
    ) {
      return {
        health: {
          nodeId: peer.nodeId,
          state: 'invalid-response',
          checkedAt,
          latencyMs: elapsedMs(startedMs),
          detail:
            nodeId !== peer.nodeId
              ? `peer identified itself as ${nodeId ?? 'unknown'}`
              : 'malformed peer health response',
        },
      }
    }
    return {
      health: {
        nodeId: peer.nodeId,
        state: 'healthy',
        checkedAt,
        answeredAt: answeredAt ?? new Date().toISOString(),
        latencyMs: elapsedMs(startedMs),
        protocolVersion,
        startedAt,
        capabilities,
      },
      ...(runtimes === undefined ? {} : { runtimes }),
    }
  } catch (error) {
    return {
      health: {
        nodeId: peer.nodeId,
        state: 'unreachable',
        checkedAt,
        latencyMs: elapsedMs(startedMs),
        detail: detail(error),
      },
    }
  }
}

/** Resolve the authoritative remote node without allowing a recursive federation fanout. */
export async function locatePeerScope(
  peer: PeerEntry,
  scopeRef: string,
  options: {
    readonly fetch?: typeof globalThis.fetch | undefined
    readonly timeoutMs?: number | undefined
  } = {}
): Promise<LocatePeerResolution> {
  const checkedAt = new Date().toISOString()
  const startedMs = performance.now()
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      new URL('/v1/federation/locate', peer.endpoint),
      {
        method: 'POST',
        headers: buildPeerProtocolHeaders(peer, PEER_PROTOCOL_VERSION, {
          contentType: 'application/json',
        }),
        body: JSON.stringify({ scopeRef }),
        signal: AbortSignal.timeout(options.timeoutMs ?? FEDERATION_PEER_OBSERVE_TIMEOUT_MS),
      }
    )
    const body = (await response.json()) as unknown
    if (!response.ok) {
      return {
        nodeId: peer.nodeId,
        state: 'refused',
        checkedAt,
        latencyMs: elapsedMs(startedMs),
        detail: refusedDetail(response, body),
      }
    }
    const location = isRecord(body) && isRecord(body['location']) ? body['location'] : undefined
    if (
      location === undefined ||
      location['scopeRef'] !== scopeRef ||
      location['localNodeId'] !== peer.nodeId ||
      !isRecord(location['observed']) ||
      location['observed']['nodeId'] !== peer.nodeId
    ) {
      return {
        nodeId: peer.nodeId,
        state: 'invalid-response',
        checkedAt,
        latencyMs: elapsedMs(startedMs),
        detail: 'malformed peer locate response',
      }
    }
    return {
      nodeId: peer.nodeId,
      state: 'answered',
      checkedAt,
      answeredAt: new Date().toISOString(),
      latencyMs: elapsedMs(startedMs),
      location: location as ScopeLocation,
    }
  } catch (error) {
    return {
      nodeId: peer.nodeId,
      state: 'unreachable',
      checkedAt,
      latencyMs: elapsedMs(startedMs),
      detail: detail(error),
    }
  }
}
