/**
 * RED→GREEN for the two remaining T-01801 input-after-reattach gaps found by the
 * live e2e (broker survived restart + input delivered, but the turn never
 * finalized client-side):
 *
 *   GAP A — LIVE EVENT PROJECTION after reattach. `attachAndReplay` did a one-shot
 *   `eventsSince` replay but never subscribed to the broker's LIVE stream, so
 *   post-reattach turn events stayed in the durable ledger and never projected
 *   into broker_invocation_events/hrc_events. Fix: consume
 *   `client.streamInvocationEvents(invocationId)` after replay.
 *
 *   GAP B — ATTACH FENCING. The fresh-on-boot reconcile attach (throwaway
 *   controller) is fenced when the live request-serving controller re-attaches on
 *   the first post-restart dispatch. The fenced controller's onClose must release
 *   SILENTLY — marking the runtime crash-terminal there corrupts the turn that is
 *   succeeding on the WINNING attach (observed: run failed "Controller fenced by a
 *   newer attach").
 *
 * Real HRC SQLite + the REAL HarnessBrokerController + BrokerEventMapper; the
 * broker is a scripted mock (no live broker / tmux).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthResponse,
  BrokerHelloResponse,
  CloseHandler,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationId,
  InvocationInputResponse,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationSnapshot,
  InvocationSnapshotRequest,
  InvocationStatusResponse,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'

import { type DurableBrokerClientLike, HarnessBrokerController } from '../broker/controller'

const SERVER_INSTANCE_ID = 'hrc-server-live-fence-test'
const HOST_SESSION_ID = 'hsid_lf'
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01801'
const RUNTIME_ID = 'runtime_lf'
const OPERATION_ID = 'op_lf'
const INVOCATION_ID = 'invocation_lf' as InvocationId
const RUN_ID = 'run_lf'

let dir: string
let db: HrcDatabase

function nowTs(): string {
  return '2026-06-01T00:00:00.000Z'
}

function seed(): void {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    activeInvocationId: INVOCATION_ID,
    activeRunId: RUN_ID,
    tmuxJson: { paneId: '%11', sessionName: `hrc-claude-code-tmux-${RUNTIME_ID}` },
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      status: 'ready',
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    operationId: OPERATION_ID,
    invocationId: INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: OPERATION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec',
    startRequestHash: 'sha256:req',
    selectedProfileHash: 'sha256:prof',
    createdAt: now,
    updatedAt: now,
  })
}

function readRuntime(): HrcRuntimeSnapshot {
  const r = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!r) throw new Error('runtime vanished')
  return r
}

function envelopeFor(
  type: InvocationEventEnvelope['type'],
  seq: number,
  payload: unknown
): InvocationEventEnvelope {
  return {
    invocationId: INVOCATION_ID,
    seq,
    time: nowTs(),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
  }
}

/** Minimal pushable async stream for streamInvocationEvents. */
class PushStream<T> implements AsyncIterable<T> {
  #buf: T[] = []
  #waiters: Array<(r: IteratorResult<T>) => void> = []
  #closed = false
  push(v: T): void {
    const w = this.#waiters.shift()
    if (w) w({ done: false, value: v })
    else this.#buf.push(v)
  }
  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w({ done: true, value: undefined as never })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.#buf.shift()
        if (v !== undefined) return Promise.resolve({ done: false, value: v })
        if (this.#closed) return Promise.resolve({ done: true, value: undefined as never })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

class MockClient implements DurableBrokerClientLike {
  closeHandler: CloseHandler | undefined
  readonly liveStream = new PushStream<InvocationEventEnvelope>()
  attachResponse!: BrokerAttachResponse
  snapshotResponse!: InvocationSnapshot
  private replay: InvocationEventsSinceResponse

  constructor(replay: InvocationEventsSinceResponse) {
    this.replay = replay
  }
  async attach(_req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    return this.attachResponse
  }
  async snapshot(_req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    return this.snapshotResponse
  }
  async eventsSince(_req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    return this.replay
  }
  async ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse> {
    return { ackedThroughSeq: req.throughSeq }
  }
  async permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse> {
    return {
      status: 'accepted',
      permissionRequestId: req.permissionRequestId,
      decision: req.decision,
    }
  }
  streamInvocationEvents(_invocationId: string): AsyncIterable<InvocationEventEnvelope> {
    return this.liveStream
  }
  async hello(): Promise<BrokerHelloResponse> {
    throw new Error('hello not expected')
  }
  async health(): Promise<BrokerHealthResponse> {
    return { status: 'ok', activeInvocations: 1, drivers: [] }
  }
  async startInvocationFromRequest(): Promise<never> {
    throw new Error('start not expected')
  }
  async input(): Promise<InvocationInputResponse> {
    return {
      inputId: 'i' as InvocationInputResponse['inputId'],
      accepted: true,
      disposition: 'started',
    }
  }
  async interrupt(): Promise<InvocationInterruptResponse> {
    return { accepted: true, effect: 'turn_interrupted' }
  }
  async stop(): Promise<InvocationStopResponse> {
    return { accepted: true, state: 'stopping' }
  }
  async status(): Promise<InvocationStatusResponse> {
    return { invocationId: INVOCATION_ID, state: 'ready' } as InvocationStatusResponse
  }
  async dispose(_req: InvocationDisposeRequest): Promise<void> {}
  onPermissionRequest(): void {}
  onClose(handler: CloseHandler): void {
    this.closeHandler = handler
  }
  async close(): Promise<void> {}
}

function emptySnapshot(over: Partial<InvocationSnapshot> = {}): InvocationSnapshot {
  return {
    invocationId: INVOCATION_ID,
    state: 'ready',
    capabilities: {
      input: {
        user: true,
        steer: true,
        appendContext: true,
        localImages: true,
        fileRefs: true,
        queue: false,
      },
      turns: { concurrency: 'single', interrupt: 'protocol' },
      continuation: { supported: true, provider: 'anthropic', keyKind: 'thread' },
      events: {
        assistantDeltas: true,
        toolCalls: true,
        usage: true,
        diagnostics: true,
        replay: true,
        ack: true,
      },
      control: { stop: true, dispose: true, status: true, attach: true },
      permissions: { brokerToClientRequests: true, eventAudit: true },
    },
    pendingInputIds: [],
    inputDispositions: {},
    pendingPermissionRequests: [],
    currentSeq: over.currentSeq ?? 0,
    retentionFloorSeq: over.retentionFloorSeq ?? 0,
    ...over,
  }
}

function attachResponseFor(s: InvocationSnapshot): BrokerAttachResponse {
  return {
    attached: true,
    brokerInstanceId: 'bi',
    runtimeId: RUNTIME_ID,
    generation: 1,
    invocationId: INVOCATION_ID,
    activeControllerInstanceId: SERVER_INSTANCE_ID,
    currentSeq: s.currentSeq,
    retentionFloorSeq: s.retentionFloorSeq,
    snapshot: s,
  }
}

function makeController(): HarnessBrokerController {
  return new HarnessBrokerController({
    db,
    now: () => nowTs(),
    serverInstanceId: SERVER_INSTANCE_ID,
  })
}

async function attach(controller: HarnessBrokerController, client: MockClient): Promise<void> {
  const r = await controller.attachAndReplay({ runtimeId: RUNTIME_ID, client, attachToken: 'tok' })
  expect(r.ok).toBe(true)
}

function projectedSeqs(): number[] {
  return db.brokerInvocationEvents
    .listByInvocationId(INVOCATION_ID)
    .filter((e) => e.projectionStatus === 'applied')
    .map((e) => e.seq)
    .sort((a, b) => a - b)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-lf-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})
afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('T-01801 GAP A — attachAndReplay subscribes to the LIVE event stream', () => {
  it('projects events that arrive AFTER the one-shot replay (post-reattach turn)', async () => {
    seed()
    const client = new MockClient({
      events: [envelopeFor('invocation.ready', 1, { state: 'ready' })],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = emptySnapshot({ currentSeq: 1, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)

    await attach(makeController(), client)
    // Replay projected seq 1.
    expect(projectedSeqs()).toEqual([1])

    // A NEW turn happens on the surviving broker — emitted live, not via replay.
    client.liveStream.push(envelopeFor('input.accepted', 2, { inputId: 'i2' }))
    client.liveStream.push(envelopeFor('turn.started', 3, { turnId: 't1' }))
    client.liveStream.push(envelopeFor('turn.completed', 4, { success: true }))
    await new Promise((r) => setTimeout(r, 20)) // let the consumer drain

    // Without the live subscription these never project (the e2e hang). With it,
    // the post-reattach turn projects through the same mapper.
    expect(projectedSeqs()).toEqual([1, 2, 3, 4])
  })
})

describe('T-01801 GAP B — a fenced controller releases silently (no crash-terminal)', () => {
  it('does NOT mark the runtime crash-terminal when fenced by a newer attach', async () => {
    seed()
    const controller = makeController()
    const client = new MockClient({ events: [], currentSeq: 0, retentionFloorSeq: 0 })
    client.snapshotResponse = emptySnapshot()
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    await attach(controller, client)

    // Broker fences this controller (a newer one attached): control.fenced ->
    // BrokerRpcError(ControllerFenced) delivered to onClose.
    const fenceError = Object.assign(new Error('Controller fenced by a newer attach'), {
      name: 'BrokerRpcError',
      code: BrokerErrorCode.ControllerFenced,
    })
    client.closeHandler?.(fenceError)

    const rt = readRuntime()
    expect(rt.status).not.toBe('terminated')
    expect(rt.status).not.toBe('crashed')
    // Run must NOT be failed by the fenced (losing) controller.
    expect(db.runs.getByRunId(RUN_ID)?.status).not.toBe('failed')
  })

  it('STILL marks crash-terminal on a genuine (non-fence) broker close', async () => {
    seed()
    const controller = makeController()
    const client = new MockClient({ events: [], currentSeq: 0, retentionFloorSeq: 0 })
    client.snapshotResponse = emptySnapshot()
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    await attach(controller, client)

    client.closeHandler?.(new Error('socket closed unexpectedly'))

    // A real crash still surfaces (regression guard: the fence carve-out must be
    // narrow — only the ControllerFenced code is exempt).
    const rt = readRuntime()
    expect(['terminated', 'crashed', 'stale']).toContain(rt.status)
  })
})
