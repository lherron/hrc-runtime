import type { FederationMessageEnvelope } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION_HEADER } from './peer-protocol.js'

export type PeerAcceptClientResult =
  | { outcome: 'accepted' | 'duplicate'; messageId: string }
  | {
      outcome: 'refused'
      status: number
      code: string
      retryable: boolean
      redirect?: { homeNodeId: string; placementEpoch: number } | undefined
    }

export type SendFederationEnvelopeOptions = {
  readonly db: HrcDatabase
  readonly peer: PeerEntry
  readonly envelope: FederationMessageEnvelope
  readonly fetch?: typeof globalThis.fetch | undefined
  /** Bounds one transport attempt; retries are owned by the durable outbox. */
  readonly timeoutMs?: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRedirect(value: unknown): { homeNodeId: string; placementEpoch: number } | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value['homeNodeId'] !== 'string' ||
    !Number.isSafeInteger(value['placementEpoch']) ||
    (value['placementEpoch'] as number) < 1
  ) {
    return undefined
  }
  return {
    homeNodeId: value['homeNodeId'],
    placementEpoch: value['placementEpoch'] as number,
  }
}

/**
 * One one-shot accept request. T-06619 owns retries/outbox state; this seam
 * owns the atomic consequence of a successful ACK at the origin.
 */
export async function sendFederationEnvelope(
  options: SendFederationEnvelopeOptions
): Promise<PeerAcceptClientResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('federation accept timeoutMs must be a positive integer')
  }
  const response = await fetchImpl(new URL('/v1/federation/accept', options.peer.endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.peer.token.reveal()}`,
      'content-type': 'application/json',
      [PEER_PROTOCOL_VERSION_HEADER]: options.envelope.protocolVersion,
    },
    body: JSON.stringify({ envelope: options.envelope }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await response.json()) as unknown
  if (!isRecord(body)) throw new Error('peer accept response must be an object')

  if (response.ok) {
    const ack = body['ack']
    if (
      !isRecord(ack) ||
      (ack['outcome'] !== 'accepted' && ack['outcome'] !== 'duplicate') ||
      ack['messageId'] !== options.envelope.messageId
    ) {
      throw new Error('peer accept response contains an invalid ACK')
    }
    if (options.envelope.phase === 'request') {
      options.db.federationAcceptedRequests.record({
        requestMessageId: options.envelope.messageId,
        acceptedByNodeId: options.peer.nodeId,
        acceptedEpoch: options.envelope.expected.placementEpoch,
      })
    }
    return { outcome: ack['outcome'], messageId: ack['messageId'] }
  }

  const error = body['error']
  if (!isRecord(error) || typeof error['code'] !== 'string') {
    throw new Error(`peer accept refused with malformed response (HTTP ${response.status})`)
  }
  const redirect = parseRedirect(error['redirect'])
  return {
    outcome: 'refused',
    status: response.status,
    code: error['code'],
    retryable: error['retryable'] === true,
    ...(redirect === undefined ? {} : { redirect }),
  }
}
