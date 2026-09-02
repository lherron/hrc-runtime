/**
 * W3B green tests for HarnessBrokerController.
 *
 * These use a fake BrokerClient; no live broker process or route wiring is
 * involved. The controller remains inert unless W4 explicitly calls it behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  InvocationCapabilities,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationEventEnvelope,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
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
  SeatProbeRequest,
  SeatProbeResponse,
  SubmissionEnqueueRequest,
  SubmissionInvokeRequest,
  SubmissionPreemptRequest,
  SubmissionResponse,
  SubmissionSteerRequest,
  TurnManifestRequest,
  TurnManifestResponse,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CapabilityRequirements,
  CompiledRuntimePlan,
} from 'spaces-runtime-contracts'

import type { BrokerClientLike } from '../../broker/controller'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from '../broker-compile-fixtures'

export const NOW = '2026-05-27T12:34:56.000Z'

export type TestFixture = {
  db: HrcDatabase
  dir: string
  cleanup: () => Promise<void>
}

export class PushableEvents implements AsyncIterable<InvocationEventEnvelope> {
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

export class FakeBrokerClient implements BrokerClientLike {
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
  readonly captureReleaseCalls: InvocationCaptureReleaseRequest[] = []
  emitCloseOnClose = false
  captureReleaseError?: Error
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

  captureReleaseResponse: InvocationCaptureReleaseResponse = {
    released: true,
    invocationId: 'invocation_w2' as InvocationCaptureReleaseResponse['invocationId'],
    rawRecordId: 'raw-blocked',
    disposition: 'ignored-known',
    releasedSeq: 7,
    resumedRecords: 2,
    capture: { state: 'open', deferredCount: 0 },
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

  async steer(_req: SubmissionSteerRequest): Promise<SubmissionResponse> {
    this.callOrder.push('steer')
    return { submissionId: 'submission_steer', admission: 'admitted' }
  }

  async enqueue(_req: SubmissionEnqueueRequest): Promise<SubmissionResponse> {
    this.callOrder.push('enqueue')
    return { submissionId: 'submission_enqueue', admission: 'admitted' }
  }

  async invoke(_req: SubmissionInvokeRequest): Promise<SubmissionResponse> {
    this.callOrder.push('invoke')
    return { submissionId: 'submission_invoke', admission: 'admitted' }
  }

  async preempt(_req: SubmissionPreemptRequest): Promise<SubmissionResponse> {
    this.callOrder.push('preempt')
    return { submissionId: 'submission_preempt', admission: 'admitted' }
  }

  async turnManifest(req: TurnManifestRequest): Promise<TurnManifestResponse> {
    this.callOrder.push('turnManifest')
    return {
      invocationId: req.invocationId,
      turnId: req.turnId,
      policy: 'open',
      submissionIds: [],
    }
  }

  async seatProbe(req: SeatProbeRequest): Promise<SeatProbeResponse> {
    this.callOrder.push('seatProbe')
    return { invocationId: req.invocationId, seat: { state: 'idle' }, brokerHeldDepth: 0 }
  }

  async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
    this.callOrder.push('interrupt')
    return { accepted: true, effect: 'turn_interrupted' }
  }

  readonly stopReasons: Array<string | undefined> = []
  async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
    this.callOrder.push('stop')
    this.stopReasons.push(req.reason)
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

  async captureRelease(
    req: InvocationCaptureReleaseRequest
  ): Promise<InvocationCaptureReleaseResponse> {
    this.callOrder.push('captureRelease')
    this.captureReleaseCalls.push(req)
    if (this.captureReleaseError) throw this.captureReleaseError
    return this.captureReleaseResponse
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

export async function makeFixture(): Promise<TestFixture> {
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

export function makeStartInput(): {
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

export function invocationCapabilities(): InvocationCapabilities {
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

export function capabilityRequirements(
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

export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | 'test_watchdog_timeout'> {
  return await Promise.race([
    promise,
    new Promise<'test_watchdog_timeout'>((resolve) =>
      setTimeout(() => resolve('test_watchdog_timeout'), timeoutMs)
    ),
  ])
}
