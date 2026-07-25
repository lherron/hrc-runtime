import { afterEach, describe, expect } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import type { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  createFederationTestServer,
  federationTestHost,
  selectLiveTailnetTest,
} from './fixtures/live-tailnet-test.js'

const SVC_LAB_TOKEN = 't06802-svc-lab'
const SVC_MAX3_TOKEN = 't06802-svc-max3'
const LAB_MAX3_TOKEN = 't06802-lab-max3'
const MAX3_SCOPE = 'agent:max3-history:project:hrc-runtime:task:T-06802'
const LAB_SCOPE = 'agent:lab-history:project:hrc-runtime:task:T-06802'
const MAX3_SESSION = `${MAX3_SCOPE}/lane:main`
const LAB_SESSION = `${LAB_SCOPE}/lane:main`

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePorts(host: string): [number, number, number] {
  const probes = [0, 1, 2].map(() =>
    Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  )
  const ports = probes.map((probe) => probe.port) as [number, number, number]
  for (const probe of probes) probe.stop(true)
  return ports
}

async function eventually<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await read()
    if (accept(last)) return last
    await Bun.sleep(25)
  } while (Date.now() < deadline)
  throw new Error(`condition not reached; last value: ${JSON.stringify(last)}`)
}

function installPlacement(
  fixture: HrcServerTestFixture,
  scopeRef: string,
  homeNodeId: string
): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef,
      homeNodeId,
      placementEpoch: 1,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
      updatedAt: '2026-07-24T00:00:00.000Z',
    })
  } finally {
    db.close()
  }
}

describe('T-06802 three-daemon collective history', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = federationTestHost(tailnetIpv4())
  const federationTest = selectLiveTailnetTest(import.meta.path, host)

  federationTest(
    'converges request/reply history across ingress nodes and recovers an svc outage',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const svc = await createHrcTestFixture('hrc-t06802-svc-')
      const lab = await createHrcTestFixture('hrc-t06802-lab-')
      const max3 = await createHrcTestFixture('hrc-t06802-max3-')
      fixtures.push(svc, lab, max3)
      const [svcPort, labPort, max3Port] = reservePorts(host)
      const endpoints = {
        svc: `http://${host}:${svcPort}`,
        lab: `http://${host}:${labPort}`,
        max3: `http://${host}:${max3Port}`,
      }

      const documents = {
        svc: {
          nodeId: 'svc',
          peers: {
            lab: { endpoint: endpoints.lab, token: SVC_LAB_TOKEN },
            max3: { endpoint: endpoints.max3, token: SVC_MAX3_TOKEN },
          },
          peerListener: { bind: endpoints.svc },
          gate: { mode: 'off' },
        },
        lab: {
          nodeId: 'lab',
          peers: {
            svc: { endpoint: endpoints.svc, token: SVC_LAB_TOKEN },
            max3: { endpoint: endpoints.max3, token: LAB_MAX3_TOKEN },
          },
          peerListener: { bind: endpoints.lab },
          gate: { mode: 'enforce', registryHost: 'svc' },
        },
        max3: {
          nodeId: 'max3',
          peers: {
            svc: { endpoint: endpoints.svc, token: SVC_MAX3_TOKEN },
            lab: { endpoint: endpoints.lab, token: LAB_MAX3_TOKEN },
          },
          peerListener: { bind: endpoints.max3 },
          gate: { mode: 'enforce', registryHost: 'svc' },
        },
      }
      for (const [fixture, nodeId] of [
        [svc, 'svc'],
        [lab, 'lab'],
        [max3, 'max3'],
      ] as const) {
        await writeFile(
          `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
          JSON.stringify(documents[nodeId]),
          { mode: 0o600 }
        )
      }

      max3.seedSession('hs-t06802-max3', MAX3_SCOPE)
      lab.seedSession('hs-t06802-lab', LAB_SCOPE)
      for (const fixture of [lab, max3]) {
        installPlacement(fixture, MAX3_SCOPE, 'max3')
        installPlacement(fixture, LAB_SCOPE, 'lab')
      }
      const oldDb = openHrcDatabase(lab.dbPath)
      try {
        oldDb.messages.insert({
          messageId: 'msg-t06802-pre-feature',
          kind: 'dm',
          phase: 'oneway',
          from: { kind: 'entity', entity: 'human' },
          to: { kind: 'entity', entity: 'system' },
          body: 'startup backfill',
        })
      } finally {
        oldDb.close()
      }

      let svcServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
      let labServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
      let max3Server: Awaited<ReturnType<typeof createHrcServer>> | undefined
      try {
        svcServer = await createFederationTestServer(svc, {
          otelListenerEnabled: false,
          collectiveHistoryPollIntervalMs: 10,
        })
        labServer = await createFederationTestServer(lab, {
          otelListenerEnabled: false,
          federationOutboxPollIntervalMs: 10,
          collectiveHistoryPollIntervalMs: 10,
        })
        max3Server = await createFederationTestServer(max3, {
          otelListenerEnabled: false,
          federationOutboxPollIntervalMs: 10,
          collectiveHistoryPollIntervalMs: 10,
        })

        const sendRequest = async (
          origin: HrcServerTestFixture,
          targetSessionRef: string,
          body: string
        ): Promise<string> => {
          const response = await origin.postJson('/v1/messages/dm', {
            from: { kind: 'entity', entity: 'human' },
            to: { kind: 'session', sessionRef: targetSessionRef },
            body,
            createIfMissing: false,
          })
          expect(response.status).toBe(200)
          return ((await response.json()) as { request: { messageId: string } }).request.messageId
        }
        const sendReply = async (
          origin: HrcServerTestFixture,
          fromSessionRef: string,
          requestMessageId: string,
          body: string
        ): Promise<string> => {
          const response = await origin.postJson('/v1/messages/dm', {
            from: { kind: 'session', sessionRef: fromSessionRef },
            to: { kind: 'entity', entity: 'human' },
            body,
            replyToMessageId: requestMessageId,
            createIfMissing: false,
          })
          expect(response.status).toBe(200)
          return ((await response.json()) as { request: { messageId: string } }).request.messageId
        }
        const localMessage = (fixture: HrcServerTestFixture, messageId: string) => {
          const db = openHrcDatabase(fixture.dbPath)
          try {
            return db.messages.getById(messageId)
          } finally {
            db.close()
          }
        }
        const query = async (fixture: HrcServerTestFixture, messageId: string) => {
          const response = await fixture.postJson('/v1/messages/query', {
            thread: { rootMessageId: messageId },
          })
          expect(response.status).toBe(200)
          return (await response.json()) as {
            messages: Array<{ messageId: string }>
            history: { source: string; complete: boolean; degraded?: { code: string } }
          }
        }

        const labRoot = await sendRequest(lab, MAX3_SESSION, 'lab request to max3')
        await eventually(
          () => localMessage(max3, labRoot),
          (record) => record?.messageId === labRoot
        )
        const max3Reply = await sendReply(max3, MAX3_SESSION, labRoot, 'max3 reply to lab')
        await eventually(
          () => localMessage(lab, max3Reply),
          (record) => record?.messageId === max3Reply
        )

        const max3Root = await sendRequest(max3, LAB_SESSION, 'max3 request to lab')
        await eventually(
          () => localMessage(lab, max3Root),
          (record) => record?.messageId === max3Root
        )
        const labReply = await sendReply(lab, LAB_SESSION, max3Root, 'lab reply to max3')
        await eventually(
          () => localMessage(max3, labReply),
          (record) => record?.messageId === labReply
        )

        for (const [rootId, expectedIds] of [
          [labRoot, [labRoot, max3Reply]],
          [max3Root, [max3Root, labReply]],
        ] as const) {
          const views = await eventually(
            () => Promise.all([query(svc, rootId), query(lab, rootId), query(max3, rootId)]),
            (candidate) =>
              candidate.every(
                (view) =>
                  view.history.source === 'collective' &&
                  view.history.complete &&
                  view.messages.length === 2
              )
          )
          expect(views.map((view) => view.messages.map((message) => message.messageId))).toEqual([
            [...expectedIds],
            [...expectedIds],
            [...expectedIds],
          ])
        }
        await eventually(
          () => query(svc, 'msg-t06802-pre-feature'),
          (view) => view.messages[0]?.messageId === 'msg-t06802-pre-feature'
        )

        await svcServer.stop()
        svcServer = undefined
        const outageRoot = await sendRequest(lab, MAX3_SESSION, 'svc outage must not block send')
        await eventually(
          () => localMessage(max3, outageRoot),
          (record) => record?.messageId === outageRoot
        )
        const degraded = await query(lab, outageRoot)
        expect(degraded.history).toMatchObject({
          source: 'local',
          complete: false,
          degraded: { code: 'collective_unreachable' },
        })

        svcServer = await createFederationTestServer(svc, {
          otelListenerEnabled: false,
          collectiveHistoryPollIntervalMs: 10,
        })
        const recovered = await eventually(
          () => query(lab, outageRoot),
          (view) =>
            view.history.source === 'collective' &&
            view.history.complete &&
            view.messages[0]?.messageId === outageRoot
        )
        expect(recovered.messages.map((message) => message.messageId)).toEqual([outageRoot])
      } finally {
        await max3Server?.stop()
        await labServer?.stop()
        await svcServer?.stop()
      }
    },
    30_000
  )
})
