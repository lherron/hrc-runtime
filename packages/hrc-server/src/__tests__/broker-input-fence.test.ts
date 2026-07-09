import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  Q_INPUT_B_ID,
  Q_INVOCATION_ID,
  Q_RUNTIME_ID,
  Q_RUN_B_ID,
  type SeededFixture,
  makeQueuedFixture,
  ts,
} from './broker-event-mapper-fixtures'

function qEnv(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: Partial<Pick<InvocationEventEnvelope, 'turnId' | 'inputId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId: Q_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

describe('broker input timeout fence (T-05176)', () => {
  let fixture: SeededFixture
  let mapper: BrokerEventMapper

  beforeEach(async () => {
    fixture = await makeQueuedFixture()
    mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })

    fixture.db.runs.fenceBrokerInput(Q_RUN_B_ID, {
      fencedAt: ts(10),
      reason: 'broker_input_timeout',
    })
    fixture.db.runs.markCompleted(Q_RUN_B_ID, {
      status: 'failed',
      completedAt: ts(10),
      updatedAt: ts(10),
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: 'broker input timed out',
    })
    fixture.db.runtimes.updateRunId(Q_RUNTIME_ID, undefined, ts(10))
    fixture.db.runtimes.update(Q_RUNTIME_ID, {
      status: 'stale',
      updatedAt: ts(10),
      runtimeStateJson: { status: 'stale' },
    })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('records late explicit-input events as skipped without resurrecting run/runtime state', () => {
    const accepted = mapper.apply(
      qEnv('input.accepted', 3, { inputId: Q_INPUT_B_ID }, { inputId: Q_INPUT_B_ID })
    )
    const started = mapper.apply(qEnv('turn.started', 4, { turnId: 'turn_fenced' }))
    const completed = mapper.apply(qEnv('turn.completed', 5, { status: 'completed' }))

    expect(accepted.lifecycleEvents).toHaveLength(0)
    expect(started.lifecycleEvents).toHaveLength(0)
    expect(completed.lifecycleEvents).toHaveLength(0)

    for (const seq of [3, 4, 5]) {
      const record = fixture.db.brokerInvocationEvents.getByInvocationAndSeq(Q_INVOCATION_ID, seq)
      expect(record?.runId).toBe(Q_RUN_B_ID)
      expect(record?.projectionStatus).toBe('skipped_fenced')
      expect(record?.hrcEventSeq).toBeDefined()
    }

    const run = fixture.db.runs.getByRunId(Q_RUN_B_ID)
    const runtime = fixture.db.runtimes.getByRuntimeId(Q_RUNTIME_ID)
    expect(run?.status).toBe('failed')
    expect(run?.brokerInputFenceReason).toBe('broker_input_timeout')
    expect(runtime?.status).toBe('stale')
    expect(runtime?.activeRunId).toBeUndefined()
  })
})
