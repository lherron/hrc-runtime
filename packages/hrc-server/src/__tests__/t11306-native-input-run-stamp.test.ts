import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { launchCarriedInvokeCorrelationJson } from '../server-types'
import {
  LANE_REF,
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_OPERATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

// T-11306 C: on rt-6c72fc90 the broker admitted its own input `input_…_8`
// (origin legacy:invocation.input, no HRC dispatch). With no run for that id,
// resolution fell back to invocation.runId, the invocation's FIRST run, which
// had completed the day before: input.accepted, submission.executed and the
// steer's admission.requested were all stamped run-2abda06a, and each bumped its
// updated_at. A broker-native input belongs to no HRC run.

const FIRST_RUN = 'run-t11306-first'
const FIRST_SUBMISSION = 'submission_t11306_1'
const NATIVE_INPUT = 'input_t11306_8'
const STEER = 'submission_t11306_3'
const TURN = 'turn_t11306_9'
const LEGACY_ORIGIN = { principalRef: 'legacy:invocation.input' }

function event(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: Partial<InvocationEventEnvelope> = {}
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

function seedFirstRun(options: { completed: boolean; launchCarried?: boolean }): void {
  fixture.db.runs.insert({
    runId: FIRST_RUN,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    status: options.completed ? 'completed' : 'accepted',
    acceptedAt: ts(),
    updatedAt: ts(),
    ...(options.completed ? { startedAt: ts(), completedAt: ts() } : {}),
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    ...(options.launchCarried
      ? {}
      : { dispatchedInputId: FIRST_SUBMISSION, brokerSubmissionId: FIRST_SUBMISSION }),
  })
  if (options.launchCarried) {
    fixture.db.runs.setCorrelationJson(FIRST_RUN, launchCarriedInvokeCorrelationJson())
  }
  fixture.db.brokerInvocations.update(TMUX_INVOCATION_ID, { runId: FIRST_RUN, updatedAt: ts() })
}

function nativeTurnWithSteer(): void {
  mapper.apply(
    event('admission.requested', 1, {
      submissionId: NATIVE_INPUT,
      class: 'exclusive',
      origin: LEGACY_ORIGIN,
      turnPolicy: 'open',
    })
  )
  mapper.apply(event('admission.admitted', 2, { submissionId: NATIVE_INPUT, class: 'exclusive' }))
  mapper.apply(
    event(
      'input.accepted',
      3,
      { inputId: NATIVE_INPUT, disposition: 'started' },
      {
        inputId: NATIVE_INPUT as never,
      }
    )
  )
  mapper.apply(
    event(
      'turn.started',
      4,
      { turnId: TURN, source: 'broker-delivery', inputId: NATIVE_INPUT },
      { turnId: TURN as never, inputId: NATIVE_INPUT as never }
    )
  )
  mapper.apply(
    event(
      'submission.executed',
      5,
      { submissionId: NATIVE_INPUT, turnId: TURN },
      { turnId: TURN as never, inputId: NATIVE_INPUT as never }
    )
  )
  mapper.apply(
    event('admission.requested', 6, {
      submissionId: STEER,
      class: 'steer',
      origin: { principalRef: 'agent:clod' },
    })
  )
}

function stampedRunIds(): Record<string, string | null> {
  const rows = fixture.db.sqlite
    .query<{ seq: number; type: string; runId: string | null }, [string]>(
      'SELECT seq, type, run_id AS runId FROM broker_invocation_events WHERE invocation_id = ? ORDER BY seq'
    )
    .all(TMUX_INVOCATION_ID)
  return Object.fromEntries(rows.map((row) => [`${row.seq}:${row.type}`, row.runId]))
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(50) })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-11306 broker-native input carries no HRC run', () => {
  it('stamps no run on the native input or a steer admitted inside its turn', () => {
    seedFirstRun({ completed: true })
    nativeTurnWithSteer()

    expect(stampedRunIds()).toEqual({
      '1:admission.requested': null,
      '2:admission.admitted': null,
      '3:input.accepted': null,
      '4:turn.started': null,
      '5:submission.executed': null,
      '6:admission.requested': null,
    })
    expect(fixture.db.runs.getByRunId(FIRST_RUN)?.updatedAt).toBe(ts())
  })

  it('still attributes a launch-carried first input to the open launch run', () => {
    seedFirstRun({ completed: false, launchCarried: true })
    nativeTurnWithSteer()
    expect(stampedRunIds()['3:input.accepted']).toBe(FIRST_RUN)
  })
})
