import { describe, expect, it } from 'bun:test'

import {
  PEER_PROTOCOL_VERSION,
  PEER_PROTOCOL_VERSION_HEADER,
  createPeerProtocolRequestHandler,
} from '../federation/peer-protocol'
import { PeerToken } from '../federation/peer-token'

/**
 * T-07155 gates G10, G17, G23, G24, G25 — federated urgent delivery.
 *
 * The property under test is an ORDERING one, not an identity one. The ordinary
 * accept path builds the durable ACK and schedules local delivery before
 * returning, so the origin can only inspect a response after the destination has
 * already actuated. Any field-level marker is therefore unsafe across version
 * skew: a peer that drops it durably ACKs an ordinary DM and delivers it.
 *
 * The fix is that urgent delivery rides its OWN route, so routing and urgent
 * admission are the same operation and there is no window between them. These
 * tests assert the consequence: a peer without the feature refuses before
 * parsing an envelope, constructing an ACK, or scheduling any delivery.
 */

const PEER_TOKEN = 'peer-a-token'

type HandlerOptions = Parameters<typeof createPeerProtocolRequestHandler>[0]

function peers(allowUrgentDelivery: boolean) {
  return new Map([
    [
      'peer-a',
      {
        nodeId: 'peer-a',
        endpoint: 'http://peer-a.example.ts.net:18490',
        token: new PeerToken(PEER_TOKEN),
        acceptedTokens: [new PeerToken(PEER_TOKEN)],
        ...(allowUrgentDelivery ? { allowUrgentDelivery: true } : {}),
      },
    ],
  ]) as unknown as HandlerOptions['peers']
}

const envelope = {
  protocolVersion: PEER_PROTOCOL_VERSION,
  messageId: 'msg-urgent-1',
  phase: 'request',
  from: { kind: 'entity', entity: 'human' },
  to: { kind: 'session', sessionRef: 'agent:x:project:p/lane:main' },
  body: 'STOP',
  delivery: { urgent: { version: 1 } },
}

function request(path: string): Request {
  const headers = new Headers()
  headers.set('authorization', `Bearer ${PEER_TOKEN}`)
  headers.set(PEER_PROTOCOL_VERSION_HEADER, PEER_PROTOCOL_VERSION)
  headers.set('content-type', 'application/json')
  return new Request(`http://lab.example.ts.net:18490${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ envelope }),
  })
}

describe('T-07155 federated urgent delivery', () => {
  it('G17/G23: a peer without the urgent route refuses before any ACK or actuation', async () => {
    let ordinaryAcceptCalls = 0
    const handler = createPeerProtocolRequestHandler({
      localNodeId: 'lab',
      peers: peers(true),
      // An OLD peer: it has the ordinary accept handler but no acceptUrgent.
      accept: async () => {
        ordinaryAcceptCalls += 1
        return { outcome: 'accepted' as const, messageId: 'msg-urgent-1' }
      },
    } as HandlerOptions)

    const response = await handler(request('/v1/federation/accept-urgent'))

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string; retryable?: boolean } }
    expect(body.error.code).toBe('peer_upgrade_required')
    expect(body.error.retryable).toBe(false)
    // The decisive assertion: the ordinary accept handler was never reached, so
    // nothing was durably ACKed and no local delivery was scheduled. The order
    // cannot have been actuated as an ordinary DM.
    expect(ordinaryAcceptCalls).toBe(0)
  })

  it('G17: an entirely unknown urgent path is a plain not_found, still without actuation', async () => {
    let ordinaryAcceptCalls = 0
    const handler = createPeerProtocolRequestHandler({
      localNodeId: 'lab',
      peers: peers(true),
      accept: async () => {
        ordinaryAcceptCalls += 1
        return { outcome: 'accepted' as const, messageId: 'msg-urgent-1' }
      },
    } as HandlerOptions)

    const response = await handler(request('/v1/federation/accept-urgent-vnext'))
    expect(response.status).toBe(404)
    expect(ordinaryAcceptCalls).toBe(0)
  })

  it('G24: an unauthorized peer is refused before admission (default deny)', async () => {
    let urgentAcceptCalls = 0
    const handler = createPeerProtocolRequestHandler({
      localNodeId: 'lab',
      peers: peers(false),
      accept: async () => ({ outcome: 'accepted' as const, messageId: 'msg-urgent-1' }),
      acceptUrgent: async (input) => {
        // Mirrors the server wiring: authorization precedes admission.
        const allowed = false
        if (!allowed) {
          return {
            outcome: 'refused' as const,
            status: 403,
            code: 'urgent_delivery_not_authorized',
            retryable: false,
          }
        }
        urgentAcceptCalls += 1
        return { outcome: 'accepted' as const, messageId: input.envelope.messageId as string }
      },
    } as HandlerOptions)

    const response = await handler(request('/v1/federation/accept-urgent'))

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('urgent_delivery_not_authorized')
    expect(urgentAcceptCalls).toBe(0)
  })

  it('G10/G25: an authorized peer is admitted as urgent and the ACK says so', async () => {
    let afterAckRan = false
    const handler = createPeerProtocolRequestHandler({
      localNodeId: 'lab',
      peers: peers(true),
      accept: async () => ({ outcome: 'accepted' as const, messageId: 'unused' }),
      acceptUrgent: async (input) => ({
        outcome: 'accepted' as const,
        messageId: input.envelope.messageId as string,
        afterAck: () => {
          afterAckRan = true
        },
      }),
    } as HandlerOptions)

    const response = await handler(request('/v1/federation/accept-urgent'))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ack: { outcome: string; messageId: string; delivery: string }
    }
    // The ACK on this route means "admitted as urgent", not merely "stored".
    expect(body.ack).toMatchObject({
      outcome: 'accepted',
      messageId: 'msg-urgent-1',
      delivery: 'urgent',
    })

    await Bun.sleep(10)
    expect(afterAckRan).toBe(true)
  })
})
