import {
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  type HrcErrorCode as HrcErrorCodeValue,
  HrcRuntimeUnavailableError,
  type StartRuntimeResponse,
  type SuffixStartRuntimeRequest,
} from 'hrc-core'

import type { PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import { buildPeerProtocolHeaders } from './peer-request.js'

export type SendRemoteRosterStartOptions = {
  readonly peer: PeerEntry
  readonly request: SuffixStartRuntimeRequest
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function responseBody(response: Response, surface: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as unknown
  if (!isRecord(body)) throw new Error(`${surface} response must be an object`)
  return body
}

const HRC_ERROR_CODES = new Set<string>(Object.values(HrcErrorCode))

function isHrcErrorCode(value: unknown): value is HrcErrorCodeValue {
  return typeof value === 'string' && HRC_ERROR_CODES.has(value)
}

function parseResult(body: Record<string, unknown>): StartRuntimeResponse {
  const claim = body['claim']
  if (
    typeof body['runtimeId'] !== 'string' ||
    typeof body['hostSessionId'] !== 'string' ||
    body['transport'] !== 'headless' ||
    typeof body['status'] !== 'string' ||
    typeof body['supportsInFlightInput'] !== 'boolean' ||
    !isRecord(claim) ||
    typeof claim['slot'] !== 'string' ||
    typeof claim['scopeRef'] !== 'string' ||
    typeof claim['sessionRef'] !== 'string' ||
    typeof claim['hostSessionId'] !== 'string' ||
    typeof claim['idempotencyKey'] !== 'string' ||
    typeof claim['replayed'] !== 'boolean'
  ) {
    throw new Error('peer roster-start response contains an invalid result')
  }
  return {
    runtimeId: body['runtimeId'],
    hostSessionId: body['hostSessionId'],
    transport: 'headless',
    status: body['status'],
    supportsInFlightInput: body['supportsInFlightInput'],
    claim: {
      slot: claim['slot'],
      scopeRef: claim['scopeRef'],
      sessionRef: claim['sessionRef'],
      hostSessionId: claim['hostSessionId'],
      idempotencyKey: claim['idempotencyKey'],
      replayed: claim['replayed'],
    },
  }
}

function peerUpgradeRequired(peer: PeerEntry): HrcConflictError {
  return new HrcConflictError(
    HrcErrorCode.STALE_CONTEXT,
    'remote suffix-roster provisioning requires a peer upgrade',
    { homeNodeId: peer.nodeId, reason: 'peer_upgrade_required', retryable: false }
  )
}

/** One synchronous, capability-gated provisioning attempt. Never uses the message outbox. */
export async function sendRemoteRosterStart(
  options: SendRemoteRosterStartOptions
): Promise<StartRuntimeResponse> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('federation roster-start timeoutMs must be a positive integer')
  }

  try {
    const health = await fetchImpl(new URL('/v1/federation/health', options.peer.endpoint), {
      headers: buildPeerProtocolHeaders(options.peer, PEER_PROTOCOL_VERSION),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (health.status === 404) throw peerUpgradeRequired(options.peer)
    const healthBody = await responseBody(health, 'peer health')
    if (!health.ok) {
      throw new HrcRuntimeUnavailableError('remote roster-start peer health was refused', {
        homeNodeId: options.peer.nodeId,
        retryable: true,
        status: health.status,
      })
    }
    const capabilities = healthBody['capabilities']
    if (!isRecord(capabilities) || capabilities['rosterStart'] !== true) {
      throw peerUpgradeRequired(options.peer)
    }

    const response = await fetchImpl(
      new URL('/v1/federation/roster-start', options.peer.endpoint),
      {
        method: 'POST',
        headers: buildPeerProtocolHeaders(options.peer, PEER_PROTOCOL_VERSION, {
          contentType: 'application/json',
        }),
        body: JSON.stringify(options.request),
        signal: AbortSignal.timeout(timeoutMs),
      }
    )
    if (response.status === 404) throw peerUpgradeRequired(options.peer)
    const body = await responseBody(response, 'peer roster-start')
    if (response.ok) return parseResult(body)

    const error = body['error']
    if (
      !isRecord(error) ||
      !isHrcErrorCode(error['code']) ||
      typeof error['message'] !== 'string'
    ) {
      throw new Error(`peer roster-start refused with malformed response (HTTP ${response.status})`)
    }
    throw new HrcDomainError(
      error['code'],
      error['message'],
      isRecord(error['detail'])
        ? error['detail']
        : { homeNodeId: options.peer.nodeId, retryable: error['retryable'] === true }
    )
  } catch (error) {
    if (error instanceof HrcDomainError) throw error
    throw new HrcRuntimeUnavailableError('remote suffix-roster provisioning is unavailable', {
      homeNodeId: options.peer.nodeId,
      retryable: true,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
