import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  SUBMISSION_FATE_MISSING_MARKER,
  settleUnstartedSubmissionRuns,
} from '../broker/turn-ownership'
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

// T-11306: a steer on an ack-evidence broker (pi-sdk, foundry seats) ended at
// input.accepted{attempted_steer} with no submission.* fate, so neither the
// T-10686 settle (keyed on submission.absorbed) nor reconcile-active (keyed on
// runtime.activeRunId, skipping headless and external owners) could see it.
// 206 runs sat `accepted` with started_at NULL on max3. The backstop settles an
// accepted, never-started submission run from broker evidence: the turn it
// landed in (its fate, else the turn open at its admission), that turn's
// terminal, and the turn's exact owner.

const NATIVE_INPUT = 'input_t11306_native'
const DISPATCHED_INPUT = 'submission_t11306_dispatched'
const OWNER_RUN = 'run-t11306-owner'
const STEER = 'submission_t11306_steer'
const STEER_RUN = 'run-t11306-steer'
const QUEUED = 'submission_t11306_queued'
const QUEUED_RUN = 'run-t11306-queued'
const TURN = 'turn_t11306_1'

// The steer was accepted at ts(); the sweep runs an hour later.
const NOW = ts(3600)
const CUTOFF_MS = Date.parse(ts(1800))

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

function seedRun(runId: string, submissionId: string, status = 'accepted'): void {
  fixture.db.runs.insert({
    runId,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    status: status as never,
    acceptedAt: ts(),
    updatedAt: ts(),
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    dispatchedInputId: submissionId,
    brokerSubmissionId: submissionId,
  })
}

/** A turn opened by `initiator`; the steer is admitted and written while it runs. */
function steerIntoTurn(initiator: string): void {
  mapper.apply(event('admission.admitted', 1, { submissionId: initiator, class: 'exclusive' }))
  mapper.apply(event('input.accepted', 2, { inputId: initiator, disposition: 'started' }))
  mapper.apply(
    event(
      'turn.started',
      3,
      { turnId: TURN, source: 'broker-delivery', inputId: initiator },
      { turnId: TURN as never, inputId: initiator as never }
    )
  )
  mapper.apply(event('admission.requested', 4, { submissionId: STEER, class: 'steer' }))
  mapper.apply(event('admission.admitted', 5, { submissionId: STEER, class: 'steer' }))
  mapper.apply(event('input.accepted', 6, { inputId: STEER, disposition: 'attempted_steer' }))
}

function endTurn(type: 'turn.completed' | 'turn.failed' | 'turn.interrupted', seq = 10): void {
  mapper.apply(
    event(
      type,
      seq,
      type === 'turn.completed'
        ? { turnId: TURN, status: 'completed', producedContent: true }
        : type === 'turn.failed'
          ? { turnId: TURN, status: 'failed', code: 'x', message: 'model failed' }
          : { turnId: TURN, status: 'interrupted', reason: 'operator' },
      { turnId: TURN as never }
    )
  )
}

function settle(dryRun = false) {
  return settleUnstartedSubmissionRuns(fixture.db, { cutoffMs: CUTOFF_MS, dryRun, now: NOW })
}

function quietRuntime(status: string, extra: Record<string, unknown> = {}): void {
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    status: status as never,
    activeRunId: undefined,
    lastActivityAt: ts(),
    runtimeStateJson: { status, ...extra },
    updatedAt: ts(),
  })
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(20) })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-11306 accepted, never-started submission runs settle from broker evidence', () => {
  it('a fate-less steer takes the outcome of the unowned turn open at its admission', () => {
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(NATIVE_INPUT)
    endTurn('turn.completed')
    quietRuntime('terminated', { lifecycleOwner: 'external' })
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('accepted')

    const results = settle()

    expect(results).toEqual([
      expect.objectContaining({
        runId: STEER_RUN,
        action: 'completed',
        turnId: TURN,
        applied: true,
      }),
    ])
    expect(fixture.db.runs.getByRunId(STEER_RUN)).toMatchObject({
      status: 'completed',
      completedAt: ts(10),
      startedAt: undefined,
    })
  })

  it('carries a failed or interrupted turn outcome', () => {
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(NATIVE_INPUT)
    endTurn('turn.interrupted')
    quietRuntime('ready')
    settle()
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('cancelled')
  })

  it('coalesces a steer into the HRC run that owns its turn', () => {
    seedRun(OWNER_RUN, DISPATCHED_INPUT, 'running')
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(DISPATCHED_INPUT)
    endTurn('turn.completed')
    quietRuntime('ready')
    expect(fixture.db.runs.getByRunId(OWNER_RUN)?.status).toBe('completed')

    expect(settle()).toEqual([
      expect.objectContaining({ runId: STEER_RUN, action: 'coalesced', ownerRunId: OWNER_RUN }),
    ])
    expect(fixture.db.runs.getByRunId(STEER_RUN)).toMatchObject({
      status: 'coalesced',
      coalescedIntoRunId: OWNER_RUN,
    })
  })

  it('fails a steer with no turn evidence, naming the missing fate', () => {
    seedRun(STEER_RUN, STEER)
    mapper.apply(event('admission.admitted', 5, { submissionId: STEER, class: 'steer' }))
    mapper.apply(event('input.accepted', 6, { inputId: STEER, disposition: 'attempted_steer' }))
    quietRuntime('terminated')

    settle()

    const run = fixture.db.runs.getByRunId(STEER_RUN)
    expect(run?.status).toBe('failed')
    expect(run?.errorMessage).toContain(SUBMISSION_FATE_MISSING_MARKER)
    expect(run?.errorMessage).toContain(STEER)
  })

  it('leaves a steer whose turn is still open on a live runtime', () => {
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(NATIVE_INPUT)
    quietRuntime('ready')
    expect(settle()).toEqual([])
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('accepted')
  })

  it('fails a steer whose turn never ended once the runtime is terminated', () => {
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(NATIVE_INPUT)
    quietRuntime('terminated')
    settle()
    expect(fixture.db.runs.getByRunId(STEER_RUN)).toMatchObject({ status: 'failed' })
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.errorMessage).toContain(TURN)
  })

  it('never touches a busy or recently active runtime', () => {
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(NATIVE_INPUT)
    endTurn('turn.completed')
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
      status: 'ready',
      lastActivityAt: ts(3500),
      updatedAt: ts(3500),
    })
    expect(settle()).toEqual([])
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('accepted')
  })

  it('a dry run reports the settlement and writes nothing', () => {
    seedRun(STEER_RUN, STEER)
    steerIntoTurn(NATIVE_INPUT)
    endTurn('turn.completed')
    quietRuntime('terminated')
    expect(settle(true)).toEqual([
      expect.objectContaining({ runId: STEER_RUN, action: 'completed', applied: false }),
    ])
    expect(fixture.db.runs.getByRunId(STEER_RUN)?.status).toBe('accepted')
  })

  it('settles a withdrawn queued submission as cancelled', () => {
    seedRun(QUEUED_RUN, QUEUED)
    mapper.apply(event('admission.admitted', 1, { submissionId: QUEUED, class: 'queue' }))
    mapper.apply(event('queue.enqueued', 2, { submissionId: QUEUED }))
    mapper.apply(event('queue.withdrawn', 3, { submissionId: QUEUED }))
    mapper.apply(event('submission.withdrawn', 4, { submissionId: QUEUED }))
    quietRuntime('terminated')
    // The broker withdrew it; the projection never terminalized the run.
    fixture.db.runs.update(QUEUED_RUN, { status: 'accepted', updatedAt: ts() })

    settle()
    expect(fixture.db.runs.getByRunId(QUEUED_RUN)?.status).toBe('cancelled')
  })

  it('settles an executed queued submission with the outcome of its own turn', () => {
    seedRun(QUEUED_RUN, QUEUED)
    mapper.apply(event('admission.admitted', 1, { submissionId: QUEUED, class: 'queue' }))
    mapper.apply(event('turn.started', 3, { turnId: TURN }, { turnId: TURN as never }))
    mapper.apply(
      event(
        'submission.executed',
        4,
        { submissionId: QUEUED, turnId: TURN },
        { turnId: TURN as never }
      )
    )
    endTurn('turn.completed')
    quietRuntime('terminated')
    // Live shape: the turn projected onto no run, so the run never started.
    fixture.db.runs.update(QUEUED_RUN, {
      status: 'accepted',
      startedAt: undefined,
      completedAt: undefined,
      updatedAt: ts(),
    })

    settle()
    expect(fixture.db.runs.getByRunId(QUEUED_RUN)).toMatchObject({
      status: 'completed',
      completedAt: ts(10),
    })
  })
})
