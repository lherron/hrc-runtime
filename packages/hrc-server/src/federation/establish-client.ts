import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  FederationPlacementBinding,
  FederationRemoteEstablishRequest,
  FederationRemoteEstablishResult,
} from 'hrc-core'

import type { PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import { buildPeerProtocolHeaders } from './peer-request.js'

export type SendRemoteEstablishOptions = {
  readonly peer: PeerEntry
  readonly request: FederationRemoteEstablishRequest
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function upgradeRequired(peer: PeerEntry): FederationRemoteEstablishResult {
  return {
    outcome: 'refused',
    status: 409,
    code: 'stale_context',
    message: 'remote policy establishment requires a peer upgrade',
    reason: 'peer_upgrade_required',
    retryable: false,
    homeNodeId: peer.nodeId,
  }
}

function parseBinding(value: unknown, scopeRef: string): FederationPlacementBinding {
  if (!isRecord(value)) throw new Error('peer establish response binding must be an object')
  const authority = value['authorityProvenance']
  const priorHomeNodeId = value['priorHomeNodeId']
  if (
    value['scopeRef'] !== scopeRef ||
    typeof value['homeNodeId'] !== 'string' ||
    !Number.isSafeInteger(value['placementEpoch']) ||
    (value['placementEpoch'] as number) < 1 ||
    (value['birthClass'] !== 'policy-born' && value['birthClass'] !== 'mechanism-born') ||
    !isRecord(authority) ||
    typeof authority['kind'] !== 'string' ||
    (value['establishmentProvenance'] !== 'pin' &&
      value['establishmentProvenance'] !== 'task_default' &&
      value['establishmentProvenance'] !== 'default_home_node' &&
      value['establishmentProvenance'] !== 'default_home_node(local)' &&
      value['establishmentProvenance'] !== 'explicit_local' &&
      value['establishmentProvenance'] !== 'rebind') ||
    (priorHomeNodeId !== undefined && typeof priorHomeNodeId !== 'string') ||
    typeof value['createdAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['createdAt'])) ||
    typeof value['updatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['updatedAt']))
  ) {
    throw new Error('peer establish response contains an invalid binding')
  }
  return {
    scopeRef,
    homeNodeId: value['homeNodeId'],
    placementEpoch: value['placementEpoch'] as number,
    birthClass: value['birthClass'],
    authorityProvenance: authority as FederationPlacementBinding['authorityProvenance'],
    establishmentProvenance: value['establishmentProvenance'],
    ...(priorHomeNodeId === undefined ? {} : { priorHomeNodeId }),
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  }
}

async function responseBody(response: Response, surface: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as unknown
  if (!isRecord(body)) throw new Error(`${surface} response must be an object`)
  return body
}

/** One authority-only establishment attempt. Durable retries belong to the outbox. */
export async function sendRemoteEstablish(
  options: SendRemoteEstablishOptions
): Promise<FederationRemoteEstablishResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('federation establish timeoutMs must be a positive integer')
  }
  const scopeRef = formatCanonicalScopeRef({ scopeRef: options.request.scopeRef })

  const health = await fetchImpl(new URL('/v1/federation/health', options.peer.endpoint), {
    headers: buildPeerProtocolHeaders(options.peer, PEER_PROTOCOL_VERSION),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (health.status === 404) return upgradeRequired(options.peer)
  const healthBody = await responseBody(health, 'peer health')
  if (!health.ok) {
    return {
      outcome: 'refused',
      status: health.status,
      code: 'stale_context',
      message: 'remote policy establishment peer health was refused',
      reason: 'registry-refused',
      retryable: false,
      homeNodeId: options.peer.nodeId,
    }
  }
  const capabilities = healthBody['capabilities']
  if (!isRecord(capabilities) || capabilities['establish'] !== true) {
    return upgradeRequired(options.peer)
  }

  const response = await fetchImpl(new URL('/v1/federation/establish', options.peer.endpoint), {
    method: 'POST',
    headers: buildPeerProtocolHeaders(options.peer, PEER_PROTOCOL_VERSION, {
      contentType: 'application/json',
    }),
    body: JSON.stringify({ ...options.request, scopeRef }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status === 404) return upgradeRequired(options.peer)
  const body = await responseBody(response, 'peer establish')
  if (response.ok) {
    if (
      (body['outcome'] !== 'established' && body['outcome'] !== 'existing') ||
      body['correlationId'] !== options.request.correlationId
    ) {
      throw new Error('peer establish response contains an invalid result')
    }
    return {
      outcome: body['outcome'],
      correlationId: options.request.correlationId,
      binding: parseBinding(body['binding'], scopeRef),
    }
  }

  const error = body['error']
  if (
    !isRecord(error) ||
    (error['code'] !== 'stale_context' && error['code'] !== 'runtime_unavailable') ||
    typeof error['message'] !== 'string' ||
    typeof error['reason'] !== 'string'
  ) {
    throw new Error(`peer establish refused with malformed response (HTTP ${response.status})`)
  }
  return {
    outcome: 'refused',
    status: response.status,
    code: error['code'],
    message: error['message'],
    reason: error['reason'],
    retryable: error['retryable'] === true,
    ...(typeof error['homeNodeId'] === 'string' ? { homeNodeId: error['homeNodeId'] } : {}),
  }
}
