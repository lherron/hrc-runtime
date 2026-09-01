import { writeFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

import type {
  FederationOutboxDeliveryRecord,
  HrcCollectiveMessageRecord,
  HrcMessageHistoryStatus,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { createHrcServer } from '../index.js'
import { buildMessageTrace } from '../message-trace.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const MESSAGE_ID = 'msg-11111111-1111-4111-8111-111111111111'
const SESSION = 'agent:cody:project:hrc-runtime:task:T-06830/lane:main'

const history: HrcMessageHistoryStatus = {
  source: 'collective',
  complete: true,
  authorityNodeId: 'svc',
  queriedNodeId: 'svc',
  cursorKind: 'collective',
  pendingReplicationCount: 0,
}

function message(
  destination: HrcCollectiveMessageRecord['collectiveHistory']['observations'][number]
): HrcCollectiveMessageRecord {
  return {
    messageSeq: 17,
    messageId: MESSAGE_ID,
    createdAt: '2026-07-25T10:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: SESSION },
    rootMessageId: MESSAGE_ID,
    body: 'trace me',
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
    collectiveHistory: {
      authorityNodeId: 'svc',
      observations: [
        {
          nodeId: 'svc',
          messageSeq: 17,
          role: 'origin',
          observedAt: '2026-07-25T10:00:00.000Z',
          originNodeId: 'svc',
          execution: { state: 'not_applicable' },
        },
        destination,
      ],
    },
  }
}

function deliveredOutbox(): FederationOutboxDeliveryRecord {
  return {
    deliveryId: 'fd-t06830',
    messageId: MESSAGE_ID,
    peerNodeId: 'max3',
    stage: 'delivering',
    envelope: {
      messageId: MESSAGE_ID,
      kind: 'dm',
      phase: 'request',
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: SESSION },
      body: 'trace me',
      rootMessageId: MESSAGE_ID,
      expected: { homeNodeId: 'max3' },
    },
    state: 'delivered',
    totalAttempts: 1,
    cycleAttempts: 1,
    replayCount: 0,
    retryWindowStartedAt: '2026-07-25T10:00:00.000Z',
    lastAttemptAt: '2026-07-25T10:00:01.000Z',
    deliveredAt: '2026-07-25T10:00:01.000Z',
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:01.000Z',
  }
}

describe('T-06830 message delivery trace', () => {
  test('renders authoritative destination runtime evidence', () => {
    const trace = buildMessageTrace({
      localNodeId: 'svc',
      message: message({
        nodeId: 'max3',
        messageSeq: 44,
        role: 'destination',
        observedAt: '2026-07-25T10:00:02.000Z',
        originNodeId: 'svc',
        acceptedDestinationNodeId: 'max3',
        execution: {
          state: 'started',
          runtimeId: 'rt-t06830',
          runId: 'run-t06830',
          transport: 'tmux',
        },
        delivery: {
          outcome: 'runtime_delivery',
          observedAt: '2026-07-25T10:00:02.000Z',
        },
      }),
      outbox: deliveredOutbox(),
      acceptance: {
        acceptedByNodeId: 'max3',
        phase: 'request',
        requestEpoch: 4,
        acceptedAt: '2026-07-25T10:00:01.000Z',
        outcome: 'accepted',
      },
      history,
    })

    expect(trace.verdict).toEqual({
      code: 'delivered_to_runtime',
      summary: 'delivered to runtime rt-t06830 on max3',
    })
    expect(trace.destination).toMatchObject({
      nodeId: 'max3',
      messageSeq: 44,
      delivery: { outcome: 'runtime_delivery' },
    })
    expect(trace.acceptance?.outcome).toBe('accepted')
  })

  test('distinguishes durable store-only acceptance from runtime injection', () => {
    const trace = buildMessageTrace({
      localNodeId: 'svc',
      message: message({
        nodeId: 'max3',
        messageSeq: 45,
        role: 'destination',
        observedAt: '2026-07-25T10:00:02.000Z',
        originNodeId: 'svc',
        acceptedDestinationNodeId: 'max3',
        execution: { state: 'not_applicable' },
        delivery: {
          outcome: 'store_only',
          reason: 'response_without_delivery_context',
          observedAt: '2026-07-25T10:00:02.000Z',
        },
      }),
      outbox: deliveredOutbox(),
      history,
    })

    expect(trace.verdict).toEqual({
      code: 'stored_not_injected',
      summary: 'stored on max3, NOT injected (response_without_delivery_context)',
    })
  })

  test('persists exact ACK outcome and replicates delivery disposition', () => {
    const db = openHrcDatabase(':memory:')
    try {
      expect(
        db.federationPeerAcceptances.record({
          messageId: MESSAGE_ID,
          acceptedByNodeId: 'max3',
          phase: 'request',
          requestEpoch: 4,
          ackOutcome: 'duplicate',
          acceptedAt: '2026-07-25T10:00:01.000Z',
        }).record
      ).toMatchObject({ ackOutcome: 'duplicate' })

      const record = db.messages.insert({
        messageId: MESSAGE_ID,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION },
        body: 'trace me',
        metadataJson: {
          federationIngress: { authenticatedNodeId: 'svc' },
          federationDelivery: {
            outcome: 'store_only',
            reason: 'response_without_delivery_context',
            observedAt: '2026-07-25T10:00:02.000Z',
          },
        },
      })
      db.collectiveHistory.recordObservation({
        sourceNodeId: 'max3',
        sourceRole: 'destination',
        originNodeId: 'svc',
        acceptedDestinationNodeId: 'max3',
        record,
      })
      expect(
        db.collectiveHistory.query({ messageId: MESSAGE_ID }, 'svc')[0]?.collectiveHistory
          ?.observations[0]?.delivery
      ).toEqual({
        outcome: 'store_only',
        reason: 'response_without_delivery_context',
        observedAt: '2026-07-25T10:00:02.000Z',
      })
    } finally {
      db.close()
    }
  })

  test('serves a local message by sequence through the typed trace route', async () => {
    const fixture = await createHrcTestFixture('hrc-t06830-route-')
    let server: Awaited<ReturnType<typeof createHrcServer>> | undefined
    try {
      await writeFile(
        `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
        JSON.stringify({ nodeId: 'mini' }),
        { mode: 0o600 }
      )
      const db = openHrcDatabase(fixture.dbPath)
      let messageSeq: number
      try {
        messageSeq = db.messages.insert({
          messageId: MESSAGE_ID,
          kind: 'dm',
          phase: 'oneway',
          from: { kind: 'entity', entity: 'human' },
          to: { kind: 'entity', entity: 'system' },
          body: 'local trace',
        }).messageSeq
      } finally {
        db.close()
      }
      server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
      const response = await fixture.postJson('/v1/messages/trace', { messageSeq })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        localNodeId: 'mini',
        message: { messageId: MESSAGE_ID, messageSeq },
        verdict: { code: 'history_incomplete' },
      })
    } finally {
      await server?.stop()
      await fixture.cleanup()
    }
  })
})
