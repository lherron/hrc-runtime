/**
 * W3B green tests for HarnessBrokerController.
 *
 * These use a fake BrokerClient; no live broker process or route wiring is
 * involved. The controller remains inert unless W4 explicitly calls it behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'

import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'
import { envelope } from './broker-event-mapper-fixtures'

import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  capabilityRequirements,
  invocationCapabilities,
  makeFixture,
  makeStartInput,
  tick,
} from './fixtures/broker-controller.fixture'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('HarnessBrokerController', () => {
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
    expect(fake.callOrder).toEqual(['permission', 'hello', 'start', 'snapshot'])
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

  it('marks a runtime crashed when its active broker invocation exits abnormally', async () => {
    const fake = new FakeBrokerClient()
    fake.emitCloseOnClose = true
    const reaped: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerTmuxSummaryReapGraceMs: 0,
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
        { exitCode: 23, signal: null, reason: 'process-exit' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    await tick()

    // A NON-user terminal (no preceding user /quit) must preserve durability: the
    // lease must NOT be reaped so the broker survives for reattach.
    expect(reaped).toEqual([])

    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_w2')
    expect(runtime?.status).toBe('crashed')
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
    const crashEvents = fixture.db.hrcEvents
      .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
      .filter((event) => event.eventKind === 'runtime.crashed')
    expect(crashEvents).toHaveLength(1)
    expect(crashEvents[0]).toMatchObject({
      errorCode: 'runtime_unavailable',
      payload: {
        invocationId: 'invocation_w2',
        providerTerminal: {
          eventType: 'invocation.exited',
          exitCode: 23,
          signal: null,
          reason: 'process-exit',
        },
      },
    })
    expect(fake.callOrder).toContain('close')
  })

  it('keeps retryable invocation failures non-terminal until the definitive provider failure', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })

    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    fake.events.push(
      envelope(
        'invocation.failed',
        9,
        {
          message: 'invalid peer certificate: UnsupportedCertVersion',
          code: 'transport_error',
          retryable: true,
          data: { willRetry: true, attempt: 3 },
        },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('ready')
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.invocationState).toBe(
      'ready'
    )
    expect(
      fixture.db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
        .filter((event) => event.eventKind === 'invocation.failed')
    ).toHaveLength(0)
    expect(
      fixture.db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
        .filter((event) => event.eventKind === 'runtime.crashed')
    ).toHaveLength(0)
    expect(fake.callOrder).not.toContain('close')

    fake.events.push(
      envelope(
        'diagnostic',
        10,
        {
          level: 'warn',
          source: 'driver',
          message: 'Reconnecting... 4/5',
        },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    expect(
      fixture.db.brokerInvocationEvents.getByInvocationAndSeq('invocation_w2', 10)
    ).not.toBeNull()

    fake.events.push(
      envelope(
        'invocation.failed',
        11,
        {
          message: 'invalid peer certificate: UnsupportedCertVersion',
          code: 'transport_error',
          retryable: false,
          data: { willRetry: false, attempt: 5 },
          reason: 'retry-exhausted',
        },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_w2')
    expect(runtime?.status).toBe('crashed')
    expect(runtime?.runtimeStateJson?.['terminalReason']).toBe(
      'invalid peer certificate: UnsupportedCertVersion'
    )
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')).toMatchObject({
      invocationState: 'failed',
      lifecycleTerminalReason: 'retry-exhausted',
    })
    expect(fixture.db.runs.getByRunId('run_w2')?.errorMessage).toContain(
      'invalid peer certificate: UnsupportedCertVersion'
    )
    expect(fake.callOrder).toContain('close')

    const crashEvents = fixture.db.hrcEvents
      .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
      .filter((event) => event.eventKind === 'runtime.crashed')
    expect(crashEvents).toHaveLength(1)
    expect(crashEvents[0]).toMatchObject({
      payload: {
        reason: 'invalid peer certificate: UnsupportedCertVersion',
        providerTerminal: {
          eventType: 'invocation.failed',
          message: 'invalid peer certificate: UnsupportedCertVersion',
          code: 'transport_error',
          reason: 'retry-exhausted',
        },
      },
    })
  })

  it('marks a runtime terminated when a user-ended continuation exits', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerTmuxSummaryReapGraceMs: 0,
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

  it('records invocation.summary and process exit before reaping a user-ended broker tmux lease', async () => {
    const fake = new FakeBrokerClient()
    const reapedWithSummary: Array<{ runtimeId: string; finalSummary: unknown }> = []
    const finalSummary = {
      reason: 'prompt_input_exit',
      summary: {
        invocationId: 'invocation_w2',
        state: 'ready',
        driver: 'codex-cli-tmux',
        startedAt: NOW,
        lastActivityAt: NOW,
        turnsCompleted: 1,
      },
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerTmuxSummaryReapGraceMs: 50,
      reapBrokerTmuxLease: async (runtimeId) => {
        const runtime = fixture.db.runtimes.getByRuntimeId(runtimeId)
        reapedWithSummary.push({
          runtimeId,
          finalSummary: runtime?.runtimeStateJson?.['finalSummary'],
        })
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
    await tick()
    expect(reapedWithSummary).toEqual([])

    fake.events.push(
      envelope('invocation.summary', 9, finalSummary, {
        invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'],
      })
    )
    await tick()
    expect(reapedWithSummary).toEqual([])

    fake.events.push(
      envelope(
        'invocation.exited',
        10,
        { exitCode: 0, signal: null, reason: 'process-exit' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    expect(reapedWithSummary).toEqual([{ runtimeId: 'runtime_w2', finalSummary }])
  })

  it('reaps after a short grace when no invocation.summary arrives', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerTmuxSummaryReapGraceMs: 0,
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
    await tick()
    await tick()

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
    fake.events.push(
      envelope(
        'invocation.ready',
        1,
        { state: 'ready' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    fake.emitClose(
      new Error('Broker process exited with exit code 1\nBroker stderr:\nstderr marker W3B')
    )
    fake.events.push(
      envelope(
        'invocation.exited',
        9,
        { exitCode: 23, signal: null, reason: 'process-exit' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()

    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('crashed')
    expect(fixture.db.runs.getByRunId('run_w2')?.status).toBe('failed')
    expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')?.invocationState).toBe(
      'exited'
    )
    expect(errors.some((entry) => JSON.stringify(entry).includes('stderr marker W3B'))).toBe(true)
    const brokerClosed = fixture.db.events
      .listFromSeq(1, { runtimeId: 'runtime_w2' })
      .find((event) => event.eventKind === 'broker.process.closed')
    expect(brokerClosed).toBeDefined()
    const canonicalCrashes = fixture.db.hrcEvents
      .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
      .filter((event) => event.eventKind === 'runtime.crashed')
    expect(canonicalCrashes).toHaveLength(1)
    expect(canonicalCrashes[0]).toMatchObject({
      errorCode: 'broker_process_closed',
      payload: {
        reason: 'broker_process_closed',
        invocationId: 'invocation_w2',
        lastBrokerEvent: {
          type: 'invocation.ready',
        },
      },
    })
  })

  it('reaps the lease (no crash-terminal) when the broker closes after a user /quit', async () => {
    const fake = new FakeBrokerClient()
    const reaped: string[] = []
    const errors: Array<{ message: string }> = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerTmuxSummaryReapGraceMs: 0,
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
    expect(
      fixture.db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
        .filter((event) => event.eventKind === 'runtime.crashed')
    ).toHaveLength(0)
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
})
