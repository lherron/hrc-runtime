import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { hasUnsettledAbsorbedAuxiliary } from '../broker/turn-ownership'
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

// A steer absorbed into a turn HRC never dispatched (an operator prompt or a
// Claude task-notification, recorded as human_submission_*) has no owner run
// to coalesce into. Recorded on rt-8c634550 (2026-10-09): such steers stayed
// `accepted` until active-run reconcile failed them as run_abandoned_by_runtime,
// which left a quiescent seat looking failed. The unowned turn's own terminal
// is the steer's terminal.

const TURN = 'turn-t10686-unowned'
const HUMAN_SUBMISSION = 'human_submission_t10686_1'
const STEER = 'submission-t10686-steer'
const STEER_RUN = 'run-t10686-steer'

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

function seedSteerRun(fixture: SeededFixture): void {
  fixture.db.runs.insert({
    runId: STEER_RUN,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: ts(),
    updatedAt: ts(),
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    dispatchedInputId: STEER,
    brokerSubmissionId: STEER,
  })
}

function unownedTurnAbsorbsSteer(mapper: BrokerEventMapper): void {
  mapper.apply(event('turn.started', 1, { turnId: TURN }, { turnId: TURN as never }))
  mapper.apply(
    event(
      'submission.executed',
      2,
      { submissionId: HUMAN_SUBMISSION, turnId: TURN },
      { turnId: TURN as never }
    )
  )
  mapper.apply(event('admission.admitted', 3, { submissionId: STEER, class: 'steer' }))
  mapper.apply(
    event(
      'submission.absorbed',
      4,
      { submissionId: STEER, turnId: TURN },
      { turnId: TURN as never }
    )
  )
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  seedSteerRun(fixture)
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    activeInvocationId: TMUX_INVOCATION_ID,
    status: 'ready',
    runtimeStateJson: { status: 'ready' },
    updatedAt: ts(),
  })
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-10686 steer absorbed into an unowned turn', () => {
  it('completes with the unowned turn and leaves the runtime idle', () => {
    unownedTurnAbsorbsSteer(mapper)
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('accepted')

    mapper.apply(
      event(
        'turn.completed',
        5,
        { turnId: TURN, status: 'completed', producedContent: true },
        { turnId: TURN as never }
      )
    )

    expect(fixture.db.runs.getByRunId(STEER_RUN)).toMatchObject({
      status: 'completed',
      completedAt: ts(5),
      startedAt: undefined,
    })
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'ready',
      activeRunId: undefined,
    })
    expect(hasUnsettledAbsorbedAuxiliary(fixture.db, TMUX_RUNTIME_ID)).toBe(false)
  })

  it('carries a failed or interrupted unowned turn outcome to the steer', () => {
    unownedTurnAbsorbsSteer(mapper)
    mapper.apply(event('turn.interrupted', 5, { turnId: TURN }, { turnId: TURN as never }))
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('cancelled')
  })

  it('replays the terminal idempotently', () => {
    unownedTurnAbsorbsSteer(mapper)
    const completed = event(
      'turn.completed',
      5,
      { turnId: TURN, status: 'completed', producedContent: true },
      { turnId: TURN as never }
    )
    mapper.apply(completed)
    expect(mapper.apply(completed).idempotent).toBe(true)
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('completed')
  })
})
