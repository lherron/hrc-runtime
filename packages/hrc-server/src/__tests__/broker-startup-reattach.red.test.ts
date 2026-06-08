/**
 * RED acceptance tests for T-01813 (T-01801 Phase 4) — STARTUP RECONCILIATION
 * BROKER-IPC REATTACH (before the orphan sweep).
 *
 * Phase 2 (T-01811) landed `HarnessBrokerController.attachAndReplay` (attach /
 * snapshot / eventsSince / replay-through-mapper / ack / retention-gap +
 * conflict fail-closed). Phase 3 (T-01812) landed the named btmux broker+TUI
 * windows, `brokerUnixClientFactory` (connectUnix), and the persisted durable
 * identity in `runtime_state_json.broker` (endpoint.kind='unix-jsonrpc-ndjson',
 * brokerWindow, tuiWindow, generation, attachTokenRef).
 *
 * Phase 4 must add the STARTUP pass that, for every non-terminal
 * controllerKind='harness-broker' tmux runtime, BEFORE the orphan sweep:
 *   1. inspects the broker IPC socket + the broker/tui windows;
 *   2. if the broker socket is LIVE: connectUnix (brokerUnixClientFactory) →
 *      attachAndReplay → rebuild controller.active → brokerAttached=true;
 *   3. if the socket is GONE but the TUI window is live & its lease matches:
 *      control.mode='direct-tmux-degraded' (NOT healthy, NOT brokerAttached);
 *   4. if the user /quit while HRC was down: mark the runtime terminated;
 *   5. fenced / transport-close during replay or ack: NOT healthy, and
 *      brokerAttached must NEVER be left true on the runtime.
 *   ...and the reattach pass must run BEFORE the orphan sweep (a claimed btmux
 *   session must not be swept out from under a reattach).
 *
 * ── Expected production entry points (named for the implementer) ─────────────
 * In packages/hrc-server/src/startup-reconcile.ts:
 *
 *   export type BrokerReattachProbe = {
 *     brokerSocketLive: boolean
 *     brokerWindow: TmuxPaneState | null
 *     tuiWindow: TmuxPaneState | null
 *     userExited?: boolean
 *   }
 *   export type DurableBrokerReattachDeps = {
 *     controller: Pick<HarnessBrokerController, 'attachAndReplay'>
 *     brokerUnixClientFactory: BrokerUnixClientFactory
 *     resolveAttachToken: (runtime: HrcRuntimeSnapshot) => Promise<string | undefined>
 *     probeBrokerLease: (runtime: HrcRuntimeSnapshot) => Promise<BrokerReattachProbe>
 *   }
 *   export type BrokerReattachOutcome = {
 *     runtimeId: string
 *     state: 'broker-attached' | 'direct-tmux-degraded' | 'terminated' | 'stale'
 *     brokerAttached: boolean
 *     replayedThroughSeq?: number
 *     reason?: string
 *   }
 *   export function reconcileDurableBrokerRuntimeReattach(
 *     db, runtime, deps: DurableBrokerReattachDeps
 *   ): Promise<BrokerReattachOutcome>
 *
 *   export function reconcileDurableBrokerStartup(
 *     db, deps: DurableBrokerReattachDeps & { sweepOrphans: () => Promise<void> }
 *   ): Promise<BrokerReattachOutcome[]>     // iterates runtimes, reattach BEFORE sweepOrphans()
 *
 * These are RED NOW: those symbols are `undefined` on the module namespace, so
 * each test fails on "reconcile.reconcileDurableBroker… is not a function".
 *
 * Harness fidelity: real HRC SQLite + the REAL HarnessBrokerController +
 * BrokerEventMapper. The broker is a scripted MOCK DurableBrokerClientLike, and
 * tmux/socket probe results are scripted (NO live broker, NO live tmux).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
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

import { type DurableBrokerClientLike, HarnessBrokerController } from '../broker/controller'
import { extractRuntimeControlState } from '../broker/runtime-state'
import * as reconcile from '../startup-reconcile'
import type { TmuxPaneState } from '../tmux'

// ───────────────────────────────────────────────────────────────────────────
// Fixture constants — a tmux-transport harness-broker runtime with a durable
// (Unix IPC) broker endpoint persisted in runtime_state_json.broker.
// ───────────────────────────────────────────────────────────────────────────
const SERVER_INSTANCE_ID = 'hrc-server-reattach-test'
const ATTACH_TOKEN = 'attach-token-secret'

const HOST_SESSION_ID = 'hsid_reattach'
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01813'
const LANE_REF = 'main'
const GENERATION = 1
const RUNTIME_ID = 'runtime_reattach'
const OPERATION_ID = 'op_reattach'
const INVOCATION_ID = 'invocation_reattach' as InvocationId
const RUN_ID = 'run_reattach'

const BROKER_SOCKET = '/tmp/hrc-reattach/bipc/b.sock'
const LEASE_SOCKET = '/tmp/hrc-reattach/btmux/claude-code-tmux-runtime_reattach.sock'
const SESSION_NAME = 'hrc-claude-code-tmux-runtime_reattach'

const BROKER_WINDOW: TmuxPaneState = {
  socketPath: LEASE_SOCKET,
  sessionName: SESSION_NAME,
  windowName: 'broker',
  sessionId: '$1',
  windowId: '@10',
  paneId: '%10',
}
const TUI_WINDOW: TmuxPaneState = {
  socketPath: LEASE_SOCKET,
  sessionName: SESSION_NAME,
  windowName: 'tui',
  sessionId: '$1',
  windowId: '@11',
  paneId: '%11',
}

let dir: string
let dbPath: string
let db: HrcDatabase

function nowTs(): string {
  return '2026-06-01T00:00:00.000Z'
}

function seedDurableBrokerRuntime(
  overrides: {
    status?: string
    invocationState?: string
  } = {}
): void {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: overrides.status ?? 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    activeInvocationId: INVOCATION_ID,
    activeRunId: RUN_ID,
    tmuxJson: {
      socketPath: LEASE_SOCKET,
      sessionName: SESSION_NAME,
      windowName: 'tui',
      sessionId: TUI_WINDOW.sessionId,
      windowId: TUI_WINDOW.windowId,
      paneId: TUI_WINDOW.paneId,
      brokerDriver: 'claude-code-tmux',
    },
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: GENERATION,
      status: overrides.status ?? 'ready',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: SERVER_INSTANCE_ID,
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: BROKER_SOCKET,
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/hrc-reattach/bipc/attach.token',
            redacted: true,
          },
        },
        generation: GENERATION,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      },
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
    laneRef: LANE_REF,
    generation: GENERATION,
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
    invocationState: overrides.invocationState ?? 'ready',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec-reattach',
    startRequestHash: 'sha256:req-reattach',
    selectedProfileHash: 'sha256:prof-reattach',
    createdAt: now,
    updatedAt: now,
  })
}

function envelopeFor(
  type: InvocationEventEnvelope['type'],
  seq: number,
  payload: unknown,
  extra: Partial<InvocationEventEnvelope> = {}
): InvocationEventEnvelope {
  return {
    invocationId: INVOCATION_ID,
    seq,
    time: nowTs(),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

function readRuntime(): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!runtime) throw new Error('runtime vanished')
  return runtime
}

// ───────────────────────────────────────────────────────────────────────────
// Scripted durable broker client (same surface used by the Phase 2 tests).
// ───────────────────────────────────────────────────────────────────────────
class MockDurableBrokerClient implements DurableBrokerClientLike {
  readonly calls: string[] = []
  closed = false
  attachResponse!: BrokerAttachResponse
  snapshotResponse!: InvocationSnapshot
  private eventsSinceQueue: InvocationEventsSinceResponse[] = []
  attachThrows: Error | undefined
  eventsSinceThrows: Error | undefined

  queueEventsSince(response: InvocationEventsSinceResponse): void {
    this.eventsSinceQueue.push(response)
  }

  async attach(_req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    this.calls.push('attach')
    if (this.attachThrows) throw this.attachThrows
    return this.attachResponse
  }
  async snapshot(_req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    this.calls.push('snapshot')
    return this.snapshotResponse
  }
  async eventsSince(_req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    this.calls.push('eventsSince')
    if (this.eventsSinceThrows) throw this.eventsSinceThrows
    const next = this.eventsSinceQueue.shift()
    if (!next) throw new Error('eventsSince called more than scripted')
    return next
  }
  async ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse> {
    this.calls.push('ackEvents')
    return { ackedThroughSeq: req.throughSeq }
  }
  async permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse> {
    this.calls.push('permissionRespond')
    return {
      status: 'accepted',
      permissionRequestId: req.permissionRequestId,
      decision: req.decision,
    }
  }
  async hello(): Promise<BrokerHelloResponse> {
    this.calls.push('hello')
    throw new Error('hello must not be called during reattach')
  }
  async health(): Promise<BrokerHealthResponse> {
    this.calls.push('health')
    return { status: 'ok', activeInvocations: 1, drivers: [] }
  }
  async startInvocationFromRequest(): Promise<never> {
    this.calls.push('start')
    throw new Error('startInvocationFromRequest must not be called during reattach')
  }
  async input(): Promise<InvocationInputResponse> {
    this.calls.push('input')
    return {
      inputId: 'input_x' as InvocationInputResponse['inputId'],
      accepted: true,
      disposition: 'started',
    }
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
    currentSeq: overrides.currentSeq ?? 0,
    retentionFloorSeq: overrides.retentionFloorSeq ?? 0,
    ...overrides,
  }
}

function attachResponseFor(snapshot: InvocationSnapshot): BrokerAttachResponse {
  return {
    attached: true,
    brokerInstanceId: 'broker-instance-test',
    runtimeId: RUNTIME_ID,
    generation: GENERATION,
    invocationId: INVOCATION_ID,
    activeControllerInstanceId: SERVER_INSTANCE_ID,
    currentSeq: snapshot.currentSeq,
    retentionFloorSeq: snapshot.retentionFloorSeq,
    snapshot,
  }
}

function makeController(): HarnessBrokerController {
  return new HarnessBrokerController({
    db,
    now: () => nowTs(),
    serverInstanceId: SERVER_INSTANCE_ID,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-reattach-'))
  dbPath = join(dir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

// ───────────────────────────────────────────────────────────────────────────
// 1. Live broker socket => reattach (connectUnix → attachAndReplay → active
//    rebuilt → brokerAttached=true), and this runs BEFORE the orphan sweep.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4 reattach: live broker socket reattaches BEFORE the sweep', () => {
  it('connectUnix + attachAndReplay rebuilds controller.active and sets brokerAttached=true', async () => {
    seedDurableBrokerRuntime()
    const controller = makeController()

    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 4, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({
      events: [
        envelopeFor('invocation.started', 1, { pid: 1, command: 'claude', args: [], cwd: '/tmp' }),
        envelopeFor('invocation.ready', 2, { state: 'ready' }),
        envelopeFor(
          'input.accepted',
          3,
          { inputId: 'i1' },
          { inputId: 'i1' as InvocationEventEnvelope['inputId'] }
        ),
        envelopeFor(
          'turn.started',
          4,
          { turnId: 't1' },
          { turnId: 't1' as InvocationEventEnvelope['turnId'] }
        ),
      ],
      currentSeq: 4,
      retentionFloorSeq: 1,
    })

    const factoryCalls: Array<{ socketPath: string }> = []
    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller,
      brokerUnixClientFactory: async (opts) => {
        factoryCalls.push({ socketPath: opts.socketPath })
        return client
      },
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      }),
    })

    // (a) Dialed the persisted durable broker IPC socket (not the lease socket).
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.socketPath).toBe(BROKER_SOCKET)

    // (b) Replay actually projected into the durable ledger via attachAndReplay.
    expect(client.calls).toContain('attach')
    expect(client.calls).toContain('eventsSince')
    expect(client.calls).toContain('ackEvents')
    const ledger = db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID)
    expect(ledger.map((e) => e.seq)).toEqual([1, 2, 3, 4])

    // (c) Outcome + persisted control state report broker-attached.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(outcome.replayedThroughSeq).toBe(4)

    // (d) controller.active was rebuilt — a follow-up dispatch reaches the broker.
    const dispatch = await controller.dispatchInput({
      runtimeId: RUNTIME_ID,
      input: { kind: 'user', content: [{ type: 'text', text: 'after reattach' }] },
    })
    expect(dispatch.ok).toBe(true)
  })

  it('reconcileDurableBrokerStartup reattaches BEFORE invoking sweepOrphans()', async () => {
    seedDurableBrokerRuntime()
    const realController = makeController()

    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 1, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({
      events: [envelopeFor('invocation.ready', 1, { state: 'ready' })],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const order: string[] = []
    const controller = {
      attachAndReplay: async (input: Parameters<HarnessBrokerController['attachAndReplay']>[0]) => {
        order.push('attach')
        return realController.attachAndReplay(input)
      },
    }

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      controller,
      brokerUnixClientFactory: async () => client,
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      }),
      sweepOrphans: async () => {
        order.push('sweep')
      },
    })

    // The claimed btmux session was reattached BEFORE the orphan sweep ran.
    expect(order).toEqual(['attach', 'sweep'])
    expect(outcomes.map((o) => o.state)).toContain('broker-attached')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. Socket missing but TUI window live & lease matches => direct-tmux-degraded.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4 reattach: socket gone + TUI live => direct-tmux-degraded', () => {
  it('marks control.mode=direct-tmux-degraded, NOT healthy, NOT brokerAttached, and never dials', async () => {
    seedDurableBrokerRuntime()
    const controller = makeController()

    let dialed = false
    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller,
      brokerUnixClientFactory: async () => {
        dialed = true
        throw new Error('must not dial a dead broker socket')
      },
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: false,
        brokerWindow: null,
        tuiWindow: TUI_WINDOW,
      }),
    })

    expect(dialed).toBe(false)
    expect(outcome.state).toBe('direct-tmux-degraded')
    expect(outcome.brokerAttached).toBe(false)

    const control = extractRuntimeControlState(readRuntime().runtimeStateJson)
    expect(control?.mode).toBe('direct-tmux-degraded')
    expect(control?.brokerAttached).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. User /quit while HRC was down => reconcile marks the runtime terminated.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4 reattach: /quit while down => terminated', () => {
  it('terminates the runtime (no broker, no TUI, user-exited) so the next run is a fresh TUI', async () => {
    seedDurableBrokerRuntime()
    const controller = makeController()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller,
      brokerUnixClientFactory: async () => {
        throw new Error('must not dial: user already exited')
      },
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: false,
        brokerWindow: null,
        tuiWindow: null,
        userExited: true,
      }),
    })

    expect(outcome.state).toBe('terminated')
    expect(outcome.brokerAttached).toBe(false)
    expect(readRuntime().status).toBe('terminated')
    expect(db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.invocationState).toBe('exited')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. Fenced / transport-close during replay or ack => NOT healthy; the runtime
//    is never left brokerAttached=true.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4 reattach: fenced / transport-close during replay => not attached', () => {
  it('does not leave brokerAttached=true when eventsSince fails with a transport close', async () => {
    seedDurableBrokerRuntime()
    const controller = makeController()

    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 4, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.eventsSinceThrows = new Error('ControllerFenced: transport closed during replay')

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller,
      brokerUnixClientFactory: async () => client,
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      }),
    })

    expect(outcome.state).not.toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(false)

    // The persisted control state must NOT claim broker-attached after a fenced
    // replay, and the failing durable client must have been closed.
    const control = extractRuntimeControlState(readRuntime().runtimeStateJson)
    expect(control?.brokerAttached === true).toBe(false)
    expect(client.closed).toBe(true)

    // A follow-up dispatch must NOT reach the broker (active not rebuilt).
    const dispatch = await controller.dispatchInput({
      runtimeId: RUNTIME_ID,
      input: { kind: 'user', content: [{ type: 'text', text: 'after fence' }] },
    })
    expect(dispatch.ok).toBe(false)
    expect(dispatch.ok === false && dispatch.error.code).toBe('broker_runtime_not_active')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 7. Minimal surfacing (cody C-03100): after reconcile, brokerAttached + replay
//    outcome are observable on the persisted runtime state so manual smoke can
//    prove healthy-vs-degraded-vs-stale.
// ───────────────────────────────────────────────────────────────────────────
describe('Phase 4 minimal surfacing: brokerAttached + replay outcome observable', () => {
  it('persists control.brokerAttached + a replay high-water after a healthy reattach', async () => {
    seedDurableBrokerRuntime()
    const controller = makeController()

    const client = new MockDurableBrokerClient()
    client.snapshotResponse = emptySnapshot({ currentSeq: 2, retentionFloorSeq: 1 })
    client.attachResponse = attachResponseFor(client.snapshotResponse)
    client.queueEventsSince({
      events: [
        envelopeFor('invocation.started', 1, { pid: 1, command: 'claude', args: [], cwd: '/tmp' }),
        envelopeFor('invocation.ready', 2, { state: 'ready' }),
      ],
      currentSeq: 2,
      retentionFloorSeq: 1,
    })

    await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller,
      brokerUnixClientFactory: async () => client,
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: TUI_WINDOW,
      }),
    })

    const state = readRuntime().runtimeStateJson ?? {}
    const control = extractRuntimeControlState(state)
    expect(control?.brokerAttached).toBe(true)
    // Replay outcome surfaced for the operator (high-water of what replayed).
    const replay = state['brokerReplay'] as Record<string, unknown> | undefined
    expect(replay).toBeDefined()
    expect(replay?.['replayedThroughSeq']).toBe(2)
  })
})
