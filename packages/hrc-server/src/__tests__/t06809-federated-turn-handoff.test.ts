import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import type {
  DispatchTurnResponse,
  FederationPlacementBinding,
  HrcLifecycleEvent,
  HrcMessageRecord,
  SemanticDmRequest,
  SemanticTurnHandoffStartedResponse,
} from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import {
  FEDERATION_CONFIG_BASENAME,
  type FederationConfig,
} from '../federation/federation-config.js'
import { FederationOriginOutbox } from '../federation/origin-outbox.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  createFederationTestServer,
  federationTestHost,
  selectLiveTailnetTest,
} from './fixtures/live-tailnet-test.js'

const TOKEN = 't06809-two-daemon-token'
const ORIGIN_SCOPE = 'agent:cody:project:hrc-runtime:task:minisvc'
const ORIGIN_SESSION = `${ORIGIN_SCOPE}/lane:main`
const REMOTE_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06809-remote'
const REMOTE_SESSION = `${REMOTE_SCOPE}/lane:main`

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
  const ports: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return ports
}

function installBinding(
  fixture: HrcServerTestFixture,
  scopeRef: string,
  homeNodeId: string,
  placementEpoch: number
): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef,
      homeNodeId,
      placementEpoch,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
      updatedAt: '2026-07-25T00:00:00.000Z',
    })
  } finally {
    db.close()
  }
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

describe('T-06809 federated semantic turn handoff', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = federationTestHost(tailnetIpv4())
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  liveTest(
    'returns remote lifecycle identity and projects the correlated final at origin',
    async () => {
      if (host === undefined) throw new Error('tailnet unavailable')
      const svc = await createHrcTestFixture('hrc-t06809-svc-')
      const lab = await createHrcTestFixture('hrc-t06809-lab-')
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

      const remoteHostSessionId = 'hs-t06809-lab'
      const remoteGeneration = 1
      lab.seedSession(remoteHostSessionId, REMOTE_SCOPE)
      installBinding(svc, REMOTE_SCOPE, 'lab-test', 4)
      installBinding(lab, REMOTE_SCOPE, 'lab-test', 4)

      const svcServer = await createFederationTestServer(svc, {
        otelListenerEnabled: false,
        federationOutboxPollIntervalMs: 10,
      })
      const labServer = await createFederationTestServer(lab, {
        otelListenerEnabled: false,
        federationOutboxPollIntervalMs: 10,
      })
      try {
        const remoteRuntimeId = 'rt-t06809-lab'
        let remoteRunId = ''
        const dispatchHost = labServer as HrcServer & {
          dispatchTurnForSession: (...args: unknown[]) => Promise<Response>
          notifyEvent(event: HrcLifecycleEvent): void
        }
        dispatchHost.dispatchTurnForSession = async (...args) => {
          const options = args[3] as { runId?: string } | undefined
          remoteRunId = options?.runId ?? ''
          if (remoteRunId.length === 0) throw new Error('missing dispatch runId')
          return Response.json({
            status: 'started',
            hostSessionId: remoteHostSessionId,
            runtimeId: remoteRuntimeId,
            runId: remoteRunId,
            generation: remoteGeneration,
            transport: 'headless',
          } satisfies DispatchTurnResponse)
        }

        const response = await svc.postJson('/v1/messages/turn-handoff', {
          from: { kind: 'session', sessionRef: ORIGIN_SESSION },
          to: { kind: 'session', sessionRef: REMOTE_SESSION },
          body: 'run on the authoritative peer',
          createIfMissing: false,
          runtimeIntent: {
            placement: {
              agentRoot: '/tmp/agent',
              projectRoot: '/tmp/project',
              cwd: '/tmp/project',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
              dryRun: true,
            },
            harness: { provider: 'openai', interactive: false },
            execution: { preferredMode: 'headless' },
          },
        })
        expect(response.status).toBe(200)
        const handoff = (await response.json()) as SemanticTurnHandoffStartedResponse
        expect(handoff).toMatchObject({
          sessionRef: REMOTE_SESSION,
          scopeRef: REMOTE_SCOPE,
          laneRef: 'default',
          hostSessionId: remoteHostSessionId,
          runtimeId: remoteRuntimeId,
          runId: remoteRunId,
          generation: remoteGeneration,
        })

        const originStarted = openHrcDatabase(svc.dbPath)
        try {
          expect(
            originStarted.hrcEvents.listByRun(remoteRunId, { eventKind: 'turn.started' })
          ).toHaveLength(1)
          expect(originStarted.messages.getById(handoff.messageId)?.execution).toMatchObject({
            state: 'started',
            runtimeId: remoteRuntimeId,
            runId: remoteRunId,
            hostSessionId: remoteHostSessionId,
          })
        } finally {
          originStarted.close()
        }

        const labDb = openHrcDatabase(lab.dbPath)
        let terminal: HrcLifecycleEvent
        try {
          const message = labDb.hrcEvents.append({
            ts: new Date().toISOString(),
            hostSessionId: remoteHostSessionId,
            scopeRef: REMOTE_SCOPE,
            laneRef: 'default',
            generation: remoteGeneration,
            runtimeId: remoteRuntimeId,
            runId: remoteRunId,
            category: 'turn',
            eventKind: 'turn.message',
            transport: 'headless',
            replayed: false,
            payload: { message: { content: 'remote final' } },
          })
          dispatchHost.notifyEvent(message)
          terminal = labDb.hrcEvents.append({
            ts: new Date().toISOString(),
            hostSessionId: remoteHostSessionId,
            scopeRef: REMOTE_SCOPE,
            laneRef: 'default',
            generation: remoteGeneration,
            runId: remoteRunId,
            category: 'turn',
            eventKind: 'turn.completed',
            replayed: false,
            payload: { success: true },
          })
        } finally {
          labDb.close()
        }
        dispatchHost.notifyEvent(terminal)

        const settled = await eventually(
          () => {
            const db = openHrcDatabase(svc.dbPath)
            try {
              return {
                request: db.messages.getById(handoff.messageId),
                replies: db.messages.query({
                  replyToMessageId: handoff.messageId,
                  kinds: ['dm'],
                  phases: ['response'],
                }),
                completed: db.hrcEvents.listByRun(remoteRunId, {
                  eventKind: 'turn.completed',
                }),
              }
            } finally {
              db.close()
            }
          },
          ({ request, replies, completed }) =>
            request?.execution.state === 'completed' &&
            replies.length === 1 &&
            completed.length === 1
        )

        expect(settled.replies[0]).toMatchObject({
          body: 'remote final',
          execution: {
            state: 'completed',
            hostSessionId: remoteHostSessionId,
            runtimeId: remoteRuntimeId,
            runId: remoteRunId,
            generation: remoteGeneration,
            transport: 'headless',
          },
        } satisfies Partial<HrcMessageRecord>)
        expect(settled.completed[0]).toMatchObject({
          scopeRef: REMOTE_SCOPE,
          laneRef: 'default',
          hostSessionId: remoteHostSessionId,
          runtimeId: remoteRuntimeId,
          runId: remoteRunId,
          payload: {
            success: true,
            body: 'remote final',
            replyMessageId: settled.replies[0]?.messageId,
          },
        })
      } finally {
        await labServer.stop()
        await svcServer.stop()
      }
    }
  )

  test('virgin remote establishment preserves the semantic handoff contract into accept', async () => {
    const db = openHrcDatabase(':memory:')
    let binding: FederationPlacementBinding | undefined
    let outbox: FederationOriginOutbox | undefined
    const wire: Array<{ path: string; body: Record<string, unknown> }> = []
    const peerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        const body =
          request.method === 'POST'
            ? ((await request.json()) as Record<string, unknown>)
            : ({} as Record<string, unknown>)
        wire.push({ path, body })
        if (path.endsWith('/health')) {
          return Response.json({
            nodeId: 'lab-test',
            protocolVersion: '1',
            startedAt: '2026-07-25T00:00:00.000Z',
            observedAt: '2026-07-25T00:00:01.000Z',
            capabilities: {
              accept: true,
              locate: true,
              health: true,
              establish: true,
              semanticTurnHandoff: true,
            },
          })
        }
        if (path.endsWith('/establish')) {
          binding = {
            scopeRef: REMOTE_SCOPE,
            homeNodeId: 'lab-test',
            placementEpoch: 1,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'pin',
            createdAt: '2026-07-25T00:00:00.000Z',
            updatedAt: '2026-07-25T00:00:00.000Z',
          }
          return Response.json({
            outcome: 'established',
            correlationId: body['correlationId'],
            binding,
          })
        }
        const envelope = (body['envelope'] as Record<string, unknown>) ?? {}
        return Response.json({
          ack: { outcome: 'accepted', messageId: envelope['messageId'] },
        })
      },
    })
    try {
      const peer = {
        nodeId: 'lab-test' as never,
        endpoint: peerServer.url.toString(),
        token: new PeerToken('test-token'),
      }
      const registryClient: BindingRegistryClient = {
        async consult() {
          return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
        },
        async establish() {
          throw new Error('origin must not establish receiver authority')
        },
      }
      outbox = new FederationOriginOutbox({
        db,
        config: {
          nodeId: 'svc-test',
          nodeIdProvenance: 'declared',
          sourcePath: '/isolated/svc-test/federation.json',
          sourceExists: true,
          peers: new Map([['lab-test', peer]]),
          registry: { bind: 'http://svc-test.example.ts.net:18491/' },
          gate: { mode: 'enforce', registryHost: 'svc-test' },
          warnings: [],
        } as FederationConfig,
        localRegistryClient: registryClient,
        pollIntervalMs: 10,
      })
      const body: SemanticDmRequest = {
        from: { kind: 'session', sessionRef: ORIGIN_SESSION },
        to: { kind: 'session', sessionRef: REMOTE_SESSION },
        body: 'establish and run remotely',
        createIfMissing: true,
        runtimeIntent: {
          placement: {
            agentRoot: '/tmp/agent',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            dryRun: true,
          },
          harness: { provider: 'openai', interactive: false },
          execution: { preferredMode: 'headless' },
        },
      }
      const inserted = db.messages.insert({
        messageId: 'msg-t06809-remote-establish',
        kind: 'dm',
        phase: 'request',
        from: body.from,
        to: body.to,
        body: body.body,
      })
      const routed = await outbox.route(
        body,
        inserted,
        {
          outcome: 'remote-establish',
          scopeRef: REMOTE_SCOPE,
          candidateHomeNodeId: 'lab-test',
          policyProvenance: 'pin',
        },
        { semanticTurnHandoff: true }
      )
      expect(routed.outcome).toBe('queued')
      if (routed.outcome !== 'queued') throw new Error('expected durable remote delivery')

      const delivery = await eventually(
        () => db.federationOutbox.get(routed.delivery.deliveryId),
        (value) => value?.state === 'delivered'
      )
      expect(delivery).toMatchObject({
        stage: 'delivering',
        state: 'delivered',
        peerNodeId: 'lab-test',
        envelope: {
          expected: { homeNodeId: 'lab-test', placementEpoch: 1 },
          delivery: { semanticTurnHandoff: { version: 1 } },
        },
      })
      expect(db.federationOutbox.list()).toHaveLength(1)
      expect(wire.map(({ path }) => path)).toEqual([
        '/v1/federation/health',
        '/v1/federation/establish',
        '/v1/federation/health',
        '/v1/federation/accept',
      ])
      expect(wire[3]?.body).toMatchObject({
        envelope: {
          expected: { homeNodeId: 'lab-test', placementEpoch: 1 },
          delivery: { semanticTurnHandoff: { version: 1 } },
        },
      })
    } finally {
      await outbox?.stop()
      peerServer.stop(true)
      db.close()
    }
  })

  test('older peers fail closed before accept instead of degrading to ordinary DM', async () => {
    const db = openHrcDatabase(':memory:')
    let acceptCalls = 0
    let outbox: FederationOriginOutbox | undefined
    const peerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith('/health')) {
          return Response.json({
            nodeId: 'lab-test',
            protocolVersion: '1',
            startedAt: '2026-07-25T00:00:00.000Z',
            observedAt: '2026-07-25T00:00:01.000Z',
            capabilities: { accept: true, locate: true, health: true },
          })
        }
        acceptCalls += 1
        return Response.json({ ack: { outcome: 'accepted', messageId: 'unexpected' } })
      },
    })
    try {
      const peer = {
        nodeId: 'lab-test' as never,
        endpoint: peerServer.url.toString(),
        token: new PeerToken('test-token'),
      }
      outbox = new FederationOriginOutbox({
        db,
        config: {
          nodeId: 'svc-test',
          nodeIdProvenance: 'declared',
          sourcePath: '/isolated/svc-test/federation.json',
          sourceExists: true,
          peers: new Map([['lab-test', peer]]),
          registry: { bind: 'http://svc-test.example.ts.net:18491/' },
          gate: { mode: 'enforce', registryHost: 'svc-test' },
          warnings: [],
        } as FederationConfig,
        localRegistryClient: {
          async consult() {
            return {
              outcome: 'bound',
              binding: {
                scopeRef: REMOTE_SCOPE,
                homeNodeId: 'lab-test',
                placementEpoch: 1,
                birthClass: 'policy-born',
                authorityProvenance: { kind: 'policy', source: 'pin' },
                establishmentProvenance: 'pin',
                createdAt: '2026-07-25T00:00:00.000Z',
                updatedAt: '2026-07-25T00:00:00.000Z',
              },
            }
          },
          async establish() {
            throw new Error('not used')
          },
        },
        pollIntervalMs: 10,
      })
      const body: SemanticDmRequest = {
        from: { kind: 'session', sessionRef: ORIGIN_SESSION },
        to: { kind: 'session', sessionRef: REMOTE_SESSION },
        body: 'must not become ordinary DM',
        createIfMissing: false,
      }
      const inserted = db.messages.insert({
        messageId: 'msg-t06809-old-peer',
        kind: 'dm',
        phase: 'request',
        from: body.from,
        to: body.to,
        body: body.body,
      })
      const routed = await outbox.route(
        body,
        inserted,
        {
          outcome: 'remote-bound',
          binding: {
            scopeRef: REMOTE_SCOPE,
            homeNodeId: 'lab-test',
            placementEpoch: 1,
          },
        },
        { semanticTurnHandoff: true }
      )
      expect(routed.outcome).toBe('queued')
      if (routed.outcome !== 'queued') throw new Error('expected durable remote delivery')

      const delivery = await eventually(
        () => db.federationOutbox.get(routed.delivery.deliveryId),
        (value) => value?.state === 'dead_letter'
      )
      expect(delivery).toMatchObject({
        state: 'dead_letter',
        lastErrorCode: 'peer_semantic_turn_unsupported',
        lastError: {
          code: 'peer_semantic_turn_unsupported',
          retryable: false,
        },
      })
      expect(acceptCalls).toBe(0)
    } finally {
      await outbox?.stop()
      peerServer.stop(true)
      db.close()
    }
  })
})
