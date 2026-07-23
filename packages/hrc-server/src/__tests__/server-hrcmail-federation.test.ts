import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import type {
  FederationMessageEnvelope,
  HrcMailAckResponse,
  HrcMailCatResponse,
  HrcMailInboxResponse,
  HrcMailSendRequest,
  HrcMailSendResponse,
} from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { createFederationAcceptHandler } from '../federation/accept.js'
import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { PEER_PROTOCOL_VERSION_HEADER } from '../federation/peer-protocol.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const TOKEN = 't06810-hrcmail-federation-token'
const ORIGIN_SESSION = 'agent:mable:project:hrc-runtime:task:minisvc/lane:main'
const TARGET_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06810-federation'
const TARGET_SESSION = `${TARGET_SCOPE}/lane:main`
const REQUEST_MESSAGE_ID = 'msg-68100000-0000-4000-8000-000000000001'
const ENVELOPE_ID = 'mail-68100000-0000-4000-8000-000000000002'

function request(): HrcMailSendRequest {
  return {
    ingressId: 'wave-f-ingress',
    from: { kind: 'scope', sessionRef: ORIGIN_SESSION },
    targetSessionRef: TARGET_SESSION,
    payload: { kind: 'request', body: 'cross-node request' },
  }
}

function wireRequest(replySchema?: Record<string, unknown>): FederationMessageEnvelope {
  const mailRequest = {
    ...request(),
    ...(replySchema === undefined ? {} : { replySchema }),
  }
  return {
    protocolVersion: '1.0',
    messageId: REQUEST_MESSAGE_ID,
    kind: 'system',
    phase: 'request',
    from: { kind: 'session', sessionRef: ORIGIN_SESSION },
    to: { kind: 'session', sessionRef: TARGET_SESSION },
    body: mailRequest.payload.body,
    rootMessageId: REQUEST_MESSAGE_ID,
    expected: { homeNodeId: 'lab-test', placementEpoch: 4 },
    mail: {
      version: 1,
      type: 'request',
      envelopeId: ENVELOPE_ID,
      request: mailRequest,
    },
  }
}

function installTargetBinding(fixture: HrcServerTestFixture): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef: TARGET_SCOPE,
      homeNodeId: 'lab-test',
      placementEpoch: 4,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
      updatedAt: '2026-07-23T00:00:00.000Z',
    })
  } finally {
    db.close()
  }
}

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function tableCount(
  db: ReturnType<typeof openHrcDatabase>,
  table: 'sessions' | 'runtimes' | 'runs'
): number {
  return (
    db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ??
    0
  )
}

function reservePorts(host: string): [number, number] {
  const first = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const second = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const ports: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return ports
}

async function eventually<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  let last: T
  do {
    last = read()
    if (accept(last)) return last
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  throw new Error(`condition not reached; last value: ${JSON.stringify(last)}`)
}

describe('T-06810 hrcmail federation', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('mail accept atomically creates one envelope and never enters semantic delivery', async () => {
    const fixture = await createHrcTestFixture('hrc-t06810-mail-accept-')
    fixtures.push(fixture)
    installTargetBinding(fixture)
    const db = openHrcDatabase(fixture.dbPath)
    let semanticDeliveries = 0
    let mailWakes = 0
    try {
      const accept = createFederationAcceptHandler({
        db,
        localNodeId: 'lab-test',
        onAccepted: () => {
          semanticDeliveries += 1
        },
        onMailAccepted: () => {
          mailWakes += 1
        },
      })
      const first = await accept({
        authenticatedNodeId: 'svc-test',
        protocolVersion: '1.0',
        envelope: wireRequest(),
      })
      expect(first).toMatchObject({ outcome: 'accepted', messageId: REQUEST_MESSAGE_ID })
      await first.afterAck?.()
      expect(mailWakes).toBe(1)
      expect(semanticDeliveries).toBe(0)
      expect(db.messages.query({})).toHaveLength(1)
      expect(db.mailEnvelopes.list()).toEqual([
        expect.objectContaining({
          envelopeId: ENVELOPE_ID,
          ingressId: REQUEST_MESSAGE_ID,
          targetSessionRef: TARGET_SESSION,
          state: 'pending',
        }),
      ])
      expect(tableCount(db, 'sessions')).toBe(0)
      expect(tableCount(db, 'runtimes')).toBe(0)
      expect(tableCount(db, 'runs')).toBe(0)

      const duplicate = await accept({
        authenticatedNodeId: 'svc-test',
        protocolVersion: '1.0',
        envelope: wireRequest(),
      })
      expect(duplicate).toEqual({ outcome: 'duplicate', messageId: REQUEST_MESSAGE_ID })
      expect(db.messages.query({})).toHaveLength(1)
      expect(db.mailEnvelopes.list()).toHaveLength(1)

      const rejected = await accept({
        authenticatedNodeId: 'svc-test',
        protocolVersion: '1.0',
        envelope: {
          ...wireRequest({ $ref: 'https://invalid.example/schema.json' }),
          messageId: 'msg-68100000-0000-4000-8000-000000000003',
          rootMessageId: 'msg-68100000-0000-4000-8000-000000000003',
        },
      })
      expect(rejected).toMatchObject({ outcome: 'refused', code: 'invalid_mail' })
      expect(db.messages.getById('msg-68100000-0000-4000-8000-000000000003')).toBeUndefined()
      expect(db.mailEnvelopes.list()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  const host = tailnetIpv4()
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  liveTest(
    'two daemons dedupe the request and return one terminal disposition to origin',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const svc = await createHrcTestFixture('hrc-t06810-mail-svc-')
      const lab = await createHrcTestFixture('hrc-t06810-mail-lab-')
      fixtures.push(svc, lab)
      const [svcPort, labPort] = reservePorts(host)
      const svcBind = `http://${host}:${svcPort}`
      const labBind = `http://${host}:${labPort}`

      for (const [fixture, nodeId, peerNodeId, bind, endpoint, registryHost] of [
        [svc, 'svc-test', 'lab-test', svcBind, labBind, 'lab-test'],
        [lab, 'lab-test', 'svc-test', labBind, svcBind, 'svc-test'],
      ] as const) {
        await writeFile(
          `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
          JSON.stringify({
            nodeId,
            peers: { [peerNodeId]: { endpoint, token: TOKEN } },
            peerListener: { bind },
            gate: { mode: 'enforce', registryHost },
          }),
          { mode: 0o600 }
        )
      }
      installTargetBinding(svc)
      installTargetBinding(lab)

      const svcServer = await createHrcServer(
        svc.serverOpts({ otelListenerEnabled: false, federationOutboxPollIntervalMs: 10 })
      )
      const labServer = await createHrcServer(
        lab.serverOpts({ otelListenerEnabled: false, federationOutboxPollIntervalMs: 10 })
      )
      try {
        const sendResponse = await svc.postJson('/v1/mail/send', request())
        expect(sendResponse.status).toBe(200)
        const sent = (await sendResponse.json()) as HrcMailSendResponse
        expect(sent).toMatchObject({
          receipt: { ingressId: 'wave-f-ingress', path: 'mail' },
          envelope: { state: 'pending', targetSessionRef: TARGET_SESSION },
        })
        const retriedSend = await svc.postJson('/v1/mail/send', request())
        expect(retriedSend.status).toBe(200)
        expect(await retriedSend.json()).toEqual(sent)

        const destination = await eventually(
          () => {
            const db = openHrcDatabase(lab.dbPath)
            try {
              return db.mailEnvelopes.get(sent.envelope.envelopeId)
            } finally {
              db.close()
            }
          },
          (envelope) => envelope?.state === 'pending'
        )
        expect(destination?.ingressId).not.toBe(sent.envelope.ingressId)

        const svcDb = openHrcDatabase(svc.dbPath)
        let requestMessageId: string
        let redelivery: FederationMessageEnvelope
        try {
          const origin = svcDb.mailFederatedOrigins.getByIngressId('wave-f-ingress')
          expect(origin).toBeDefined()
          requestMessageId = origin!.requestMessageId
          const delivery = svcDb.federationOutbox.getByMessageId(requestMessageId)
          expect(delivery).toMatchObject({ state: 'delivered', stage: 'delivering' })
          if (delivery?.stage !== 'delivering') throw new Error('mail delivery is not fenced')
          redelivery = delivery.envelope
          expect(svcDb.mailEnvelopes.list()).toHaveLength(0)
          expect(
            svcDb.mailFederatedOrigins.getByEnvelopeId(sent.envelope.envelopeId)
          ).toMatchObject({
            envelope: { state: 'pending' },
          })
        } finally {
          svcDb.close()
        }

        const duplicate = await fetch(`${labBind}/v1/federation/accept`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            [PEER_PROTOCOL_VERSION_HEADER]: '1.0',
          },
          body: JSON.stringify({ envelope: redelivery }),
        })
        expect(await duplicate.json()).toMatchObject({
          ack: { outcome: 'duplicate', messageId: requestMessageId },
        })

        const preAckDb = openHrcDatabase(lab.dbPath)
        try {
          expect(preAckDb.mailEnvelopes.list()).toHaveLength(1)
          expect(preAckDb.messages.query({})).toHaveLength(1)
          expect(tableCount(preAckDb, 'sessions')).toBe(0)
          expect(tableCount(preAckDb, 'runtimes')).toBe(0)
          expect(tableCount(preAckDb, 'runs')).toBe(0)
        } finally {
          preAckDb.close()
        }

        const inboxResponse = await lab.postJson('/v1/mail/inbox', {
          actor: { kind: 'scope', sessionRef: TARGET_SESSION },
          targetSessionRef: TARGET_SESSION,
        })
        expect(inboxResponse.status).toBe(200)
        const inbox = (await inboxResponse.json()) as HrcMailInboxResponse
        expect(inbox.envelopes).toEqual([
          expect.objectContaining({ envelopeId: sent.envelope.envelopeId, state: 'presented' }),
        ])
        const ackResponse = await lab.postJson('/v1/mail/ack', {
          actor: { kind: 'scope', sessionRef: TARGET_SESSION },
          envelopeIds: [sent.envelope.envelopeId],
          response: { ok: true, node: 'lab-test' },
        })
        expect(ackResponse.status).toBe(200)
        expect((await ackResponse.json()) as HrcMailAckResponse).toMatchObject({
          results: [{ outcome: 'applied', envelope: { state: 'acked' } }],
        })
        const ackRetryResponse = await lab.postJson('/v1/mail/ack', {
          actor: { kind: 'scope', sessionRef: TARGET_SESSION },
          envelopeIds: [sent.envelope.envelopeId],
          response: { ok: true, node: 'lab-test' },
        })
        expect(ackRetryResponse.status).toBe(200)
        expect((await ackRetryResponse.json()) as HrcMailAckResponse).toMatchObject({
          results: [{ outcome: 'idempotent', envelope: { state: 'acked' } }],
        })

        const originTerminal = await eventually(
          () => {
            const db = openHrcDatabase(svc.dbPath)
            try {
              return db.mailFederatedOrigins.getByIngressId('wave-f-ingress')
            } finally {
              db.close()
            }
          },
          (origin) => origin?.envelope.state === 'acked'
        )
        expect(originTerminal?.envelope).toMatchObject({
          envelopeId: sent.envelope.envelopeId,
          ingressId: 'wave-f-ingress',
          state: 'acked',
          response: { ok: true, node: 'lab-test' },
        })

        const catResponse = await svc.postJson('/v1/mail/cat', {
          envelopeId: sent.envelope.envelopeId,
        })
        expect(catResponse.status).toBe(200)
        expect((await catResponse.json()) as HrcMailCatResponse).toMatchObject({
          envelope: {
            envelopeId: sent.envelope.envelopeId,
            state: 'acked',
            response: { ok: true, node: 'lab-test' },
          },
        })

        for (const fixture of [svc, lab]) {
          const db = openHrcDatabase(fixture.dbPath)
          try {
            expect(
              db.messages.query({
                replyToMessageId: requestMessageId,
                phases: ['response'],
              })
            ).toHaveLength(1)
          } finally {
            db.close()
          }
        }
      } finally {
        await labServer.stop()
        await svcServer.stop()
      }
    }
  )
})
