/**
 * W3B green tests for HarnessBrokerController.
 *
 * These use a fake BrokerClient; no live broker process or route wiring is
 * involved. The controller remains inert unless W4 explicitly calls it behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { BrokerTransportError } from 'spaces-harness-broker-client'
import type {
  InvocationStatusRequest,
  InvocationStopRequest,
  SubmissionInvokeRequest,
} from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'

import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'

import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  invocationCapabilities,
  makeFixture,
  makeStartInput,
  resolveWithin,
} from './fixtures/broker-controller.fixture'

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

  it('persists HRC-resolved actuator authority on both starting and settled runtime state', async () => {
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    const runtimeAuthority = {
      actuatorSplit: {
        schemaVersion: 'hrc.actuator-split-policy/v1',
        mode: 'high-risk',
        laneClass: 'verifier',
        codeMutation: 'forbidden',
        productionCodePaths: ['packages'],
      },
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })

    const result = await controller.start({
      ...input,
      brokerClient: fake,
      runtimeAuthority,
    })

    expect(result.ok).toBe(true)
    expect(
      fixture.db.runtimes.getByRuntimeId('runtime_w2')?.runtimeStateJson?.['authority']
    ).toEqual(runtimeAuthority)
  })

  it('PRIMARY gate: rejects json_schema via the DECLARED driver capability when the broker driver does not advertise finalResponse (T-05142)', async () => {
    // The aspc/broker-declared driver capability (from the negotiated hello) is
    // authoritative. The fake's codex-app-server driver advertises no
    // finalResponse, mirroring claude-code-tmux / pi-tui-tmux. A json_schema turn
    // must be rejected on that declared capability — keyed off the REQUESTED
    // format, NOT startRequest.initialInput (which compile drops for launch-primed).
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })

    const result = await controller.start({
      ...input,
      requestedResponseFormat: { kind: 'json_schema', schema: { type: 'object' } },
      brokerClient: fake,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail-closed result')
    expect(result.error.code).toBe('unsupported_capability')
    // Capability-accurate rejection from the preflight (not the backstop):
    // no `reason` field, and the declared finalResponse is surfaced as `actual`.
    const detail = result.error.detail as { reason?: string; capability?: string; actual?: unknown }
    expect(detail.reason).toBeUndefined()
    expect(detail.capability).toBe('finalResponse.jsonSchema')
    // No broker invocation side effect: the turn must never reach broker start.
    expect(fake.callOrder).not.toContain('start')
  })

  it('BACKSTOP: rejects a declared-capable driver whose start path cannot deliver the format (initialInput dropped) (T-05142)', async () => {
    // Defense-in-depth: a driver that DECLARES finalResponse but whose start
    // request carries no initialInput (hypothetical launch-primed capable driver)
    // has no per-turn vehicle, so it must fail closed rather than silently drop.
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    // Make the declared driver capability advertise finalResponse so the PRIMARY
    // preflight passes and execution reaches the deliverability backstop.
    fake.helloResponse = {
      ...fake.helloResponse,
      drivers: [
        {
          kind: input.profile.brokerDriver,
          version: '0.1.1-test',
          available: true,
          capabilities: {
            ...invocationCapabilities(),
            finalResponse: { jsonSchema: true, perTurn: true },
          },
        },
      ],
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })

    const result = await controller.start({
      ...input,
      startRequest: { ...input.startRequest, initialInput: undefined },
      requestedResponseFormat: { kind: 'json_schema', schema: { type: 'object' } },
      brokerClient: fake,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail-closed result')
    expect(result.error.code).toBe('unsupported_capability')
    expect((result.error.detail as { reason?: string }).reason).toBe(
      'initial-input-not-deliverable'
    )
    expect(fake.callOrder).not.toContain('start')
  })

  it('dispose forwards an operator_reap reason to broker stop (T-04423)', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    const result = await controller.dispose('runtime_w2', { reason: 'operator_reap' })

    expect(result.ok).toBe(true)
    // stop carries the operator intent; dispose follows.
    expect(fake.stopReasons).toContain('operator_reap')
    expect(fake.callOrder).toContain('stop')
    expect(fake.callOrder).toContain('dispose')
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('disposed')
  })

  it('dispose defaults to reason "dispose" when none is supplied', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    const result = await controller.dispose('runtime_w2')

    expect(result.ok).toBe(true)
    expect(fake.stopReasons).toContain('dispose')
  })

  it('dispose bounds a wedged broker RPC and drops the unresponsive binding (broker-resume-after-restart hang)', async () => {
    // A broker that is alive but no longer acks stop/dispose — the failure mode
    // of a durable broker-tmux runtime reattached after an hrc-server restart.
    // Without the bound, `client.stop()` hangs forever and freezes the terminate
    // path; with it, dispose fails fast and forgets the dead binding.
    class HangingStopBrokerClient extends FakeBrokerClient {
      override async stop(): Promise<never> {
        this.callOrder.push('stop')
        return new Promise<never>(() => {}) // never resolves
      }
    }
    const fake = new HangingStopBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
      brokerDisposeTimeoutMs: 40,
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    // Returns (does not hang) and reports failure rather than success.
    const result = await controller.dispose('runtime_w2', { reason: 'operator_reap' })
    expect(result.ok).toBe(false)
    // Surfaces the specific timeout code (toControllerError preserves it); still a
    // non-`broker_runtime_not_active` failure, so disposeBrokerRuntime logs WARN
    // and the terminate path proceeds to tear down the leased tmux + finalize.
    if (!result.ok) expect(result.error.code).toBe('broker_dispose_timeout')
    expect(fake.callOrder).toContain('stop')

    // The unresponsive binding was dropped: a second dispose now fast-fails as
    // not-active (so a retry/teardown is never re-blocked on the dead client).
    const again = await controller.dispose('runtime_w2')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('broker_runtime_not_active')
  })

  it('times out a wedged active input RPC, closes the client, and drops the binding (T-05176)', async () => {
    // T-05176 red: reused broker input delivery must be bounded at the generic
    // active RPC boundary. The local watchdog keeps the current unbounded code
    // from hanging this test; green is the controller returning broker_input_timeout.
    class HangingInvokeBrokerClient extends FakeBrokerClient {
      closeCalls = 0

      override async invoke(_req: SubmissionInvokeRequest): Promise<never> {
        this.callOrder.push('invoke')
        return new Promise<never>(() => {})
      }

      override async close(): Promise<void> {
        this.closeCalls++
        await super.close()
      }
    }
    const fake = new HangingInvokeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
      brokerActiveRpcTimeoutMs: 25,
    } as any)

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    const startedAt = Date.now()
    const result = await resolveWithin(
      controller.invoke({
        runtimeId: 'runtime_w2',
        body: 'wedged reuse input',
        origin: { principalRef: 'agent:test' },
      }),
      200
    )

    expect(result).not.toBe('test_watchdog_timeout')
    if (result === 'test_watchdog_timeout') return
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('broker_invoke_timeout')
    expect(fake.closeCalls).toBe(1)

    const again = await controller.status('runtime_w2')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('broker_runtime_not_active')
  })

  it('times out status interrupt and stop with operation codes without dropping the active binding (T-05176)', async () => {
    // Negative guard for the shared helper: only input timeouts retire the
    // wedged binding. Other active RPC timeout codes are typed but non-terminal.
    class HangingControlBrokerClient extends FakeBrokerClient {
      override async status(req: InvocationStatusRequest): Promise<never> {
        this.callOrder.push('status')
        this.statusCalls.push(req)
        return new Promise<never>(() => {})
      }

      override async interrupt(): Promise<never> {
        this.callOrder.push('interrupt')
        return new Promise<never>(() => {})
      }

      override async stop(req: InvocationStopRequest): Promise<never> {
        this.callOrder.push('stop')
        this.stopReasons.push(req.reason)
        return new Promise<never>(() => {})
      }
    }
    const fake = new HangingControlBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
      brokerActiveRpcTimeoutMs: 25,
    } as any)

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    const status = await resolveWithin(controller.status('runtime_w2'), 200)
    expect(status).not.toBe('test_watchdog_timeout')
    if (status === 'test_watchdog_timeout') return
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.error.code).toBe('broker_status_timeout')

    const inputAfterStatusTimeout = await controller.invoke({
      runtimeId: 'runtime_w2',
      body: 'still active after status',
      origin: { principalRef: 'agent:test' },
    })
    expect(inputAfterStatusTimeout.ok).toBe(true)

    const interrupt = await resolveWithin(
      controller.interrupt('runtime_w2', { runId: 'run_w2', generation: 1 }),
      200
    )
    expect(interrupt).not.toBe('test_watchdog_timeout')
    if (interrupt === 'test_watchdog_timeout') return
    expect(interrupt.ok).toBe(false)
    if (!interrupt.ok) expect(interrupt.error.code).toBe('broker_interrupt_timeout')

    const inputAfterInterruptTimeout = await controller.invoke({
      runtimeId: 'runtime_w2',
      body: 'still active after interrupt',
      origin: { principalRef: 'agent:test' },
    })
    expect(inputAfterInterruptTimeout.ok).toBe(true)

    const stop = await resolveWithin(
      controller.stop('runtime_w2', { reason: 'operator_reap' }),
      200
    )
    expect(stop).not.toBe('test_watchdog_timeout')
    if (stop === 'test_watchdog_timeout') return
    expect(stop.ok).toBe(false)
    if (!stop.ok) expect(stop.error.code).toBe('broker_stop_timeout')

    const inputAfterStopTimeout = await controller.invoke({
      runtimeId: 'runtime_w2',
      body: 'still active after stop',
      origin: { principalRef: 'agent:test' },
    })
    expect(inputAfterStopTimeout.ok).toBe(true)
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
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = []
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
      logger: {
        error(message, fields) {
          errors.push({ message, fields })
        },
      },
    })

    const input = makeStartInput()
    const result = await controller.start(input)

    expect(result.ok).toBe(false)
    expect(attempts).toBe(1)
    if (!result.ok) {
      expect(result.error.code).toBe('broker_start_failed')
    }
    expect(errors).toEqual([
      {
        message: 'harness broker start failed',
        fields: expect.objectContaining({
          error: 'Failed to connect to broker unix socket',
          code: 'broker_start_failed',
          runtimeId: 'runtime_w2',
          runId: 'run_w2',
          operationId: 'runtimeOperation_w2',
          invocationId: 'invocation_w2',
          hostSessionId: 'hostSession_w2',
          scopeRef: 'agent:larry:project:hrc-runtime:task:T-01697',
          laneRef: 'main',
          sessionRef: 'agent:larry:project:hrc-runtime:task:T-01697/lane:main',
          cwd: input.profile.harnessInvocation.startRequest.spec.process.cwd,
        }),
      },
    ])
  })
})
