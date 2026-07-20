import { describe, expect, test } from 'bun:test'

import type { FederationMessageEnvelope } from 'hrc-core'
import { openHrcDatabase } from '../index.js'

const MESSAGE_ID = 'msg-11111111-1111-4111-8111-111111111111'

function envelope(): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId: MESSAGE_ID,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime:task:minisvc' },
    to: { kind: 'session', sessionRef: 'agent:cody:project:hrc-runtime:task:T-06619' },
    body: 'queued while lab sleeps',
    rootMessageId: MESSAGE_ID,
    expected: { homeNodeId: 'lab', placementEpoch: 7 },
  }
}

describe('T-06619 durable federation outbox', () => {
  test('the outbound message and its network delivery are separate durable facts', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.messages.insert({
        messageId: MESSAGE_ID,
        kind: 'dm',
        phase: 'request',
        from: envelope().from,
        to: envelope().to,
        body: envelope().body,
      })
      const delivery = db.federationOutbox.enqueue({
        deliveryId: 'delivery-1',
        messageId: MESSAGE_ID,
        peerNodeId: 'lab',
        envelope: envelope(),
        now: '2026-07-20T00:00:00.000Z',
      })

      db.messages.updateExecution(MESSAGE_ID, {
        state: 'failed',
        errorCode: 'target_turn_failed',
        errorMessage: 'the accepted target turn failed',
      })
      db.federationOutbox.scheduleRetry({
        deliveryId: delivery.deliveryId,
        state: 'peer_unreachable',
        nextAttemptAt: '2026-07-20T00:00:01.000Z',
        attemptedAt: '2026-07-20T00:00:00.000Z',
        errorCode: 'peer_unreachable',
        errorMessage: 'connection refused',
      })

      expect(db.messages.getById(MESSAGE_ID)?.execution).toMatchObject({
        state: 'failed',
        errorCode: 'target_turn_failed',
      })
      expect(db.federationOutbox.get(delivery.deliveryId)).toMatchObject({
        messageId: MESSAGE_ID,
        peerNodeId: 'lab',
        state: 'peer_unreachable',
        totalAttempts: 1,
        cycleAttempts: 1,
        lastErrorCode: 'peer_unreachable',
      })
    } finally {
      db.close()
    }
  })

  test('dead-letter is terminal for automatic delivery but replay starts a fresh retry window', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.messages.insert({
        messageId: MESSAGE_ID,
        kind: 'dm',
        phase: 'request',
        from: envelope().from,
        to: envelope().to,
        body: envelope().body,
      })
      db.federationOutbox.enqueue({
        deliveryId: 'delivery-1',
        messageId: MESSAGE_ID,
        peerNodeId: 'lab',
        envelope: envelope(),
        now: '2026-07-20T00:00:00.000Z',
      })
      db.federationOutbox.markDeadLetter({
        deliveryId: 'delivery-1',
        attemptedAt: '2026-08-17T00:00:00.000Z',
        errorCode: 'retry_window_exhausted',
        errorMessage: 'peer remained unreachable for the retry window',
      })

      expect(db.federationOutbox.listDue('2027-01-01T00:00:00.000Z')).toEqual([])
      const replayed = db.federationOutbox.replay('delivery-1', '2026-09-01T12:00:00.000Z')
      expect(replayed).toMatchObject({
        state: 'pending',
        replayCount: 1,
        cycleAttempts: 0,
        retryWindowStartedAt: '2026-09-01T12:00:00.000Z',
        nextAttemptAt: '2026-09-01T12:00:00.000Z',
      })
      expect(db.federationOutbox.listDue('2026-09-01T12:00:00.000Z')).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
