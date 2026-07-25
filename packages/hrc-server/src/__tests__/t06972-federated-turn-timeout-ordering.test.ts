import { afterEach, describe, expect, test } from 'bun:test'

import type {
  FederationMessageEnvelope,
  FederationOutboxDeliveryRecord,
  FederationOutboxState,
  FederationSemanticTurnIdentity,
  HrcMessageRecord,
  WaitMessageResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const ORIGIN_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06972'
const ORIGIN_SESSION = `${ORIGIN_SCOPE}/lane:main`
const REMOTE_SCOPE = 'agent:clod:project:hrc-runtime:task:T-06972-remote'
const REMOTE_SESSION = `${REMOTE_SCOPE}/lane:main`
const DELIVERY_ID = 'delivery-t06972'

type FakeOriginOutbox = {
  stop(): Promise<void>
  resolveTargetPlacement(): Promise<{
    outcome: 'remote-bound'
    binding: {
      scopeRef: string
      homeNodeId: string
      placementEpoch: number
    }
  }>
  route(
    body: unknown,
    record: HrcMessageRecord
  ): Promise<{ outcome: 'queued'; delivery: FederationOutboxDeliveryRecord }>
  list(): FederationOutboxDeliveryRecord[]
  cancel(deliveryId: string): FederationOutboxDeliveryRecord
}

type ServerSeams = {
  federationOriginOutbox: FakeOriginOutbox | undefined
  waitForMessage(): Promise<WaitMessageResponse>
  deliverFederationAcceptedMessage(
    envelope: FederationMessageEnvelope,
    record: HrcMessageRecord
  ): Promise<void>
  stop(): Promise<void>
}

function deliveryRecord(
  state: FederationOutboxState,
  messageId = 'msg-route-placeholder'
): FederationOutboxDeliveryRecord {
  const now = '2026-07-25T14:45:00.000Z'
  return {
    deliveryId: DELIVERY_ID,
    messageId,
    peerNodeId: 'lab-test',
    state,
    totalAttempts: state === 'pending' ? 0 : 1,
    cycleAttempts: state === 'pending' ? 0 : 1,
    replayCount: 0,
    retryWindowStartedAt: now,
    ...(state === 'delivered' ? { deliveredAt: now } : {}),
    ...(state === 'dead_letter'
      ? {
          deadLetteredAt: now,
          lastErrorCode: 'operator_cancelled',
          lastErrorMessage: 'delivery cancelled by operator',
          lastError: {
            code: 'operator_cancelled',
            message: 'delivery cancelled by operator',
            reason: 'operator_cancelled',
            retryable: false,
          },
        }
      : {}),
    createdAt: now,
    updatedAt: now,
    stage: 'delivering',
    envelope: {
      protocolVersion: '1.0',
      messageId,
      kind: 'dm',
      phase: 'request',
      from: { kind: 'session', sessionRef: ORIGIN_SESSION },
      to: { kind: 'session', sessionRef: REMOTE_SESSION },
      body: 'run remotely',
      expected: { homeNodeId: 'lab-test', placementEpoch: 1 },
    },
  }
}

async function installTimedOutRemoteRoute(
  fixture: HrcServerTestFixture,
  initialState: FederationOutboxState
): Promise<{
  server: ServerSeams
  cancelCalls: string[]
}> {
  const server = (await createHrcServer(
    fixture.serverOpts({ otelListenerEnabled: false })
  )) as unknown as ServerSeams
  const cancelCalls: string[] = []
  let delivery = deliveryRecord(initialState)
  const outbox: FakeOriginOutbox = {
    async stop() {},
    async resolveTargetPlacement() {
      return {
        outcome: 'remote-bound',
        binding: {
          scopeRef: REMOTE_SCOPE,
          homeNodeId: 'lab-test',
          placementEpoch: 1,
        },
      }
    },
    async route(_body, record) {
      delivery = deliveryRecord(delivery.state, record.messageId)
      return { outcome: 'queued', delivery }
    },
    list() {
      return [delivery]
    },
    cancel(deliveryId) {
      cancelCalls.push(deliveryId)
      delivery = deliveryRecord('dead_letter', delivery.messageId)
      return delivery
    },
  }
  Object.defineProperty(server, 'federationOriginOutbox', {
    configurable: true,
    value: outbox,
  })
  Object.defineProperty(server, 'waitForMessage', {
    configurable: true,
    value: async () => ({ matched: false, reason: 'timeout' }) satisfies WaitMessageResponse,
  })
  return { server, cancelCalls }
}

async function postRemoteTurn(fixture: HrcServerTestFixture): Promise<Response> {
  return fixture.postJson('/v1/messages/turn-handoff', {
    from: { kind: 'session', sessionRef: ORIGIN_SESSION },
    to: { kind: 'session', sessionRef: REMOTE_SESSION },
    body: 'run remotely',
    createIfMissing: false,
  })
}

describe('T-06972 federated semantic-turn timeout and signal ordering', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('a delivered timeout reports pending/unknown without failing the durable request', async () => {
    const fixture = await createHrcTestFixture('hrc-t06972-delivered-timeout-')
    fixtures.push(fixture)
    const { server, cancelCalls } = await installTimedOutRemoteRoute(fixture, 'delivered')
    try {
      const response = await postRemoteTurn(fixture)
      expect(response.status).toBe(202)
      const pending = (await response.json()) as Record<string, unknown>
      expect(pending).toMatchObject({
        status: 'pending',
        outcome: 'unknown',
        delivery: {
          deliveryId: DELIVERY_ID,
          state: 'delivered',
          cancellation: {
            attempted: false,
            outcome: 'not_cancellable',
            reason: 'delivered',
          },
        },
      })
      expect(cancelCalls).toEqual([])

      const db = openHrcDatabase(fixture.dbPath)
      try {
        const messageId = pending['messageId']
        expect(typeof messageId).toBe('string')
        expect(db.messages.getById(String(messageId))?.execution).toMatchObject({
          state: 'not_applicable',
        })
      } finally {
        db.close()
      }
    } finally {
      await server.stop()
    }
  })

  test('a pre-ACK timeout attempts cancellation and fails only after cancellation succeeds', async () => {
    const fixture = await createHrcTestFixture('hrc-t06972-pending-timeout-')
    fixtures.push(fixture)
    const { server, cancelCalls } = await installTimedOutRemoteRoute(fixture, 'pending')
    try {
      const response = await postRemoteTurn(fixture)
      expect(response.status).toBe(503)
      const failure = (await response.json()) as {
        error?: { detail?: Record<string, unknown> }
      }
      expect(failure.error?.detail).toMatchObject({
        reason: 'timeout',
        deliveryId: DELIVERY_ID,
        deliveryState: 'dead_letter',
        cancellation: {
          attempted: true,
          outcome: 'cancelled',
          reason: 'operator_cancelled',
        },
      })
      expect(cancelCalls).toEqual([DELIVERY_ID])

      const messageId = failure.error?.detail?.['messageId']
      expect(typeof messageId).toBe('string')
      const db = openHrcDatabase(fixture.dbPath)
      try {
        expect(db.messages.getById(String(messageId))?.execution).toMatchObject({
          state: 'failed',
          errorCode: 'operator_cancelled',
        })
      } finally {
        db.close()
      }
    } finally {
      await server.stop()
    }
  })

  test('a late started signal does not append after the run already completed', async () => {
    const fixture = await createHrcTestFixture('hrc-t06972-terminal-first-')
    fixtures.push(fixture)
    const requestId = 'msg-11111111-1111-4111-8111-111111111111'
    const signalId = 'msg-22222222-2222-4222-8222-222222222222'
    const identity: FederationSemanticTurnIdentity = {
      sessionRef: REMOTE_SESSION,
      scopeRef: REMOTE_SCOPE,
      laneRef: 'main',
      hostSessionId: 'hs-t06972-remote',
      runtimeId: 'rt-t06972-remote',
      runId: 'run-t06972-remote',
      generation: 1,
      mode: 'headless',
      transport: 'headless',
    }

    let signalRecord: HrcMessageRecord
    const seed = openHrcDatabase(fixture.dbPath)
    try {
      seed.messages.insert({
        messageId: requestId,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'session', sessionRef: ORIGIN_SESSION },
        to: { kind: 'session', sessionRef: REMOTE_SESSION },
        body: 'run remotely',
        execution: { state: 'completed', ...identity },
        metadataJson: { federationSemanticTurnOrigin: true },
      })
      seed.hrcEvents.append({
        ts: '2026-07-25T14:45:01.000Z',
        hostSessionId: identity.hostSessionId,
        scopeRef: identity.scopeRef,
        laneRef: identity.laneRef,
        generation: identity.generation,
        runtimeId: identity.runtimeId,
        runId: identity.runId,
        category: 'turn',
        eventKind: 'turn.completed',
        transport: identity.transport,
        replayed: false,
        payload: { success: true },
      })
      signalRecord = seed.messages.insert({
        messageId: signalId,
        kind: 'system',
        phase: 'response',
        from: { kind: 'session', sessionRef: REMOTE_SESSION },
        to: { kind: 'session', sessionRef: ORIGIN_SESSION },
        body: '',
        replyToMessageId: requestId,
        rootMessageId: requestId,
        execution: { state: 'not_applicable' },
      })
    } finally {
      seed.close()
    }

    const server = (await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false })
    )) as unknown as ServerSeams
    try {
      await server.deliverFederationAcceptedMessage(
        {
          protocolVersion: '1.0',
          messageId: signalId,
          kind: 'system',
          phase: 'response',
          from: { kind: 'session', sessionRef: REMOTE_SESSION },
          to: { kind: 'session', sessionRef: ORIGIN_SESSION },
          body: '',
          replyToMessageId: requestId,
          rootMessageId: requestId,
          expected: { homeNodeId: 'svc-test', placementEpoch: 1 },
          semanticTurnSignal: {
            version: 1,
            type: 'started',
            sourceHrcSeq: 42,
            identity,
          },
        },
        signalRecord
      )

      const verify = openHrcDatabase(fixture.dbPath)
      try {
        expect(verify.messages.getById(requestId)?.execution.state).toBe('completed')
        expect(verify.messages.getById(signalId)?.execution.state).toBe('started')
        expect(
          verify.hrcEvents.listByRun(identity.runId, { eventKind: 'turn.started' })
        ).toHaveLength(0)
        expect(
          verify.hrcEvents.listByRun(identity.runId, { eventKind: 'turn.completed' })
        ).toHaveLength(1)
      } finally {
        verify.close()
      }
    } finally {
      await server.stop()
    }
  })
})
