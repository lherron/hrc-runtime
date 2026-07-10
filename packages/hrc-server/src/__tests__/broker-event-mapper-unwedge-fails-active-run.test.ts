/**
 * T-06088 — the run-mismatch unwedge must fail the active run loudly.
 *
 * Field failure (3× on 2026-07-10, @4 leaf-drain verify observer): the broker
 * lost the active turn's terminal off the wire (out-of-order emission +
 * client monotonic-seq dedup), so the owning run never completed. The queued
 * input's turn then terminated with runId != activeRunId, and the unwedge
 * cleared ownership WITHOUT failing the active run. When the invocation died
 * moments later, markBrokerInvocationTerminal found activeRunId already
 * undefined, so its RUNTIME_UNAVAILABLE safety net never fired — the caller
 * hung blind to its dispatch timeout (90m for drain seats).
 *
 * The unwedge preconditions prove the active run's turn is over (another
 * run's terminal closed every turn bracket on the invocation), so the mapper
 * must complete the active run as failed (errorCode run_mismatch) in the same
 * projection that clears ownership.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'

import { BrokerEventMapper } from '../broker/event-mapper'

import type {
  InvocationEventEnvelope,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  Q_INPUT_C_ID,
  Q_INVOCATION_ID,
  Q_RUNTIME_ID,
  Q_RUN_A_ID,
  Q_RUN_C_ID,
  type SeededFixture,
  makeQueuedFixture,
  ts,
} from './broker-event-mapper-fixtures'

function qEnv(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: Partial<
    Pick<InvocationEventEnvelope, 'turnId' | 'inputId' | 'harnessGeneration' | 'turnAttempt'>
  > = {}
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

const TURN_C = 'turn_unwedge_C' as TurnId

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeQueuedFixture()
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
})

afterEach(async () => {
  await fixture.cleanup()
})

/** Clean single-turn sequence for run C against the pre-wedged (activeRunId=A) runtime. */
function applyMismatchedTerminal() {
  mapper.apply(qEnv('input.accepted', 50, { inputId: Q_INPUT_C_ID }, { inputId: Q_INPUT_C_ID }))
  mapper.apply(qEnv('turn.started', 51, { turnId: TURN_C }, { turnId: TURN_C }))
  mapper.apply(
    qEnv(
      'turn.completed',
      52,
      { turnId: TURN_C, status: 'completed', producedContent: true },
      { turnId: TURN_C }
    )
  )
}

describe('[T-06088] run-mismatch unwedge fails the active run', () => {
  it('marks the wedged active run failed with run_mismatch and clears ownership', () => {
    const db = fixture.db

    const runtimeBefore = db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runtimeBefore.status).toBe('busy')
    expect(runtimeBefore.activeRunId).toBe(Q_RUN_A_ID)

    applyMismatchedTerminal()

    const runtime = db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runtime.status).toBe('ready')
    expect(runtime.activeRunId).toBeUndefined()

    // The caller waiting on run A gets a terminal failure result, not a hang.
    const runA = db.runs.getByRunId(Q_RUN_A_ID)!
    expect(runA.status).toBe('failed')
    expect(runA.completedAt).toBeDefined()
    expect(runA.errorCode).toBe(HrcErrorCode.RUN_MISMATCH)

    // The mismatched terminal still completes its own run.
    const runC = db.runs.getByRunId(Q_RUN_C_ID)!
    expect(runC.status).toBe('completed')
  })

  it('leaves an already-terminal active run untouched while still unwedging', () => {
    const db = fixture.db

    // Run A already reached a terminal state through some other path; the
    // runtime row is stale-wedged on it.
    db.runs.markCompleted(Q_RUN_A_ID, {
      status: 'completed',
      completedAt: ts(10),
      updatedAt: ts(10),
    })

    applyMismatchedTerminal()

    const runtime = db.runtimes.getByRuntimeId(Q_RUNTIME_ID)!
    expect(runtime.status).toBe('ready')
    expect(runtime.activeRunId).toBeUndefined()

    const runA = db.runs.getByRunId(Q_RUN_A_ID)!
    expect(runA.status).toBe('completed')
    expect(runA.completedAt).toBe(ts(10))
    expect(runA.errorCode).toBeUndefined()
  })
})
