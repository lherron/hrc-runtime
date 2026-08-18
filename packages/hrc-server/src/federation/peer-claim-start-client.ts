/**
 * Shared transport for the two capability-gated claim-and-start peer verbs:
 * `rosterStart` (T-07118) and `exactStart` (T-07302).
 *
 * Both send ONE canonical request to the configured home peer, synchronously,
 * and never use the message outbox: provisioning is an interactive act, so a
 * retryable failure has to reach the person now rather than be queued behind a
 * delivery it looks nothing like.
 *
 * The verbs are separate routes with separate capability flags on purpose. A
 * peer that predates one of them 404s that route and is refused as
 * `peer_upgrade_required`, instead of having its older sibling silently reused
 * with different occupancy semantics.
 */

import {
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  type HrcErrorCode as HrcErrorCodeValue,
  HrcRuntimeUnavailableError,
  type StartRuntimeResponse,
} from 'hrc-core'

import type { PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import { buildPeerProtocolHeaders } from './peer-request.js'

export type PeerClaimStartCapability = 'rosterStart' | 'exactStart'

export type SendPeerClaimStartOptions = {
  readonly peer: PeerEntry
  readonly request: unknown
  /** Health capability flag that must be advertised `true` before we send. */
  readonly capability: PeerClaimStartCapability
  /** Peer route, e.g. `/v1/federation/exact-start`. */
  readonly path: string
  /** Operator-facing noun for this verb, used in refusal messages. */
  readonly label: string
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

/**
 * Validate a peer's claim-and-start result. Both verbs answer with the same
 * `StartRuntimeResponse & { claim }` shape, so one parser keeps their wire
 * contracts from drifting apart.
 */
export function parsePeerClaimStartResult(body: Record<string, unknown>): StartRuntimeResponse {
  const claim = body['claim']
  const transport = body['transport']
  const tmux = body['tmux']
  const surface = body['surface']
  if (
    typeof body['runtimeId'] !== 'string' ||
    typeof body['hostSessionId'] !== 'string' ||
    (transport !== 'headless' && transport !== 'tmux' && transport !== 'ghostty') ||
    typeof body['status'] !== 'string' ||
    typeof body['supportsInFlightInput'] !== 'boolean' ||
    (tmux !== undefined &&
      (!isRecord(tmux) ||
        typeof tmux['sessionId'] !== 'string' ||
        typeof tmux['windowId'] !== 'string' ||
        typeof tmux['paneId'] !== 'string')) ||
    (surface !== undefined &&
      (!isRecord(surface) ||
        typeof surface['surfaceId'] !== 'string' ||
        (surface['title'] !== undefined && typeof surface['title'] !== 'string'))) ||
    !isRecord(claim) ||
    typeof claim['slot'] !== 'string' ||
    typeof claim['scopeRef'] !== 'string' ||
    typeof claim['sessionRef'] !== 'string' ||
    typeof claim['hostSessionId'] !== 'string' ||
    typeof claim['idempotencyKey'] !== 'string' ||
    typeof claim['replayed'] !== 'boolean' ||
    (claim['conflictPolicy'] !== undefined &&
      claim['conflictPolicy'] !== 'suffix' &&
      claim['conflictPolicy'] !== 'reject')
  ) {
    throw new Error('peer claim-start response contains an invalid result')
  }
  const common = {
    runtimeId: body['runtimeId'],
    hostSessionId: body['hostSessionId'],
    status: body['status'],
    supportsInFlightInput: body['supportsInFlightInput'],
    claim: {
      slot: claim['slot'],
      scopeRef: claim['scopeRef'],
      sessionRef: claim['sessionRef'],
      hostSessionId: claim['hostSessionId'],
      idempotencyKey: claim['idempotencyKey'],
      replayed: claim['replayed'],
      ...(claim['conflictPolicy'] === undefined
        ? {}
        : { conflictPolicy: claim['conflictPolicy'] as 'suffix' | 'reject' }),
    },
  }
  if (transport === 'headless') return { ...common, transport }
  if (transport === 'ghostty') {
    return {
      ...common,
      transport,
      ...(surface === undefined
        ? {}
        : {
            surface: {
              surfaceId: surface['surfaceId'] as string,
              ...(surface['title'] === undefined ? {} : { title: surface['title'] as string }),
            },
          }),
    }
  }
  return {
    ...common,
    transport,
    ...(tmux === undefined
      ? {}
      : {
          tmux: {
            sessionId: tmux['sessionId'] as string,
            windowId: tmux['windowId'] as string,
            paneId: tmux['paneId'] as string,
          },
        }),
  }
}

function peerUpgradeRequired(peer: PeerEntry, label: string): HrcConflictError {
  return new HrcConflictError(
    HrcErrorCode.STALE_CONTEXT,
    `remote ${label} requires a peer upgrade`,
    { homeNodeId: peer.nodeId, reason: 'peer_upgrade_required', retryable: false }
  )
}

/** One synchronous, capability-gated provisioning attempt. Never uses the message outbox. */
export async function sendPeerClaimStart(
  options: SendPeerClaimStartOptions
): Promise<StartRuntimeResponse> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('federation claim-start timeoutMs must be a positive integer')
  }

  try {
    const health = await fetchImpl(new URL('/v1/federation/health', options.peer.endpoint), {
      headers: buildPeerProtocolHeaders(options.peer, PEER_PROTOCOL_VERSION),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (health.status === 404) throw peerUpgradeRequired(options.peer, options.label)
    const healthBody = await responseBody(health, 'peer health')
    if (!health.ok) {
      throw new HrcRuntimeUnavailableError(`remote ${options.label} peer health was refused`, {
        homeNodeId: options.peer.nodeId,
        retryable: true,
        status: health.status,
      })
    }
    const capabilities = healthBody['capabilities']
    if (!isRecord(capabilities) || capabilities[options.capability] !== true) {
      throw peerUpgradeRequired(options.peer, options.label)
    }

    const response = await fetchImpl(new URL(options.path, options.peer.endpoint), {
      method: 'POST',
      headers: buildPeerProtocolHeaders(options.peer, PEER_PROTOCOL_VERSION, {
        contentType: 'application/json',
      }),
      body: JSON.stringify(options.request),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 404) throw peerUpgradeRequired(options.peer, options.label)
    const body = await responseBody(response, `peer ${options.label}`)
    if (response.ok) return parsePeerClaimStartResult(body)

    const error = body['error']
    if (
      !isRecord(error) ||
      !isHrcErrorCode(error['code']) ||
      typeof error['message'] !== 'string'
    ) {
      throw new Error(
        `peer ${options.label} refused with malformed response (HTTP ${response.status})`
      )
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
    throw new HrcRuntimeUnavailableError(`remote ${options.label} is unavailable`, {
      homeNodeId: options.peer.nodeId,
      retryable: true,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
