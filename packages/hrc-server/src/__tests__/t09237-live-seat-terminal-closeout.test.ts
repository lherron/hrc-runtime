/**
 * T-09237 — a current live-seat `terminal` observation closes out an invocation
 * HRC still projects as `ready`.
 *
 * Replays the max3 2026-09-25 22:43Z sequence (rt-0441038b / inv-3b639fd0):
 * codex emitted retryable errors, the ASP driver turned them into `turn.failed`
 * then `invocation.failed {retryable:true}`, and the broker seat went
 * `terminal`. HRC treats a retryable invocation.failed as attempt evidence and
 * waited for a non-retryable one that never came, so runtime + invocation
 * stayed `ready` over a dead seat: the queued submission stalled until the
 * caller's 300s timeout and the next no-reuse dispatch was refused as though
 * the scope were healthy.
 *
 * Failure modes this file pins:
 *  F1 terminal seat + ready projection → nothing closes out (the defect).
 *  F2 close-out fires on a retryable blip whose seat stays live (over-reach).
 *  F3 close-out fails the active run but leaves a queued run open (caller hangs).
 *  F4 close-out drops the provider's message (caller sees a generic error).
 *  F5 a terminal seat observed for a DIFFERENT invocation closes this one.
 *  F6 dispatch reads only the projection, so a scope whose retained seat is
 *     terminal still refuses a no-reuse dispatch before any monitor tick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { SeatProbeRequest, SeatProbeResponse } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import { type HrcServer, createHrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isRuntimeUnavailableStatus } from '../server-util'
import { envelope, inputId, turnId } from './broker-event-mapper-fixtures'
import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  makeFixture,
  makeStartInput,
  tick,
} from './fixtures/broker-controller.fixture'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const RUNTIME = 'runtime_w2'
const INVOCATION = 'invocation_w2'
const QUEUED_RUN = 'run_t09237_queued'
const CODEX_MESSAGE = 'Reconnecting... 3/5'

let fixture: TestFixture
let controller: HarnessBrokerController | undefined

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  controller?.shutdown()
  await fixture.cleanup()
})

function retryablePayload(message: string) {
  return {
    message,
    code: 'codex_app_server_error',
    retryable: true,
    data: { willRetry: true, error: { message } },
  }
}

async function startSeat(): Promise<{
  fake: FakeBrokerClient
  setSeat: (seat: SeatProbeResponse['seat']) => void
}> {
  const fake = new FakeBrokerClient()
  let seat: SeatProbeResponse['seat'] = { state: 'idle' }
  fake.seatProbe = async (request: SeatProbeRequest) => ({
    invocationId: request.invocationId,
    seat,
    brokerHeldDepth: 0,
  })
  controller = new HarnessBrokerController({
    db: fixture.db,
    brokerClientFactory: async () => fake,
    // The monitor is driven by hand so each observation is deterministic.
    brokerSeatProbeIntervalMs: 0,
    now: () => NOW,
  })
  await controller.start({ ...makeStartInput(), brokerClient: fake })
  await tick()
  const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME)!
  fixture.db.runtimes.update(RUNTIME, { status: 'ready', updatedAt: NOW })
  fixture.db.runs.insert({
    runId: QUEUED_RUN,
    hostSessionId: runtime.hostSessionId,
    runtimeId: RUNTIME,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    generation: runtime.generation,
    transport: runtime.transport,
    status: 'accepted',
    acceptedAt: NOW,
    updatedAt: NOW,
    invocationId: INVOCATION,
    brokerSubmissionId: 'submission_queued',
    dispatchedInputId: 'submission_queued',
  })
  return {
    fake,
    setSeat: (next) => {
      seat = next
    },
  }
}

/** The observed broker sequence up to (not including) the seat going terminal. */
async function replayRetryableFailures(fake: FakeBrokerClient): Promise<void> {
  fake.events.push(
    envelope(
      'turn.failed',
      1,
      { turnId: turnId('turn-t09237'), ...retryablePayload('Reconnecting... 2/5') } as never,
      {
        invocationId: INVOCATION as never,
        turnId: turnId('turn-t09237'),
        inputId: inputId('input-t09237'),
      }
    )
  )
  fake.events.push(
    envelope(
      'input.accepted',
      2,
      { inputId: inputId('submission_queued'), disposition: 'queued' },
      { invocationId: INVOCATION as never, inputId: inputId('submission_queued') }
    )
  )
  fake.events.push(
    envelope('invocation.failed', 3, retryablePayload(CODEX_MESSAGE) as never, {
      invocationId: INVOCATION as never,
    })
  )
  await tick()
  await tick()
  await tick()
}

function runtimeCrashedEvents() {
  return fixture.db.hrcEvents
    .listFromHrcSeq(1, { runtimeId: RUNTIME })
    .filter((event) => event.eventKind === 'runtime.crashed')
}

describe('T-09237 live-seat terminal closes out a ready invocation', () => {
  it('replayed incident: a terminal seat fails the invocation, the runtime and every open run with the carried codex error', async () => {
    const { fake, setSeat } = await startSeat()
    await replayRetryableFailures(fake)

    // Retryable failures alone are attempt evidence: still ready.
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME)?.status).toBe('ready')
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION)?.invocationState).toBe(
      'ready'
    )

    setSeat({ state: 'terminal' })
    await controller!.seatProbe(RUNTIME)

    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME)!
    expect(runtime.status).not.toBe('ready')
    expect(isRuntimeUnavailableStatus(runtime.status)).toBe(true)

    const invocation = fixture.db.brokerInvocations.getByInvocationId(INVOCATION)!
    expect(invocation.invocationState).toBe('failed')
    expect(invocation.lifecycleTerminalReason).toBe('live-seat-terminal')

    const queued = fixture.db.runs.getByRunId(QUEUED_RUN)!
    expect(queued.status).toBe('failed')
    expect(queued.completedAt).toBeDefined()
    expect(queued.errorMessage).toContain(CODEX_MESSAGE)
    expect(queued.errorMessage).toContain('live-seat-terminal')

    const crashed = runtimeCrashedEvents()
    expect(crashed).toHaveLength(1)
    expect(crashed[0]!.payload).toMatchObject({
      providerTerminal: { reason: 'live-seat-terminal', message: CODEX_MESSAGE },
    })

    // Idempotent: a second terminal observation adds nothing.
    await controller!.seatProbe(RUNTIME)
    expect(runtimeCrashedEvents()).toHaveLength(1)
  })

  it('control: a retryable blip whose seat stays live does NOT close the invocation', async () => {
    const { fake, setSeat } = await startSeat()
    await replayRetryableFailures(fake)

    for (const seat of [
      { state: 'starting' },
      { state: 'turn-active', turnId: turnId('turn-retry') },
      { state: 'idle' },
    ] as SeatProbeResponse['seat'][]) {
      setSeat(seat)
      await controller!.seatProbe(RUNTIME)
    }

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME)?.status).toBe('ready')
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION)?.invocationState).toBe(
      'ready'
    )
    expect(fixture.db.runs.getByRunId(QUEUED_RUN)?.completedAt).toBeUndefined()
    expect(runtimeCrashedEvents()).toHaveLength(0)
  })

  it('a terminal seat observed for a different invocation does not close this one', async () => {
    const { fake } = await startSeat()
    fake.seatProbe = async () => ({
      invocationId: 'invocation_other' as never,
      seat: { state: 'terminal' },
      brokerHeldDepth: 0,
    })
    // Retained observation naming another invocation (e.g. a pre-rotation seat).
    fixture.db.runtimes.update(RUNTIME, {
      runtimeStateJson: {
        ...(fixture.db.runtimes.getByRuntimeId(RUNTIME)!.runtimeStateJson ?? {}),
        brokerDispatchDiagnostics: {
          liveSeatProbe: {
            availability: 'current',
            state: 'terminal',
            observedAt: NOW,
            invocationId: 'invocation_other',
            brokerHeldDepth: 0,
            cause: 'test',
          },
        },
      },
      updatedAt: NOW,
    })
    expect(controller!.closeOutTerminalLiveSeat(RUNTIME, 'dispatch-admission')).toBe(false)
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME)?.status).toBe('ready')
  })

  it('dispatch-time: a retained terminal observation closes out before the next monitor tick', async () => {
    const { fake, setSeat } = await startSeat()
    await replayRetryableFailures(fake)
    // Retain a terminal observation without the monitor's close-out running:
    // write exactly what recordSeatProbe retains.
    setSeat({ state: 'terminal' })
    fixture.db.runtimes.update(RUNTIME, {
      runtimeStateJson: {
        ...(fixture.db.runtimes.getByRuntimeId(RUNTIME)!.runtimeStateJson ?? {}),
        brokerDispatchDiagnostics: {
          liveSeatProbe: {
            availability: 'stale',
            state: 'terminal',
            observedAt: NOW,
            invocationId: INVOCATION,
            brokerHeldDepth: 0,
            cause: 'periodic-monitor',
          },
        },
      },
      updatedAt: NOW,
    })

    expect(controller!.closeOutTerminalLiveSeat(RUNTIME, 'dispatch-admission')).toBe(true)
    expect(isRuntimeUnavailableStatus(fixture.db.runtimes.getByRuntimeId(RUNTIME)!.status)).toBe(
      true
    )
    expect(fixture.db.runs.getByRunId(QUEUED_RUN)?.errorMessage).toContain(CODEX_MESSAGE)
  })
})

// F6 on the real admission path: dispatchTurnForSession and
// decideInteractiveBrokerAdmission run for real; only the seams BELOW admission
// (tmux liveness, presentation, broker start/delivery) are replaced.
describe('T-09237 no-reuse dispatch against a dead seat births fresh', () => {
  const RUNTIME_ID = 'rt-t09237-dead-seat'
  const ACTIVE_INVOCATION = 'inv-t09237-dead-seat'
  let server: HrcServer | undefined
  let hrc: HrcServerTestFixture
  let internal: HrcServerInstanceForHandlers
  let hostSessionId: string
  let births: string[]
  let delivered: string[]

  beforeEach(async () => {
    hrc = await createHrcTestFixture('t09237-dead-seat-')
    server = await createHrcServer(hrc.serverOpts())
    internal = server as unknown as HrcServerInstanceForHandlers
    hostSessionId = (await hrc.resolveSession('t09237-dead-seat')).hostSessionId
    births = []
    delivered = []
    const timestamp = hrc.now()
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)!
    internal.db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      controllerKind: 'harness-broker',
      activeInvocationId: ACTIVE_INVOCATION,
      tmuxJson: {
        socketPath: hrc.tmuxSocketPath,
        sessionName: 'hrc-t09237',
        windowName: 'main',
        paneId: '%t09237',
        brokerDriver: 'codex-cli-tmux',
      },
      supportsInflightInput: true,
      adopted: false,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    internal.db.brokerInvocations.insert({
      invocationId: ACTIVE_INVOCATION,
      operationId: 'op-t09237',
      runtimeId: RUNTIME_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-cli-tmux',
      invocationState: 'ready',
      capabilitiesJson: '{}',
      specHash: 'sha256:t09237:spec',
      startRequestHash: 'sha256:t09237:request',
      selectedProfileHash: 'sha256:t09237:profile',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    internal.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    internal.publishPresentation = async () => undefined
    internal.handleInteractiveTmuxBrokerDispatchTurn = async (submittedSession, _i, _p, runId) => {
      births.push(runId)
      return Response.json(
        {
          submissionId: `sub-${runId}`,
          admission: 'admitted',
          runId,
          hostSessionId: submittedSession.hostSessionId,
          generation: submittedSession.generation,
          runtimeId: 'rt-t09237-fresh',
          transport: 'tmux',
          status: 'started',
          supportsInFlightInput: true,
        },
        { status: 202 }
      )
    }
    internal.executeInteractiveBrokerInputTurn = async (_s, runtime, _p, runId) => {
      delivered.push(runtime.runtimeId)
      return Response.json({ runId, admission: 'admitted' }, { status: 202 })
    }
  })

  afterEach(async () => {
    if (server !== undefined) {
      await server.stop()
      server = undefined
    }
    await hrc.cleanup()
  })

  function retainSeat(state: 'terminal' | 'idle'): void {
    const runtime = internal.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    internal.db.runtimes.update(RUNTIME_ID, {
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        brokerDispatchDiagnostics: {
          liveSeatProbe: {
            availability: 'current',
            state,
            observedAt: hrc.now(),
            invocationId: ACTIVE_INVOCATION,
            brokerHeldDepth: 0,
            cause: 'periodic-monitor',
          },
        },
      },
      updatedAt: hrc.now(),
    })
  }

  function noReuseInvoke() {
    return hrc.postJson('/v1/submissions/invoke', {
      target: hostSessionId,
      body: 'score this',
      origin: { principalRef: 'agent:mneme-signal' },
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: { provider: 'openai', id: 'codex-cli', interactive: true },
        execution: { preferredMode: 'interactive', allowInteractiveSurfaceReuse: false },
      },
      turnPolicy: 'guarded',
      wait: false,
    })
  }

  it('terminal seat: the scope is not healthy, so the dispatch births a fresh seat', async () => {
    retainSeat('terminal')
    const response = await noReuseInvoke()
    const body = (await response.json()) as Record<string, unknown>

    expect(body).not.toMatchObject({ error: { message: 'caller-surface-reuse-refusal' } })
    expect(response.status).toBe(202)
    expect(births).toHaveLength(1)
    expect(delivered).toHaveLength(0)
    const runtime = internal.db.runtimes.getByRuntimeId(RUNTIME_ID)!
    expect(isRuntimeUnavailableStatus(runtime.status)).toBe(true)
    expect(internal.db.brokerInvocations.getByInvocationId(ACTIVE_INVOCATION)).toMatchObject({
      invocationState: 'failed',
      lifecycleTerminalReason: 'live-seat-terminal',
    })
  })

  it('control: an idle live seat is still healthy and the refusal stands', async () => {
    retainSeat('idle')
    const response = await noReuseInvoke()
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ error: { message: 'caller-surface-reuse-refusal' } })
    expect(births).toHaveLength(0)
    expect(internal.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('ready')
  })
})
