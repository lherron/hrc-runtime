import { describe, expect, test } from 'bun:test'

import type { FederationMessageEnvelope } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { createFederationAcceptHandler } from '../federation/accept.js'

const REQUEST_ID = 'msg-11111111-1111-4111-8111-111111111111'
const RESPONSE_ID = 'msg-22222222-2222-4222-8222-222222222222'
const ORIGIN_SCOPE = 'agent:mable:project:hrc-runtime:task:minisvc'
const ORIGIN_SESSION = `${ORIGIN_SCOPE}/lane:default`
const REMOTE_SESSION = 'agent:cody:project:hrc-runtime:task:T-06620/lane:default'

function seedAcceptedRequest(db: ReturnType<typeof openHrcDatabase>): void {
  db.messages.insert({
    messageId: REQUEST_ID,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'session', sessionRef: ORIGIN_SESSION },
    to: { kind: 'session', sessionRef: REMOTE_SESSION },
    body: 'request before the rebind',
  })
  db.federationAcceptedRequests.record({
    requestMessageId: REQUEST_ID,
    acceptedByNodeId: 'lab',
    acceptedEpoch: 4,
  })
}

function installCurrentPlacement(db: ReturnType<typeof openHrcDatabase>): void {
  createPlacementLedgerRepository(db.sqlite).installActive({
    scopeRef: ORIGIN_SCOPE,
    homeNodeId: 'svc-next',
    placementEpoch: 5,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'pin' },
    establishmentProvenance: 'rebind',
    priorHomeNodeId: 'svc',
    updatedAt: '2026-07-20T01:00:00.000Z',
  })
}

function responseEnvelope(messageId = RESPONSE_ID): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId,
    kind: 'dm',
    phase: 'response',
    from: { kind: 'session', sessionRef: REMOTE_SESSION },
    to: { kind: 'session', sessionRef: ORIGIN_SESSION },
    body: 'late but valid response',
    replyToMessageId: REQUEST_ID,
    rootMessageId: REQUEST_ID,
    // This is the request acceptance tuple, deliberately older than the
    // origin scope's current placement. Responses are fenced by the durable
    // accepted-request record, not by this node's current placement ledger.
    expected: { homeNodeId: 'lab', placementEpoch: 4 },
  }
}

describe('T-06620 accepted-request response fence', () => {
  test('accepts a late response after the origin scope placement epoch advances', async () => {
    const db = openHrcDatabase(':memory:')
    seedAcceptedRequest(db)
    installCurrentPlacement(db)
    const accept = createFederationAcceptHandler({ db, localNodeId: 'svc' })

    try {
      await expect(
        accept({
          authenticatedNodeId: 'lab',
          protocolVersion: '1.0',
          envelope: responseEnvelope(),
        })
      ).resolves.toMatchObject({ outcome: 'accepted', messageId: RESPONSE_ID })
      expect(db.messages.getById(RESPONSE_ID)).toMatchObject({
        phase: 'response',
        replyToMessageId: REQUEST_ID,
      })
    } finally {
      db.close()
    }
  })

  test('rejects a response from a node other than the one that accepted the request', async () => {
    const db = openHrcDatabase(':memory:')
    seedAcceptedRequest(db)
    installCurrentPlacement(db)
    const accept = createFederationAcceptHandler({ db, localNodeId: 'svc' })

    try {
      await expect(
        accept({
          authenticatedNodeId: 'lab-impostor',
          protocolVersion: '1.0',
          envelope: responseEnvelope(),
        })
      ).resolves.toEqual({
        outcome: 'refused',
        code: 'response_node_mismatch',
        retryable: false,
        status: 409,
      })
      expect(db.messages.getById(RESPONSE_ID)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('requires the replied-to request and its acceptance record to exist locally', async () => {
    const db = openHrcDatabase(':memory:')
    installCurrentPlacement(db)
    const accept = createFederationAcceptHandler({ db, localNodeId: 'svc' })

    try {
      await expect(
        accept({
          authenticatedNodeId: 'lab',
          protocolVersion: '1.0',
          envelope: responseEnvelope(),
        })
      ).resolves.toEqual({
        outcome: 'refused',
        code: 'response_request_unknown',
        retryable: true,
        status: 409,
      })
      expect(db.messages.getById(RESPONSE_ID)).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
