/**
 * W3B green tests for HarnessBrokerController.
 *
 * These use a fake BrokerClient; no live broker process or route wiring is
 * involved. The controller remains inert unless W4 explicitly calls it behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import { BrokerTransportError } from 'spaces-harness-broker-client'
import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInspectionSummary,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationLifecycleView,
  InvocationLivenessView,
  InvocationRuntimeContext,
  InvocationSnapshot,
  InvocationSnapshotRequest,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CapabilityRequirements,
  CompiledRuntimePlan,
} from 'spaces-runtime-contracts'

import {
  type BrokerClientLike,
  BrokerControllerError,
  HarnessBrokerController,
} from '../broker/controller'

import {
  makeBrokerProfile,
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'
import { envelope } from './broker-event-mapper-fixtures'

const NOW = '2026-05-27T12:34:56.000Z'

type TestFixture = {
  db: HrcDatabase
  dir: string
  cleanup: () => Promise<void>
}

class PushableEvents implements AsyncIterable<InvocationEventEnvelope> {
  private queue: InvocationEventEnvelope[] = []
  private waiters: Array<(result: IteratorResult<InvocationEventEnvelope>) => void> = []
  private closed = false

  push(event: InvocationEventEnvelope): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value: event })
      return
    }
    this.queue.push(event)
  }

  next(): Promise<IteratorResult<InvocationEventEnvelope>> {
    const event = this.queue.shift()
    if (event) {
      return Promise.resolve({ done: false, value: event })
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<InvocationEventEnvelope> {
    return this
  }
}

class FakeBrokerClient implements BrokerClientLike {
  readonly events = new PushableEvents()
  readonly callOrder: string[] = []
  readonly startCalls: Array<{
    request: InvocationStartRequest
    dispatchEnv?: Record<string, string> | undefined
    runtime?: InvocationRuntimeContext | undefined
  }> = []
  readonly healthCalls: BrokerHealthRequest[] = []
  readonly statusCalls: InvocationStatusRequest[] = []
  readonly listInvocationsCalls: BrokerListInvocationsRequest[] = []
  readonly snapshotCalls: InvocationSnapshotRequest[] = []
  emitCloseOnClose = false
  permissionHandler?: (request: PermissionRequestParams) => Promise<PermissionDecision>
  private closeHandler?: (error: Error) => void

  helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
    // T-01866 — HRC negotiates harness-broker/0.2 only. This fake serves both the
    // stdio (pre-created/interactive) and unix (durable headless) routes, so it
    // advertises both transports + attachReplay.
    protocolVersion: 'harness-broker/0.2',
    capabilities: {
      multiInvocation: false,
      transports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
      attachReplay: true,
    },
    drivers: [
      {
        kind: 'codex-app-server',
        version: '0.1.1-test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ],
  }

  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_w2',
    state: 'ready',
    capabilities: invocationCapabilities(),
  }

  statusResponse: InvocationStatusResponse = {
    invocationId: 'invocation_w2',
    state: 'ready',
    capabilities: invocationCapabilities(),
  }

  listInvocationsResponse: BrokerListInvocationsResponse = { invocations: [] }

  snapshotResponse: InvocationSnapshot = {
    invocationId: 'invocation_w2' as InvocationSnapshot['invocationId'],
    state: 'ready',
    capabilities: invocationCapabilities(),
    pendingInputIds: [],
    inputDispositions: {},
    pendingPermissionRequests: [],
    currentSeq: 0,
    retentionFloorSeq: 0,
  }

  healthResponse: BrokerHealthResponse = {
    status: 'ok',
    activeInvocations: 1,
    drivers: this.helloResponse.drivers,
  }

  onPermissionRequest(
    handler: (request: PermissionRequestParams) => Promise<PermissionDecision>
  ): void {
    this.callOrder.push('permission')
    this.permissionHandler = handler
  }

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler
  }

  async hello(_req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    this.callOrder.push('hello')
    return this.helloResponse
  }

  async health(req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    this.callOrder.push('health')
    this.healthCalls.push(req)
    return this.healthResponse
  }

  async startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnv?: Record<string, string>,
    runtime?: InvocationRuntimeContext
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }> {
    this.callOrder.push('start')
    this.startCalls.push({ request, dispatchEnv, runtime })
    return {
      invocationId: this.startResponse.invocationId,
      response: this.startResponse,
      events: this.events,
    }
  }

  async input(_req: InvocationInputRequest): Promise<InvocationInputResponse> {
    this.callOrder.push('input')
    return { inputId: 'input_later', accepted: true, disposition: 'started' }
  }

  async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
    this.callOrder.push('interrupt')
    return { accepted: true, effect: 'turn_interrupted' }
  }

  async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
    this.callOrder.push('stop')
    return { accepted: true, state: 'stopping' }
  }

  async status(req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
    this.callOrder.push('status')
    this.statusCalls.push(req)
    return this.statusResponse
  }

  async listInvocations(
    req: BrokerListInvocationsRequest = {}
  ): Promise<BrokerListInvocationsResponse> {
    this.callOrder.push('listInvocations')
    this.listInvocationsCalls.push(req)
    return this.listInvocationsResponse
  }

  async snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    this.callOrder.push('snapshot')
    this.snapshotCalls.push(req)
    return this.snapshotResponse
  }

  async dispose(): Promise<void> {
    this.callOrder.push('dispose')
    this.events.close()
  }

  async close(): Promise<void> {
    this.callOrder.push('close')
    this.events.close()
    if (this.emitCloseOnClose) {
      this.emitClose(new Error('Broker process closed with signal SIGTERM'))
    }
  }

  emitClose(error: Error): void {
    this.closeHandler?.(error)
  }
}

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('HarnessBrokerController', () => {
  it('negotiates hello, persists the broker graph, and starts with the frozen request plus dispatch env', async () => {
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })

    const result = await controller.start({ ...input, brokerClient: fake })

    expect(result.ok).toBe(true)
    expect(fake.callOrder.slice(0, 3)).toEqual(['permission', 'hello', 'start'])
    expect(fake.startCalls[0]?.request).toBe(input.startRequest)
    expect(fake.startCalls[0]?.dispatchEnv).toEqual({ HRC_DISPATCH: 'yes' })
    expect(fixture.db.compiledRuntimePlans.getByPlanHash('planhash_w2')).not.toBeNull()
    expect(fixture.db.runtimeOperations.getByOperationId('runtimeOperation_w2')?.status).toBe(
      'completed'
    )
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.controllerKind).toBe('harness-broker')
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.invocationState).toBe(
      'ready'
    )
    expect(fixture.db.runs.getByRunId('run_w2')?.status).toBe('accepted')
  })

  it('allocates and persists an HRC-owned tmux socket on interactive broker-tmux dispatch', async () => {
    const fake = new FakeBrokerClient()
    const identity = makeIdentity({
      runtimeId: 'runtime_tmux',
      invocationId: 'invocation_tmux',
      runId: 'run_tmux',
    })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
    fake.helloResponse.drivers = [
      {
        kind: 'claude-code-tmux',
        version: '0.1.1-test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ]
    fake.startResponse = {
      ...fake.startResponse,
      invocationId: 'invocation_tmux',
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      tmuxAllocator: {
        async allocate() {
          return {
            socketPath: '/tmp/hrc-runtime/claude-code-tmux/runtime_tmux/tmux.sock',
            allocatedAt: NOW,
          }
        },
      },
      now: () => NOW,
    })

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: { HRC_DISPATCH: 'yes' },
    })

    expect(result.ok).toBe(true)
    expect(fake.startCalls[0]?.request).toBe(startRequest)
    expect(
      (fake.startCalls[0]?.request as unknown as { runtime?: unknown }).runtime
    ).toBeUndefined()
    expect(fake.startCalls[0]?.runtime).toEqual({
      tmux: { socketPath: '/tmp/hrc-runtime/claude-code-tmux/runtime_tmux/tmux.sock' },
    })
    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_tmux')
    expect(runtime?.transport).toBe('tmux')
    expect(runtime?.tmuxJson).toEqual({
      kind: 'broker-tmux-allocation',
      brokerDriver: 'claude-code-tmux',
      socketPath: '/tmp/hrc-runtime/claude-code-tmux/runtime_tmux/tmux.sock',
      allocatedAt: NOW,
      generation: 1,
    })
    expect(runtime?.runtimeStateJson?.['tmux']).toEqual({
      brokerDriver: 'claude-code-tmux',
      socketPath: '/tmp/hrc-runtime/claude-code-tmux/runtime_tmux/tmux.sock',
      allocatedAt: NOW,
      generation: 1,
    })
  })

  // T-02009 — durable-broker Unix dial boot race. The leased-tmux/headless
  // allocator launches the broker window and returns the IPC socket path BEFORE
  // the broker has bound its listener, so the very next connectUnix dial can fail
  // ENOENT/ECONNREFUSED. The controller retries socket-not-ready failures instead
  // of aborting the whole start as broker_start_failed.
  it('retries the durable broker unix dial when the socket is not listening yet', async () => {
    const fake = new FakeBrokerClient()
    let attempts = 0
    const controller = new HarnessBrokerController({
      db: fixture.db,
      // Headless codex profile (makeStartInput) with NO injected substrate
      // allocator → the controller synthesizes a durable allocation carrying a
      // brokerIpcSocketPath and dials it via brokerUnixClientFactory.
      brokerUnixClientFactory: async () => {
        attempts++
        if (attempts < 3) {
          throw new BrokerTransportError(
            'Failed to connect to broker unix socket',
            Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
          )
        }
        return fake
      },
      now: () => NOW,
    })

    const result = await controller.start(makeStartInput())

    expect(result.ok).toBe(true)
    expect(attempts).toBe(3)
  })

  it('does NOT retry a non-socket-ready durable dial failure (fails closed once)', async () => {
    let attempts = 0
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerUnixClientFactory: async () => {
        attempts++
        // EACCES is a real permission failure, not a boot race — retrying it
        // would just burn the budget. The controller must fail closed at once.
        throw new BrokerTransportError(
          'Failed to connect to broker unix socket',
          Object.assign(new Error('connect EACCES'), { code: 'EACCES' })
        )
      },
      now: () => NOW,
    })

    const result = await controller.start(makeStartInput())

    expect(result.ok).toBe(false)
    expect(attempts).toBe(1)
    if (!result.ok) {
      expect(result.error.code).toBe('broker_start_failed')
    }
  })

  it('pauses attached broker-tmux launch before invocation.start until resumed', async () => {
    const fake = new FakeBrokerClient()
    const identity = makeIdentity({
      runtimeId: 'runtime_attach_first',
      invocationId: 'invocation_attach_first',
      runId: 'run_attach_first',
    })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
    fake.helloResponse.drivers = [
      {
        kind: 'claude-code-tmux',
        version: '0.1.1-test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ]
    fake.startResponse = {
      ...fake.startResponse,
      invocationId: 'invocation_attach_first',
    }
    const lease = {
      kind: 'tmux-pane' as const,
      ownership: 'hrc' as const,
      socketPath: '/tmp/hrc-runtime/btmux/claude-code-tmux-runtime_attach_first.sock',
      sessionId: '$1',
      windowId: '@2',
      paneId: '%3',
      sessionName: 'hrc-claude-code-tmux-runtime_attach_first',
      windowName: 'tui',
      allowedOps: {
        inspect: true as const,
        sendInput: true as const,
        sendInterrupt: true as const,
        capture: true,
        resize: false,
      },
    }
    const waitOrder: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      tmuxAllocator: {
        async allocate() {
          return {
            socketPath: lease.socketPath,
            allocatedAt: NOW,
            generation: 1,
            lease,
          }
        },
      },
      waitForAttachedTerminal: async ({ runtime, allocation }) => {
        waitOrder.push(`${runtime.runtimeId}:${allocation.lease?.windowName}`)
      },
      now: () => NOW,
    })

    const startPromise = controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: { HRC_DISPATCH: 'yes' },
      attachBeforeInvocationStart: { pendingStartId: 'pending-attach-first' },
    })

    const ready = await controller.waitForAttachedStartReady('pending-attach-first')
    expect(ready.runtime.runtimeId).toBe('runtime_attach_first')
    expect(ready.runtime.tmuxJson?.['windowName']).toBe('tui')
    expect(fake.startCalls).toHaveLength(0)
    expect(fake.callOrder).toEqual(['permission', 'hello'])

    const resumed = controller.resumeAttachedStart('pending-attach-first')
    expect(resumed.ok).toBe(true)
    const result = await startPromise

    expect(result.ok).toBe(true)
    expect(waitOrder).toEqual(['runtime_attach_first:tui'])
    expect(fake.callOrder).toEqual(['permission', 'hello', 'start'])
    expect(fake.startCalls[0]?.runtime).toEqual({ terminalSurface: lease })
  })

  it('delegates ordered broker events to the mapper without interpreting payloads', async () => {
    const fake = new FakeBrokerClient()
    const seen: InvocationEventEnvelope[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      mapper: {
        apply(envelope) {
          seen.push(envelope)
          return { idempotent: false, events: [] }
        },
      },
      now: () => NOW,
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)
    const event = envelope(
      'diagnostic',
      42,
      {
        level: 'warn',
        message: 'opaque payload marker',
        data: { nested: ['left untouched'] },
      },
      { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
    )

    fake.events.push(event)
    await tick()

    expect(seen).toEqual([event])
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.lastEventSeq).toBe(42)
  })

  it('drops broker events whose invocationId belongs to a different runtime', async () => {
    const fake = new FakeBrokerClient()
    const seen: InvocationEventEnvelope[] = []
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      mapper: {
        apply(envelope) {
          seen.push(envelope)
          return { idempotent: false, events: [] }
        },
      },
      now: () => NOW,
      logger: {
        warn(message, fields) {
          warnings.push({ message, fields })
        },
      },
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)
    fixture.db.brokerInvocations.insert({
      invocationId: 'invocation_foreign',
      operationId: 'operation_foreign',
      runtimeId: 'runtime_foreign',
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({}),
      specHash: 'sha256:spec-foreign',
      startRequestHash: 'sha256:req-foreign',
      selectedProfileHash: 'sha256:profile-foreign',
      createdAt: NOW,
      updatedAt: NOW,
    })

    fake.events.push(
      envelope(
        'diagnostic',
        43,
        {
          level: 'info',
          message: 'foreign payload marker',
        },
        { invocationId: 'invocation_foreign' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    expect(seen).toEqual([])
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_foreign')?.lastEventSeq).toBe(
      undefined
    )
    expect(warnings).toEqual([
      {
        message: 'dropped broker event for non-consuming runtime',
        fields: {
          runtimeId: 'runtime_w2',
          invocationId: 'invocation_foreign',
          invocationRuntimeId: 'runtime_foreign',
          eventType: 'diagnostic',
          seq: 43,
        },
      },
    ])
  })

  it('marks a runtime stale when its active broker invocation exits', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      reapBrokerTmuxLease: async (runtimeId) => {
        reaped.push(runtimeId)
      },
      now: () => NOW,
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    fake.events.push(
      envelope(
        'invocation.exited',
        9,
        { exitCode: 0, signal: null },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    await tick()

    // A NON-user terminal (no preceding user /quit) must preserve durability: the
    // lease must NOT be reaped so the broker survives for reattach.
    expect(reaped).toEqual([])

    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_w2')
    expect(runtime?.status).toBe('stale')
    expect(runtime?.activeRunId).toBeUndefined()
    expect(runtime?.runtimeStateJson?.['terminalInvocation']).toEqual({
      invocationId: 'invocation_w2',
      eventType: 'invocation.exited',
      seq: 9,
    })
    expect(fixture.db.runs.getByRunId('run_w2')?.status).toBe('failed')
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.invocationState).toBe(
      'exited'
    )
    expect(
      fixture.db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
        .some((event) => event.eventKind === 'runtime.stale')
    ).toBe(true)
    expect(fake.callOrder).toContain('close')
  })

  it('marks a runtime terminated when a user-ended continuation exits', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      reapBrokerTmuxLease: async (runtimeId) => {
        reaped.push(runtimeId)
      },
      now: () => NOW,
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    fake.events.push(
      envelope(
        'continuation.cleared',
        8,
        { reason: 'prompt_input_exit' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    fake.events.push(
      envelope(
        'invocation.exited',
        9,
        { exitCode: 0, signal: null },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    await tick()

    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_w2')
    expect(runtime?.status).toBe('terminated')
    expect(runtime?.runtimeStateJson?.['terminalReason']).toBe('user_initiated_session_end')
    expect(runtime?.runtimeStateJson?.['userExitReason']).toBe('prompt_input_exit')
    expect(runtime?.runtimeStateJson?.['terminalInvocation']).toEqual({
      invocationId: 'invocation_w2',
      eventType: 'invocation.exited',
      seq: 9,
    })

    const runtimeEvents = fixture.db.hrcEvents.listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
    expect(runtimeEvents.some((event) => event.eventKind === 'runtime.terminated')).toBe(true)
    expect(runtimeEvents.some((event) => event.eventKind === 'runtime.stale')).toBe(false)
    expect(fake.callOrder).toContain('close')
    // Lever 2: a user-initiated /quit reaps the broker-tmux lease so the durable
    // broker process exits instead of stranding the operator on a live pane.
    expect(reaped).toEqual(['runtime_w2'])
  })

  it('default-denies and persists permission decisions when no request channel exists', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    const decision = await fake.permissionHandler?.({
      invocationId: 'invocation_w2',
      permissionRequestId: 'perm_default_deny',
      kind: 'command',
      subject: { command: 'rm -rf /tmp/nope' },
      defaultDecision: 'allow',
    })

    expect(decision).toEqual({
      decision: 'deny',
      message: 'Denied by HRC policy: no permission request channel is configured.',
    })

    const row = fixture.db.permissionDecisions.getByPermissionRequestId('perm_default_deny')
    expect(row?.decision).toBe('deny')
    expect(row?.decidedBy).toBe('policy')
    expect(row?.runtimeId).toBe('runtime_w2')

    fake.events.push(
      envelope(
        'permission.resolved',
        2,
        {
          permissionRequestId: 'perm_default_deny',
          decision: 'deny',
          decidedBy: 'policy',
        },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    expect(fixture.db.permissionDecisions.listByInvocationId('invocation_w2')).toHaveLength(1)
  })

  it('uses broker.health in status/reconcile probes', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })

    const status = await controller.status('runtime_w2')
    const reconcile = await controller.reconcile('runtime_w2')

    expect(status.ok).toBe(true)
    expect(reconcile.state).toBe('healthy')
    expect(fake.healthCalls).toEqual([{ probeDrivers: true }, { probeDrivers: true }])
  })

  it('treats broker close/crash as terminal and logs the stderr-bearing error', async () => {
    const fake = new FakeBrokerClient()
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      logger: {
        error(message, fields) {
          errors.push({ message, fields })
        },
      },
    })

    await controller.start({ ...makeStartInput(), brokerClient: fake })
    fake.emitClose(
      new Error('Broker process exited with exit code 1\nBroker stderr:\nstderr marker W3B')
    )

    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('terminated')
    expect(fixture.db.runs.getByRunId('run_w2')?.status).toBe('failed')
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.invocationState).toBe(
      'failed'
    )
    expect(errors.some((entry) => JSON.stringify(entry).includes('stderr marker W3B'))).toBe(true)
    const brokerClosed = fixture.db.events
      .listFromSeq(1, { runtimeId: 'runtime_w2' })
      .find((event) => event.eventKind === 'broker.process.closed')
    expect(brokerClosed).toBeDefined()
  })

  it('reaps the lease (no crash-terminal) when the broker closes after a user /quit', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const errors: Array<{ message: string }> = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      reapBrokerTmuxLease: async (runtimeId) => {
        reaped.push(runtimeId)
      },
      now: () => NOW,
      logger: {
        error(message) {
          errors.push({ message })
        },
      },
    })

    await controller.start({ ...makeStartInput(), brokerClient: fake })

    // The operator typed /quit: the broker emits a user-initiated continuation
    // clear, then (the real interactive path) its IPC socket drops — surfacing as
    // a non-intentional broker close rather than a clean invocation.exited.
    fake.events.push(
      envelope(
        'continuation.cleared',
        8,
        { reason: 'prompt_input_exit' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    fake.emitClose(new Error('Broker socket closed unexpectedly'))
    await tick()

    // A graceful user exit reaps the lease exactly once (deduped across the
    // continuation-clear and broker-close signals) and must NOT be recorded as a
    // crash-terminal.
    expect(reaped).toEqual(['runtime_w2'])
    expect(errors.some((entry) => entry.message.includes('harness broker process closed'))).toBe(
      false
    )
    const crashEvent = fixture.db.events
      .listFromSeq(1, { runtimeId: 'runtime_w2' })
      .find((event) => event.eventKind === 'broker.process.closed')
    expect(crashEvent).toBeUndefined()
  })

  it('does NOT reap the lease on a /clear continuation clear (session keeps running)', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      reapBrokerTmuxLease: async (runtimeId) => {
        reaped.push(runtimeId)
      },
      now: () => NOW,
    })

    await controller.start({ ...makeStartInput(), brokerClient: fake })

    // `/clear` wipes context but keeps the harness running — it must NOT tear the
    // lease down, even though `clear` is a user-initiated continuation-clear reason.
    fake.events.push(
      envelope(
        'continuation.cleared',
        8,
        { reason: 'clear' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    await tick()

    expect(reaped).toEqual([])
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).not.toBe('terminated')
  })

  it('admits raw queue-capable codex drivers and validates queue on effective start caps', async () => {
    const fake = new FakeBrokerClient()
    const rawCaps = invocationCapabilities()
    rawCaps.input.queue = true
    const effectiveCaps = invocationCapabilities()
    effectiveCaps.input.queue = false
    fake.helloResponse.drivers = [
      {
        kind: 'codex-app-server',
        version: '0.1.2-test',
        available: true,
        capabilities: rawCaps,
      },
    ]
    fake.startResponse = {
      ...fake.startResponse,
      capabilities: effectiveCaps,
    }
    const input = makeStartInput()
    input.profile.expectedCapabilities = capabilityRequirements({ queue: 'forbidden' })
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const result = await controller.start({ ...input, brokerClient: fake })

    expect(result.ok).toBe(true)
    expect(fake.callOrder).toContain('start')
    expect(fixture.db.runtimeOperations.getByOperationId('runtimeOperation_w2')?.status).toBe(
      'completed'
    )
  })

  it('fails closed after start when effective invocation caps violate the profile', async () => {
    const fake = new FakeBrokerClient()
    const rawCaps = invocationCapabilities()
    rawCaps.input.queue = true
    const effectiveCaps = invocationCapabilities()
    effectiveCaps.input.queue = true
    fake.helloResponse.drivers = [
      {
        kind: 'codex-app-server',
        version: '0.1.2-test',
        available: true,
        capabilities: rawCaps,
      },
    ]
    fake.startResponse = {
      ...fake.startResponse,
      capabilities: effectiveCaps,
    }
    const input = makeStartInput()
    input.profile.expectedCapabilities = capabilityRequirements({ queue: 'forbidden' })
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const result = await controller.start({ ...input, brokerClient: fake })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('broker_invocation_admission_rejected')
      expect(result.error.detail['missing']).toEqual(['input.queue.forbidden'])
      expect(result.error.detail['effectiveCapabilities']).toEqual(effectiveCaps)
    }
    expect(fake.callOrder).toContain('start')
    expect(fake.callOrder).toContain('dispose')
    expect(fake.callOrder).toContain('close')
    expect(fixture.db.compiledRuntimePlans.getByPlanHash('planhash_w2')).not.toBeNull()
    expect(fixture.db.runtimeOperations.getByOperationId('runtimeOperation_w2')?.status).toBe(
      'failed'
    )
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('failed')
    expect(fixture.db.runs.getByRunId('run_w2')?.status).toBe('failed')
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.invocationState).toBe(
      'failed'
    )
  })

  // ── T-01855 reds: inspection read model + capability negotiation ─────────────
  //
  // These tests are intentionally RED: controller.listInvocations / the
  // extended controller.status(runtimeId, {probeLiveness}) / capability-gating
  // do not exist yet. They go green when the implementation in
  // packages/hrc-server/src/broker/controller.ts lands.

  describe('inspection read model — listInvocations', () => {
    it('returns InvocationInspectionSummary[] from the broker client', async () => {
      const fake = new FakeBrokerClient()
      // Broker advertises listInvocations so the controller serves it over the wire.
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const summary: InvocationInspectionSummary = {
        invocationId: 'invocation_w2' as InvocationInspectionSummary['invocationId'],
        state: 'ready',
        driver: 'codex-app-server',
        startedAt: NOW,
        lastActivityAt: NOW,
      }
      fake.listInvocationsResponse = { invocations: [summary] }

      // RED: controller.listInvocations does not exist yet
      const result = await (controller as any).listInvocations('runtime_w2')

      expect(result).toEqual([summary])
      expect(fake.listInvocationsCalls).toHaveLength(1)
    })

    it('does NOT mutate runtime or session DB state', async () => {
      const fake = new FakeBrokerClient()
      // Advertise listInvocations so the no-mutation guard exercises a real
      // broker round-trip rather than the older-broker degrade path.
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const runtimeBefore = fixture.db.runtimes.getByRuntimeId('runtime_w2')
      const sessionBefore = fixture.db.sessions.getByHostSessionId('hostSession_w2')
      const invocationBefore = fixture.db.brokerInvocations.getByInvocationId('invocation_w2')

      fake.listInvocationsResponse = { invocations: [] }

      // RED: controller.listInvocations does not exist yet
      await (controller as any).listInvocations('runtime_w2')

      // DB state must be byte-for-byte identical after the read-only call
      expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')).toEqual(runtimeBefore)
      expect(fixture.db.sessions.getByHostSessionId('hostSession_w2')).toEqual(sessionBefore)
      expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')).toEqual(
        invocationBefore
      )
    })

    it('returns an error (not throws) when the runtime is not active', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })

      // No start() — 'runtime_w2' is not active
      // RED: controller.listInvocations does not exist yet
      const result = await (controller as any).listInvocations('runtime_w2')

      expect(result.ok).toBe(false)
      expect(result.error).toBeInstanceOf(BrokerControllerError)
    })

    it('older broker (no inspection block): degrades cleanly without throwing and returns empty', async () => {
      const fake = new FakeBrokerClient()
      // Default helloResponse has NO inspection field → behaves like an older broker
      expect((fake.helloResponse.capabilities as any).inspection).toBeUndefined()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet;
      // when implemented: must return [] without calling fake.listInvocations
      const result = await (controller as any).listInvocations('runtime_w2')

      expect(Array.isArray(result)).toBe(true)
      // Broker must NOT be called when inspection is not advertised
      expect(fake.listInvocationsCalls).toHaveLength(0)
    })
  })

  describe('inspection read model — status with probeLiveness', () => {
    it('plumbs probeLiveness: true into client.status() and returns extended summary fields', async () => {
      const fake = new FakeBrokerClient()
      const lifecycle: InvocationLifecycleView = {
        retention: { mode: 'keep-alive' },
        harnessRecovery: { mode: 'restart' },
        turnRetry: { mode: 'none' },
      }
      const liveness: InvocationLivenessView = {
        mode: 'probe',
        checkedAt: NOW,
        driver: { state: 'healthy' },
      }
      fake.statusResponse = {
        ...fake.statusResponse,
        lifecycle,
        liveness,
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.status currently ignores extra args;
      // when implemented: must forward probeLiveness to client.status()
      const result = await (controller as any).status('runtime_w2', { probeLiveness: true })

      expect(result.ok).toBe(true)
      // The broker client must have received probeLiveness: true
      const statusCall = fake.statusCalls.find((c) => c.probeLiveness === true)
      expect(statusCall).toBeDefined()
      expect(statusCall?.probeLiveness).toBe(true)
      // The response must carry the extended InvocationInspectionSummary fields
      expect(result.response.invocation?.lifecycle).toEqual(lifecycle)
      expect(result.response.invocation?.liveness).toEqual(liveness)
    })

    it('does NOT forward probeLiveness when called without the option', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      await controller.status('runtime_w2')

      // probeLiveness must be absent/falsy when not requested
      expect(fake.statusCalls.every((c) => !c.probeLiveness)).toBe(true)
    })
  })

  describe('inspection read model — snapshot', () => {
    it('returns InvocationSnapshot via a direct client.snapshot() call', async () => {
      const fake = new FakeBrokerClient()
      const lifecycle: InvocationLifecycleView = {
        retention: { mode: 'keep-alive' },
        harnessRecovery: { mode: 'restart' },
        turnRetry: { mode: 'none' },
      }
      fake.snapshotResponse = {
        ...fake.snapshotResponse,
        lifecycle,
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.snapshot does not exist yet
      const result = await (controller as any).snapshot('runtime_w2')

      expect(result.ok).toBe(true)
      expect(result.response.lifecycle).toEqual(lifecycle)
      // Must have called snapshot exactly once with the right invocationId
      expect(fake.snapshotCalls).toHaveLength(1)
      expect(fake.snapshotCalls[0]?.invocationId).toBe('invocation_w2')
    })

    it('snapshot does NOT call eventsSince or ackEvents (direct read, no replay)', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.snapshot does not exist yet;
      // when implemented: must be a direct snapshot() only — no replay machinery
      await (controller as any).snapshot('runtime_w2')

      expect(fake.callOrder).not.toContain('eventsSince')
      expect(fake.callOrder).not.toContain('ackEvents')
      expect(fake.callOrder).toContain('snapshot')
    })

    it('snapshot does NOT mutate runtime or session DB state', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const runtimeBefore = fixture.db.runtimes.getByRuntimeId('runtime_w2')
      const sessionBefore = fixture.db.sessions.getByHostSessionId('hostSession_w2')
      const invocationBefore = fixture.db.brokerInvocations.getByInvocationId('invocation_w2')

      // RED: controller.snapshot does not exist yet
      await (controller as any).snapshot('runtime_w2')

      expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')).toEqual(runtimeBefore)
      expect(fixture.db.sessions.getByHostSessionId('hostSession_w2')).toEqual(sessionBefore)
      expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')).toEqual(
        invocationBefore
      )
    })

    it('snapshot returns an error (not throws) when the runtime is not active', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })

      // No start() — runtime_w2 not active
      // RED: controller.snapshot does not exist yet
      const result = await (controller as any).snapshot('runtime_w2')

      expect(result.ok).toBe(false)
      expect(result.error).toBeInstanceOf(BrokerControllerError)
    })
  })

  describe('capability tri-state gating', () => {
    it('inspection.liveness === probe: controller passes probeLiveness: true on listInvocations', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'probe',
            eventTypeFilter: false,
          },
        },
      }
      fake.listInvocationsResponse = { invocations: [] }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet
      await (controller as any).listInvocations('runtime_w2', { probeLiveness: true })

      // With liveness:'probe', controller must honor the caller's flag
      expect(fake.listInvocationsCalls).toHaveLength(1)
      expect(fake.listInvocationsCalls[0]?.probeLiveness).toBe(true)
    })

    it('inspection.liveness === cached: controller does NOT pass probeLiveness on listInvocations', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'cached',
            eventTypeFilter: false,
          },
        },
      }
      fake.listInvocationsResponse = { invocations: [] }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet;
      // when implemented: cached → must NOT forward probeLiveness: true
      await (controller as any).listInvocations('runtime_w2', { probeLiveness: true })

      expect(fake.listInvocationsCalls).toHaveLength(1)
      expect(fake.listInvocationsCalls[0]?.probeLiveness).not.toBe(true)
    })

    it('inspection.liveness === none: controller omits probeLiveness on listInvocations', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: false,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      fake.listInvocationsResponse = { invocations: [] }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet;
      // when implemented: none → must NOT forward probeLiveness
      await (controller as any).listInvocations('runtime_w2', { probeLiveness: true })

      expect(fake.listInvocationsCalls).toHaveLength(1)
      expect(fake.listInvocationsCalls[0]?.probeLiveness).not.toBe(true)
    })

    it('inspection.liveness === probe: controller passes probeLiveness: true on status()', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'probe',
            eventTypeFilter: false,
          },
        },
      }
      const liveness: InvocationLivenessView = {
        mode: 'probe',
        checkedAt: NOW,
        driver: { state: 'healthy' },
      }
      fake.statusResponse = { ...fake.statusResponse, liveness }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.status currently ignores extra opts;
      // when implemented: must forward probeLiveness to client.status()
      await (controller as any).status('runtime_w2', { probeLiveness: true })

      const statusCall = fake.statusCalls.find((c) => c.probeLiveness === true)
      expect(statusCall).toBeDefined()
    })

    it('inspection.liveness === cached: controller does NOT probe on status()', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'cached',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: when implemented: cached → status must NOT request a live probe
      await (controller as any).status('runtime_w2', { probeLiveness: true })

      expect(fake.statusCalls.every((c) => !c.probeLiveness)).toBe(true)
    })
  })
  // ── end T-01855 reds ─────────────────────────────────────────────────────────

  it('fails closed when broker hello cannot admit the requested driver', async () => {
    const fake = new FakeBrokerClient()
    fake.emitCloseOnClose = true
    const infos: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = []
    fake.helloResponse = {
      ...fake.helloResponse,
      drivers: [{ kind: 'codex-app-server', version: '0.1.1-test', available: false }],
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      logger: {
        info(message, fields) {
          infos.push({ message, fields })
        },
        warn(message, fields) {
          warnings.push({ message, fields })
        },
        error(message, fields) {
          errors.push({ message, fields })
        },
      },
    })

    const result = await controller.start({ ...makeStartInput(), brokerClient: fake })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BrokerControllerError)
      expect(result.error.code).toBe('broker_admission_rejected')
      expect(result.error.detail['missing']).toEqual(['driver.codex-app-server.available'])
      expect(result.error.detail['protocolVersion']).toBe('harness-broker/0.2')
      expect(result.error.detail['driver']).toEqual(
        expect.objectContaining({ kind: 'codex-app-server', available: false })
      )
    }
    expect(fake.callOrder).toContain('close')
    expect(warnings.some((entry) => entry.message.includes('pre-start admission rejected'))).toBe(
      true
    )
    expect(infos.some((entry) => entry.message.includes('closed intentionally'))).toBe(true)
    expect(errors).toEqual([])
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')).toBeNull()
  })
})

async function makeFixture(): Promise<TestFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-controller-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:larry:project:hrc-runtime:task:T-01697',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  return {
    db,
    dir,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function makeStartInput(): {
  plan: CompiledRuntimePlan
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
  identity: ReturnType<typeof makeIdentity>
  dispatchEnv: Record<string, string>
} {
  const identity = makeIdentity()
  const { profile, startRequest } = makeBrokerProfile(identity)
  const response = makeCompileResponse(identity, [profile])
  if (!response.ok) {
    throw new Error('fixture compile response unexpectedly failed')
  }
  return {
    plan: response.plan,
    profile,
    startRequest,
    specHash: profile.harnessInvocation.specHash,
    startRequestHash: profile.harnessInvocation.startRequestHash,
    identity,
    dispatchEnv: { HRC_DISPATCH: 'yes' },
  }
}

function invocationCapabilities(): InvocationCapabilities {
  return {
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
      replay: false,
      ack: false,
    },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: true },
  }
}

function capabilityRequirements(
  overrides: Partial<CapabilityRequirements['input']> = {}
): CapabilityRequirements {
  return {
    input: {
      user: 'required',
      steer: 'optional',
      appendContext: 'optional',
      localImages: 'optional',
      fileRefs: 'optional',
      queue: 'optional',
      ...overrides,
    },
    turns: { concurrency: 'single', interrupt: 'optional' },
    continuation: 'required',
    permissions: 'client-mediated',
    events: {
      assistantDeltas: 'optional',
      toolCalls: 'optional',
      usage: 'optional',
      diagnostics: 'optional',
    },
    control: {
      stop: 'optional',
      dispose: 'optional',
      reconcile: 'optional',
      attachReplay: 'optional',
    },
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
