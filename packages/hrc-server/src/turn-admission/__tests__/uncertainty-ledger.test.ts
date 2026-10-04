import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Q_INPUT_B_ID,
  Q_INVOCATION_ID,
  Q_RUN_B_ID,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_OPERATION_ID,
  TMUX_RUNTIME_ID,
  envelope,
  makeQueuedFixture,
  makeTmuxSeededFixture,
  ts,
  turnId,
} from '../../__tests__/broker-event-mapper-fixtures'
import { BrokerEventMapper } from '../../broker/event-mapper'
import { TurnAdmissionGate } from '../../turn-admission-gate'
import { ADMISSION_STEPS, runLeasedAdmission } from '../admit'

for (const fault of ['response projection failed', 'RPC timeout', 'caller cancellation']) {
  test(`format2 ${fault}: protection survives and a later committed landing completes`, async () => {
    const fixture = await makeTmuxSeededFixture()
    const root = await mkdtemp(join(tmpdir(), 'admission-uncertainty-'))
    try {
      const db = fixture.db
      db.brokerInvocations.update(TMUX_INVOCATION_ID, {
        executionFormat: 'format2',
        updatedAt: ts(),
      })
      const result = await runLeasedAdmission(
        { gate: new TurnAdmissionGate(root), record: () => {} },
        {
          steps: ADMISSION_STEPS.slice(1).map((step) => ({
            step,
            run: async () => ({ outcome: 'passed' as const }),
          })),
          route: async () => {
            db.inputs.insert({
              inputId: 'hrc-input-uncertain',
              admissionHostSessionId: TMUX_HOST_SESSION_ID,
              idempotencyKey: 'uncertain',
              requestHash: 'sha256:uncertain',
              hostSessionId: TMUX_HOST_SESSION_ID,
              runtimeId: TMUX_RUNTIME_ID,
              operationId: TMUX_OPERATION_ID,
              invocationId: TMUX_INVOCATION_ID,
              brokerSubmissionId: 'sub-uncertain',
              door: 'enqueue',
              admissionClass: 'queue',
              origin: 'agent',
              status: 'accepted',
              uncertainty: 'none',
              cleanupProtection: 'protected',
              admittedAt: ts(),
              createdAt: ts(),
              updatedAt: ts(),
            })
            if (fault === 'RPC timeout') await new Promise((resolve) => setTimeout(resolve, 1))
            throw new Error(fault)
          },
        }
      )
      expect(result.outcome).toBe('possible_write')
      expect(db.inputs.getByInputId('hrc-input-uncertain')).toMatchObject({
        status: 'accepted',
        cleanupProtection: 'protected',
      })
      const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
      const nativeTurn = turnId('turn-uncertain')
      mapper.apply(
        envelope(
          'turn.started',
          1,
          { source: 'observed', turnId: nativeTurn },
          { invocationId: TMUX_INVOCATION_ID, turnId: nativeTurn }
        )
      )
      mapper.apply(
        envelope(
          'submission.executed',
          2,
          { submissionId: 'sub-uncertain', turnId: nativeTurn },
          { invocationId: TMUX_INVOCATION_ID, turnId: nativeTurn }
        )
      )
      const input = db.inputs.getByInputId('hrc-input-uncertain')
      expect(input?.carrierRunId).toBeDefined()
      mapper.apply(
        envelope(
          'turn.completed',
          3,
          { status: 'completed' },
          { invocationId: TMUX_INVOCATION_ID, turnId: nativeTurn }
        )
      )
      expect(db.runs.getByRunId(input?.carrierRunId ?? 'missing')?.status).toBe('completed')
    } finally {
      await fixture.cleanup()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('format1 timeout preserves the route fence and failed run; later evidence remains skipped_fenced', async () => {
  const fixture = await makeQueuedFixture()
  const root = await mkdtemp(join(tmpdir(), 'admission-format1-'))
  try {
    const db = fixture.db
    const result = await runLeasedAdmission(
      { gate: new TurnAdmissionGate(root), record: () => {} },
      {
        steps: ADMISSION_STEPS.slice(1).map((step) => ({
          step,
          run: async () => ({ outcome: 'passed' as const }),
        })),
        route: async () => {
          db.runs.fenceBrokerInput(Q_RUN_B_ID, { fencedAt: ts(10), reason: 'broker_input_timeout' })
          db.runs.markCompleted(Q_RUN_B_ID, {
            status: 'failed',
            completedAt: ts(10),
            updatedAt: ts(10),
          })
          throw new Error('broker_input_timeout')
        },
      }
    )
    expect(result.outcome).toBe('possible_write')
    const before = db.runs.getByRunId(Q_RUN_B_ID)
    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const events = [
      envelope(
        'input.accepted',
        3,
        { inputId: Q_INPUT_B_ID },
        { invocationId: Q_INVOCATION_ID, inputId: Q_INPUT_B_ID }
      ),
      envelope(
        'turn.started',
        4,
        { inputId: Q_INPUT_B_ID },
        { invocationId: Q_INVOCATION_ID, turnId: turnId('turn-fenced'), inputId: Q_INPUT_B_ID }
      ),
      envelope('turn.completed', 5, { status: 'completed' }, { invocationId: Q_INVOCATION_ID }),
    ]
    for (const event of events) {
      expect(mapper.apply(event).lifecycleEvents).toHaveLength(0)
      expect(
        db.brokerInvocationEvents.getByInvocationAndSeq(Q_INVOCATION_ID, event.seq)
          ?.projectionStatus
      ).toBe('skipped_fenced')
    }
    expect(db.runs.getByRunId(Q_RUN_B_ID)).toEqual(before)
  } finally {
    await fixture.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('format1 unfenced response throw preserves the open run for later committed landing', async () => {
  const fixture = await makeQueuedFixture()
  const root = await mkdtemp(join(tmpdir(), 'admission-unfenced-'))
  try {
    const db = fixture.db
    const before = db.runs.getByRunId(Q_RUN_B_ID)
    const result = await runLeasedAdmission(
      { gate: new TurnAdmissionGate(root), record: () => {} },
      {
        steps: ADMISSION_STEPS.slice(1).map((step) => ({
          step,
          run: async () => ({ outcome: 'passed' as const }),
        })),
        route: async () => {
          throw new Error('response projection failed after acceptance')
        },
      }
    )
    expect(result.outcome).toBe('possible_write')
    expect(db.runs.getByRunId(Q_RUN_B_ID)).toEqual(before)
    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const nativeTurn = turnId('turn-unfenced')
    mapper.apply(
      envelope(
        'input.accepted',
        3,
        { inputId: Q_INPUT_B_ID },
        { invocationId: Q_INVOCATION_ID, inputId: Q_INPUT_B_ID }
      )
    )
    mapper.apply(
      envelope(
        'turn.started',
        4,
        { inputId: Q_INPUT_B_ID },
        { invocationId: Q_INVOCATION_ID, inputId: Q_INPUT_B_ID, turnId: nativeTurn }
      )
    )
    mapper.apply(
      envelope(
        'turn.completed',
        5,
        { status: 'completed' },
        { invocationId: Q_INVOCATION_ID, turnId: nativeTurn }
      )
    )
    expect(db.runs.getByRunId(Q_RUN_B_ID)?.status).toBe('completed')
  } finally {
    await fixture.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
