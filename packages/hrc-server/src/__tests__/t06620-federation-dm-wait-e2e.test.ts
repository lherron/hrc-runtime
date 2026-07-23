import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'

import type {
  FederationMessageEnvelope,
  HrcLifecycleEvent,
  HrcMessageRecord,
  WaitMessageResponse,
} from 'hrc-core'
import {
  createPlacementLedgerRepository,
  createScopeRetirementRepository,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const TOKEN = 't06620-two-daemon-token'
const ORIGIN_SCOPE = 'agent:mable:project:hrc-runtime:task:minisvc'
const ORIGIN_SESSION = `${ORIGIN_SCOPE}/lane:default`
const REMOTE_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06620-e2e'
const REMOTE_SESSION = `${REMOTE_SCOPE}/lane:default`

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePorts(host: string): [number, number] {
  const first = Bun.serve({
    hostname: host,
    port: 0,
    fetch: () => new Response('probe'),
  })
  const second = Bun.serve({
    hostname: host,
    port: 0,
    fetch: () => new Response('probe'),
  })
  const result: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return result
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

function installBinding(
  fixture: HrcServerTestFixture,
  scopeRef: string,
  homeNodeId: string,
  placementEpoch: number,
  provenance: 'pin' | 'rebind' = 'pin'
): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    createPlacementLedgerRepository(db.sqlite).installActive({
      scopeRef,
      homeNodeId,
      placementEpoch,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: provenance,
      ...(provenance === 'rebind' ? { priorHomeNodeId: 'svc-test' } : {}),
      updatedAt: '2026-07-20T00:00:00.000Z',
    })
  } finally {
    db.close()
  }
}

describe('T-06620 local dm wait over bilateral federation transcripts', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = tailnetIpv4()
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  test('local wait returns a durable terminal outbox failure without any peer request', async () => {
    const fixture = await createHrcTestFixture('hrc-t06620-terminal-wait-')
    fixtures.push(fixture)
    const messageId = 'msg-33333333-3333-4333-8333-333333333333'
    const db = openHrcDatabase(fixture.dbPath)
    let request: HrcMessageRecord
    try {
      request = db.messages.insert({
        messageId,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'session', sessionRef: ORIGIN_SESSION },
        to: { kind: 'session', sessionRef: REMOTE_SESSION },
        body: 'peer will remain unavailable',
      })
      const envelope: FederationMessageEnvelope = {
        protocolVersion: '1.0',
        messageId,
        kind: 'dm',
        phase: 'request',
        from: request.from,
        to: request.to,
        body: request.body,
        rootMessageId: request.rootMessageId,
        expected: { homeNodeId: 'lab-test', placementEpoch: 4 },
      }
      db.federationOutbox.enqueue({
        deliveryId: 'delivery-t06620-terminal',
        messageId,
        peerNodeId: 'lab-test',
        envelope,
        now: '2026-07-20T00:00:00.000Z',
      })
    } finally {
      db.close()
    }

    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    try {
      const waitPromise = fixture
        .postJson('/v1/messages/wait', {
          thread: { rootMessageId: request.rootMessageId },
          phases: ['response'],
          afterSeq: request.messageSeq,
          deliveryMessageId: messageId,
          timeoutMs: 2_000,
        })
        .then((response) => response.json() as Promise<WaitMessageResponse>)

      await Bun.sleep(50)
      const failureDb = openHrcDatabase(fixture.dbPath)
      try {
        failureDb.federationOutbox.markDeadLetter({
          deliveryId: 'delivery-t06620-terminal',
          attemptedAt: '2026-07-20T00:01:00.000Z',
          errorCode: 'peer_unreachable',
          errorMessage: 'peer remained unavailable',
          structuredErrorCode: 'runtime_unavailable',
          errorReason: 'peer_unreachable',
          retryable: true,
          homeNodeId: 'lab-test',
        })
      } finally {
        failureDb.close()
      }

      await expect(waitPromise).resolves.toEqual({
        matched: false,
        reason: 'delivery_failed',
        messageId,
        errorCode: 'runtime_unavailable',
        errorMessage: 'peer remained unavailable',
        errorReason: 'peer_unreachable',
        retryable: true,
        homeNodeId: 'lab-test',
      })
    } finally {
      await server.stop()
    }
  })

  liveTest('peer restart and origin epoch bump do not lose the eventual response', async () => {
    if (host === undefined) throw new Error('tailnet unavailable')
    const svc = await createHrcTestFixture('hrc-t06620-svc-')
    const lab = await createHrcTestFixture('hrc-t06620-lab-')
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

    lab.seedSession('hs-t06620-lab', REMOTE_SCOPE)
    installBinding(svc, REMOTE_SCOPE, 'lab-test', 4)
    installBinding(lab, REMOTE_SCOPE, 'lab-test', 4)
    // The origin's conversation scope has already moved elsewhere by the time
    // the response arrives. Its epoch must not participate in completion.
    installBinding(svc, ORIGIN_SCOPE, 'svc-next', 5, 'rebind')
    // Model the loser-node fence that namespace reconciliation leaves behind
    // on the responding node. It bars local execution for ORIGIN_SCOPE, but an
    // explicit response to authenticated federation ingress must still use
    // the existing response-fence route back to the request's origin.
    const labDb = openHrcDatabase(lab.dbPath)
    try {
      createScopeRetirementRepository(labDb.sqlite).retire({
        scopeRef: ORIGIN_SCOPE,
        retiredNodeId: 'lab-test',
        retiredPlacementEpoch: 4,
        successorNodeId: 'svc-test',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:00:00.000Z',
      })
    } finally {
      labDb.close()
    }

    const svcServer = await createHrcServer(
      svc.serverOpts({
        otelListenerEnabled: false,
        federationOutboxPollIntervalMs: 10,
      })
    )
    let labServer = await createHrcServer(
      lab.serverOpts({
        otelListenerEnabled: false,
        federationOutboxPollIntervalMs: 10,
      })
    )
    try {
      const sentResponse = await svc.postJson('/v1/messages/dm', {
        from: { kind: 'session', sessionRef: ORIGIN_SESSION },
        to: { kind: 'session', sessionRef: REMOTE_SESSION },
        body: 'request that survives the peer restart',
        createIfMissing: false,
      })
      expect(sentResponse.status).toBe(200)
      const sent = (await sentResponse.json()) as {
        request: HrcMessageRecord
      }

      await eventually(
        () => {
          const db = openHrcDatabase(lab.dbPath)
          try {
            return db.messages.getById(sent.request.messageId)
          } finally {
            db.close()
          }
        },
        (record) => record?.body === 'request that survives the peer restart'
      )

      const signalRunId = 'run-t06704-remote-ask'
      let askEvent: HrcLifecycleEvent
      const signalDb = openHrcDatabase(lab.dbPath)
      try {
        const acceptedRequest = signalDb.messages.getById(sent.request.messageId)
        expect(acceptedRequest).toBeDefined()
        const metadata = acceptedRequest?.metadataJson ?? {}
        const ingress = metadata['federationIngress'] as Record<string, unknown>
        signalDb.sqlite.query('UPDATE messages SET metadata_json = ? WHERE message_id = ?').run(
          JSON.stringify({
            ...metadata,
            federationIngress: {
              ...ingress,
              delivery: {
                runtimeIntent: {
                  launch: { env: { ACP_RUN_ID: 'run_acp_t06704' } },
                },
              },
            },
          }),
          sent.request.messageId
        )
        signalDb.messages.updateExecution(sent.request.messageId, {
          state: 'started',
          mode: 'interactive',
          sessionRef: REMOTE_SESSION,
          hostSessionId: 'hs-t06620-lab',
          generation: 1,
          runtimeId: 'rt-t06704-lab',
          runId: signalRunId,
          transport: 'tmux',
        })
        askEvent = signalDb.hrcEvents.append({
          ts: new Date().toISOString(),
          hostSessionId: 'hs-t06620-lab',
          scopeRef: REMOTE_SCOPE,
          laneRef: 'default',
          generation: 1,
          runtimeId: 'rt-t06704-lab',
          runId: signalRunId,
          category: 'turn',
          eventKind: 'turn.tool_call',
          transport: 'tmux',
          replayed: false,
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu_t06704',
            toolName: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Fruit?',
                  header: 'Fruit',
                  options: [{ label: 'Apple', description: 'Choose Apple' }],
                  multiSelect: false,
                },
              ],
            },
          },
        })
      } finally {
        signalDb.close()
      }

      // Replaying the same source event is harmless: the signal message ID is
      // deterministic and the origin projects the canonical event once.
      const notifyLab = labServer as unknown as { notifyEvent(event: HrcLifecycleEvent): void }
      notifyLab.notifyEvent(askEvent)
      notifyLab.notifyEvent(askEvent)

      await eventually(
        () => {
          const db = openHrcDatabase(svc.dbPath)
          try {
            return {
              projected: db.hrcEvents.listByRun(signalRunId, { eventKind: 'turn.tool_call' }),
              responses: db.messages.query({
                thread: { rootMessageId: sent.request.rootMessageId },
                phases: ['response'],
              }),
            }
          } finally {
            db.close()
          }
        },
        ({ projected, responses }) => projected.length === 1 && responses.length === 1
      ).then(({ projected, responses }) => {
        expect(projected).toHaveLength(1)
        expect(projected[0]).toMatchObject({
          scopeRef: REMOTE_SCOPE,
          laneRef: 'default',
          hostSessionId: 'hs-t06620-lab',
          runtimeId: 'rt-t06704-lab',
          runId: signalRunId,
          generation: 1,
          eventKind: 'turn.tool_call',
          payload: {
            toolName: 'AskUserQuestion',
            acpRunId: 'run_acp_t06704',
            federationSourceHrcSeq: askEvent.hrcSeq,
          },
        })
        expect(responses).toEqual([
          expect.objectContaining({ kind: 'system', phase: 'response', body: '' }),
        ])
      })

      const waitPromise = svc
        .postJson('/v1/messages/wait', {
          thread: { rootMessageId: sent.request.rootMessageId },
          kinds: ['dm'],
          phases: ['response'],
          afterSeq: sent.request.messageSeq,
          deliveryMessageId: sent.request.messageId,
          timeoutMs: 4_000,
        })
        .then((response) => response.json() as Promise<WaitMessageResponse>)

      await labServer.stop()
      labServer = await createHrcServer(
        lab.serverOpts({
          otelListenerEnabled: false,
          federationOutboxPollIntervalMs: 10,
        })
      )

      const replyResponse = await lab.postJson('/v1/messages/dm', {
        from: { kind: 'session', sessionRef: REMOTE_SESSION },
        to: { kind: 'session', sessionRef: ORIGIN_SESSION },
        body: 'response after peer restart',
        replyToMessageId: sent.request.messageId,
        createIfMissing: false,
      })
      expect(replyResponse.status).toBe(200)
      const reply = (await replyResponse.json()) as {
        request: HrcMessageRecord
      }

      const waited = await waitPromise
      expect(waited).toMatchObject({
        matched: true,
        record: {
          messageId: reply.request.messageId,
          replyToMessageId: sent.request.messageId,
          body: 'response after peer restart',
        },
      })

      for (const fixture of [svc, lab]) {
        const db = openHrcDatabase(fixture.dbPath)
        try {
          expect(db.messages.getById(sent.request.messageId)).toBeDefined()
        } finally {
          db.close()
        }
      }
      const svcDb = openHrcDatabase(svc.dbPath)
      try {
        expect(svcDb.federationPeerAcceptances.get(sent.request.messageId)).toMatchObject({
          acceptedByNodeId: 'lab-test',
          phase: 'request',
          requestEpoch: 4,
        })
      } finally {
        svcDb.close()
      }
    } finally {
      await labServer.stop()
      await svcServer.stop()
    }
  })
})
