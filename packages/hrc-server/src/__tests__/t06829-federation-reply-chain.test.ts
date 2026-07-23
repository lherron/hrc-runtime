import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import type { FederationMessageEnvelope, HrcMessageRecord } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { sendFederationEnvelope } from '../federation/accept-client.js'
import { createFederationAcceptHandler } from '../federation/accept.js'
import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const ROOT_ID = 'msg-11111111-1111-4111-8111-111111111111'
const RESPONSE_1_ID = 'msg-22222222-2222-4222-8222-222222222222'
const RESPONSE_2_ID = 'msg-33333333-3333-4333-8333-333333333333'
const RESPONSE_3_ID = 'msg-44444444-4444-4444-8444-444444444444'
const A_SCOPE = 'agent:mable:project:hrc-runtime:task:minisvc'
const A_SESSION = `${A_SCOPE}/lane:default`
const B_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06829'
const B_SESSION = `${B_SCOPE}/lane:default`

type Accept = ReturnType<typeof createFederationAcceptHandler>

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePorts(host: string): [number, number] {
  const a = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const b = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const ports: [number, number] = [a.port, b.port]
  a.stop(true)
  b.stop(true)
  return ports
}

async function eventually<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4_000
  let last: T
  do {
    last = read()
    if (accept(last)) return last
    await Bun.sleep(10)
  } while (Date.now() < deadline)
  throw new Error(`condition not reached; last value: ${JSON.stringify(last)}`)
}

function requestEnvelope(): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId: ROOT_ID,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'session', sessionRef: A_SESSION },
    to: { kind: 'session', sessionRef: B_SESSION },
    body: 'request',
    rootMessageId: ROOT_ID,
    expected: { homeNodeId: 'node-b', placementEpoch: 7 },
    delivery: { createIfMissing: false },
  }
}

function responseEnvelope(
  messageId: string,
  parent: HrcMessageRecord,
  from: string,
  to: string
): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId,
    kind: 'dm',
    phase: 'response',
    from: { kind: 'session', sessionRef: from },
    to: { kind: 'session', sessionRef: to },
    body: `response ${messageId}`,
    replyToMessageId: parent.messageId,
    rootMessageId: parent.rootMessageId,
    // Response authorization deliberately ignores this stale routing hint.
    expected: { homeNodeId: 'obsolete-node', placementEpoch: 1 },
    delivery: { createIfMissing: false },
  }
}

async function transmit(
  originDb: ReturnType<typeof openHrcDatabase>,
  originNodeId: string,
  destinationNodeId: string,
  envelope: FederationMessageEnvelope,
  accept: Accept
) {
  return sendFederationEnvelope({
    db: originDb,
    peer: {
      nodeId: parseNodeId(destinationNodeId, 'test destination'),
      endpoint: 'http://127.0.0.1:1/',
      token: new PeerToken('t06829-token'),
    },
    envelope,
    fetch: async () => {
      const result = await accept({
        authenticatedNodeId: originNodeId,
        protocolVersion: '1.0',
        envelope,
      })
      if (result.outcome === 'refused') {
        return new Response(
          JSON.stringify({
            error: {
              code: result.code,
              retryable: result.retryable,
              ...(result.redirect === undefined ? {} : { redirect: result.redirect }),
            },
          }),
          { status: result.status, headers: { 'content-type': 'application/json' } }
        )
      }
      const response = new Response(
        JSON.stringify({
          ack: { outcome: result.outcome, messageId: result.messageId },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
      await result.afterAck?.()
      return response
    },
  })
}

function insertLocalResponse(
  db: ReturnType<typeof openHrcDatabase>,
  envelope: FederationMessageEnvelope
): HrcMessageRecord {
  return db.messages.insert({
    messageId: envelope.messageId,
    kind: envelope.kind,
    phase: envelope.phase,
    from: envelope.from,
    to: envelope.to,
    body: envelope.body,
    replyToMessageId: envelope.replyToMessageId,
    rootMessageId: envelope.rootMessageId,
  })
}

describe('T-06829 phase-neutral per-hop response fencing', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = tailnetIpv4()
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  test('alternating request plus three replies inject at every hop across an epoch bump', async () => {
    const a = openHrcDatabase(':memory:')
    const b = openHrcDatabase(':memory:')
    const injectedAtA: string[] = []
    const injectedAtB: string[] = []
    let placementConsults = 0
    const registry = {
      consult: async () => {
        placementConsults += 1
        throw new Error('response admission must not consult placement')
      },
    }
    const acceptA = createFederationAcceptHandler({
      db: a,
      localNodeId: 'node-a',
      registry,
      onAccepted: ({ record }) => injectedAtA.push(record.messageId),
    })
    const acceptB = createFederationAcceptHandler({
      db: b,
      localNodeId: 'node-b',
      registry,
      onAccepted: ({ record }) => injectedAtB.push(record.messageId),
    })

    try {
      const request = requestEnvelope()
      a.messages.insert({
        messageId: request.messageId,
        kind: request.kind,
        phase: request.phase,
        from: request.from,
        to: request.to,
        body: request.body,
      })
      createPlacementLedgerRepository(b.sqlite).installActive({
        scopeRef: B_SCOPE,
        homeNodeId: 'node-b',
        placementEpoch: 7,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: '2026-07-23T20:00:00.000Z',
      })
      await expect(transmit(a, 'node-a', 'node-b', request, acceptB)).resolves.toMatchObject({
        outcome: 'accepted',
      })

      // The request origin has moved by the time the first response arrives.
      // Response admission must not read this newer placement tuple.
      createPlacementLedgerRepository(a.sqlite).installActive({
        scopeRef: A_SCOPE,
        homeNodeId: 'node-a-next',
        placementEpoch: 99,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'rebind',
        priorHomeNodeId: 'node-a',
        updatedAt: '2026-07-23T20:01:00.000Z',
      })

      const requestAtB = b.messages.getById(ROOT_ID)
      expect(requestAtB).toBeDefined()
      const response1 = responseEnvelope(RESPONSE_1_ID, requestAtB!, B_SESSION, A_SESSION)
      insertLocalResponse(b, response1)
      await expect(transmit(b, 'node-b', 'node-a', response1, acceptA)).resolves.toMatchObject({
        outcome: 'accepted',
      })

      const response1AtA = a.messages.getById(RESPONSE_1_ID)
      expect(response1AtA).toBeDefined()
      const response2 = responseEnvelope(RESPONSE_2_ID, response1AtA!, A_SESSION, B_SESSION)
      insertLocalResponse(a, response2)
      await expect(transmit(a, 'node-a', 'node-b', response2, acceptB)).resolves.toMatchObject({
        outcome: 'accepted',
      })

      const response2AtB = b.messages.getById(RESPONSE_2_ID)
      expect(response2AtB).toBeDefined()
      const response3 = responseEnvelope(RESPONSE_3_ID, response2AtB!, B_SESSION, A_SESSION)
      insertLocalResponse(b, response3)
      await expect(transmit(b, 'node-b', 'node-a', response3, acceptA)).resolves.toMatchObject({
        outcome: 'accepted',
      })

      expect(injectedAtA).toEqual([RESPONSE_1_ID, RESPONSE_3_ID])
      expect(injectedAtB).toEqual([ROOT_ID, RESPONSE_2_ID])
      expect(placementConsults).toBe(0)
      expect(a.federationOutbox.list()).toEqual([])
      expect(b.federationOutbox.list()).toEqual([])
      expect(a.federationPeerAcceptances.get(ROOT_ID)).toMatchObject({
        acceptedByNodeId: 'node-b',
        phase: 'request',
        requestEpoch: 7,
      })
      expect(b.federationPeerAcceptances.get(RESPONSE_1_ID)).toMatchObject({
        acceptedByNodeId: 'node-a',
        phase: 'response',
      })
      expect(a.federationPeerAcceptances.get(RESPONSE_2_ID)).toMatchObject({
        acceptedByNodeId: 'node-b',
        phase: 'response',
      })
      expect(b.federationPeerAcceptances.get(RESPONSE_3_ID)).toMatchObject({
        acceptedByNodeId: 'node-a',
        phase: 'response',
      })

      const response3AtA = a.messages.getById(RESPONSE_3_ID)
      expect(response3AtA).toBeDefined()
      const refusedId = 'msg-55555555-5555-4555-8555-555555555555'
      const next = responseEnvelope(refusedId, response3AtA!, A_SESSION, B_SESSION)
      await expect(
        acceptB({
          authenticatedNodeId: 'node-impostor',
          protocolVersion: '1.0',
          envelope: next,
        })
      ).resolves.toEqual({
        outcome: 'refused',
        code: 'response_node_mismatch',
        retryable: false,
        status: 409,
      })
      await expect(
        acceptB({
          authenticatedNodeId: 'node-a',
          protocolVersion: '1.0',
          envelope: { ...next, rootMessageId: refusedId },
        })
      ).resolves.toEqual({
        outcome: 'refused',
        code: 'response_root_mismatch',
        retryable: false,
        status: 409,
      })
      expect(b.messages.getById(refusedId)).toBeUndefined()
    } finally {
      a.close()
      b.close()
    }
  })

  test('peer-acceptance recording is idempotent and conflicting bindings fail closed', async () => {
    const db = openHrcDatabase(':memory:')
    try {
      const input = {
        messageId: RESPONSE_1_ID,
        acceptedByNodeId: 'node-a',
        phase: 'response' as const,
      }
      expect(db.federationPeerAcceptances.record(input)).toMatchObject({ outcome: 'recorded' })
      expect(db.federationPeerAcceptances.record(input)).toMatchObject({ outcome: 'duplicate' })
      expect(() =>
        db.federationPeerAcceptances.record({ ...input, acceptedByNodeId: 'node-c' })
      ).toThrow(/conflicting peer-acceptance ACK/)

      const envelope = responseEnvelope(
        RESPONSE_1_ID,
        {
          messageId: ROOT_ID,
          rootMessageId: ROOT_ID,
        } as HrcMessageRecord,
        B_SESSION,
        A_SESSION
      )
      const result = await sendFederationEnvelope({
        db,
        peer: {
          nodeId: parseNodeId('node-c', 'conflicting peer'),
          endpoint: 'http://127.0.0.1:1/',
          token: new PeerToken('t06829-token'),
        },
        envelope,
        fetch: async () =>
          new Response(
            JSON.stringify({
              ack: { outcome: 'duplicate', messageId: RESPONSE_1_ID },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
      })
      expect(result).toMatchObject({
        outcome: 'refused',
        code: 'peer_acceptance_conflict',
        retryable: false,
      })
    } finally {
      db.close()
    }
  })

  liveTest(
    'two daemons settle an alternating depth-3 reply chain without active residue',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const a = await createHrcTestFixture('hrc-t06829-a-')
      const b = await createHrcTestFixture('hrc-t06829-b-')
      fixtures.push(a, b)
      const [aPort, bPort] = reservePorts(host)
      const aBind = `http://${host}:${aPort}`
      const bBind = `http://${host}:${bPort}`

      for (const [fixture, nodeId, peerNodeId, bind, endpoint, registryHost] of [
        [a, 'node-a', 'node-b', aBind, bBind, 'node-b'],
        [b, 'node-b', 'node-a', bBind, aBind, 'node-a'],
      ] as const) {
        await writeFile(
          `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
          JSON.stringify({
            nodeId,
            peers: { [peerNodeId]: { endpoint, token: 't06829-two-daemon-token' } },
            peerListener: { bind },
            gate: { mode: 'enforce', registryHost },
          }),
          { mode: 0o600 }
        )
      }

      a.seedSession('hs-t06829-a', A_SCOPE)
      b.seedSession('hs-t06829-b', B_SCOPE)
      for (const fixture of [a, b]) {
        const db = openHrcDatabase(fixture.dbPath)
        try {
          createPlacementLedgerRepository(db.sqlite).installActive({
            scopeRef: B_SCOPE,
            homeNodeId: 'node-b',
            placementEpoch: 7,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'pin',
            updatedAt: '2026-07-23T20:00:00.000Z',
          })
        } finally {
          db.close()
        }
      }

      const aServer = await createHrcServer(
        a.serverOpts({ otelListenerEnabled: false, federationOutboxPollIntervalMs: 10 })
      )
      const bServer = await createHrcServer(
        b.serverOpts({ otelListenerEnabled: false, federationOutboxPollIntervalMs: 10 })
      )
      try {
        const send = async (
          fixture: HrcServerTestFixture,
          from: string,
          to: string,
          body: string,
          replyToMessageId?: string
        ): Promise<HrcMessageRecord> => {
          const response = await fixture.postJson('/v1/messages/dm', {
            from: { kind: 'session', sessionRef: from },
            to: { kind: 'session', sessionRef: to },
            body,
            createIfMissing: false,
            ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
          })
          expect(response.status).toBe(200)
          return ((await response.json()) as { request: HrcMessageRecord }).request
        }
        const awaitInjected = (
          fixture: HrcServerTestFixture,
          messageId: string,
          hostSessionId: string
        ) =>
          eventually(
            () => {
              const db = openHrcDatabase(fixture.dbPath)
              try {
                return db.messages.getById(messageId)
              } finally {
                db.close()
              }
            },
            (record) => record?.execution.hostSessionId === hostSessionId
          )

        const request = await send(a, A_SESSION, B_SESSION, 'live request')
        await awaitInjected(b, request.messageId, 'hs-t06829-b')

        // Add a newer origin-scope tuple after the request has crossed. None of
        // the three response admissions may consult it.
        const bumpDb = openHrcDatabase(a.dbPath)
        try {
          createPlacementLedgerRepository(bumpDb.sqlite).installActive({
            scopeRef: A_SCOPE,
            homeNodeId: 'node-a-next',
            placementEpoch: 99,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'rebind',
            priorHomeNodeId: 'node-a',
            updatedAt: '2026-07-23T20:01:00.000Z',
          })
        } finally {
          bumpDb.close()
        }

        const response1 = await send(b, B_SESSION, A_SESSION, 'live response 1', request.messageId)
        await awaitInjected(a, response1.messageId, 'hs-t06829-a')
        const response2 = await send(
          a,
          A_SESSION,
          B_SESSION,
          'live response 2',
          response1.messageId
        )
        await awaitInjected(b, response2.messageId, 'hs-t06829-b')
        const response3 = await send(
          b,
          B_SESSION,
          A_SESSION,
          'live response 3',
          response2.messageId
        )
        await awaitInjected(a, response3.messageId, 'hs-t06829-a')

        const chain = new Set([
          request.messageId,
          response1.messageId,
          response2.messageId,
          response3.messageId,
        ])
        for (const fixture of [a, b]) {
          const db = openHrcDatabase(fixture.dbPath)
          try {
            const rows = db.federationOutbox
              .list()
              .filter((delivery) => chain.has(delivery.messageId))
            expect(rows.every((delivery) => delivery.state === 'delivered')).toBe(true)
            expect(
              rows.filter(
                (delivery) =>
                  delivery.state === 'pending' ||
                  delivery.state === 'retry_scheduled' ||
                  delivery.state === 'peer_unreachable' ||
                  delivery.state === 'dead_letter'
              )
            ).toEqual([])
          } finally {
            db.close()
          }
        }
      } finally {
        await bServer.stop()
        await aServer.stop()
      }
    }
  )
})
