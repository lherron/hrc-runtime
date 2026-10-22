import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
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

// Recorded on rt-eda85bb1 / inv-747fbbd6 (2026-10-22): a steer landed as turn
// _31 ended. The prompt hook opened _32 for it (seq 1123) and the late
// transcript user row opened _33 for the same prompt (seq 1127). Only _33
// stopped, so the steer's run owned the runtime, busy, through five later
// turns. Lance ruling: a turn terminal ends every turn that started before it.

const STEER_RUN = 'run-t11508-steer'
const STEER_INPUT = 'submission-t11508-steer'
const NEXT_RUN = 'run-t11508-next'
const NEXT_INPUT = 'submission-t11508-next'
const ORPHANED = 'turn-t11508-orphaned'
const SERVED = 'turn-t11508-served'
const NEXT = 'turn-t11508-next'

function event(
  type: InvocationEventType,
  seq: number,
  turnId: string,
  payload: Record<string, unknown> = {},
  inputId?: string
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    turnId: turnId as never,
    ...(inputId !== undefined ? { inputId: inputId as never } : {}),
    payload: {
      turnId,
      ...(inputId !== undefined ? { inputId } : {}),
      ...payload,
    } as InvocationEventEnvelope['payload'],
  }
}

function seedRun(runId: string, inputId: string, status = 'running'): void {
  fixture.db.runs.insert({
    runId,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'tmux',
    status,
    acceptedAt: ts(),
    updatedAt: ts(),
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    dispatchedInputId: inputId,
    brokerSubmissionId: inputId,
  })
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  seedRun(STEER_RUN, STEER_INPUT)
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    activeInvocationId: TMUX_INVOCATION_ID,
    activeRunId: STEER_RUN,
    status: 'busy',
    runtimeStateJson: { status: 'busy', activeRunId: STEER_RUN },
    updatedAt: ts(),
  })
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
  mapper.apply(event('turn.started', 1, ORPHANED, { source: 'hook-observed' }, STEER_INPUT))
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-11508 a turn terminal ends every turn that started before it', () => {
  it('an owner-less terminal ends the orphaned owner run and readies the runtime', () => {
    mapper.apply(event('turn.started', 2, SERVED, { source: 'hook-observed' }))
    mapper.apply(event('turn.completed', 3, SERVED, { status: 'completed' }))

    expect(fixture.db.runs.getByRunId(STEER_RUN)).toMatchObject({
      status: 'completed',
      completedAt: ts(3),
    })
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'ready',
      activeRunId: undefined,
    })
    expect(
      fixture.db.brokerInvocations.getByInvocationId(TMUX_INVOCATION_ID)?.invocationState
    ).toBe('ready')
  })

  it("another run's exact terminal ends the orphaned owner run", () => {
    seedRun(NEXT_RUN, NEXT_INPUT)
    mapper.apply(event('turn.started', 2, NEXT, { source: 'hook-observed' }, NEXT_INPUT))
    mapper.apply(event('turn.completed', 3, NEXT, { status: 'completed' }))

    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('completed')
    expect(fixture.db.runs.getByRunId(NEXT_RUN)?.status).toBe('completed')
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'ready',
      activeRunId: undefined,
    })
  })

  it('ends the orphaned run with the terminator outcome', () => {
    mapper.apply(event('turn.started', 2, SERVED, { source: 'hook-observed' }))
    mapper.apply(event('turn.interrupted', 3, SERVED, { reason: 'interrupted' }))

    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('cancelled')
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)?.status).toBe('ready')
  })

  it('a turn that started after the terminating turn keeps its run and the runtime busy', () => {
    mapper.apply(event('turn.completed', 2, 'turn-t11508-earlier', { status: 'completed' }))

    expect(fixture.db.runs.getByRunId(STEER_RUN)?.completedAt).toBeUndefined()
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'busy',
      activeRunId: STEER_RUN,
    })
  })
})
