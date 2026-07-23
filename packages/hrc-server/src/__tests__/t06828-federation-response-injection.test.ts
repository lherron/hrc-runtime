import { afterEach, describe, expect, test } from 'bun:test'

import type { FederationMessageEnvelope, HrcMessageRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const REQUEST_ID = 'msg-11111111-1111-4111-8111-111111111111'
const RESPONSE_ID = 'msg-22222222-2222-4222-8222-222222222222'
const ORIGIN_SCOPE = 'agent:clod:project:taskboard:task:primary'
const ORIGIN_SESSION = `${ORIGIN_SCOPE}/lane:default`
const REMOTE_SESSION = 'agent:cody:project:wrkq:task:minisvc/lane:default'
const HOST_SESSION_ID = 'hs-t06828-origin'

type ServerWithDelivery = {
  deliverFederationAcceptedMessage(
    envelope: FederationMessageEnvelope,
    record: HrcMessageRecord
  ): Promise<void>
  stop(): Promise<void>
}

function responseEnvelope(withDelivery: boolean): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId: RESPONSE_ID,
    kind: 'dm',
    phase: 'response',
    from: { kind: 'session', sessionRef: REMOTE_SESSION },
    to: { kind: 'session', sessionRef: ORIGIN_SESSION },
    body: 'explicit reply across federation',
    replyToMessageId: REQUEST_ID,
    rootMessageId: REQUEST_ID,
    expected: { homeNodeId: 'svc-test', placementEpoch: 1 },
    ...(withDelivery ? { delivery: { createIfMissing: false } } : {}),
  }
}

/**
 * Seed the origin-node view of the conversation: the local requester session,
 * its outbound request record, and the accepted federated response as the
 * accept handler stores it just before local delivery runs.
 */
function seedAcceptedResponse(fixture: HrcServerTestFixture): HrcMessageRecord {
  fixture.seedSession(HOST_SESSION_ID, ORIGIN_SCOPE)
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.messages.insert({
      messageId: REQUEST_ID,
      kind: 'dm',
      phase: 'request',
      from: { kind: 'session', sessionRef: ORIGIN_SESSION },
      to: { kind: 'session', sessionRef: REMOTE_SESSION },
      body: 'ping across federation',
    })
    return db.messages.insert({
      messageId: RESPONSE_ID,
      kind: 'dm',
      phase: 'response',
      from: { kind: 'session', sessionRef: REMOTE_SESSION },
      to: { kind: 'session', sessionRef: ORIGIN_SESSION },
      body: 'explicit reply across federation',
      replyToMessageId: REQUEST_ID,
      rootMessageId: REQUEST_ID,
      execution: { state: 'not_applicable' },
      metadataJson: {
        federationIngress: {
          authenticatedNodeId: 'svc-test',
          protocolVersion: '1.0',
          expected: { homeNodeId: 'svc-test', placementEpoch: 1 },
        },
      },
    })
  } finally {
    db.close()
  }
}

describe('T-06828 federated response local delivery', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('a response with delivery context reaches the recipient session', async () => {
    const fixture = await createHrcTestFixture('hrc-t06828-inject-')
    fixtures.push(fixture)
    const record = seedAcceptedResponse(fixture)
    const server = (await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false })
    )) as unknown as ServerWithDelivery
    try {
      await server.deliverFederationAcceptedMessage(responseEnvelope(true), record)
      const db = openHrcDatabase(fixture.dbPath)
      try {
        // The durable correlation join proves the semantic delivery path ran
        // against the local recipient session (the same assertion shape the
        // request-phase T-06618 e2e uses).
        expect(db.messages.getById(RESPONSE_ID)).toMatchObject({
          execution: { hostSessionId: HOST_SESSION_ID },
        })
      } finally {
        db.close()
      }
    } finally {
      await server.stop()
    }
  })

  test('a response without delivery context stays store-only', async () => {
    const fixture = await createHrcTestFixture('hrc-t06828-store-only-')
    fixtures.push(fixture)
    const record = seedAcceptedResponse(fixture)
    const server = (await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false })
    )) as unknown as ServerWithDelivery
    try {
      await server.deliverFederationAcceptedMessage(responseEnvelope(false), record)
      const db = openHrcDatabase(fixture.dbPath)
      try {
        const persisted = db.messages.getById(RESPONSE_ID)
        expect(persisted?.execution.state).toBe('not_applicable')
        expect(persisted?.execution.hostSessionId).toBeUndefined()
      } finally {
        db.close()
      }
    } finally {
      await server.stop()
    }
  })
})
