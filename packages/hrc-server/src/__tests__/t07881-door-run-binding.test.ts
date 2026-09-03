import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  InputId,
  InvocationEventEnvelope,
  InvocationId,
  SubmissionId,
  TurnId,
} from 'spaces-harness-broker-protocol'

import { autoReplyCandidateFor } from 'hrc-mail-kicker'
import { observeMailDriveLifecycleEvent } from 'hrc-mail-kicker'
import { executeHeadlessBrokerInputTurn } from '../broker-headless-handlers.js'
import { executeInteractiveBrokerInputTurn } from '../broker-interactive-handlers.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import {
  LANE_REF,
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  makeSeededFixture,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'

const SUBMISSION_ID = 'submission_inv-t07881_1' as SubmissionId
const INPUT_ID = SUBMISSION_ID as InputId
const TURN_ID = 'turn_t07881_1' as TurnId
const RUN_ID = 'run_t07881_mail'
const TARGET = `${TMUX_SCOPE_REF}/lane:${LANE_REF}`
const COUNTERPARTY = 'mable@hcs:primary'
const ROOM = 'T-07881'

function successfulDoorServer(db: HrcDatabase): HrcServerInstanceForHandlers {
  const response = async () => ({
    ok: true as const,
    response: { submissionId: SUBMISSION_ID, admission: 'admitted' as const },
  })
  const controller = {
    steer: response,
    enqueue: response,
    invoke: response,
    preempt: response,
  }
  return {
    db,
    brokerWarmupComplete: Promise.resolve(),
    brokerReattachOperations: new Map(),
    getHarnessBrokerController: () => controller,
    notifyEvent: () => undefined,
    options: { runtimeRoot: '/tmp/hrc-t07881' },
  } as unknown as HrcServerInstanceForHandlers
}

function brokerEnvelope(
  invocationId: InvocationId,
  seq: number,
  type: InvocationEventEnvelope['type'],
  payload: Record<string, unknown>,
  extra: Partial<Pick<InvocationEventEnvelope, 'inputId' | 'turnId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: ts(seq),
    type,
    payload,
    ...extra,
  } as InvocationEventEnvelope
}

describe('T-07881 door-dispatched run persistence', () => {
  let fixture: SeededFixture

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('writes the door submission token as dispatched_input_id on the headless path', async () => {
    fixture = await makeSeededFixture()
    fixture.db.runtimes.update('runtime_broker_w3a', {
      activeInvocationId: 'invocation_broker_w3a',
      updatedAt: ts(0),
    })
    const run = fixture.db.runs.getByRunId('run_broker_w3a')
    const runtime = fixture.db.runtimes.getByRuntimeId('runtime_broker_w3a')
    const session = fixture.db.sessions.getByHostSessionId('hsid_broker_w3a')
    expect(run).not.toBeNull()
    expect(runtime).not.toBeNull()
    expect(session).not.toBeNull()

    await executeHeadlessBrokerInputTurn.call(
      successfulDoorServer(fixture.db),
      session!,
      runtime!,
      'door-dispatched headless input',
      run!.runId,
      { waitForCompletion: false, submissionDoor: 'enqueue' }
    )

    expect(fixture.db.runs.getByRunId(run!.runId)).toMatchObject({
      brokerSubmissionId: SUBMISSION_ID,
      dispatchedInputId: SUBMISSION_ID,
    })
  })

  it('writes the door submission token as dispatched_input_id on the interactive path', async () => {
    fixture = await makeTmuxSeededFixture()
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
      activeInvocationId: TMUX_INVOCATION_ID,
      updatedAt: ts(0),
    })
    const runtime = fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)
    const session = fixture.db.sessions.getByHostSessionId(TMUX_HOST_SESSION_ID)
    expect(runtime).not.toBeNull()
    expect(session).not.toBeNull()

    await executeInteractiveBrokerInputTurn.call(
      successfulDoorServer(fixture.db),
      session!,
      runtime!,
      'door-dispatched interactive input',
      RUN_ID,
      { waitForCompletion: false, submissionDoor: 'enqueue' }
    )

    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({
      brokerSubmissionId: SUBMISSION_ID,
      dispatchedInputId: SUBMISSION_ID,
    })
  })

  it('dispatches a cold interactive door run that controller startup already preaccepted', async () => {
    fixture = await makeTmuxSeededFixture()
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
      activeInvocationId: TMUX_INVOCATION_ID,
      updatedAt: ts(0),
    })
    const runtime = fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)
    const session = fixture.db.sessions.getByHostSessionId(TMUX_HOST_SESSION_ID)
    expect(runtime).not.toBeNull()
    expect(session).not.toBeNull()

    fixture.db.runs.insert({
      runId: RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
    })

    await executeInteractiveBrokerInputTurn.call(
      successfulDoorServer(fixture.db),
      session!,
      runtime!,
      'cold door input after controller acceptance',
      RUN_ID,
      { waitForCompletion: false, submissionDoor: 'invoke' }
    )

    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'accepted',
      runtimeId: TMUX_RUNTIME_ID,
      invocationId: TMUX_INVOCATION_ID,
      brokerSubmissionId: SUBMISSION_ID,
      dispatchedInputId: SUBMISSION_ID,
    })
  })
})

describe('T-07881 hook-observed mail turn binding', () => {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeTmuxSeededFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('falls back to broker_submission_id, stamps the run, and mints the auto-reply intent', () => {
    const db = fixture.db
    const runtime = db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID) as HrcRuntimeSnapshot
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
      invocationId: TMUX_INVOCATION_ID,
      operationId: runtime.activeOperationId,
      brokerSubmissionId: SUBMISSION_ID,
      // Historical §10.4 rows have no dispatched_input_id. This forces the
      // resolver's broker_submission_id fallback instead of the repaired write.
    })

    const ledger = new FakeWrkqLedger()
    const source = ledger.say({
      toScopeRef: TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:mable',
      roomKey: ROOM,
      body: 'exercise the hook-observed reply-is-ack path',
    })
    const candidate = autoReplyCandidateFor([source])
    expect(candidate).toBeDefined()
    const driveAttemptId = 'drive-t07881'
    db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [source.id] },
      { driveAttemptId, runId: RUN_ID }
    )
    db.mailDrives.presentForAttempt(driveAttemptId, [source.id])
    db.mailDrives.recordAutoReplyCandidate(driveAttemptId, candidate!)

    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const observer = {
      db,
      mailKickerLapsedRuntimes: new Set<string>(),
      wake: () => {
        db.mailDrives.completeStartedAttempt(RUN_ID, 'turn.completed')
      },
    } as unknown as HrcServerInstanceForHandlers
    const applyAndObserve = (event: InvocationEventEnvelope) => {
      const projected = mapper.apply(event)
      for (const lifecycle of projected.lifecycleEvents) {
        observeMailDriveLifecycleEvent.call(observer, lifecycle)
      }
      return projected
    }

    applyAndObserve(
      brokerEnvelope(
        TMUX_INVOCATION_ID,
        25,
        'input.accepted',
        { inputId: INPUT_ID },
        { inputId: INPUT_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        TMUX_INVOCATION_ID,
        26,
        'turn.started',
        { turnId: TURN_ID, source: 'hook-observed' },
        { inputId: INPUT_ID, turnId: TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        TMUX_INVOCATION_ID,
        27,
        'submission.executed',
        { submissionId: SUBMISSION_ID, turnId: TURN_ID },
        { turnId: TURN_ID }
      )
    )
    appendHrcEvent(db, 'turn.message', {
      ts: ts(28),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      runId: RUN_ID,
      runtimeId: TMUX_RUNTIME_ID,
      transport: 'tmux',
      payload: { message: { role: 'assistant', content: 'automatic reply from the driven turn' } },
    })
    applyAndObserve(
      brokerEnvelope(
        TMUX_INVOCATION_ID,
        29,
        'turn.completed',
        { turnId: TURN_ID, status: 'completed' },
        { turnId: TURN_ID }
      )
    )

    expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
      brokerSubmissionId: SUBMISSION_ID,
      startedAt: ts(26),
      completedAt: ts(29),
      status: 'completed',
    })
    expect(db.mailDrives.getAutoReplyIntent(driveAttemptId)).toMatchObject({
      driveAttemptId,
      runId: RUN_ID,
      state: 'pending',
      sourceEnvelopeIds: [source.id],
    })
    expect(
      db.hrcEvents
        .listByRun(RUN_ID, { eventKind: 'turn.message' })
        .some((event) =>
          JSON.stringify(event.payload).includes('automatic reply from the driven turn')
        )
    ).toBe(true)
  })
})
