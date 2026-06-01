/**
 * RED acceptance tests for T-01811 (T-01801 Phase 2) — durable broker replay /
 * idempotency / ack / retention safety.
 *
 * Phase 1 (T-01810) added the DurableBrokerClientLike surface
 * (attach/snapshot/eventsSince/ackEvents/permissionRespond) + isDurableBrokerClient
 * on `broker/controller.ts`. Phase 2 must wire those durability methods into the
 * controller so that, given an ALREADY-CONNECTED durable client, the controller:
 *
 *   1. attaches, reads a snapshot, asks the broker for events SINCE HRC's last
 *      SUCCESSFULLY PROJECTED broker seq, and replays each returned envelope
 *      THROUGH the live `BrokerEventMapper.apply()` path (idempotent on
 *      (invocationId, seq) — no second projection path);
 *   2. acks ONLY the max seq actually projected, and ONLY after projection;
 *   3. fails closed (runtime stale + durable client closed, brokerAttached never
 *      true) on a replay-append conflict;
 *   4. honors snapshot.inputDispositions so an already-accepted prompt is not
 *      re-sent / re-projected (duplicate input retry reuses the same inputId);
 *   5. treats a retention-floor gap (broker dropped events HRC never projected)
 *      as UNSAFE — conservative default = mark stale, do not attach.
 *
 * ── Expected production entry point (named for the implementer) ──────────────
 *   HarnessBrokerController.attachAndReplay(input: {
 *     runtimeId: string
 *     client: DurableBrokerClientLike   // already connected (Phase 3 builds connect)
 *     attachToken: string
 *   }): Promise<BrokerControllerAttachResult>
 *
 *   where BrokerControllerAttachResult is:
 *     | { ok: true;  brokerAttached: true;  replayedThroughSeq: number;
 *         ackedThroughSeq: number; acceptedInputIds: string[] }
 *     | { ok: false; brokerAttached: false; error: BrokerControllerError }
 *
 * These are RED NOW: `attachAndReplay` does not exist on the controller, so every
 * `it` throws "controller.attachAndReplay is not a function".
 *
 * Harness fidelity: real HRC SQLite + the REAL BrokerEventMapper (wrapped only by
 * a thin counting spy that delegates to it, to prove replay reuses apply()). The
 * broker is a scripted MOCK DurableBrokerClientLike.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthResponse,
  BrokerHelloResponse,
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

import {
  type DurableBrokerClientLike,
  BrokerControllerError,
  HarnessBrokerController,
} from '../broker/controller'
import { BrokerEventMapper } from '../broker/event-mapper'

import {
  envelope,
  headlessSequence,
  INVOCATION_ID,
  inputId,
  makeSeededFixture,
  RUN_ID,
  RUNTIME_ID,
  type SeededFixture,
  ts,
  turnId,
} from './broker-event-mapper-fixtures'

const SERVER_INSTANCE_ID = 'hrc-server-replay-test'
const ATTACH_TOKEN = 'attach-token-secret'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

// ───────────────────────────────────────────────────────────────────────────
// Scripted durable broker client. Replay must touch ONLY the durability surface
// (attach/snapshot/eventsSince/ackEvents) + close on failure; it must never
// re-launch (startInvocationFromRequest) or re-send a prompt (input) during the
// replay itself.
// ───────────────────────────────────────────────────────────────────────────
class MockDurableBrokerClient implements DurableBrokerClientLike {
  readonly calls: string[] = []
  readonly attachCalls: BrokerAttachRequest[] = []
  readonly eventsSinceCalls: InvocationEventsSinceRequest[] = []
  readonly ackCalls: InvocationAckEventsRequest[] = []
  readonly inputCalls: unknown[] = []
  closed = false

  attachResponse!: BrokerAttachResponse
  snapshotResponse!: InvocationSnapshot
  private eventsSinceQueue: InvocationEventsSinceResponse[] = []
  eventsSinceConflict = false

  queueEventsSince(response: InvocationEventsSinceResponse): void {
    this.eventsSinceQueue.push(response)
  }

  // ── durability surface (Phase 1 contract) ────────────────────────────────
  async attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    this.calls.push('attach')
    this.attachCalls.push(req)
    return this.attachResponse
  }

  async snapshot(_req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    this.calls.push('snapshot')
    return this.snapshotResponse
  }

  async eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    this.calls.push('eventsSince')
    this.eventsSinceCalls.push(req)
    const next = this.eventsSinceQueue.shift()
    if (!next) {
      throw new Error('MockDurableBrokerClient: eventsSince called more times than scripted')
    }
    return next
  }

  async ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse> {
    this.calls.push('ackEvents')
    this.ackCalls.push(req)
    return { ackedThroughSeq: req.throughSeq }
  }

  async permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse> {
    this.calls.push('permissionRespond')
    return { status: 'accepted', permissionRequestId: req.permissionRequestId, decision: req.decision }
  }

  // ── base BrokerClientLike surface (should NOT be exercised by replay) ──────
  async hello(): Promise<BrokerHelloResponse> {
    this.calls.push('hello')
    throw new Error('MockDurableBrokerClient: hello must not be called during replay')
  }

  async health(): Promise<BrokerHealthResponse> {
    this.calls.push('health')
    return { status: 'ok', activeInvocations: 1, drivers: [] }
  }

  async startInvocationFromRequest(): Promise<never> {
    this.calls.push('start')
    throw new Error('MockDurableBrokerClient: startInvocationFromRequest must not be called during replay')
  }

  async input(req: unknown): Promise<InvocationInputResponse> {
    this.calls.push('input')
    this.inputCalls.push(req)
    return { inputId: inputId('input_live'), accepted: true, disposition: 'started' }
  }

  async interrupt(): Promise<InvocationInterruptResponse> {
    this.calls.push('interrupt')
    return { accepted: true, effect: 'turn_interrupted' }
  }

  async stop(): Promise<InvocationStopResponse> {
    this.calls.push('stop')
    return { accepted: true, state: 'stopping' }
  }

  async status(): Promise<InvocationStatusResponse> {
    this.calls.push('status')
    return { invocationId: INVOCATION_ID, state: 'ready' } as InvocationStatusResponse
  }

  async dispose(_req: InvocationDisposeRequest): Promise<void> {
    this.calls.push('dispose')
  }

  onPermissionRequest(): void {
    this.calls.push('onPermissionRequest')
  }

  onClose(): void {
    this.calls.push('onClose')
  }

  async close(): Promise<void> {
    this.calls.push('close')
    this.closed = true
  }
}

function emptySnapshot(overrides: Partial<InvocationSnapshot> = {}): InvocationSnapshot {
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
      continuation: { supported: true, provider: 'openai', keyKind: 'thread' },
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
    currentSeq: overrides.currentSeq ?? 0,
    retentionFloorSeq: overrides.retentionFloorSeq ?? 0,
    ...overrides,
  }
}

/** Real mapper wrapped in a thin counting spy to prove replay reuses apply(). */
function spyMapper(fix: SeededFixture): {
  mapper: Pick<BrokerEventMapper, 'apply'>
  appliedSeqs: () => number[]
} {
  const real = new BrokerEventMapper({ db: fix.db, now: () => ts(0) })
  const applied: number[] = []
  return {
    mapper: {
      apply(env: InvocationEventEnvelope) {
        applied.push(env.seq)
        return real.apply(env)
      },
    },
    appliedSeqs: () => applied,
  }
}

function makeController(
  fix: SeededFixture,
  mapper?: Pick<BrokerEventMapper, 'apply'>
): HarnessBrokerController {
  return new HarnessBrokerController({
    db: fix.db,
    ...(mapper ? { mapper } : {}),
    now: () => ts(0),
    serverInstanceId: SERVER_INSTANCE_ID,
  })
}

function lifecycleEventKinds(fix: SeededFixture): string[] {
  return fix.db.hrcEvents.listFromHrcSeq(1, { runtimeId: RUNTIME_ID }).map((e) => e.eventKind)
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Replay reuses event-mapper.apply() and is idempotent.
// ───────────────────────────────────────────────────────────────────────────
describe('T-01811 replay reuses the live event-mapper apply() path', () => {
  it('projects events returned by eventsSince() through apply() and replays idempotently', async () => {
    const spy = spyMapper(fixture)
    const controller = makeController(fixture, spy.mapper)

    // Non-terminal slice seq 1..8 (omit the seq-9 exit to avoid termination).
    const events = headlessSequence().slice(0, 8)
    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 8, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({ events, currentSeq: 8, retentionFloorSeq: 1 })

    const result = await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })

    expect(result.ok).toBe(true)
    expect(result.brokerAttached).toBe(true)

    // (a) Each replayed envelope went THROUGH the injected apply() spy, in order.
    expect(spy.appliedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    // (b) Projection landed: ledger rows applied, lifecycle stream populated.
    const ledger = fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    expect(ledger.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(ledger.every((e) => e.projectionStatus === 'applied')).toBe(true)
    expect(lifecycleEventKinds(fixture)).toContain('turn.completed')

    // (c) Ack only the max seq actually projected, only after projection.
    expect(client.ackCalls).toHaveLength(1)
    expect(client.ackCalls[0]?.throughSeq).toBe(8)
    expect(client.calls.indexOf('ackEvents')).toBeGreaterThan(client.calls.indexOf('eventsSince'))
    expect(result.ackedThroughSeq).toBe(8)

    // ── Replay the SAME events again: apply() is idempotent — one projection. ──
    const lifecycleCountBefore = lifecycleEventKinds(fixture).length
    client.queueEventsSince({ events, currentSeq: 8, retentionFloorSeq: 1 })
    const second = await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })

    expect(second.ok).toBe(true)
    // No duplicate ledger rows, no duplicate lifecycle events.
    expect(fixture.db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).map((e) => e.seq)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8]
    )
    expect(lifecycleEventKinds(fixture).length).toBe(lifecycleCountBefore)

    // Replay never re-launched or re-sent a prompt.
    expect(client.calls).not.toContain('start')
    expect(client.calls).not.toContain('input')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. High-water rule: afterSeq = last SUCCESSFULLY PROJECTED seq (NOT the row's
//    stored last_event_seq), and ack only the max seq actually projected.
// ───────────────────────────────────────────────────────────────────────────
describe('T-01811 high-water uses the last successfully PROJECTED broker seq', () => {
  it('asks eventsSince(afterSeq=lastProjected) ignoring a divergent stored last_event_seq, and acks max projected', async () => {
    // Pre-project seq 1..3 through the REAL mapper => ledger applied through 3.
    const seedMapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(0) })
    for (const e of headlessSequence().slice(0, 3)) {
      seedMapper.apply(e)
    }

    // Poison the in-memory/stored high-water with a value AHEAD of reality. The
    // controller must NOT trust this; it must derive afterSeq from the ledger.
    fixture.db.brokerInvocations.update(INVOCATION_ID, { lastEventSeq: 99, updatedAt: ts(0) })

    const spy = spyMapper(fixture)
    const controller = makeController(fixture, spy.mapper)

    const events = headlessSequence().slice(3, 6) // seq 4,5,6
    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 6, retentionFloorSeq: 4 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({ events, currentSeq: 6, retentionFloorSeq: 4 })

    const result = await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })

    expect(result.ok).toBe(true)
    // afterSeq is the last PROJECTED seq (3), never the poisoned stored 99.
    expect(client.eventsSinceCalls).toHaveLength(1)
    expect(client.eventsSinceCalls[0]?.afterSeq).toBe(3)
    // attach announces the same high-water to the broker.
    expect(client.attachCalls[0]?.lastProjectedSeq).toBe(3)

    // Only events 4,5,6 replayed; ack the max projected (6), not 99, not 3.
    expect(spy.appliedSeqs()).toEqual([4, 5, 6])
    expect(client.ackCalls[0]?.throughSeq).toBe(6)
    expect(result.ackedThroughSeq).toBe(6)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. Conflict fail-closed: an append conflict during replay => stale + close,
//    never brokerAttached / never ack.
// ───────────────────────────────────────────────────────────────────────────
describe('T-01811 replay-append conflict fails closed', () => {
  it('marks the runtime stale and closes the durable client before any live stream is healthy', async () => {
    // Pre-project seq 3 with the canonical payload.
    const seedMapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(0) })
    for (const e of headlessSequence().slice(0, 3)) {
      seedMapper.apply(e)
    }

    const spy = spyMapper(fixture)
    const controller = makeController(fixture, spy.mapper)

    // The broker replays seq 3 again but with a DIVERGENT payload => the
    // idempotent append throws BrokerInvocationEventConflictError.
    const divergentSeq3 = envelope(
      'input.accepted',
      3,
      { inputId: inputId('input_w3a_1'), tampered: true },
      { inputId: inputId('input_w3a_1') }
    )
    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 4, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({ events: [divergentSeq3], currentSeq: 4, retentionFloorSeq: 1 })

    const result = await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })

    expect(result.ok).toBe(false)
    expect(result.brokerAttached).toBe(false)
    expect(result.error).toBeInstanceOf(BrokerControllerError)
    // The underlying cause is the durable append conflict.
    expect(
      result.error instanceof BrokerControllerError &&
        JSON.stringify(result.error.detail ?? {}).includes('conflict')
    ).toBe(true)

    // Runtime is fenced stale, the client is closed, no ack ever happened.
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('stale')
    expect(client.closed).toBe(true)
    expect(client.calls).toContain('close')
    expect(client.calls).not.toContain('ackEvents')

    // brokerAttached false => a follow-up dispatch must NOT reach the broker.
    const dispatch = await controller.dispatchInput({
      runtimeId: RUNTIME_ID,
      input: { kind: 'user', content: [{ type: 'text', text: 'after conflict' }] },
    })
    expect(dispatch.ok).toBe(false)
    expect(dispatch.ok === false && dispatch.error.code).toBe('broker_runtime_not_active')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. Input-retry idempotency: snapshot.inputDispositions is honored — a prompt
//    the broker already accepted is not re-sent / re-projected.
// ───────────────────────────────────────────────────────────────────────────
describe('T-01811 honors snapshot.inputDispositions (no duplicate user prompt)', () => {
  it('reconciles an already-accepted input without re-sending it, and replay projects the prompt exactly once', async () => {
    // HRC dispatched a run with inputId 'input_retry_1' but lost the response.
    const RETRY_INPUT = inputId('input_retry_1')
    fixture.db.runs.update(RUN_ID, { dispatchedInputId: String(RETRY_INPUT), updatedAt: ts(0) })

    const spy = spyMapper(fixture)
    const controller = makeController(fixture, spy.mapper)

    const acceptedDisposition: InvocationInputResponse = {
      inputId: RETRY_INPUT,
      accepted: true,
      disposition: 'started',
    }
    const tid = turnId('turn_retry_1')
    const acceptedEvent = envelope('input.accepted', 10, { inputId: RETRY_INPUT }, { inputId: RETRY_INPUT })
    const turnStarted = envelope('turn.started', 11, { turnId: tid }, { turnId: tid })

    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({
      currentSeq: 11,
      retentionFloorSeq: 1,
      inputDispositions: { [String(RETRY_INPUT)]: acceptedDisposition },
      pendingInputIds: [],
    })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({ events: [acceptedEvent, turnStarted], currentSeq: 11, retentionFloorSeq: 1 })

    const result = await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })

    expect(result.ok).toBe(true)
    // The controller honored the disposition: it never re-sent the prompt.
    expect(client.calls).not.toContain('input')
    // The already-accepted inputId is surfaced so the HRC call site REUSES it
    // (rather than allocating a fresh inputId) on retry.
    expect(result.acceptedInputIds).toContain(String(RETRY_INPUT))

    // Exactly one turn.accepted lifecycle event for the reused inputId.
    const acceptedCount = lifecycleEventKinds(fixture).filter((k) => k === 'turn.accepted').length
    expect(acceptedCount).toBe(1)

    // A second replay of the SAME accepted event is idempotent — still one prompt.
    client.queueEventsSince({ events: [acceptedEvent, turnStarted], currentSeq: 11, retentionFloorSeq: 1 })
    await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })
    const acceptedCountAfter = lifecycleEventKinds(fixture).filter((k) => k === 'turn.accepted').length
    expect(acceptedCountAfter).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. Retention-floor gap: broker dropped events HRC never projected => UNSAFE,
//    conservative default = mark stale, do not attach.
// ───────────────────────────────────────────────────────────────────────────
describe('T-01811 retention-floor gap is unsafe (conservative stale)', () => {
  it('marks the runtime stale and does not attach when the broker floor is past the last projected seq + 1', async () => {
    // Pre-project seq 1..3 => HRC needs seq 4 next.
    const seedMapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(0) })
    for (const e of headlessSequence().slice(0, 3)) {
      seedMapper.apply(e)
    }

    const spy = spyMapper(fixture)
    const controller = makeController(fixture, spy.mapper)

    // Broker's earliest still-served seq is 6 — it already dropped 4 and 5, which
    // HRC never projected. That is an unrecoverable lifecycle gap.
    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 7, retentionFloorSeq: 6 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    // If the controller still asks for events, it gets the truncated tail.
    client.queueEventsSince({
      events: [envelope('turn.completed', 6, { turnId: turnId('turn_gap'), status: 'completed' })],
      currentSeq: 7,
      retentionFloorSeq: 6,
    })

    const result = await (controller as any).attachAndReplay({
      runtimeId: RUNTIME_ID,
      client,
      attachToken: ATTACH_TOKEN,
    })

    expect(result.ok).toBe(false)
    expect(result.brokerAttached).toBe(false)

    // Conservative: stale, client closed, nothing projected/acked, not attached.
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('stale')
    expect(client.closed).toBe(true)
    expect(client.calls).not.toContain('ackEvents')
    expect(spy.appliedSeqs()).toEqual([])

    const dispatch = await controller.dispatchInput({
      runtimeId: RUNTIME_ID,
      input: { kind: 'user', content: [{ type: 'text', text: 'after gap' }] },
    })
    expect(dispatch.ok).toBe(false)
    expect(dispatch.ok === false && dispatch.error.code).toBe('broker_runtime_not_active')
  })
})

// ── helpers ────────────────────────────────────────────────────────────────
function attachResponseFor(snapshot: InvocationSnapshot): BrokerAttachResponse {
  return {
    attached: true,
    brokerInstanceId: 'broker-instance-test',
    runtimeId: RUNTIME_ID,
    generation: 1,
    invocationId: INVOCATION_ID,
    activeControllerInstanceId: SERVER_INSTANCE_ID,
    currentSeq: snapshot.currentSeq,
    retentionFloorSeq: snapshot.retentionFloorSeq,
    snapshot,
  }
}
