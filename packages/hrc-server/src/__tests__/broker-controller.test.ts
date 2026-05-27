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
import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  InvocationEventEnvelope,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile, CompiledRuntimePlan } from 'spaces-runtime-contracts'

import {
  type BrokerClientLike,
  BrokerControllerError,
  HarnessBrokerController,
} from '../broker/controller'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'
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
  }> = []
  readonly healthCalls: BrokerHealthRequest[] = []
  permissionHandler?: (request: PermissionRequestParams) => Promise<PermissionDecision>
  private closeHandler?: (error: Error) => void

  helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.1.1-test' },
    protocolVersion: 'harness-broker/0.1',
    capabilities: {
      multiInvocation: false,
      transports: ['stdio-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
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
    dispatchEnv?: Record<string, string>
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }> {
    this.callOrder.push('start')
    this.startCalls.push({ request, dispatchEnv })
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

  async status(_req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
    this.callOrder.push('status')
    return this.statusResponse
  }

  async dispose(): Promise<void> {
    this.callOrder.push('dispose')
    this.events.close()
  }

  async close(): Promise<void> {
    this.callOrder.push('close')
    this.events.close()
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

    const result = await controller.start(input)

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

    const started = await controller.start(makeStartInput())
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

  it('default-denies and persists permission decisions when no request channel exists', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const started = await controller.start(makeStartInput())
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
    await controller.start(makeStartInput())

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

    await controller.start(makeStartInput())
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

  it('fails closed when broker hello cannot admit the requested driver', async () => {
    const fake = new FakeBrokerClient()
    fake.helloResponse = {
      ...fake.helloResponse,
      drivers: [{ kind: 'codex-app-server', version: '0.1.1-test', available: false }],
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const result = await controller.start(makeStartInput())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BrokerControllerError)
      expect(result.error.code).toBe('broker_admission_rejected')
    }
    expect(fake.callOrder).toContain('close')
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

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
