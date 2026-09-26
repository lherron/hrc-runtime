import { afterEach, beforeEach, expect, test } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper.js'
import {
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_OPERATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  envelope,
  makeTmuxSeededFixture,
  ts,
  turnId,
} from './broker-event-mapper-fixtures.js'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function admittedInput(inputIdValue: string, brokerSubmissionId: string) {
  return {
    inputId: inputIdValue,
    admissionHostSessionId: TMUX_HOST_SESSION_ID,
    idempotencyKey: `idem-${inputIdValue}`,
    requestHash: `sha256:${inputIdValue}`,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    brokerSubmissionId,
    door: 'steer',
    admissionClass: 'steer',
    origin: 'agent',
    status: 'accepted',
    uncertainty: 'none',
    cleanupProtection: 'protected',
    admittedAt: ts(),
    createdAt: ts(),
    updatedAt: ts(),
  }
}

test('input-id-less provider start mints one execution; later submission.executed binds its initiating input once', () => {
  const db = fixture.db as any
  db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    executionFormat: 'format2',
    updatedAt: ts(),
  })
  // Captured hrcdev Codex format-2 wire: invocation `inv-d23624a5…` emitted
  // this native `submission.executed.payload.submissionId` for its launch
  // input. The producer contract prebound that native field at admission; the
  // mapper never compares a broker input field to `inputs.input_id`.
  const hrcInputId = 'input-26dd05e4-0bfa-4e72-9049-61d11fd2d60b'
  const nativeTurnId = turnId('turn-t08207-initiating')
  const initialNativeSubmissionId = 'input-26dd05e4-0bfa-4e72-9049-61d11fd2d60b'
  db.inputs.insert(admittedInput(hrcInputId, initialNativeSubmissionId))
  const mapper = new BrokerEventMapper({ db, now: () => ts(100) })

  // Live Codex provider evidence (T-08207 artifact) has a top-level turnId and
  // correlation identity but no HRC inputId. A later broker disposition is the
  // sole submission-to-turn proof in this shape.
  const observedStart = {
    ...envelope(
      'turn.started',
      1,
      { source: 'observed', turnId: nativeTurnId },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
      }
    ),
    correlation: {
      hostSessionId: TMUX_HOST_SESSION_ID,
      operationId: TMUX_OPERATION_ID,
      requestId: 'req-t08207-observed',
      runId: 'legacy-run-not-authoritative',
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      traceId: 'trace-t08207-observed',
    },
  }
  const started = mapper.apply(observedStart)

  const turnKey = `${TMUX_RUNTIME_ID}|${TMUX_OPERATION_ID}|${TMUX_INVOCATION_ID}|${nativeTurnId}|g=-|a=-`
  const run = db.runs.getByTurnKey(turnKey)
  expect(run).toMatchObject({
    executionFormat: 'format2',
    turnKey,
    nativeTurnId,
    initiatingInputId: undefined,
    status: 'running',
  })
  expect(db.inputs.getByInputId(hrcInputId)).toMatchObject({
    status: 'accepted',
    cleanupProtection: 'protected',
  })

  const executed = mapper.apply(
    envelope(
      'submission.executed',
      2,
      {
        submissionId: initialNativeSubmissionId,
        turnId: nativeTurnId,
      },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
      }
    )
  )
  mapper.apply(
    envelope(
      'submission.executed',
      2,
      {
        submissionId: initialNativeSubmissionId,
        turnId: nativeTurnId,
      },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
      }
    )
  )

  expect(db.runs.getByRunId(run.runId)).toMatchObject({ initiatingInputId: hrcInputId })
  expect(db.inputs.getByInputId(hrcInputId)).toMatchObject({
    status: 'initiating',
    carrierRunId: run.runId,
    turnId: nativeTurnId,
  })
  const landed = executed.lifecycleEvents.find((event) => event.eventKind === 'input.landed')
  expect(landed?.payload).toMatchObject({
    inputId: hrcInputId,
    kind: 'initiating',
    carrierRunId: run.runId,
    turnId: nativeTurnId,
    runStartedHrcSeq: started.lifecycleEvents.find((event) => event.eventKind === 'turn.started')
      ?.hrcSeq,
  })
  expect(db.runs.listRuns({ hostSessionId: TMUX_HOST_SESSION_ID })).toHaveLength(1)

  const terminal = mapper.apply(
    envelope(
      'turn.completed',
      3,
      { turnId: nativeTurnId, status: 'completed', producedContent: true },
      { invocationId: TMUX_INVOCATION_ID, turnId: nativeTurnId }
    )
  )
  expect(db.runs.getByRunId(run.runId)).toMatchObject({ status: 'completed', nativeTurnId })
  expect(
    terminal.lifecycleEvents.find((event) => event.eventKind === 'turn.completed')
  ).toMatchObject({
    runId: run.runId,
  })
})

test('a format-2 unowned turn obtains its own execution and cannot consume a later joined input', () => {
  const db = fixture.db as any
  db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    executionFormat: 'format2',
    updatedAt: ts(),
  })
  const nativeTurnId = turnId('turn-t08207-unowned')
  const mapper = new BrokerEventMapper({ db, now: () => ts(100) })

  mapper.apply(
    envelope(
      'turn.started',
      1,
      { turnId: nativeTurnId },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
      }
    )
  )
  const carrier = db.runs.getByTurnKey(
    `${TMUX_RUNTIME_ID}|${TMUX_OPERATION_ID}|${TMUX_INVOCATION_ID}|${nativeTurnId}|g=-|a=-`
  )
  expect(carrier).toMatchObject({
    executionFormat: 'format2',
    nativeTurnId,
    initiatingInputId: undefined,
  })

  db.inputs.insert(admittedInput('input-t08207-joined', 'submission-t08207-joined'))
  const absorbed = mapper.apply(
    envelope(
      'submission.absorbed',
      2,
      {
        submissionId: 'submission-t08207-joined',
        turnId: nativeTurnId,
      },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
      }
    )
  )

  expect(db.inputs.getByInputId('input-t08207-joined')).toMatchObject({
    status: 'joined',
    carrierRunId: carrier.runId,
    turnId: nativeTurnId,
  })
  expect(
    absorbed.lifecycleEvents.find((event) => event.eventKind === 'input.landed')?.payload
  ).toMatchObject({
    inputId: 'input-t08207-joined',
    kind: 'joined',
    carrierRunId: carrier.runId,
  })
  expect(db.runs.listRuns({ hostSessionId: TMUX_HOST_SESSION_ID })).toHaveLength(1)
})

test('format-2 native input identity cannot collide with a different HRC input id', () => {
  const db = fixture.db as any
  db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    executionFormat: 'format2',
    updatedAt: ts(),
  })
  // The native id names input A's HRC id, while its durable native binding owns
  // input B. A direct getByInputId(nativeId) would land A incorrectly.
  db.inputs.insert(admittedInput('input-t08207-native-collision', 'submission-t08207-a'))
  db.inputs.insert(admittedInput('input-t08207-b', 'input-t08207-native-collision'))
  const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
  const nativeTurnId = turnId('turn-t08207-native-collision')

  mapper.apply(
    envelope(
      'turn.started',
      1,
      { turnId: nativeTurnId },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
        inputId: 'input-t08207-native-collision' as never,
      }
    )
  )

  const carrier = db.runs.getByTurnKey(
    `${TMUX_RUNTIME_ID}|${TMUX_OPERATION_ID}|${TMUX_INVOCATION_ID}|${nativeTurnId}|g=-|a=-`
  )
  expect(carrier).toMatchObject({ initiatingInputId: 'input-t08207-b' })
  expect(db.inputs.getByInputId('input-t08207-native-collision')).toMatchObject({
    status: 'accepted',
    cleanupProtection: 'protected',
  })
  expect(db.inputs.getByInputId('input-t08207-b')).toMatchObject({
    status: 'initiating',
    carrierRunId: carrier.runId,
  })
})

test('format-2 conflicting native envelope fields leave both protected inputs unowned', () => {
  const db = fixture.db as any
  db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    executionFormat: 'format2',
    updatedAt: ts(),
  })
  db.inputs.insert(admittedInput('input-t08207-conflict-a', 'submission-t08207-conflict-a'))
  db.inputs.insert(admittedInput('input-t08207-conflict-b', 'submission-t08207-conflict-b'))
  const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
  const nativeTurnId = turnId('turn-t08207-native-conflict')

  mapper.apply(
    envelope(
      'turn.started',
      1,
      { turnId: nativeTurnId, submissionId: 'submission-t08207-conflict-b' } as never,
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
        inputId: 'submission-t08207-conflict-a' as never,
      }
    )
  )

  const carrier = db.runs.getByTurnKey(
    `${TMUX_RUNTIME_ID}|${TMUX_OPERATION_ID}|${TMUX_INVOCATION_ID}|${nativeTurnId}|g=-|a=-`
  )
  expect(carrier).toMatchObject({ initiatingInputId: undefined, executionFormat: 'format2' })
  expect(db.inputs.getByInputId('input-t08207-conflict-a')).toMatchObject({
    status: 'accepted',
    cleanupProtection: 'protected',
  })
  expect(db.inputs.getByInputId('input-t08207-conflict-b')).toMatchObject({
    status: 'accepted',
    cleanupProtection: 'protected',
  })
})

test('a failed format-2 landing rolls back the minted carrier and preserves input protection for retry', () => {
  const db = fixture.db as any
  db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    executionFormat: 'format2',
    updatedAt: ts(),
  })
  const hrcInputId = 'input-t08207-rollback'
  const nativeTurnId = turnId('turn-t08207-rollback')
  db.inputs.insert(admittedInput(hrcInputId, 'submission-t08207-rollback'))
  const mapper = new BrokerEventMapper({ db, now: () => ts(100) })

  mapper.apply(
    envelope(
      'submission.executed',
      1,
      {
        submissionId: 'submission-t08207-rollback',
        turnId: nativeTurnId,
      },
      {
        invocationId: TMUX_INVOCATION_ID,
        turnId: nativeTurnId,
      }
    )
  )
  const started = envelope(
    'turn.started',
    2,
    { source: 'observed', turnId: nativeTurnId },
    {
      invocationId: TMUX_INVOCATION_ID,
      turnId: nativeTurnId,
    }
  )
  const recordLanding = db.inputs.recordLanding.bind(db.inputs)
  db.inputs.recordLanding = () => {
    throw new Error('forced landing failure')
  }
  expect(() => mapper.apply(started)).toThrow('forced landing failure')
  db.inputs.recordLanding = recordLanding

  expect(db.runs.listRuns({ hostSessionId: TMUX_HOST_SESSION_ID })).toEqual([])
  expect(db.inputs.getByInputId(hrcInputId)).toMatchObject({
    status: 'accepted',
    cleanupProtection: 'protected',
  })
  expect(db.inputs.getByInputId(hrcInputId)).not.toHaveProperty('carrierRunId')
  expect(db.brokerInvocationEvents.getByInvocationAndSeq(TMUX_INVOCATION_ID, 2)).toBeNull()
  expect(db.brokerInvocations.getByInvocationId(TMUX_INVOCATION_ID)).toMatchObject({
    lastProjectedSeq: 1,
  })

  mapper.apply(started)
  expect(db.runs.listRuns({ hostSessionId: TMUX_HOST_SESSION_ID })).toHaveLength(1)
  expect(db.inputs.getByInputId(hrcInputId)).toMatchObject({
    status: 'initiating',
    cleanupProtection: 'carrier-run',
  })
})

test('format-2 releases only an exact rejected input; teardown cancellation and invocation failure stay protected', () => {
  const db = fixture.db as any
  db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    executionFormat: 'format2',
    updatedAt: ts(),
  })
  db.inputs.insert(admittedInput('input-t08207-rejected', 'submission-t08207-rejected'))
  db.inputs.insert(admittedInput('input-t08207-teardown', 'submission-t08207-teardown'))
  const mapper = new BrokerEventMapper({ db, now: () => ts(100) })

  const rejected = mapper.apply(
    envelope(
      'submission.rejected',
      1,
      { submissionId: 'submission-t08207-rejected' },
      {
        invocationId: TMUX_INVOCATION_ID,
      }
    )
  )
  const cancelled = mapper.apply(
    envelope(
      'submission.cancelled',
      2,
      {
        submissionId: 'submission-t08207-teardown',
        reason: 'teardown',
      },
      {
        invocationId: TMUX_INVOCATION_ID,
      }
    )
  )
  const invocationFailed = mapper.apply(
    envelope(
      'invocation.failed',
      3,
      { reason: 'submission_correlation_lost' },
      {
        invocationId: TMUX_INVOCATION_ID,
      }
    )
  )

  expect(db.inputs.getByInputId('input-t08207-rejected')).toMatchObject({
    status: 'rejected',
    cleanupProtection: 'released',
  })
  expect(db.inputs.getByInputId('input-t08207-teardown')).toMatchObject({
    status: 'accepted',
    cleanupProtection: 'protected',
  })
  expect(
    rejected.lifecycleEvents.find((event) => event.eventKind === 'input.terminal')?.payload
  ).toMatchObject({
    inputId: 'input-t08207-rejected',
    terminal: 'rejected',
  })
  expect(
    cancelled.lifecycleEvents.find((event) => event.eventKind === 'input.correlation')?.payload
  ).toMatchObject({
    inputId: 'input-t08207-teardown',
    fact: 'cancelled',
    detail: 'teardown',
  })
  expect(
    invocationFailed.lifecycleEvents.find((event) => event.eventKind === 'input.correlation')
      ?.payload
  ).toMatchObject({
    inputId: 'input-t08207-teardown',
    fact: 'invocation_failed',
  })
  expect(db.runs.listRuns({ hostSessionId: TMUX_HOST_SESSION_ID })).toEqual([])
})
