import { describe, expect, test } from 'bun:test'

import type { FederationMessageEnvelope } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { sendFederationEnvelope } from '../federation/accept-client.js'
import {
  InMemoryBindingHintCache,
  createStalePlacementRedirectHandler,
} from '../federation/binding-cache.js'
import { parseNodeId } from '../federation/node-id.js'
import {
  DEFAULT_FEDERATION_OUTBOX_RETRY_POLICY,
  FederationOutboxDeliveryEngine,
  type FederationOutboxDeliveryObservation,
  federationRetryDelayMs,
} from '../federation/outbox-delivery.js'
import { PeerToken } from '../federation/peer-token.js'

const MESSAGE_ID = 'msg-11111111-1111-4111-8111-111111111111'
const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06619'
const SESSION = `${SCOPE}/lane:default`

function seed(db: ReturnType<typeof openHrcDatabase>): FederationMessageEnvelope {
  const value: FederationMessageEnvelope = {
    protocolVersion: '1.0',
    messageId: MESSAGE_ID,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime:task:minisvc' },
    to: { kind: 'session', sessionRef: SESSION },
    body: 'wake up when ready',
    rootMessageId: MESSAGE_ID,
    expected: { homeNodeId: 'lab', placementEpoch: 2 },
  }
  db.messages.insert({
    messageId: value.messageId,
    kind: value.kind,
    phase: value.phase,
    from: value.from,
    to: value.to,
    body: value.body,
  })
  db.federationOutbox.enqueue({
    deliveryId: 'delivery-1',
    messageId: value.messageId,
    peerNodeId: 'lab',
    envelope: value,
    now: '2026-07-20T00:00:00.000Z',
  })
  return value
}

describe('T-06619 clock-driven federation retry state machine', () => {
  test('the accept client fires the binding-cache correction seam at the redirect response site', async () => {
    const db = openHrcDatabase(':memory:')
    const envelope = seed(db)
    const cache = new InMemoryBindingHintCache()
    cache.learn({
      scopeRef: SCOPE,
      homeNodeId: 'lab',
      placementEpoch: 2,
    })

    try {
      const result = await sendFederationEnvelope({
        db,
        peer: {
          nodeId: parseNodeId('lab', 'test peer'),
          endpoint: 'http://127.0.0.1:18499/',
          token: new PeerToken('test-token'),
        },
        envelope,
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'stale_placement',
                retryable: true,
                redirect: { homeNodeId: 'lab-next', placementEpoch: 3 },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } }
          ),
        onStaleRedirect: createStalePlacementRedirectHandler(cache),
      })

      expect(result).toMatchObject({
        outcome: 'refused',
        code: 'stale_placement',
        redirect: { homeNodeId: 'lab-next', placementEpoch: 3 },
      })
      expect(cache.get(SCOPE)).toMatchObject({
        homeNodeId: 'lab-next',
        placementEpoch: 3,
      })
    } finally {
      db.close()
    }
  })

  test('default exponential retry is capped and the terminal horizon is measured in weeks', () => {
    const policy = DEFAULT_FEDERATION_OUTBOX_RETRY_POLICY
    expect(policy.deadLetterAfterMs).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1_000)
    expect(federationRetryDelayMs(1, policy)).toBe(policy.initialRetryDelayMs)
    expect(federationRetryDelayMs(2, policy)).toBe(policy.initialRetryDelayMs * 2)
    expect(federationRetryDelayMs(100, policy)).toBe(policy.maxRetryDelayMs)
  })

  test('peer sleep is visible and retries automatically until the peer wakes', async () => {
    const db = openHrcDatabase(':memory:')
    let nowMs = Date.parse('2026-07-20T00:00:00.000Z')
    let reachable = false
    let sends = 0
    const observations: FederationOutboxDeliveryObservation[] = []
    seed(db)
    const engine = new FederationOutboxDeliveryEngine({
      db,
      now: () => new Date(nowMs),
      policy: { initialRetryDelayMs: 1_000, maxRetryDelayMs: 8_000, deadLetterAfterMs: 60_000 },
      onObservation: (observation) => observations.push(observation),
      send: async () => {
        sends += 1
        if (!reachable) throw new Error('connect ECONNREFUSED')
        return { outcome: 'accepted', messageId: MESSAGE_ID }
      },
    })

    try {
      await engine.drainDue()
      expect(db.federationOutbox.get('delivery-1')).toMatchObject({
        state: 'peer_unreachable',
        totalAttempts: 1,
        nextAttemptAt: '2026-07-20T00:00:01.000Z',
      })

      nowMs += 999
      await engine.drainDue()
      expect(sends).toBe(1)

      nowMs += 1
      await engine.drainDue()
      expect(db.federationOutbox.get('delivery-1')).toMatchObject({
        state: 'peer_unreachable',
        totalAttempts: 2,
        nextAttemptAt: '2026-07-20T00:00:03.000Z',
      })

      reachable = true
      nowMs += 2_000
      await engine.drainDue()
      expect(db.federationOutbox.get('delivery-1')).toMatchObject({
        state: 'delivered',
        totalAttempts: 3,
        deliveredAt: '2026-07-20T00:00:03.000Z',
      })
      expect(db.messages.getById(MESSAGE_ID)?.execution.state).toBe('not_applicable')
      expect(observations).toEqual([
        expect.objectContaining({
          transition: 'attempt_started',
          messageId: MESSAGE_ID,
          peerNodeId: 'lab',
          attemptNumber: 1,
        }),
        expect.objectContaining({
          transition: 'peer_unreachable',
          errorCode: 'peer_unreachable',
          attemptNumber: 1,
        }),
        expect.objectContaining({ transition: 'attempt_started', attemptNumber: 2 }),
        expect.objectContaining({
          transition: 'peer_unreachable',
          errorCode: 'peer_unreachable',
          attemptNumber: 2,
        }),
        expect.objectContaining({ transition: 'attempt_started', attemptNumber: 3 }),
        expect.objectContaining({
          transition: 'delivered',
          acceptOutcome: 'accepted',
          attemptNumber: 3,
        }),
      ])
    } finally {
      db.close()
    }
  })

  test('retry exhaustion dead-letters and explicit replay is safe', async () => {
    const db = openHrcDatabase(':memory:')
    let nowMs = Date.parse('2026-07-20T00:00:00.000Z')
    let reachable = false
    let sends = 0
    seed(db)
    const engine = new FederationOutboxDeliveryEngine({
      db,
      now: () => new Date(nowMs),
      policy: { initialRetryDelayMs: 1_000, maxRetryDelayMs: 2_000, deadLetterAfterMs: 3_000 },
      send: async () => {
        sends += 1
        if (!reachable) throw new Error('peer asleep')
        return { outcome: 'duplicate', messageId: MESSAGE_ID }
      },
    })

    try {
      await engine.drainDue()
      nowMs += 1_000
      await engine.drainDue()
      nowMs += 2_000
      await engine.drainDue()
      expect(db.federationOutbox.get('delivery-1')).toMatchObject({
        state: 'dead_letter',
        nextAttemptAt: undefined,
        lastErrorCode: 'peer_unreachable',
        lastError: {
          code: 'runtime_unavailable',
          reason: 'peer_unreachable',
          retryable: true,
          homeNodeId: 'lab',
        },
      })

      reachable = true
      engine.replay('delivery-1')
      expect(() => engine.replay('delivery-1')).toThrow('is not dead-lettered')
      const sendsBeforeReplay = sends
      await engine.drainDue()
      expect(db.federationOutbox.get('delivery-1')).toMatchObject({
        state: 'delivered',
        replayCount: 1,
        cycleAttempts: 1,
      })
      expect(sends).toBe(sendsBeforeReplay + 1)
    } finally {
      db.close()
    }
  })
})
