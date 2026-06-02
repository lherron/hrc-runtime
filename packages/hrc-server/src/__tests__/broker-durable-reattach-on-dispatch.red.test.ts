/**
 * RED→GREEN regression for T-01801 — INPUT-AFTER-REATTACH on the DISPATCH path.
 *
 * Gap proven by this suite: after a daemon restart the durable broker survives,
 * but the request-serving `HarnessBrokerController` is rebuilt fresh and holds NO
 * in-memory active client (startup reconciliation attaches on a SEPARATE,
 * throwaway controller — it runs before the server instance, hence the
 * request-serving controller, exists). The first interactive input therefore
 * fails `broker_runtime_not_active` and the dispatch handler falls back to legacy
 * pane-lease reassociation (which re-allocs / loses broker continuity).
 *
 * `reattachDurableBrokerForDispatch(db, runtime, { controller, brokerUnixClientFactory })`
 * closes the gap: it re-attaches the persisted durable endpoint onto the SAME
 * controller the handler dispatches through, so a retry reaches the SAME broker.
 *
 * Harness fidelity mirrors broker-startup-reattach.red.test.ts: real HRC SQLite +
 * the REAL HarnessBrokerController + a scripted mock durable broker client. No
 * live broker / tmux.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { HrcRuntimeSnapshot } from 'hrc-core'
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
import type { TmuxPaneState } from '../tmux'
import { reattachDurableBrokerForDispatch } from '../startup-reconcile'

const SERVER_INSTANCE_ID = 'hrc-server-reattach-dispatch-test'
const ATTACH_TOKEN = 'attach-token-secret'
const HOST_SESSION_ID = 'hsid_reattach'
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01801'
const LANE_REF = 'main'
const GENERATION = 1
const RUNTIME_ID = 'runtime_reattach'
const OPERATION_ID = 'op_reattach'
const INVOCATION_ID = 'invocation_reattach' as InvocationId
const RUN_ID = 'run_reattach'

const BROKER_SOCKET = '/tmp/hrc-reattach-dispatch/bipc/b.sock'
const LEASE_SOCKET = '/tmp/hrc-reattach-dispatch/btmux/claude-code-tmux-runtime_reattach.sock'
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
let db: HrcDatabase

function nowTs(): string {
  return '2026-06-01T00:00:00.000Z'
}

function seedDurableBrokerRuntime(opts: { durable?: boolean } = {}): void {
  const durable = opts.durable ?? true
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
    status: 'ready',
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
      status: 'ready',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: SERVER_INSTANCE_ID,
        // A non-durable (legacy pane-lease) broker persists NO unix endpoint.
        ...(durable
          ? {
              endpoint: {
                kind: 'unix-jsonrpc-ndjson',
                socketPath: BROKER_SOCKET,
                attachTokenRef: {
                  kind: 'file',
                  path: '/tmp/hrc-reattach-dispatch/bipc/attach.token',
                  redacted: true,
                },
              },
            }
          : {}),
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
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec-reattach',
    startRequestHash: 'sha256:req-reattach',
    selectedProfileHash: 'sha256:prof-reattach',
    createdAt: now,
    updatedAt: now,
  })
}

function readRuntime(): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!runtime) throw new Error('runtime vanished')
  return runtime
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

class MockDurableBrokerClient implements DurableBrokerClientLike {
  readonly calls: string[] = []
  closed = false
  attachResponse!: BrokerAttachResponse
  snapshotResponse!: InvocationSnapshot
  private eventsSinceQueue: InvocationEventsSinceResponse[] = []

  queueEventsSince(response: InvocationEventsSinceResponse): void {
    this.eventsSinceQueue.push(response)
  }
  async attach(_req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    this.calls.push('attach')
    return this.attachResponse
  }
  async snapshot(_req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    this.calls.push('snapshot')
    return this.snapshotResponse
  }
  async eventsSince(_req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    this.calls.push('eventsSince')
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
    return { status: 'accepted', permissionRequestId: req.permissionRequestId, decision: req.decision }
  }
  async hello(): Promise<BrokerHelloResponse> {
    throw new Error('hello must not be called during reattach')
  }
  async health(): Promise<BrokerHealthResponse> {
    return { status: 'ok', activeInvocations: 1, drivers: [] }
  }
  async startInvocationFromRequest(): Promise<never> {
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
    return { accepted: true, effect: 'turn_interrupted' }
  }
  async stop(): Promise<InvocationStopResponse> {
    return { accepted: true, state: 'stopping' }
  }
  async status(): Promise<InvocationStatusResponse> {
    return { invocationId: INVOCATION_ID, state: 'ready' } as InvocationStatusResponse
  }
  async dispose(_req: InvocationDisposeRequest): Promise<void> {
    this.calls.push('dispose')
  }
  onPermissionRequest(): void {}
  onClose(): void {}
  async close(): Promise<void> {
    this.closed = true
  }
}

function emptySnapshot(overrides: Partial<InvocationSnapshot> = {}): InvocationSnapshot {
  return {
    invocationId: INVOCATION_ID,
    state: 'ready',
    capabilities: {
      input: { user: true, steer: true, appendContext: true, localImages: true, fileRefs: true, queue: false },
      turns: { concurrency: 'single', interrupt: 'protocol' },
      continuation: { supported: true, provider: 'anthropic', keyKind: 'thread' },
      events: { assistantDeltas: true, toolCalls: true, usage: true, diagnostics: true, replay: true, ack: true },
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

function makeRequestServingController(): HarnessBrokerController {
  // Models the freshly-built request-serving controller post-restart: it has
  // NEVER attached this runtime, so `this.active` is empty.
  return new HarnessBrokerController({
    db,
    now: () => nowTs(),
    serverInstanceId: SERVER_INSTANCE_ID,
  })
}

function liveBrokerClient(): MockDurableBrokerClient {
  const client = new MockDurableBrokerClient()
  client.snapshotResponse = emptySnapshot({ currentSeq: 1, retentionFloorSeq: 1 })
  client.attachResponse = attachResponseFor(client.snapshotResponse)
  client.queueEventsSince({
    events: [envelopeFor('invocation.ready', 1, { state: 'ready' })],
    currentSeq: 1,
    retentionFloorSeq: 1,
  })
  return client
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-reattach-dispatch-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('T-01801 input-after-reattach: request-serving controller re-attaches on dispatch', () => {
  it('the GAP: a fresh request-serving controller cannot dispatch the survived durable runtime', async () => {
    seedDurableBrokerRuntime()
    const controller = makeRequestServingController()

    const dispatch = await controller.dispatchInput({
      runtimeId: RUNTIME_ID,
      input: { kind: 'user', content: [{ type: 'text', text: 'first input after restart' }] },
    })

    expect(dispatch.ok).toBe(false)
    expect(dispatch.ok === false && dispatch.error.code).toBe('broker_runtime_not_active')
  })

  it('the FIX: reattachDurableBrokerForDispatch re-attaches onto the SAME controller so the retry succeeds', async () => {
    seedDurableBrokerRuntime()
    const controller = makeRequestServingController()
    const client = liveBrokerClient()

    const factoryCalls: Array<{ socketPath: string }> = []
    const reattached = await reattachDurableBrokerForDispatch(db, readRuntime(), {
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

    expect(reattached).toBe(true)
    // Dialed the persisted durable broker IPC socket (not the tmux lease socket).
    expect(factoryCalls).toEqual([{ socketPath: BROKER_SOCKET }])
    expect(client.calls).toContain('attach')

    // The SAME controller the handler dispatches through now reaches the broker.
    const dispatch = await controller.dispatchInput({
      runtimeId: RUNTIME_ID,
      input: { kind: 'user', content: [{ type: 'text', text: 'after reattach' }] },
    })
    expect(dispatch.ok).toBe(true)
    expect(client.calls).toContain('input')
  })

  it('no-ops to false for a non-durable runtime so the caller falls back to legacy reassociation', async () => {
    seedDurableBrokerRuntime({ durable: false })
    const controller = makeRequestServingController()

    let dialed = false
    const reattached = await reattachDurableBrokerForDispatch(db, readRuntime(), {
      controller,
      brokerUnixClientFactory: async () => {
        dialed = true
        throw new Error('must not dial for a non-durable runtime')
      },
    })

    expect(reattached).toBe(false)
    expect(dialed).toBe(false)
  })
})
