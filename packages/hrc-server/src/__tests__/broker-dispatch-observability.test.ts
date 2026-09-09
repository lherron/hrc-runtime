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
  function diagnosticEvents(eventKind: string) {
    return fixture.db.hrcEvents
      .listFromHrcSeq(1, { runtimeId: 'runtime_w2' })
      .filter((event) => event.eventKind === eventKind)
  }

  it('maps invoke to queue when the runtime lacks exclusive and records both facts', async () => {
    const fake = new FakeBrokerClient()
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })
    const invocation = fixture.db.brokerInvocations.getByInvocationId('invocation_w2')!
    const capabilities = JSON.parse(invocation.capabilitiesJson) as {
      admission: { classes: string[] }
    }
    capabilities.admission.classes = ['steer', 'queue']
    fixture.db.brokerInvocations.update('invocation_w2', {
      capabilitiesJson: JSON.stringify(capabilities),
      updatedAt: NOW,
    })

    const result = await controller.invoke({
      runtimeId: 'runtime_w2',
      runId: 'run_w2',
      submissionDoor: 'invoke',
      origin: { principalRef: 'agent:cody' },
      body: 'wait behind the current turn',
    })

    expect(result).toMatchObject({
      ok: true,
      response: { submissionId: 'submission_enqueue', admission: 'admitted' },
    })
    expect(fake.callOrder).toContain('enqueue')
    expect(fake.callOrder).not.toContain('invoke')
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.at(-1)
    ).toMatchObject({
      submissionId: 'submission_enqueue',
      door: 'invoke',
      admissionClass: 'queue',
    })
  })

  it('keeps invoke on exclusive when the runtime advertises it', async () => {
    const fake = new FakeBrokerClient()
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })

    const result = await controller.invoke({
      runtimeId: 'runtime_w2',
      runId: 'run_w2',
      submissionDoor: 'invoke',
      origin: { principalRef: 'agent:cody' },
      body: 'start immediately',
    })

    expect(result).toMatchObject({
      ok: true,
      response: { submissionId: 'submission_invoke', admission: 'admitted' },
    })
    expect(fake.callOrder).toContain('invoke')
    expect(fake.callOrder).not.toContain('enqueue')
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.at(-1)
    ).toMatchObject({
      submissionId: 'submission_invoke',
      door: 'invoke',
      admissionClass: 'exclusive',
    })
  })

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
    const stalled = diagnosticEvents('broker.seat.stalled')
    expect(stalled).toHaveLength(1)
    expect(diagnosticEvents('broker.seat.transition')).toHaveLength(1)

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

  it('accepts and records a turn-observed seat with its provider turn id', async () => {
    const fake = new FakeBrokerClient()
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat: { state: 'turn-observed', turnId: turnId('turn-awaiting-attribution') },
      brokerHeldDepth: 1,
    })
    controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
    })
    await controller.start({ ...makeStartInput(), brokerClient: fake })

    const response = await controller.seatProbe('runtime_w2')

    expect(response).toMatchObject({
      ok: true,
      response: {
        seat: { state: 'turn-observed', turnId: 'turn-awaiting-attribution' },
        brokerHeldDepth: 1,
      },
    })
    expect(getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.liveSeatProbe).toMatchObject({
      state: 'turn-observed',
      turnId: 'turn-awaiting-attribution',
    })
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
    expect(diagnosticEvents('broker.submission.milestone').map((event) => event.category)).toEqual([
      'input',
      'input',
      'input',
    ])
    expect(diagnosticEvents('broker.turn.origin')).toMatchObject([
      { category: 'turn', runId: 'run_w2' },
    ])

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
    expect(diagnosticEvents('broker.submission.stalled')).toHaveLength(1)
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.at(-1)
    ).toMatchObject({ lastMilestone: 'accepted', stalledWarnedAt: '2026-05-27T12:34:58.000Z' })
  })

  /**
   * T-08108: a steer's last milestone IS `handed_to_harness`.
   *
   * It joins a turn already running and originates none of its own, so it can
   * never report a `turn.started` of its own. Before this, the detector warned
   * about every healthy steer at the threshold — observed on max3, 60 s after a
   * delivery that had already reached the pane and been read.
   */
  async function steerAndProbe(options: { handToHarness: boolean }): Promise<string[]> {
    const fake = new FakeBrokerClient()
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat: { state: 'turn-active', turnId: turnId('turn-live') },
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
    const steered = await controller.steer({
      runtimeId: 'runtime_w2',
      runId: 'run_steer',
      origin: { principalRef: 'agent:clod' },
      body: 'steered into a live turn',
    })
    if (options.handToHarness && steered.ok) {
      recordBrokerEventMilestones({
        db: fixture.db,
        logger: {},
        runtimeId: 'runtime_w2',
        envelope: envelope(
          'input.accepted',
          5,
          { inputId: inputId(steered.response.submissionId) },
          { invocationId: 'invocation_w2' as never }
        ),
        observedAt: NOW,
      })
    }
    now = '2026-05-27T12:34:58.000Z'
    await controller.seatProbe('runtime_w2')
    await controller.seatProbe('runtime_w2')
    return warnings
  }

  it('never calls a steer stalled once it reached the harness', async () => {
    const warnings = await steerAndProbe({ handToHarness: true })
    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toEqual([])
    expect(diagnosticEvents('broker.submission.stalled')).toHaveLength(0)
  })

  it('still calls a steer stalled when it never reached the harness', async () => {
    // The exemption is for a steer that LANDED, not for the door. A steer stuck
    // at `accepted` is the case this detector exists for.
    const warnings = await steerAndProbe({ handToHarness: false })
    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toHaveLength(1)
  })

  /**
   * T-08333: a QUEUED submission that already EXECUTED is not stalled.
   *
   * Frozen evidence (var/wrkq-artifacts/T-08296/quasar-audit, C-21096/C-21097):
   * four queued submissions across BOTH drivers executed and were then reported
   * `broker.submission.stalled` roughly 60 s after ACCEPTANCE, each carrying
   * `lastCompletedMilestone: "handed_to_harness"` — astra _53 while its own
   * payload said seatState idle / invocationPhase ready. Their `turn.started`
   * envelopes carry no inputId, so the tracker never advanced past
   * `handed_to_harness`; the correlation it needed was in the
   * `submission.executed` payload, which it did not read.
   *
   * This reproduces that exact shape: queue admission -> inputId-less observed
   * start -> correlated execution, with the unexecuted control on the same path.
   */
  async function queuedSubmissionAndProbe(options: {
    landing?:
      | { type: 'submission.executed' | 'submission.absorbed'; submissionId: string }
      | undefined
  }): Promise<{
    warnings: string[]
    stalled: ReturnType<typeof diagnosticEvents>
  }> {
    const fake = new FakeBrokerClient()
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat: { state: 'idle' },
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
    const invocation = fixture.db.brokerInvocations.getByInvocationId('invocation_w2')!
    const capabilities = JSON.parse(invocation.capabilitiesJson) as {
      admission: { classes: string[] }
    }
    capabilities.admission.classes = ['steer', 'queue']
    fixture.db.brokerInvocations.update('invocation_w2', {
      capabilitiesJson: JSON.stringify(capabilities),
      updatedAt: NOW,
    })
    const admitted = await controller.invoke({
      runtimeId: 'runtime_w2',
      runId: 'run_w2',
      submissionDoor: 'invoke',
      origin: { principalRef: 'agent:astra' },
      body: 'queued behind the current turn',
    })
    expect(admitted).toMatchObject({
      ok: true,
      response: { submissionId: 'submission_enqueue', admission: 'admitted' },
    })
    fixture.db.runs.update('run_w2', {
      brokerSubmissionId: 'submission_enqueue',
      dispatchedInputId: 'submission_enqueue',
      updatedAt: NOW,
    })
    fake.events.push(
      envelope(
        'input.accepted',
        1,
        { inputId: inputId('submission_enqueue'), disposition: 'queued' },
        { invocationId: 'invocation_w2' as never, inputId: inputId('submission_enqueue') }
      )
    )
    // The audit shape: `turn.started` carries only {turnId, source, sessionId}.
    // No inputId on the envelope and none in the payload.
    fake.events.push(
      envelope(
        'turn.started',
        2,
        { turnId: turnId('turn-executed') },
        { invocationId: 'invocation_w2' as never, turnId: turnId('turn-executed') }
      )
    )
    if (options.landing !== undefined) {
      fake.events.push(
        envelope(
          options.landing.type,
          3,
          { submissionId: options.landing.submissionId, turnId: turnId('turn-executed') },
          { invocationId: 'invocation_w2' as never }
        )
      )
    }
    await tick()
    await tick()
    await tick()
    now = '2026-05-27T12:34:58.000Z'
    await controller.seatProbe('runtime_w2')
    await controller.seatProbe('runtime_w2')
    return {
      warnings: warnings.filter((event) => event === 'broker.submission.stalled'),
      stalled: diagnosticEvents('broker.submission.stalled'),
    }
  }

  it('never calls an executed queued submission stalled', async () => {
    const observed = await queuedSubmissionAndProbe({
      landing: { type: 'submission.executed', submissionId: 'submission_enqueue' },
    })
    expect(observed.warnings).toEqual([])
    expect(observed.stalled).toHaveLength(0)
    const submission = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
      (entry) => entry.submissionId === 'submission_enqueue'
    )
    expect(submission).toMatchObject({
      admissionClass: 'queue',
      lastMilestone: 'turn_started',
      turnId: 'turn-executed',
      turnStartedAt: expect.any(String),
    })
    expect(submission?.stalledWarnedAt).toBeUndefined()
  })

  it('does not let one submission execution settle another input', async () => {
    // Identity is the whole exemption. An execution that names a DIFFERENT
    // submission is unrelated evidence and must leave this one exposed.
    const observed = await queuedSubmissionAndProbe({
      landing: { type: 'submission.executed', submissionId: 'submission_unrelated' },
    })
    expect(observed.warnings).toHaveLength(1)
    const submissions = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions ?? []
    expect(submissions.find((entry) => entry.submissionId === 'submission_enqueue')).toMatchObject({
      lastMilestone: 'handed_to_harness',
      turnStartedAt: null,
      stalledWarnedAt: '2026-05-27T12:34:58.000Z',
    })
    expect(
      submissions.find((entry) => entry.submissionId === 'submission_unrelated')
    ).toMatchObject({ lastMilestone: 'turn_started', turnStartedAt: expect.any(String) })
  })

  it('keeps the first observed start when execution evidence repeats or arrives late', async () => {
    const fake = new FakeBrokerClient()
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat: { state: 'idle' },
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
      origin: { principalRef: 'agent:astra' },
      body: 'warned, then executed',
    })

    // A legitimate warning first: nothing had reached the harness by the
    // threshold, which is exactly what this detector exists for.
    now = '2026-05-27T12:34:58.000Z'
    await controller.seatProbe('runtime_w2')
    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toHaveLength(1)

    const executed = (observedAt: string, seq: number) =>
      recordBrokerEventMilestones({
        db: fixture.db,
        logger: {},
        runtimeId: 'runtime_w2',
        envelope: envelope(
          'submission.executed',
          seq,
          { submissionId: 'submission_invoke', turnId: turnId('turn-late') },
          { invocationId: 'invocation_w2' as never }
        ),
        observedAt,
      })

    executed('2026-05-27T12:35:10.000Z', 9)
    // Replay/duplicate execution is inert: the recorded start stays the first
    // one observed rather than drifting forward to the replay's timestamp.
    executed('2026-05-27T12:36:40.000Z', 10)

    now = '2026-05-27T12:37:00.000Z'
    await controller.seatProbe('runtime_w2')
    // The earlier warning is not retracted and no second one is emitted.
    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toHaveLength(1)
    expect(diagnosticEvents('broker.submission.stalled')).toHaveLength(1)
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
        (entry) => entry.submissionId === 'submission_invoke'
      )
    ).toMatchObject({
      lastMilestone: 'turn_started',
      turnStartedAt: '2026-05-27T12:35:10.000Z',
      turnId: 'turn-late',
      stalledWarnedAt: '2026-05-27T12:34:58.000Z',
    })
  })

  /**
   * T-08333 (astra clarification): the same approved false-stall class covers a
   * QUEUE-door submission that is ABSORBED — merged into a turn that is already
   * running. `landing.ts` already treats `submission.absorbed` and
   * `submission.executed` alike as landed evidence; the stall tracker treated
   * neither as landed, and the T-08108 carve-out reaches absorbed submissions
   * only when the door happens to be `steer`.
   *
   * Absorption is NOT a turn start. It joins an existing turn and originates
   * none of its own, so it must settle the delivery-stall condition WITHOUT
   * stamping a turn start or a turn origin.
   */
  it('never calls an absorbed queued submission stalled', async () => {
    const observed = await queuedSubmissionAndProbe({
      landing: { type: 'submission.absorbed', submissionId: 'submission_enqueue' },
    })
    expect(observed.warnings).toEqual([])
    expect(observed.stalled).toHaveLength(0)
  })

  it('records absorption as landing evidence, never as a turn start or origin', async () => {
    await queuedSubmissionAndProbe({
      landing: { type: 'submission.absorbed', submissionId: 'submission_enqueue' },
    })
    const diagnostics = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')
    expect(
      diagnostics?.submissions?.find((entry) => entry.submissionId === 'submission_enqueue')
    ).toMatchObject({
      admissionClass: 'queue',
      // The submission reached the harness and joined a turn. It did not start
      // one, so the milestone stays `handed_to_harness` and no start time or
      // originated turn is asserted.
      lastMilestone: 'handed_to_harness',
      turnStartedAt: null,
      turnId: null,
      absorbedTurnId: 'turn-executed',
      absorbedAt: expect.any(String),
    })
    // Only the observed `turn.started` produces an origin. Absorption adds none.
    expect(diagnosticEvents('broker.turn.origin')).toHaveLength(1)
  })

  it('does not let one submission absorption settle another input', async () => {
    const observed = await queuedSubmissionAndProbe({
      landing: { type: 'submission.absorbed', submissionId: 'submission_unrelated' },
    })
    expect(observed.warnings).toHaveLength(1)
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
        (entry) => entry.submissionId === 'submission_enqueue'
      )
    ).toMatchObject({
      lastMilestone: 'handed_to_harness',
      absorbedAt: null,
      stalledWarnedAt: '2026-05-27T12:34:58.000Z',
    })
  })

  it('keeps the first observed absorption when it repeats or arrives late', async () => {
    const fake = new FakeBrokerClient()
    fake.seatProbe = async (request: SeatProbeRequest) => ({
      invocationId: request.invocationId,
      seat: { state: 'idle' },
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
      origin: { principalRef: 'agent:astra' },
      body: 'warned, then absorbed',
    })

    // A legitimate warning first: nothing had landed by the threshold.
    now = '2026-05-27T12:34:58.000Z'
    await controller.seatProbe('runtime_w2')
    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toHaveLength(1)

    const absorbed = (observedAt: string, seq: number) =>
      recordBrokerEventMilestones({
        db: fixture.db,
        logger: {},
        runtimeId: 'runtime_w2',
        envelope: envelope(
          'submission.absorbed',
          seq,
          { submissionId: 'submission_invoke', turnId: turnId('turn-joined') },
          { invocationId: 'invocation_w2' as never }
        ),
        observedAt,
      })

    absorbed('2026-05-27T12:35:10.000Z', 11)
    absorbed('2026-05-27T12:36:40.000Z', 12)

    now = '2026-05-27T12:37:00.000Z'
    await controller.seatProbe('runtime_w2')
    // The earlier warning stands unretracted and no second one is emitted.
    expect(warnings.filter((event) => event === 'broker.submission.stalled')).toHaveLength(1)
    expect(diagnosticEvents('broker.submission.stalled')).toHaveLength(1)
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
        (entry) => entry.submissionId === 'submission_invoke'
      )
    ).toMatchObject({
      lastMilestone: 'handed_to_harness',
      absorbedAt: '2026-05-27T12:35:10.000Z',
      absorbedTurnId: 'turn-joined',
      turnStartedAt: null,
      turnId: null,
      stalledWarnedAt: '2026-05-27T12:34:58.000Z',
    })
  })

  /**
   * The invariant behind reusing `turn_started`/`turnStartedAt` for an executed
   * submission: these are OBSERVATION-time evidence — the moment HRC saw the
   * disposition — never an asserted original start. The helper's landing
   * envelope carries `time` = ts(3) = 2026-05-27T12:00:03Z, roughly 35 minutes
   * BEFORE the observation at NOW. If anything ever backdates the record to the
   * envelope's own clock, this fails.
   */
  it('timestamps landings at observation time, never from the envelope clock', async () => {
    const envelopeTime = '2026-05-27T12:00:03.000Z'
    await queuedSubmissionAndProbe({
      landing: { type: 'submission.executed', submissionId: 'submission_enqueue' },
    })
    const executed = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
      (entry) => entry.submissionId === 'submission_enqueue'
    )
    expect(executed?.turnStartedAt).toBe(NOW)
    expect(executed?.turnStartedAt).not.toBe(envelopeTime)

    await fixture.cleanup()
    fixture = await makeFixture()
    controller?.shutdown()
    await queuedSubmissionAndProbe({
      landing: { type: 'submission.absorbed', submissionId: 'submission_enqueue' },
    })
    const absorbedEntry = getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
      (entry) => entry.submissionId === 'submission_enqueue'
    )
    expect(absorbedEntry?.absorbedAt).toBe(NOW)
    expect(absorbedEntry?.absorbedAt).not.toBe(envelopeTime)
  })

  it('still calls an identical unexecuted queued submission stalled', async () => {
    // The control that makes the exemption a discriminator rather than a
    // blanket suppression: same door, same admission class, same inputId-less
    // observed start — only the correlated execution is missing.
    const observed = await queuedSubmissionAndProbe({})
    expect(observed.warnings).toHaveLength(1)
    expect(observed.stalled).toHaveLength(1)
    expect(
      getBrokerDispatchDiagnostics(fixture.db, 'runtime_w2')?.submissions?.find(
        (entry) => entry.submissionId === 'submission_enqueue'
      )
    ).toMatchObject({
      lastMilestone: 'handed_to_harness',
      stalledWarnedAt: '2026-05-27T12:34:58.000Z',
    })
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

    fake.emitClose(new Error('Broker socket closed unexpectedly'))
    await tick()
    expect(diagnosticEvents('broker.socket.closed_unexpectedly')).toMatchObject([
      {
        category: 'runtime',
        payload: {
          invocationPhaseAtClose: 'ready',
          brokerPid: 4242,
          childPid: null,
          exitCode: null,
          signal: null,
        },
      },
    ])
  })
})
