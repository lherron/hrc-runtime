/**
 * T-07944 — two producer-side lifecycle defects.
 *
 * 1. A cold-birth accepted run is zombied while its caller prompt is still
 *    owed: the sweep reads the RUN's clock, which stops at `turn.accepted`
 *    because the compiler priming turn carries no run identity, and the
 *    wait->submit chain that owed the prompt lived only in process memory.
 * 2. `runtime.crashed` is emitted from the broker event-consumer catch on an
 *    intentional reap, and attached to a run that had already completed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot, SweepZombieRunsResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { serializeDurableColdBootTurnInput } from '../broker-headless-handlers'
import { HarnessBrokerController } from '../broker/controller'
import { recoverColdBootInputContinuations } from '../cold-boot-input-recovery'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import {
  HOST_SESSION_ID,
  OPERATION_ID,
  RUNTIME_ID,
  RUN_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
} from './broker-event-mapper-fixtures'
import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  makeFixture,
  makeStartInput,
  tick,
} from './fixtures/broker-controller.fixture'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const PLAN_HASH = 'sha256:plan-t07944'
const PROFILE_HASH = 'sha256:profile-t07944'
const PRIMING_INPUT_ID = 'input-compiler-priming-t07944'

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

type ColdBirthSeed = {
  runId: string
  hostSessionId: string
  scopeRef: string
  runtimeId: string
  invocationId: string
  operationId: string
  acceptedAt: string
  /** Latest broker-ledger activity on the runtime — the honest priming clock. */
  runtimeActivityAt: string
  primingTerminal: boolean
  correlationJson?: string | undefined
  runtimeStatus?: string | undefined
}

describe('T-07944 defect 1a — zombie sweep vs. a live cold-birth priming turn', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t07944-sweep-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  function seedColdBirth(seed: ColdBirthSeed): void {
    fixture.seedSession(seed.hostSessionId, seed.scopeRef)
    const scopeRef = seed.scopeRef.startsWith('agent:') ? seed.scopeRef : `agent:${seed.scopeRef}`
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.compiledRuntimePlans.insert({
        planHash: PLAN_HASH,
        compileId: 'compile-t07944',
        schemaVersion: '1',
        compilerName: 'asp',
        compilerVersion: '0.0.0-test',
        planProjectionJson: JSON.stringify({
          executionProfiles: [
            {
              profileHash: PROFILE_HASH,
              harnessInvocation: {
                startRequest: { initialInput: { inputId: PRIMING_INPUT_ID } },
              },
            },
          ],
        }),
        createdAt: seed.acceptedAt,
      })
      db.runtimes.insert({
        runtimeId: seed.runtimeId,
        hostSessionId: seed.hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: seed.runtimeStatus ?? 'busy',
        controllerKind: 'harness-broker',
        supportsInflightInput: false,
        adopted: false,
        planHash: PLAN_HASH,
        selectedProfileHash: PROFILE_HASH,
        activeInvocationId: seed.invocationId,
        activeOperationId: seed.operationId,
        activeRunId: seed.runId,
        lastActivityAt: seed.runtimeActivityAt,
        createdAt: seed.acceptedAt,
        updatedAt: seed.runtimeActivityAt,
      })
      db.brokerInvocations.insert({
        invocationId: seed.invocationId,
        operationId: seed.operationId,
        runtimeId: seed.runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        invocationState: 'running',
        capabilitiesJson: JSON.stringify({ turns: 'single' }),
        specHash: 'sha256:spec',
        startRequestHash: 'sha256:req',
        selectedProfileHash: PROFILE_HASH,
        createdAt: seed.acceptedAt,
        updatedAt: seed.runtimeActivityAt,
      })
      // The compiler priming submission: executed, and terminal only when the
      // seat has actually finished the priming turn.
      db.brokerInvocationEvents.appendEvent({
        invocationId: seed.invocationId,
        seq: 1,
        time: seed.acceptedAt,
        type: 'submission.executed',
        runtimeId: seed.runtimeId,
        payload: { submissionId: PRIMING_INPUT_ID, turnId: 'turn-priming' },
      })
      if (seed.primingTerminal) {
        db.brokerInvocationEvents.appendEvent({
          invocationId: seed.invocationId,
          seq: 2,
          time: seed.runtimeActivityAt,
          type: 'turn.completed',
          runtimeId: seed.runtimeId,
          payload: { turnId: 'turn-priming' },
        })
      } else {
        db.brokerInvocationEvents.appendEvent({
          invocationId: seed.invocationId,
          seq: 2,
          time: seed.runtimeActivityAt,
          type: 'tool.call.started',
          runtimeId: seed.runtimeId,
          payload: { turnId: 'turn-priming', toolCallId: 'tc-1' },
        })
      }
      db.runs.insert({
        runId: seed.runId,
        hostSessionId: seed.hostSessionId,
        runtimeId: seed.runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        status: 'accepted',
        acceptedAt: seed.acceptedAt,
        updatedAt: seed.acceptedAt,
        invocationId: seed.invocationId,
        operationId: seed.operationId,
      })
      // The only ledger event carrying the run id: acceptance.
      db.hrcEvents.append({
        ts: seed.acceptedAt,
        hostSessionId: seed.hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        runtimeId: seed.runtimeId,
        runId: seed.runId,
        category: 'turn',
        eventKind: 'turn.accepted',
        replayed: false,
        payload: { authority: 'durable-start-graph' },
      })
      if (seed.correlationJson !== undefined) {
        db.runs.setCorrelationJson(seed.runId, seed.correlationJson)
      }
    } finally {
      db.close()
    }
  }

  async function sweep(): Promise<SweepZombieRunsResponse> {
    const res = await fixture.postJson('/v1/runs/sweep-zombies', {
      olderThan: '30m',
      dryRun: true,
    })
    expect(res.status).toBe(200)
    return (await res.json()) as SweepZombieRunsResponse
  }

  it('does not make an accepted cold-birth run a candidate while its priming turn is running', async () => {
    seedColdBirth({
      runId: 'run-priming-live',
      hostSessionId: 'hsid-priming-live',
      scopeRef: 't07944-priming-live',
      runtimeId: 'rt-priming-live',
      invocationId: 'inv-priming-live',
      operationId: 'op-priming-live',
      // Accepted 75 minutes ago: far past the 30m silence threshold on the
      // run's own clock.
      acceptedAt: isoMinutesAgo(75),
      // But the seat emitted a broker event a minute ago — it is working.
      runtimeActivityAt: isoMinutesAgo(1),
      primingTerminal: false,
    })

    const body = await sweep()

    expect(body.results.map((result) => result.runId)).not.toContain('run-priming-live')
    expect(body.summary.matched).toBe(0)
  })

  it('still ages out a cold-birth run whose runtime went silent, and names the runtime clock', async () => {
    seedColdBirth({
      runId: 'run-priming-silent',
      hostSessionId: 'hsid-priming-silent',
      scopeRef: 't07944-priming-silent',
      runtimeId: 'rt-priming-silent',
      invocationId: 'inv-priming-silent',
      operationId: 'op-priming-silent',
      acceptedAt: isoMinutesAgo(120),
      // Priming never went terminal AND the runtime has been silent for 90
      // minutes: the exemption is a clock swap, not a free pass.
      runtimeActivityAt: isoMinutesAgo(90),
      primingTerminal: false,
    })

    const body = await sweep()

    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({
      runId: 'run-priming-silent',
      status: 'matched',
      observedSource: 'runtime_event',
    })
  })

  it('reads the run clock again once the priming turn is terminal', async () => {
    seedColdBirth({
      runId: 'run-priming-done',
      hostSessionId: 'hsid-priming-done',
      scopeRef: 't07944-priming-done',
      runtimeId: 'rt-priming-done',
      invocationId: 'inv-priming-done',
      operationId: 'op-priming-done',
      acceptedAt: isoMinutesAgo(75),
      runtimeActivityAt: isoMinutesAgo(1),
      primingTerminal: true,
    })

    const body = await sweep()

    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({
      runId: 'run-priming-done',
      status: 'matched',
      // Priming is over: the run's own silence is the honest measure again.
      observedSource: 'event',
    })
  })

  describe('defect 1b — startup recovery of the owed prompt', () => {
    function instance(): HrcServerInstanceForHandlers {
      return server as unknown as HrcServerInstanceForHandlers
    }

    function readRun(runId: string): {
      status: string
      errorCode: string | undefined
      dispatchedInputId: string | undefined
    } {
      const db = openHrcDatabase(fixture.dbPath)
      try {
        const run = db.runs.getByRunId(runId)
        if (!run) throw new Error(`missing run ${runId}`)
        return {
          status: run.status,
          errorCode: run.errorCode,
          dispatchedInputId: run.dispatchedInputId,
        }
      } finally {
        db.close()
      }
    }

    function readTurnFailedPayloads(runId: string): Array<Record<string, unknown>> {
      const db = openHrcDatabase(fixture.dbPath)
      try {
        return db.hrcEvents
          .listByRun(runId, { eventKind: 'turn.failed' })
          .map((event) => (event.payload ?? {}) as Record<string, unknown>)
      } finally {
        db.close()
      }
    }

    it('re-arms the persisted prompt and submits it through the invoke door', async () => {
      const durable = serializeDurableColdBootTurnInput('the caller prompt', {
        dispatchIdempotencyKey: 'idem-t07944',
        submissionDoor: 'invoke',
        origin: { actor: 'agent:mable', kind: 'agent_dm', causationRef: 'EN-03552' },
      })
      seedColdBirth({
        runId: 'run-rearm',
        hostSessionId: 'hsid-rearm',
        scopeRef: 't07944-rearm',
        runtimeId: 'rt-rearm',
        invocationId: 'inv-rearm',
        operationId: 'op-rearm',
        acceptedAt: isoMinutesAgo(5),
        runtimeActivityAt: isoMinutesAgo(1),
        // The priming turn finished during the outage; the prompt was never sent.
        primingTerminal: true,
        correlationJson: durable,
      })

      const submitted: Array<{
        runId: string
        prompt: string
        options: Record<string, unknown>
      }> = []
      const seam = instance() as unknown as Record<string, unknown>
      seam['getHarnessBrokerController'] = () => ({
        seatProbe: async () => ({ ok: true, response: { busy: false } }),
      })
      seam['executeHeadlessBrokerInputTurn'] = async (
        _session: unknown,
        _runtime: HrcRuntimeSnapshot,
        prompt: string,
        runId: string,
        options: Record<string, unknown>
      ) => {
        submitted.push({ runId, prompt, options })
        return new Response('{}')
      }

      await recoverColdBootInputContinuations(instance())

      expect(submitted).toHaveLength(1)
      expect(submitted[0]?.runId).toBe('run-rearm')
      expect(submitted[0]?.prompt).toBe('the caller prompt')
      // The dispatch options are rebuilt from the persisted record, not invented.
      expect(submitted[0]?.options).toMatchObject({
        dispatchIdempotencyKey: 'idem-t07944',
        submissionDoor: 'invoke',
        origin: { actor: 'agent:mable', kind: 'agent_dm', causationRef: 'EN-03552' },
        waitForCompletion: false,
      })
      expect(readRun('run-rearm').status).toBe('accepted')
      expect(readTurnFailedPayloads('run-rearm')).toHaveLength(0)
    })

    it('fails the run positively when the invocation that owed the prompt is gone', async () => {
      seedColdBirth({
        runId: 'run-lost',
        hostSessionId: 'hsid-lost',
        scopeRef: 't07944-lost',
        runtimeId: 'rt-lost',
        invocationId: 'inv-lost',
        operationId: 'op-lost',
        acceptedAt: isoMinutesAgo(5),
        runtimeActivityAt: isoMinutesAgo(4),
        primingTerminal: false,
        correlationJson: serializeDurableColdBootTurnInput('the caller prompt', {
          dispatchIdempotencyKey: undefined,
        }),
        // The runtime did not survive the restart.
        runtimeStatus: 'dead',
      })

      let submits = 0
      const seam = instance() as unknown as Record<string, unknown>
      seam['executeHeadlessBrokerInputTurn'] = async () => {
        submits++
        return new Response('{}')
      }

      await recoverColdBootInputContinuations(instance())

      expect(submits).toBe(0)
      expect(readRun('run-lost')).toMatchObject({
        status: 'failed',
        errorCode: 'cold_input_continuation_lost',
      })
      const payloads = readTurnFailedPayloads('run-lost')
      expect(payloads).toHaveLength(1)
      // Positive: it names what was lost, not "no events for 30 minutes".
      expect(payloads[0]).toMatchObject({
        code: 'cold_input_continuation_lost',
        phase: 'cold-boot-input-recovery',
        reason: 'runtime_unavailable',
      })
    })
  })
})

describe('T-07944 defect 2 — event-consumer catch on an intentional reap', () => {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeSeededFixture()
  })

  afterEach(async () => {
    try {
      await fixture.cleanup()
    } catch {
      // already torn down
    }
  })

  function makeController(logs: { level: string; message: string }[]): HarnessBrokerController {
    return new HarnessBrokerController({
      db: fixture.db,
      now: () => '2026-09-03T00:00:00.000Z',
      serverInstanceId: 'hrc-server-t07944-test',
      logger: {
        info: (message: string) => logs.push({ level: 'info', message }),
        warn: (message: string) => logs.push({ level: 'warn', message }),
        error: (message: string) => logs.push({ level: 'error', message }),
      },
    })
  }

  async function runFailingConsumer(controller: HarnessBrokerController): Promise<void> {
    // Match the real shape: the `for await` throws when the transport the reap
    // tore down goes away.
    const closedTransport: AsyncIterable<InvocationEventEnvelope> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('Broker transport is closed')),
      }),
    }
    ;(
      controller as unknown as {
        consumeEvents: (id: string, events: AsyncIterable<InvocationEventEnvelope>) => void
      }
    ).consumeEvents(RUNTIME_ID, closedTransport)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  function seedOperationRow(status: string): void {
    fixture.db.runtimeOperations.insert({
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      operationKind: 'broker_invocation',
      controller: 'harness-broker',
      startupMethod: 'broker.startInvocationFromRequest',
      status,
      routeDecisionJson: JSON.stringify({ controller: 'harness-broker' }),
      createdAt: '2026-09-02T22:00:00.000Z',
      startedAt: '2026-09-02T22:00:00.000Z',
      updatedAt: '2026-09-02T22:00:00.000Z',
    })
  }

  function crashEventCount(): number {
    return fixture.db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'runtime.crashed').length
  }

  it('emits no runtime.crashed and leaves the operation row un-failed on an operator reap', async () => {
    seedOperationRow('completed')
    // The turn this runtime last ran completed long before the reap.
    fixture.db.runs.markCompleted(RUN_ID, {
      status: 'completed',
      completedAt: '2026-09-02T22:47:00.000Z',
      updatedAt: '2026-09-02T22:47:00.000Z',
    })

    const logs: { level: string; message: string }[] = []
    const controller = makeController(logs)
    // What `dispose(runtimeId, { reason: 'operator_reap' })` records before it
    // stops, disposes and closes the broker transport.
    ;(
      controller as unknown as { markBrokerClosing: (id: string, reason: string) => void }
    ).markBrokerClosing(RUNTIME_ID, 'operator_reap')

    await runFailingConsumer(controller)

    expect(crashEventCount()).toBe(0)
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).not.toBe('crashed')
    expect(fixture.db.runtimeOperations.getByOperationId(OPERATION_ID)?.status).toBe('completed')
    expect(logs.filter((log) => log.level === 'error')).toHaveLength(0)
    expect(logs.map((log) => log.message)).toContain(
      'harness broker event consumer ended on intentional close'
    )
  })

  it('still escalates a consumer failure that no teardown declared', async () => {
    const logs: { level: string; message: string }[] = []
    await runFailingConsumer(makeController(logs))

    expect(crashEventCount()).toBe(1)
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('crashed')
  })

  it('does not attach the crash to a run that had already completed', async () => {
    fixture.db.runs.markCompleted(RUN_ID, {
      status: 'completed',
      completedAt: '2026-09-02T22:47:00.000Z',
      updatedAt: '2026-09-02T22:47:00.000Z',
    })

    const logs: { level: string; message: string }[] = []
    await runFailingConsumer(makeController(logs))

    const crashes = fixture.db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'runtime.crashed')
    expect(crashes).toHaveLength(1)
    expect(crashes[0]?.runtimeId).toBe(RUNTIME_ID)
    // The runtime owns the crash; the completed turn does not.
    expect(crashes[0]?.runId).toBeUndefined()
  })
})

describe('T-07944 defect 2 — invocation.exited that IS the reap finishing', () => {
  let fixture: TestFixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function startAndExit(intentional: boolean): Promise<HarnessBrokerController> {
    const fake = new FakeBrokerClient()
    fake.emitCloseOnClose = true
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerTmuxSummaryReapGraceMs: 0,
      reapBrokerTmuxLease: async () => undefined,
      now: () => NOW,
    })
    const started = await controller.start({ ...makeStartInput(), brokerClient: fake })
    expect(started.ok).toBe(true)

    if (intentional) {
      // What terminate records before it stops the broker. The broker's own
      // `invocation.exited` then arrives as the LAST act of that teardown.
      ;(
        controller as unknown as { markBrokerClosing: (id: string, reason: string) => void }
      ).markBrokerClosing('runtime_w2', 'operator_reap')
    }

    fake.events.push(
      envelope(
        'invocation.exited',
        9,
        { exitCode: 0, signal: null, reason: 'operator_reap' },
        { invocationId: 'invocation_w2' as InvocationEventEnvelope['invocationId'] }
      )
    )
    await tick()
    await tick()
    return controller
  }

  function terminalEvents(kind: string) {
    return fixture.db.hrcEvents
      .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
      .filter((event) => event.eventKind === kind)
  }

  it('classifies a reap-driven exit as terminated, with no crash and no error code', async () => {
    await startAndExit(true)

    expect(terminalEvents('runtime.crashed')).toHaveLength(0)
    const terminated = terminalEvents('runtime.terminated')
    expect(terminated).toHaveLength(1)
    expect(terminated[0]?.errorCode).toBeUndefined()
    expect(terminated[0]).toMatchObject({
      payload: {
        reason: 'operator_initiated_teardown',
        operatorCloseReason: 'operator_reap',
      },
    })
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('terminated')
  })

  it('still classifies an unannounced exit as a crash', async () => {
    await startAndExit(false)

    expect(terminalEvents('runtime.terminated')).toHaveLength(0)
    const crashes = terminalEvents('runtime.crashed')
    expect(crashes).toHaveLength(1)
    expect(crashes[0]?.errorCode).toBe('runtime_unavailable')
    expect(crashes[0]).toMatchObject({
      payload: { reason: 'broker_invocation_abnormal_terminal' },
    })
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.status).toBe('crashed')
  })
})
