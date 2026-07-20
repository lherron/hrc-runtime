import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const TOKEN = 't06619-two-daemon-token'
const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06619-e2e'
const SESSION = `${SCOPE}/lane:default`

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePorts(host: string): [number, number] {
  const first = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const second = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const result: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return result
}

async function eventually<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 4_000
  let last: T
  do {
    last = await read()
    if (accept(last)) return last
    await Bun.sleep(10)
  } while (Date.now() < deadline)
  throw new Error(`condition not reached; last value: ${JSON.stringify(last)}`)
}

describe('T-06619 isolated origin outbox lifecycle', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = tailnetIpv4()
  const liveTest = host === undefined ? test.skip : test

  liveTest(
    'peer sleep retries visibly, wake delivers automatically, dead-letter replays once',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const origin = await createHrcTestFixture('hrc-t06619-origin-')
      const lab = await createHrcTestFixture('hrc-t06619-lab-')
      fixtures.push(origin, lab)
      const [originPort, labPort] = reservePorts(host)
      const originBind = `http://${host}:${originPort}`
      const labBind = `http://${host}:${labPort}`

      for (const [fixture, nodeId, peerNodeId, bind, endpoint, registryHost] of [
        [origin, 'origin-test', 'lab-test', originBind, labBind, 'lab-test'],
        [lab, 'lab-test', 'origin-test', labBind, originBind, 'origin-test'],
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

      lab.seedSession('hs-t06619-lab', SCOPE)
      for (const [fixture, homeNodeId] of [
        [origin, 'lab-test'],
        [lab, 'lab-test'],
      ] as const) {
        const db = openHrcDatabase(fixture.dbPath)
        try {
          createPlacementLedgerRepository(db.sqlite).installActive({
            scopeRef: SCOPE,
            homeNodeId,
            placementEpoch: 3,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'pin',
            updatedAt: '2026-07-20T00:00:00.000Z',
          })
        } finally {
          db.close()
        }
      }

      const originServer = await createHrcServer(
        origin.serverOpts({
          otelListenerEnabled: false,
          federationOutboxPollIntervalMs: 10,
          federationOutboxRetryPolicy: {
            initialRetryDelayMs: 20,
            maxRetryDelayMs: 20,
            deadLetterAfterMs: 120,
          },
        })
      )
      let labServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
      try {
        const send = async (body: string) => {
          const response = await origin.postJson('/v1/messages/dm', {
            from: { kind: 'entity', entity: 'human' },
            to: { kind: 'session', sessionRef: SESSION },
            body,
            createIfMissing: false,
          })
          expect(response.status).toBe(200)
          const payload = (await response.json()) as { request: { messageId: string } }
          return payload.request.messageId
        }
        const readDelivery = async (messageId: string) => {
          const response = await origin.fetchSocket(
            `/v1/federation/outbox?messageId=${encodeURIComponent(messageId)}`
          )
          return (await response.json()) as Array<{
            deliveryId: string
            state: string
            totalAttempts: number
            lastErrorCode?: string
          }>
        }

        const sleepMessageId = await send('deliver automatically after peer wake')
        const unreachable = await eventually(
          () => readDelivery(sleepMessageId),
          (rows) => rows[0]?.state === 'peer_unreachable'
        )
        expect(unreachable[0]).toMatchObject({
          state: 'peer_unreachable',
          lastErrorCode: 'peer_unreachable',
        })

        labServer = await createHrcServer(
          lab.serverOpts({
            otelListenerEnabled: false,
            federationOutboxPollIntervalMs: 10,
            federationOutboxRetryPolicy: {
              initialRetryDelayMs: 20,
              maxRetryDelayMs: 20,
              deadLetterAfterMs: 120,
            },
          })
        )
        await eventually(
          () => readDelivery(sleepMessageId),
          (rows) => rows[0]?.state === 'delivered'
        )
        await eventually(
          () => {
            const db = openHrcDatabase(lab.dbPath)
            try {
              return db.messages.getById(sleepMessageId)
            } finally {
              db.close()
            }
          },
          (record) =>
            record?.body === 'deliver automatically after peer wake' &&
            record.execution.hostSessionId === 'hs-t06619-lab'
        )

        await labServer.stop()
        labServer = undefined
        const replayMessageId = await send('dead-letter then replay')
        const dead = await eventually(
          () => readDelivery(replayMessageId),
          (rows) => rows[0]?.state === 'dead_letter'
        )
        expect(dead[0]?.totalAttempts).toBeGreaterThan(1)

        labServer = await createHrcServer(lab.serverOpts({ otelListenerEnabled: false }))
        await Bun.sleep(50)
        expect((await readDelivery(replayMessageId))[0]?.state).toBe('dead_letter')

        const replayResponse = await origin.postJson('/v1/federation/outbox/replay', {
          deliveryId: dead[0]?.deliveryId,
        })
        expect(replayResponse.status).toBe(200)
        await eventually(
          () => readDelivery(replayMessageId),
          (rows) => rows[0]?.state === 'delivered'
        )
        await eventually(
          () => {
            const db = openHrcDatabase(lab.dbPath)
            try {
              return db.messages.getById(replayMessageId)?.execution.hostSessionId
            } finally {
              db.close()
            }
          },
          (hostSessionId) => hostSessionId === 'hs-t06619-lab'
        )
        const labDb = openHrcDatabase(lab.dbPath)
        try {
          expect(
            labDb.messages.query({}).filter((row) => row.messageId === replayMessageId)
          ).toHaveLength(1)
        } finally {
          labDb.close()
        }
      } finally {
        await labServer?.stop()
        await originServer.stop()
      }
    }
  )
})
