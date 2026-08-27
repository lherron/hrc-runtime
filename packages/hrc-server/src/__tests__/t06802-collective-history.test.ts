import { describe, expect, test } from 'bun:test'

import type { HrcMessageRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { CollectiveHistoryCoordinator } from '../federation/collective-history.js'
import type { FederationConfig, PeerEntry } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { createPeerProtocolRequestHandler } from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'

const LAB_TOKEN = 't06802-lab-token'
const MAX3_TOKEN = 't06802-max3-token'

function peer(nodeId: string, token: string): PeerEntry {
  return {
    nodeId: parseNodeId(nodeId, 'T-06802 peer'),
    endpoint: 'http://svc.test:18490/',
    token: new PeerToken(token),
  }
}

function config(nodeId: string, peers: ReadonlyArray<[string, string]>): FederationConfig {
  return {
    nodeId: parseNodeId(nodeId, 'T-06802 node'),
    nodeIdProvenance: 'declared',
    sourcePath: `/tmp/t06802-${nodeId}.json`,
    sourceExists: true,
    peers: new Map(
      peers.map(([peerNodeId, token]) => [
        parseNodeId(peerNodeId, 'T-06802 peer'),
        peer(peerNodeId, token),
      ])
    ),
    gate: { mode: 'off' },
    warnings: [],
  }
}

function insert(
  db: ReturnType<typeof openHrcDatabase>,
  input: {
    messageId: string
    phase?: 'request' | 'response'
    replyToMessageId?: string | undefined
    rootMessageId?: string | undefined
    body: string
    ingressOriginNodeId?: string | undefined
  }
): HrcMessageRecord {
  return db.messages.insert({
    messageId: input.messageId,
    kind: 'dm',
    phase: input.phase ?? 'request',
    from: {
      kind: 'session',
      sessionRef: 'agent:cody:project:hrc-runtime:task:origin/lane:main',
    },
    to: {
      kind: 'session',
      sessionRef: 'agent:clod:project:hrc-runtime:task:target/lane:main',
    },
    body: input.body,
    ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
    ...(input.rootMessageId === undefined ? {} : { rootMessageId: input.rootMessageId }),
    execution: { state: 'completed' },
    ...(input.ingressOriginNodeId === undefined
      ? {}
      : {
          metadataJson: {
            federationIngress: {
              authenticatedNodeId: input.ingressOriginNodeId,
              protocolVersion: '1.0',
            },
          },
        }),
  })
}

async function eventually(read: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(10)
  }
  throw new Error('collective history did not converge')
}

describe('T-06802 collective message read model', () => {
  test('backfills, deduplicates, and returns one ordered transcript through every node', async () => {
    const svcDb = openHrcDatabase(':memory:')
    const labDb = openHrcDatabase(':memory:')
    const max3Db = openHrcDatabase(':memory:')
    const root = insert(labDb, {
      messageId: 'msg-t06802-root',
      body: 'lab to max3',
    })
    const reply = insert(max3Db, {
      messageId: 'msg-t06802-reply',
      phase: 'response',
      replyToMessageId: root.messageId,
      rootMessageId: root.messageId,
      body: 'max3 to lab',
    })
    insert(max3Db, {
      messageId: root.messageId,
      body: root.body,
      ingressOriginNodeId: 'lab',
    })
    insert(labDb, {
      messageId: reply.messageId,
      phase: 'response',
      replyToMessageId: root.messageId,
      rootMessageId: root.messageId,
      body: reply.body,
      ingressOriginNodeId: 'max3',
    })

    const svc = new CollectiveHistoryCoordinator({
      db: svcDb,
      config: config('svc', [
        ['lab', LAB_TOKEN],
        ['max3', MAX3_TOKEN],
      ]),
      pollIntervalMs: 10,
    })
    const handler = createPeerProtocolRequestHandler({
      localNodeId: 'svc',
      peers: config('svc', [
        ['lab', LAB_TOKEN],
        ['max3', MAX3_TOKEN],
      ]).peers,
      locate: async () => ({}),
      health: () => ({
        startedAt: '2026-07-24T00:00:00.000Z',
        capabilities: {
          locate: true,
          health: true,
          collectiveHistory: true,
        },
      }),
      collectiveHistoryReplicate: ({ authenticatedNodeId, body }) =>
        svc.acceptReplication(authenticatedNodeId, body),
      collectiveHistoryCheckpoint: ({ authenticatedNodeId, body }) =>
        svc.acceptCheckpoint(authenticatedNodeId, body),
      collectiveHistoryQuery: ({ filter }) => svc.queryAuthority(filter),
    })
    const routeFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof fetch
    const lab = new CollectiveHistoryCoordinator({
      db: labDb,
      config: config('lab', [['svc', LAB_TOKEN]]),
      pollIntervalMs: 10,
      fetch: routeFetch,
    })
    const max3 = new CollectiveHistoryCoordinator({
      db: max3Db,
      config: config('max3', [['svc', MAX3_TOKEN]]),
      pollIntervalMs: 10,
      fetch: routeFetch,
    })

    try {
      svc.start()
      expect(svc.queryAuthority({}).history).toMatchObject({
        complete: false,
        unconfirmedNodeIds: ['lab', 'max3'],
        degraded: { code: 'collective_lagging' },
      })
      lab.start()
      max3.start()
      await eventually(async () => {
        await Promise.all([lab.drainDue(), max3.drainDue()])
        return (
          labDb.collectiveHistoryReplications.pendingCount() === 0 &&
          max3Db.collectiveHistoryReplications.pendingCount() === 0 &&
          svcDb.collectiveHistory.count() === 2
        )
      })
      svc.acceptReplication('lab', { record: root })
      expect(svcDb.collectiveHistory.count()).toBe(2)
      labDb.messages.updateExecution(root.messageId, {
        state: 'failed',
        errorCode: 'delivery_failed',
        errorMessage: 'fixture failure projection',
      })
      await eventually(async () => {
        await lab.drainDue()
        return (
          svcDb.collectiveHistory.query({ messageId: root.messageId }, 'svc')[0]?.execution
            .state === 'failed'
        )
      })

      const filter = { thread: { rootMessageId: root.messageId } }
      const [svcView, labView, max3View] = await Promise.all([
        svc.query(filter),
        lab.query(filter),
        max3.query(filter),
      ])
      const ids = (view: typeof svcView) => view.messages.map((record) => record.messageId)
      expect(ids(svcView)).toEqual([root.messageId, reply.messageId])
      expect(ids(labView)).toEqual(ids(svcView))
      expect(ids(max3View)).toEqual(ids(svcView))
      expect(svcView.messages[0]?.execution).toMatchObject({
        state: 'failed',
        errorCode: 'delivery_failed',
      })
      expect(labView.history).toMatchObject({
        source: 'collective',
        complete: true,
        queriedNodeId: 'lab',
        cursorKind: 'collective',
      })
      expect(max3View.history).toMatchObject({
        source: 'collective',
        complete: true,
        queriedNodeId: 'max3',
      })
      expect(svcView.messages[0]?.collectiveHistory?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: 'lab', role: 'origin' }),
          expect.objectContaining({ nodeId: 'max3', role: 'destination' }),
        ])
      )
      expect(svcView.messages[1]?.collectiveHistory?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: 'max3', role: 'origin' }),
          expect.objectContaining({ nodeId: 'lab', role: 'destination' }),
        ])
      )
    } finally {
      lab.stop()
      max3.stop()
      svc.stop()
      labDb.close()
      max3Db.close()
      svcDb.close()
    }
  })

  test('keeps sends local and labels the fallback incomplete while svc is unavailable', async () => {
    const labDb = openHrcDatabase(':memory:')
    const lab = new CollectiveHistoryCoordinator({
      db: labDb,
      config: config('lab', [['svc', LAB_TOKEN]]),
      pollIntervalMs: 10,
      fetch: (() => Promise.reject(new Error('svc sleeping'))) as typeof fetch,
    })
    try {
      lab.start()
      const stored = insert(labDb, {
        messageId: 'msg-t06802-offline',
        body: 'accepted while archive unavailable',
      })
      await Bun.sleep(0)
      const result = await lab.query({ messageId: stored.messageId })
      expect(result.messages.map((record) => record.messageId)).toEqual([stored.messageId])
      expect(result.history).toMatchObject({
        source: 'local',
        complete: false,
        queriedNodeId: 'lab',
        pendingReplicationCount: 1,
        degraded: { code: 'collective_unreachable' },
      })
    } finally {
      lab.stop()
      labDb.close()
    }
  })
})
