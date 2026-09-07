import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  UNRESOLVED_ABSORBED_OWNER_MARKER,
  hasUnsettledAbsorbedAuxiliary,
  resolveExactTurnOwner,
} from '../broker/turn-ownership'
import { launchCarriedInvokeCorrelationJson } from '../server-types'
import { evaluatePruneDisposition } from '../sweep-helpers'
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

const OWNER_RUN = 'run-t08201-owner'
const OWNER_INPUT = 'input-t08201-owner'
const NEXT_RUN = 'run-t08201-next'
const NEXT_INPUT = 'input-t08201-next'
const TURN = 'turn-t08201-owner'

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

function seedRun(
  fixture: SeededFixture,
  runId: string,
  inputId: string | undefined,
  options: {
    submissionId?: string | undefined
    status?: string | undefined
    completedAt?: string | undefined
  } = {}
): void {
  fixture.db.runs.insert({
    runId,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'tmux',
    status: options.status ?? 'accepted',
    acceptedAt: ts(),
    ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
    updatedAt: ts(),
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    ...(inputId !== undefined ? { dispatchedInputId: inputId } : {}),
    ...(options.submissionId !== undefined ? { brokerSubmissionId: options.submissionId } : {}),
  })
}

function startOwner(mapper: BrokerEventMapper, seq = 1): void {
  mapper.apply(
    event(
      'turn.started',
      seq,
      { turnId: TURN, inputId: OWNER_INPUT },
      { turnId: TURN as never, inputId: OWNER_INPUT as never }
    )
  )
}

function admitAndAbsorb(
  mapper: BrokerEventMapper,
  submissionId: string,
  admittedSeq: number,
  absorbedSeq: number
): void {
  mapper.apply(event('admission.admitted', admittedSeq, { submissionId, class: 'steer' }))
  mapper.apply(
    event(
      'submission.absorbed',
      absorbedSeq,
      { submissionId, turnId: TURN },
      { turnId: TURN as never }
    )
  )
}

let fixture: SeededFixture
let mapper: BrokerEventMapper

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  seedRun(fixture, OWNER_RUN, OWNER_INPUT)
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    activeInvocationId: TMUX_INVOCATION_ID,
    activeRunId: OWNER_RUN,
    status: 'busy',
    runtimeStateJson: { status: 'busy', activeRunId: OWNER_RUN },
    updatedAt: ts(),
  })
  mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-08201 exact turn ownership', () => {
  it('keeps disposition on the auxiliary while terminalizing the original owner', () => {
    const submissionId = 'submission-t08201-steer'
    seedRun(fixture, 'run-t08201-aux', submissionId, { submissionId })
    startOwner(mapper)
    admitAndAbsorb(mapper, submissionId, 2, 3)

    const auxiliary = fixture.db.runs.getByRunId('run-t08201-aux')
    expect(auxiliary).toMatchObject({
      status: 'coalesced',
      coalescedIntoRunId: OWNER_RUN,
      startedAt: undefined,
    })
    expect(auxiliary?.coalescedPosition).toBeUndefined()
    expect(
      fixture.db.brokerInvocationEvents.getByInvocationAndSeq(TMUX_INVOCATION_ID, 3)?.runId
    ).toBe('run-t08201-aux')

    const terminal = mapper.apply(
      event(
        'turn.completed',
        4,
        { turnId: TURN, status: 'completed', producedContent: true },
        { turnId: TURN as never }
      )
    )
    expect(terminal.lifecycleEvents[0]?.runId).toBe(OWNER_RUN)
    expect(fixture.db.runs.getByRunId(OWNER_RUN)?.status).toBe('completed')
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)?.activeRunId).toBeUndefined()
  })

  it('coalesces two steers including the legacy ACK-completed shape and replays idempotently', () => {
    seedRun(fixture, 'run-t08201-aux-a', 'submission-a', {
      submissionId: 'submission-a',
    })
    seedRun(fixture, 'run-t08201-aux-b', 'submission-b', {
      submissionId: 'submission-b',
      status: 'completed',
      completedAt: ts(2),
    })
    startOwner(mapper)
    admitAndAbsorb(mapper, 'submission-a', 2, 3)
    admitAndAbsorb(mapper, 'submission-b', 4, 5)

    expect(fixture.db.runs.getByRunId('run-t08201-aux-a')).toMatchObject({
      status: 'coalesced',
      coalescedIntoRunId: OWNER_RUN,
    })
    expect(fixture.db.runs.getByRunId('run-t08201-aux-b')).toMatchObject({
      status: 'coalesced',
      completedAt: ts(2),
      coalescedIntoRunId: OWNER_RUN,
    })
    expect(
      mapper.apply(
        event(
          'submission.absorbed',
          5,
          { submissionId: 'submission-b', turnId: TURN },
          { turnId: TURN as never }
        )
      ).idempotent
    ).toBe(true)
  })

  it('settles an earlier absorption when definitive own attribution arrives later', () => {
    seedRun(fixture, 'run-t08201-delayed-aux', 'submission-delayed', {
      submissionId: 'submission-delayed',
    })
    mapper.apply(
      event('turn.started', 1, { turnId: TURN, source: 'observed' }, { turnId: TURN as never })
    )
    admitAndAbsorb(mapper, 'submission-delayed', 2, 3)
    expect(fixture.db.runs.getByRunId('run-t08201-delayed-aux')?.status).toBe('accepted')

    mapper.apply(
      event(
        'turn.attributed',
        4,
        {
          turnId: TURN,
          ownership: 'own',
          inputId: OWNER_INPUT,
          origin: 'broker',
        },
        { turnId: TURN as never, inputId: OWNER_INPUT as never }
      )
    )
    expect(fixture.db.runs.getByRunId('run-t08201-delayed-aux')).toMatchObject({
      status: 'coalesced',
      coalescedIntoRunId: OWNER_RUN,
    })
  })

  it('settles an earlier absorption when definitive submission execution arrives later', () => {
    fixture.db.runs.update(OWNER_RUN, {
      brokerSubmissionId: 'submission-owner-executed',
      updatedAt: ts(),
    })
    seedRun(fixture, 'run-t08201-executed-aux', 'submission-executed-aux', {
      submissionId: 'submission-executed-aux',
    })
    mapper.apply(
      event('turn.started', 1, { turnId: TURN, source: 'observed' }, { turnId: TURN as never })
    )
    admitAndAbsorb(mapper, 'submission-executed-aux', 2, 3)
    expect(fixture.db.runs.getByRunId('run-t08201-executed-aux')?.status).toBe('accepted')

    mapper.apply(
      event(
        'submission.executed',
        4,
        { submissionId: 'submission-owner-executed', turnId: TURN },
        { turnId: TURN as never }
      )
    )
    expect(fixture.db.runs.getByRunId('run-t08201-executed-aux')).toMatchObject({
      status: 'coalesced',
      coalescedIntoRunId: OWNER_RUN,
    })
  })

  it('does not let a late old-owner terminal clear or ready a newer active run', () => {
    seedRun(fixture, NEXT_RUN, NEXT_INPUT)
    startOwner(mapper)
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
      activeRunId: NEXT_RUN,
      status: 'busy',
      runtimeStateJson: { status: 'busy', activeRunId: NEXT_RUN },
      updatedAt: ts(2),
    })
    fixture.db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      invocationState: 'turn_active',
      updatedAt: ts(2),
    })

    const terminal = mapper.apply(
      event(
        'turn.interrupted',
        3,
        { turnId: TURN, reason: 'interrupted' },
        { turnId: TURN as never }
      )
    )
    expect(terminal.lifecycleEvents[0]).toMatchObject({
      eventKind: 'turn.completed',
      runId: OWNER_RUN,
    })
    expect(fixture.db.runs.getByRunId(OWNER_RUN)?.status).toBe('cancelled')
    expect(fixture.db.runs.getByRunId(NEXT_RUN)?.completedAt).toBeUndefined()
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'busy',
      activeRunId: NEXT_RUN,
    })
    expect(
      fixture.db.brokerInvocations.getByInvocationId(TMUX_INVOCATION_ID)?.invocationState
    ).toBe('turn_active')
  })

  it('does not release a newer observed bracket whose owner is still unresolved', () => {
    startOwner(mapper)
    fixture.db.runtimes.updateRunId(TMUX_RUNTIME_ID, undefined, ts(2))
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, { status: 'busy', updatedAt: ts(2) })
    mapper.apply(
      event(
        'turn.started',
        2,
        { turnId: 'turn-t08201-new-observed', source: 'observed' },
        { turnId: 'turn-t08201-new-observed' as never }
      )
    )

    mapper.apply(
      event(
        'turn.completed',
        3,
        { turnId: TURN, status: 'completed', producedContent: true },
        { turnId: TURN as never }
      )
    )
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)?.status).toBe('busy')
    expect(
      fixture.db.brokerInvocations.getByInvocationId(TMUX_INVOCATION_ID)?.invocationState
    ).toBe('turn_active')
  })

  it('rejects borrowed start ownership, guards prune, then releases the dependency at teardown', async () => {
    seedRun(fixture, 'run-t08201-borrowed-aux', 'submission-borrowed', {
      submissionId: 'submission-borrowed',
      status: 'completed',
      completedAt: ts(1),
    })
    mapper.apply(
      event('admission.admitted', 1, {
        submissionId: 'submission-borrowed',
        class: 'steer',
      })
    )
    mapper.apply(
      event('turn.started', 2, { turnId: TURN, source: 'observed' }, { turnId: TURN as never })
    )
    fixture.db.sqlite
      .query(
        `UPDATE broker_invocation_events
            SET run_id = ?
          WHERE invocation_id = ? AND seq = 2`
      )
      .run('run-t08201-borrowed-aux', TMUX_INVOCATION_ID)
    mapper.apply(
      event(
        'submission.absorbed',
        3,
        { submissionId: 'submission-borrowed', turnId: TURN },
        { turnId: TURN as never }
      )
    )
    expect(hasUnsettledAbsorbedAuxiliary(fixture.db, TMUX_RUNTIME_ID)).toBe(true)
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
      status: 'terminated',
      activeRunId: null,
      updatedAt: ts(4),
    })
    expect(
      await evaluatePruneDisposition(
        fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)!,
        {} as never,
        fixture.db
      )
    ).toEqual({ prunable: false, reason: 'unsettled_absorbed_auxiliary' })

    mapper.apply(event('invocation.exited', 4, { exitCode: 1, signal: null }))
    expect(fixture.db.runs.getByRunId('run-t08201-borrowed-aux')).toMatchObject({
      status: 'failed',
      errorCode: 'runtime_unavailable',
    })
    expect(
      fixture.db.runs
        .getByRunId('run-t08201-borrowed-aux')
        ?.errorMessage?.includes(UNRESOLVED_ABSORBED_OWNER_MARKER)
    ).toBe(true)
    expect(hasUnsettledAbsorbedAuxiliary(fixture.db, TMUX_RUNTIME_ID)).toBe(false)
  })

  it('keeps immutable launch ownership after invocation.runId advances, for the first turn only', () => {
    fixture.db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      runId: OWNER_RUN,
      updatedAt: ts(),
    })
    fixture.db.runs.setCorrelationJson(OWNER_RUN, launchCarriedInvokeCorrelationJson())
    seedRun(fixture, NEXT_RUN, NEXT_INPUT, { submissionId: 'submission-launch-next' })
    const first = mapper.apply(
      event('turn.started', 1, { turnId: TURN }, { turnId: TURN as never })
    )
    mapper.apply(
      event(
        'submission.executed',
        2,
        { submissionId: 'submission-launch-next', turnId: 'turn-t08201-next' },
        { turnId: 'turn-t08201-next' as never }
      )
    )
    expect(fixture.db.brokerInvocations.getByInvocationId(TMUX_INVOCATION_ID)?.runId).toBe(NEXT_RUN)
    const delayedTerminal = mapper.apply(
      event(
        'turn.completed',
        3,
        { turnId: TURN, status: 'completed', producedContent: true },
        { turnId: TURN as never }
      )
    )
    const second = mapper.apply(
      event(
        'turn.started',
        4,
        { turnId: 'turn-t08201-human' },
        { turnId: 'turn-t08201-human' as never }
      )
    )
    expect(first.lifecycleEvents[0]?.runId).toBe(OWNER_RUN)
    expect(delayedTerminal.lifecycleEvents[0]?.runId).toBe(OWNER_RUN)
    expect(second.lifecycleEvents[0]?.runId).toBeUndefined()
  })

  it('rejects initiating evidence whose ledger runtime does not match the historical epoch', () => {
    startOwner(mapper)
    fixture.db.sqlite
      .query(
        `UPDATE broker_invocation_events
            SET runtime_id = 'runtime-t08201-foreign'
          WHERE invocation_id = ? AND seq = 1`
      )
      .run(TMUX_INVOCATION_ID)

    const terminal = mapper.apply(
      event(
        'turn.completed',
        2,
        { turnId: TURN, status: 'completed', producedContent: true },
        { turnId: TURN as never }
      )
    )
    expect(terminal.lifecycleEvents[0]?.runId).toBeUndefined()
    expect(fixture.db.runs.getByRunId(OWNER_RUN)?.completedAt).toBeUndefined()
  })

  it('keeps repeated native turn IDs isolated by invocation and historical generation', () => {
    const invocationId = 'invocation-t08201-generation-2'
    const operationId = 'operation-t08201-generation-2'
    const runId = 'run-t08201-generation-2'
    const inputId = 'input-t08201-generation-2'
    fixture.db.runtimeOperations.insert({
      operationId,
      runtimeId: TMUX_RUNTIME_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      generation: 2,
      operationKind: 'broker_invocation',
      controller: 'harness-broker',
      startupMethod: 'test',
      status: 'started',
      routeDecisionJson: '{}',
      createdAt: ts(),
      updatedAt: ts(),
    })
    fixture.db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId: TMUX_RUNTIME_ID,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: 'codex-app-server',
      invocationState: 'turn_active',
      capabilitiesJson: '{}',
      specHash: 'sha256:generation-2',
      startRequestHash: 'sha256:generation-2',
      selectedProfileHash: 'sha256:generation-2',
      createdAt: ts(),
      updatedAt: ts(),
    })
    fixture.db.runs.insert({
      runId,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 2,
      transport: 'tmux',
      status: 'running',
      acceptedAt: ts(),
      startedAt: ts(1),
      updatedAt: ts(1),
      operationId,
      invocationId,
      dispatchedInputId: inputId,
    })
    fixture.db.brokerInvocationEvents.appendEvent({
      invocationId,
      seq: 1,
      time: ts(1),
      type: 'turn.started',
      runtimeId: TMUX_RUNTIME_ID,
      runId,
      payload: { turnId: TURN, inputId },
      envelopeJson: JSON.stringify({
        invocationId,
        seq: 1,
        time: ts(1),
        type: 'turn.started',
        turnId: TURN,
        inputId,
      }),
    })
    fixture.db.runtimes.update(TMUX_RUNTIME_ID, { generation: 99, updatedAt: ts(2) })

    expect(
      resolveExactTurnOwner(
        fixture.db,
        event(
          'turn.completed',
          2,
          { turnId: TURN, status: 'completed', producedContent: true },
          { invocationId: invocationId as never, turnId: TURN as never }
        )
      )
    ).toBe(runId)
  })
})
