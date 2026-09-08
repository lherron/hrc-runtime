/**
 * The shared attach owner against the REAL controller (T-08296, Astra EN-08597).
 *
 * `t08296-shared-attach-owner.test.ts` stubs `attachAndReplay` and counts a
 * modelled consumer, so it establishes factory/owner multiplicity and nothing
 * more. This lane closes that gap: a real `HarnessBrokerController`, overlapping
 * attaches staged at the injectable client seam, and then a supported event
 * pushed through the LIVE subscription after both calls have finished — so the
 * assertions are about the real subscription, real projection and real ack
 * rather than a stand-in.
 *
 * The property that matters: `attachAndReplay` publishes its client with
 * `setActive` and then subscribes `streamInvocationEvents` on that same client.
 * Two attaches therefore mean two live subscriptions on one broker stream, and
 * because projection is idempotent the store looks perfect while the process
 * quietly runs two consumers. Counting subscriptions is the only way to see it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller.js'
import { type BrokerReattachOutcome, attachDurableBrokerShared } from '../startup-reconcile.js'

const RUNTIME_ID = 'rt-t08296-int'
const HOST_SESSION_ID = 'hsid-t08296-int'
const INVOCATION_ID = 'inv-t08296-int'
const SCOPE = 'agent:stella:project:hrc-ios:task:primary-nova'
const NOW = '2026-09-08T00:00:00.000Z'

let dir: string
let db: HrcDatabase
let controller: HarnessBrokerController
let inFlight: Map<string, Promise<BrokerReattachOutcome>>
let clients: MockClient[]
let gateOpen: Promise<void>
let openGate!: () => void

/** The invocation snapshot shape the real attach path validates against. */
function snapshotShape() {
  return {
    invocationId: INVOCATION_ID,
    state: 'ready',
    capabilities: {
      admission: { classes: ['queue'] },
      input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: false,
        fileRefs: false,
        queue: true,
      },
      turns: { concurrency: 'single', interrupt: 'unsupported' },
      continuation: { supported: true, provider: 'openai', keyKind: 'thread' },
      events: {
        assistantDeltas: false,
        toolCalls: true,
        usage: true,
        diagnostics: true,
        replay: true,
        ack: true,
      },
      control: { stop: true, dispose: true, status: true, attach: true },
      permissions: { brokerToClientRequests: false, eventAudit: true },
    },
    pendingInputIds: [],
    inputDispositions: {},
    pendingPermissionRequests: [],
    currentSeq: 0,
    retentionFloorSeq: 0,
  }
}

function envelope(type: string, seq: number, payload: unknown, extra: object = {}) {
  return { invocationId: INVOCATION_ID, seq, time: NOW, type, payload, ...extra } as never
}

/**
 * A broker client that can be driven live.
 *
 * `streamInvocationEvents` hands back an async iterable this test feeds after the
 * attaches settle, and every subscription is counted — that count is the whole
 * point of the lane.
 */
class MockClient {
  readonly calls: string[] = []
  streamSubscriptions = 0
  ackedThrough: number[] = []
  private pending: Array<(value: IteratorResult<unknown>) => void> = []
  private queued: unknown[] = []

  constructor(readonly id: number) {}

  async attach() {
    this.calls.push('attach')
    return {
      attached: true,
      brokerInstanceId: 'broker-t08296-int',
      runtimeId: RUNTIME_ID,
      generation: 1,
      invocationId: INVOCATION_ID,
      activeControllerInstanceId: 'hrc-server:t08296-int',
      currentSeq: 0,
      retentionFloorSeq: 0,
      snapshot: snapshotShape(),
    } as never
  }
  async snapshot() {
    this.calls.push('snapshot')
    return snapshotShape() as never
  }
  async eventsSince() {
    this.calls.push('eventsSince')
    // One replayed event so the controller has a projection cursor to ACK. It
    // only acks when `lastProjectedBrokerSeq > 0`, so an empty replay would make
    // the ack assertion below vacuous rather than true.
    return {
      events: [envelope('invocation.ready', 1, { state: 'ready' })],
      currentSeq: 1,
      retentionFloorSeq: 0,
    } as never
  }
  async ackEvents(req: { throughSeq: number }) {
    this.calls.push('ackEvents')
    this.ackedThrough.push(req.throughSeq)
    return { ackedThroughSeq: req.throughSeq }
  }
  /** The live subscription the controller opens after publishing this client. */
  streamInvocationEvents(): AsyncIterable<unknown> {
    this.streamSubscriptions += 1
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            const queued = self.queued.shift()
            if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
            return new Promise((resolve) => self.pending.push(resolve))
          },
        }
      },
    }
  }
  /** Push one event into every live subscription of this client. */
  emit(event: unknown): void {
    const waiter = this.pending.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.queued.push(event)
  }
  async hello() {
    throw new Error('hello must not be called during reattach')
  }
  async health() {
    return { status: 'ok', activeInvocations: 1, drivers: [] } as never
  }
  async status() {
    return { invocationId: INVOCATION_ID, state: 'ready' } as never
  }
  async input() {
    return { inputId: 'i', accepted: true, disposition: 'started' } as never
  }
  async invoke() {
    return { submissionId: 's', admission: 'admitted' as const }
  }
  async interrupt() {
    return { accepted: true, effect: 'turn_interrupted' } as never
  }
  async stop() {
    return { accepted: true, state: 'stopping' } as never
  }
  async dispose() {}
  async permissionRespond() {
    return { status: 'accepted' } as never
  }
  async startInvocationFromRequest(): Promise<never> {
    throw new Error('start must not be called during reattach')
  }
  onPermissionRequest(): void {}
  onClose(): void {}
  async close(): Promise<void> {
    this.calls.push('close')
  }
}

function brokerWindow() {
  return {
    socketPath: join(dir, 'tmux.sock'),
    sessionName: 'hrc-t08296-int',
    windowName: 'broker',
    sessionId: '$1',
    windowId: '@10',
    paneId: '%10',
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08296-int-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  controller = new HarnessBrokerController({
    db,
    now: () => NOW,
    serverInstanceId: 'hrc-server:t08296-int',
  } as never)
  inFlight = new Map()
  clients = []
  gateOpen = new Promise<void>((resolve) => {
    openGate = resolve
  })

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
    activeInvocationId: INVOCATION_ID,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      status: 'ready',
      lifecycleOwner: 'external',
      control: { mode: 'broker-ipc', brokerAttached: true },
      broker: {
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: 'hrc-server:previous',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: join(dir, 'broker.sock'),
          attachTokenRef: { kind: 'file', path: join(dir, 'attach.token'), redacted: true },
        },
        generation: 1,
        brokerPid: 4242,
        brokerWindow: brokerWindow(),
      },
    },
  })
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: 'op-t08296-int',
    runtimeId: RUNTIME_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-desktop',
    invocationState: 'ready',
    capabilitiesJson: '{}',
    specHash: 'spec',
    startRequestHash: 'startreq',
    selectedProfileHash: 'profile',
    specProjectionJson: '{}',
    startRequestProjectionJson: '{}',
    ownerServerInstanceId: 'hrc-server:previous',
    createdAt: NOW,
    updatedAt: NOW,
  })
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function runtime(): HrcRuntimeSnapshot {
  const found = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (found === null) throw new Error('fixture runtime missing')
  return found
}

function deps(gated: boolean) {
  return {
    runtimeRoot: dir,
    controller,
    brokerUnixClientFactory: async () => {
      const client = new MockClient(clients.length + 1)
      clients.push(client)
      if (gated) await gateOpen
      return client as never
    },
    resolveAttachToken: async () => 'token',
    probeBrokerLease: async () => ({ brokerSocketLive: true, brokerWindow: brokerWindow() }),
    inFlightOperations: inFlight,
  } as unknown as Parameters<typeof attachDurableBrokerShared>[2]
}

async function whenOwnerInFlight(): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (inFlight.has(RUNTIME_ID)) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('no attach ever went in flight')
}

describe('shared attach owner, real controller', () => {
  it('overlapped attaches leave ONE live subscription that projects and acks', async () => {
    const owner = attachDurableBrokerShared(db, runtime(), deps(true))
    await whenOwnerInFlight()
    const joiner = attachDurableBrokerShared(db, runtime(), deps(true))
    openGate()
    const [a, b] = await Promise.all([owner, joiner])

    expect(a.state).toBe('broker-attached')
    expect(b.state).toBe('broker-attached')
    // One client built, and — the assertion this lane exists for — exactly one
    // LIVE subscription on the real controller, not a modelled one.
    expect(clients).toHaveLength(1)
    expect(clients[0]?.streamSubscriptions).toBe(1)

    // Serving control: this daemon can now address the runtime's invocation.
    expect(controller.activeClientInvocationId(RUNTIME_ID)).toBe(INVOCATION_ID)

    // A supported event AFTER both calls finish must project exactly once and be
    // acked through the real consumer.
    clients[0]?.emit(envelope('turn.started', 5, { turnId: 't-int' }, { turnId: 't-int' }))
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const projected = db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
      if (projected.some((row: { seq: number }) => row.seq === 5)) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const rows = db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    // The replayed event and the live one are both present exactly once, which
    // is what one subscription looks like; two would still yield one row each
    // (projection is idempotent) — the subscription COUNT above is the fence.
    expect(rows.filter((row) => row.seq === 1)).toHaveLength(1)
    const turnRows = rows.filter((row) => row.seq === 5)
    expect(turnRows).toHaveLength(1)
    expect(turnRows[0]?.type).toBe('turn.started')
    expect(turnRows[0]?.projectionStatus).toBe('applied')

    // Acked through the REAL client on the real path. The controller acks from
    // its durable projection cursor during attach/replay, so this asserts the ack
    // that actually happens rather than inventing a per-live-event one.
    expect(clients[0]?.calls).toContain('ackEvents')
    expect(Math.max(...(clients[0]?.ackedThrough ?? [0]))).toBeGreaterThanOrEqual(1)
  })

  it('CONTROL: two separate owners open TWO live subscriptions on one stream', async () => {
    // The unfenced shape, with the real controller: two clients, two live
    // consumers on the same invocation. `active` holds only the last one, which
    // is exactly why a map entry was never evidence of one connection.
    const separateA = {
      ...(deps(true) as Record<string, unknown>),
      inFlightOperations: new Map(),
    } as unknown as Parameters<typeof attachDurableBrokerShared>[2]
    const separateB = {
      ...(deps(true) as Record<string, unknown>),
      inFlightOperations: new Map(),
    } as unknown as Parameters<typeof attachDurableBrokerShared>[2]
    const first = attachDurableBrokerShared(db, runtime(), separateA)
    const second = attachDurableBrokerShared(db, runtime(), separateB)
    openGate()
    await Promise.all([first, second])

    expect(clients).toHaveLength(2)
    expect(clients.map((client) => client.streamSubscriptions)).toEqual([1, 1])
  })
})
