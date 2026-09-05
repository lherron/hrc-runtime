import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SeatProbeRequest, SeatProbeResponse } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import {
  BROKER_CLOSE_OUTPUT_TAIL_BYTES,
  buildBrokerCloseDiagnostic,
  getBrokerDispatchDiagnostics,
  projectBrokerDispatchInspectView,
  recordBrokerEventMilestones,
} from '../broker/dispatch-observability'
import { envelope, inputId, turnId } from './broker-event-mapper-fixtures'
import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  makeFixture,
  makeStartInput,
  tick,
} from './fixtures/broker-controller.fixture'

let fixture: TestFixture
let controller: HarnessBrokerController | undefined

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  controller?.shutdown()
  await fixture.cleanup()
})

describe('broker dispatch observability', () => {
  it('persists seat transitions and warns once for a stuck non-dispatchable seat without input', async () => {
    const fake = new FakeBrokerClient()
    let seat: SeatProbeResponse['seat'] = { state: 'starting' }
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat,
      brokerHeldDepth: 0,
    })
    let now = NOW
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = []
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerSeatProbeIntervalMs: 5,
      brokerDispatchStallThresholdMs: 1_000,
      now: () => now,
      logger: {
        warn(event, fields) {
          warnings.push({ event, fields })
        },
      },
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })
    await tick()

    now = '2026-05-27T12:34:58.000Z'
    await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(warnings.filter((entry) => entry.event === 'broker.seat.stalled')).toHaveLength(1)
    const stalled = fixture.db.events
      .listFromSeq(1, { runtimeId: 'runtime_w2' })
      .filter((event) => event.eventKind === 'broker.seat.stalled')
    expect(stalled).toHaveLength(1)

    seat = { state: 'idle' }
    now = '2026-05-27T12:34:59.000Z'
    await new Promise((resolve) => setTimeout(resolve, 15))
    const diagnostics = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')
    expect(diagnostics?.seatTransitions?.map((entry) => entry.nextState)).toEqual([
      'starting',
      'idle',
    ])
    expect(diagnostics?.liveSeatProbe).toMatchObject({ availability: 'current', state: 'idle' })
  })

  it('records accepted, harness handoff, turn start, and explicit turn origins', async () => {
    const fake = new FakeBrokerClient()
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })
    const accepted = await controller.invoke({
      runtimeId: 'runtime_w2',
      runId: 'run_w2',
      submissionDoor: 'invoke',
      origin: { principalRef: 'agent:cody' },
      body: 'diagnostic probe',
    })
    expect(accepted).toMatchObject({ ok: true, response: { admission: 'admitted' } })
    fixture.db.runs.update('run_w2', {
      brokerSubmissionId: 'submission_invoke',
      dispatchedInputId: 'submission_invoke',
      updatedAt: NOW,
    })
    fake.events.push(
      envelope(
        'input.accepted',
        1,
        { inputId: inputId('submission_invoke'), disposition: 'started' },
        { invocationId: 'invocation_w2' as never, inputId: inputId('submission_invoke') }
      )
    )
    fake.events.push(
      envelope(
        'turn.started',
        2,
        { turnId: turnId('turn-observed') },
        {
          invocationId: 'invocation_w2' as never,
          inputId: inputId('submission_invoke'),
          turnId: turnId('turn-observed'),
        }
      )
    )
    await tick()
    await tick()

    let diagnostics = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')
    expect(diagnostics?.submissions?.at(-1)).toMatchObject({
      submissionId: 'submission_invoke',
      runId: 'run_w2',
      lastMilestone: 'turn_started',
      handedToHarnessAt: expect.any(String),
      turnStartedAt: expect.any(String),
      turnId: 'turn-observed',
    })
    expect(diagnostics?.turns?.at(-1)).toMatchObject({
      turnId: 'turn-observed',
      origin: 'hrc-dispatched',
      runId: 'run_w2',
    })

    const interactiveRuntime = fixture.db.runtimes.getByRuntimeId('runtime_w2')!
    fixture.db.runtimes.update('runtime_w2', {
      runtimeStateJson: {
        ...(interactiveRuntime.runtimeStateJson ?? {}),
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: {
            kind: 'tmux-tui',
            tuiWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
            operatorAttachTarget: true,
          },
        },
      },
      updatedAt: NOW,
    })
    recordBrokerEventMilestones({
      db: fixture.db,
      logger: {},
      runtimeId: 'runtime_w2',
      envelope: envelope(
        'turn.started',
        3,
        { turnId: turnId('turn-local') },
        {
          invocationId: 'invocation_w2' as never,
          turnId: turnId('turn-local'),
        }
      ),
      observedAt: NOW,
    })
    diagnostics = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')
    expect(diagnostics?.turns?.at(-1)).toMatchObject({
      turnId: 'turn-local',
      origin: 'local-interactive',
      runId: null,
    })

    const headlessRuntime = fixture.db.runtimes.getByRuntimeId('runtime_w2')!
    fixture.db.runtimes.update('runtime_w2', {
      runtimeStateJson: {
        ...(headlessRuntime.runtimeStateJson ?? {}),
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: { kind: 'none' },
        },
      },
      updatedAt: NOW,
    })
    recordBrokerEventMilestones({
      db: fixture.db,
      logger: {},
      runtimeId: 'runtime_w2',
      envelope: envelope(
        'turn.started',
        4,
        { turnId: turnId('turn-unknown') },
        {
          invocationId: 'invocation_w2' as never,
          turnId: turnId('turn-unknown'),
        }
      ),
      observedAt: NOW,
    })
    expect(getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.turns?.at(-1)).toMatchObject({
      turnId: 'turn-unknown',
      origin: 'unknown',
      runId: null,
    })
  })

  it('warns once when an accepted submission never reaches turn.started', async () => {
    const fake = new FakeBrokerClient()
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat: { state: 'starting' },
      brokerHeldDepth: 0,
    })
    let now = NOW
    const warnings: string[] = []
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      brokerDispatchStallThresholdMs: 1_000,
      now: () => now,
      logger: { warn: (event) => warnings.push(event) },
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })
    await controller.invoke({
      runtimeId: 'runtime_w2',
      runId: 'run_w2',
      submissionDoor: 'invoke',
      origin: { principalRef: 'agent:cody' },
      body: 'never starts',
    })
    now = '2026-05-27T12:34:58.000Z'
    await controller.seatProbe('runtime_w2')
    await controller.seatProbe('runtime_w2')

    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toHaveLength(1)
    expect(
      fixture.db.events
        .listFromSeq(1, { runtimeId: 'runtime_w2' })
        .filter((event) => event.eventKind === 'broker.submission.stalled')
    ).toHaveLength(1)
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.at(-1)
    ).toMatchObject({ lastMilestone: 'accepted', stalledWarnedAt: '2026-05-27T12:34:58.000Z' })
  })

  it('projects matching, divergent, stale, and unavailable inspect states', () => {
    const base = {
      runtimeProjection: 'ready',
      invocationProjection: 'ready',
    }
    const observation = {
      availability: 'current' as const,
      state: 'idle' as const,
      observedAt: NOW,
      invocationId: 'invocation_w2',
      brokerHeldDepth: 0,
      cause: 'test',
    }
    expect(
      projectBrokerDispatchInspectView({ ...base, liveSeatProbe: observation }).agreement
    ).toBe('agree')
    expect(
      projectBrokerDispatchInspectView({
        ...base,
        liveSeatProbe: { ...observation, state: 'starting' },
      }).agreement
    ).toBe('disagree')
    expect(
      projectBrokerDispatchInspectView({
        ...base,
        liveSeatProbe: { ...observation, availability: 'stale' },
      }).agreement
    ).toBe('stale')
    expect(
      projectBrokerDispatchInspectView({
        ...base,
        liveSeatProbe: { ...observation, availability: 'unavailable', state: null },
      }).agreement
    ).toBe('unavailable')
  })

  it('retains bounded redacted close evidence and explicit process availability', async () => {
    const fake = new FakeBrokerClient()
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })
    const ipcDir = join(fixture.dir, 'broker-ipc')
    await mkdir(ipcDir)
    const tokenPath = join(ipcDir, 'attach.token')
    await writeFile(tokenPath, 'not-read')
    await writeFile(
      join(ipcDir, 'broker.err'),
      `${'x'.repeat(BROKER_CLOSE_OUTPUT_TAIL_BYTES + 200)}\napi_key=super-secret-value\ncrash-marker\n`
    )
    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_w2')!
    fixture.db.runtimes.update('runtime_w2', {
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        broker: {
          ...((runtime.runtimeStateJson?.['broker'] as Record<string, unknown>) ?? {}),
          brokerPid: 4242,
          endpoint: { attachTokenRef: { kind: 'file', path: tokenPath, redacted: true } },
        },
      },
      updatedAt: NOW,
    })

    const clean = buildBrokerCloseDiagnostic({
      db: fixture.db,
      runtimeId: 'runtime_w2',
      error: new Error('Broker process exited with exit code 0'),
      observedAt: NOW,
    })
    const nonZero = buildBrokerCloseDiagnostic({
      db: fixture.db,
      runtimeId: 'runtime_w2',
      error: new Error('Broker process exited with exit code 17'),
      observedAt: NOW,
    })
    const signalled = buildBrokerCloseDiagnostic({
      db: fixture.db,
      runtimeId: 'runtime_w2',
      error: new Error('Broker process closed with signal SIGKILL'),
      observedAt: NOW,
    })
    const abrupt = buildBrokerCloseDiagnostic({
      db: fixture.db,
      runtimeId: 'runtime_w2',
      error: new Error('Broker socket closed unexpectedly'),
      observedAt: NOW,
    })

    expect(clean).toMatchObject({ exitCode: 0, signal: null })
    expect(nonZero).toMatchObject({ exitCode: 17, signal: null })
    expect(signalled).toMatchObject({ exitCode: null, signal: 'SIGKILL' })
    expect(abrupt).toMatchObject({
      invocationId: 'invocation_w2',
      invocationPhaseAtClose: 'ready',
      brokerPid: 4242,
      childPid: null,
      exitCode: null,
      signal: null,
      output: { availability: 'available', source: 'broker-stderr-file', truncated: true },
    })
    expect(abrupt.output.tail).toContain('api_key=[REDACTED]')
    expect(abrupt.output.tail).not.toContain('super-secret-value')
    expect(Buffer.byteLength(abrupt.output.tail ?? '', 'utf8')).toBeLessThanOrEqual(
      BROKER_CLOSE_OUTPUT_TAIL_BYTES
    )
  })
})
