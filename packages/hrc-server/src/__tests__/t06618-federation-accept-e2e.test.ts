import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import type { FederationMessageEnvelope } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { PEER_PROTOCOL_VERSION_HEADER } from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer, sendFederationEnvelope } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const TOKEN = 't06618-two-daemon-token'
const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06618'
const SESSION = `${SCOPE}/lane:default`
const MESSAGE_ID = 'msg-33333333-3333-4333-8333-333333333333'

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

async function reservePorts(host: string): Promise<[number, number]> {
  const first = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const second = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const result: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return result
}

function envelope(messageId = MESSAGE_ID, epoch = 4): FederationMessageEnvelope {
  return {
    protocolVersion: '1.0',
    messageId,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime:task:minisvc' },
    to: { kind: 'session', sessionRef: SESSION },
    body: 'two daemon delivery',
    rootMessageId: messageId,
    expected: { homeNodeId: 'lab-test', placementEpoch: epoch },
    ignoredByOlderReader: true,
  }
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  do {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(20)
    }
  } while (Date.now() < deadline)
  throw lastError
}

describe('T-06618 two isolated daemon delivery', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = tailnetIpv4()
  const liveTest = host === undefined ? test.skip : test

  liveTest(
    'accepts, ACKs after durability, runs local correlation, dedupes, and redirects stale epochs',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const svc = await createHrcTestFixture('hrc-t06618-svc-')
      const lab = await createHrcTestFixture('hrc-t06618-lab-')
      fixtures.push(svc, lab)
      const [svcPort, labPort] = await reservePorts(host)
      const svcBind = `http://${host}:${svcPort}`
      const labBind = `http://${host}:${labPort}`

      for (const [fixture, nodeId, peerNodeId, bind, endpoint] of [
        [svc, 'svc-test', 'lab-test', svcBind, labBind],
        [lab, 'lab-test', 'svc-test', labBind, svcBind],
      ] as const) {
        await writeFile(
          `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
          JSON.stringify({
            nodeId,
            peers: { [peerNodeId]: { endpoint, token: TOKEN } },
            peerListener: { bind },
          }),
          { mode: 0o600 }
        )
      }

      lab.seedSession('hs-t06618-lab', SCOPE)
      const seedDb = openHrcDatabase(lab.dbPath)
      try {
        createPlacementLedgerRepository(seedDb.sqlite).installActive({
          scopeRef: SCOPE,
          homeNodeId: 'lab-test',
          placementEpoch: 4,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'pin' },
          establishmentProvenance: 'pin',
          updatedAt: '2026-07-20T00:00:00.000Z',
        })
      } finally {
        seedDb.close()
      }

      const svcServer = await createHrcServer(svc.serverOpts({ otelListenerEnabled: false }))
      const labServer = await createHrcServer(lab.serverOpts({ otelListenerEnabled: false }))
      try {
        const send = (body: unknown) =>
          fetch(`${labBind}/v1/federation/accept`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${TOKEN}`,
              'content-type': 'application/json',
              [PEER_PROTOCOL_VERSION_HEADER]: '1.0',
            },
            body: JSON.stringify({ envelope: body, futureRequestField: 'ignored' }),
          })

        const originDb = openHrcDatabase(svc.dbPath)
        try {
          const accepted = await sendFederationEnvelope({
            db: originDb,
            peer: {
              nodeId: parseNodeId('lab-test', 'test peer'),
              endpoint: `${labBind}/`,
              token: new PeerToken(TOKEN),
            },
            envelope: envelope(),
          })
          expect(accepted).toEqual({ outcome: 'accepted', messageId: MESSAGE_ID })
          expect(originDb.federationAcceptedRequests.get(MESSAGE_ID)).toMatchObject({
            requestMessageId: MESSAGE_ID,
            acceptedByNodeId: 'lab-test',
            acceptedEpoch: 4,
          })
        } finally {
          originDb.close()
        }

        await eventually(() => {
          const db = openHrcDatabase(lab.dbPath)
          try {
            expect(db.messages.getById(MESSAGE_ID)).toMatchObject({
              messageSeq: 1,
              execution: { hostSessionId: 'hs-t06618-lab' },
            })
          } finally {
            db.close()
          }
        })
        const duplicate = await send(envelope())
        expect(await duplicate.json()).toMatchObject({
          ack: { outcome: 'duplicate', messageId: MESSAGE_ID },
        })
        const labDb = openHrcDatabase(lab.dbPath)
        try {
          expect(labDb.messages.query({})).toHaveLength(1)
        } finally {
          labDb.close()
        }

        const stale = await send(envelope('msg-44444444-4444-4444-8444-444444444444', 3))
        expect(stale.status).toBe(409)
        expect(await stale.json()).toMatchObject({
          error: {
            code: 'stale_placement',
            redirect: { homeNodeId: 'lab-test', placementEpoch: 4 },
          },
        })
      } finally {
        await labServer.stop()
        await svcServer.stop()
      }
    }
  )
})
