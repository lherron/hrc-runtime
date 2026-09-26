import { expect, test } from 'bun:test'

import { persistStartGraph } from '../broker/controller/persistence.js'
import {
  makeFixture,
  makeStartInput,
} from './fixtures/broker-controller.fixture.js'

const HELLO = {
  protocolVersion: 'harness-broker/0.2',
  capabilities: {},
  drivers: [],
} as never

test('format 2 start graph persists an observed-execution invocation without an admission run', async () => {
  const fixture = await makeFixture()
  try {
    const start = makeStartInput()
    const { runId: _legacyAdmissionRun, ...identity } = start.identity

    const graph = persistStartGraph(
      { db: fixture.db, now: () => '2026-09-26T08:30:00.000Z', serverInstanceId: 'srv-t08207' },
      {
        ...start,
        identity,
        executionFormat: 'format2',
        dispatchIdempotencyKey: 't08207-format2-start',
        format2RequestHash: 'sha256:t08207-format2-start',
      },
      HELLO,
      undefined
    )

    expect(graph.run).toBeUndefined()
    expect(graph.runtime.activeRunId).toBeUndefined()
    expect(fixture.db.runtimeOperations.getByOperationId(String(identity.operationId))?.runId).toBeUndefined()
    expect(graph.invocation).toMatchObject({ executionFormat: 'format2' })
    expect(graph.invocation.runId).toBeUndefined()
    expect(fixture.db.runs.listByRuntimeId(String(identity.runtimeId))).toHaveLength(0)
    // Captured hrcdev Codex wire: an initial broker `input.accepted` and its
    // later `submission.executed` both name the producer's supplied
    // `initialInput.inputId`.  These fields have distinct semantics, even when
    // this narrow producer contract assigns the same bytes.
    expect(graph.input).toMatchObject({
      inputId: String(identity.initialInputId),
      brokerSubmissionId: String(start.execution.dispatchRequest.startRequest.initialInput?.inputId),
      cleanupProtection: 'protected',
    })
    expect(
      fixture.db.hrcEvents.listByKind('input.admitted', {
        runtimeId: String(identity.runtimeId),
      })
    ).toMatchObject([
      {
        payload: {
          inputId: String(identity.initialInputId),
          brokerSubmissionId: String(start.execution.dispatchRequest.startRequest.initialInput?.inputId),
          invocationId: String(identity.invocationId),
          afterSeq: 0,
        },
      },
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('format 2 start graph rolls back the protected input and admission event together', async () => {
  const fixture = await makeFixture()
  try {
    const start = makeStartInput()
    const { runId: _legacyAdmissionRun, ...identity } = start.identity
    const append = fixture.db.hrcEvents.appendWithinExistingTransaction.bind(fixture.db.hrcEvents)
    fixture.db.hrcEvents.appendWithinExistingTransaction = () => {
      throw new Error('controlled input.admitted append failure')
    }

    expect(() =>
      persistStartGraph(
        { db: fixture.db, now: () => '2026-09-26T08:30:00.000Z', serverInstanceId: 'srv-t08207' },
        {
          ...start,
          identity,
          executionFormat: 'format2',
          dispatchIdempotencyKey: 't08207-format2-rollback',
          format2RequestHash: 'sha256:t08207-format2-rollback',
        },
        HELLO,
        undefined
      )
    ).toThrow('controlled input.admitted append failure')

    fixture.db.hrcEvents.appendWithinExistingTransaction = append
    expect(fixture.db.inputs.getByInputId(String(identity.initialInputId))).toBeNull()
    expect(fixture.db.runtimes.getByRuntimeId(String(identity.runtimeId))).toBeNull()
    expect(fixture.db.brokerInvocations.getByInvocationId(String(identity.invocationId))).toBeNull()
  } finally {
    await fixture.cleanup()
  }
})

test('format 1 start graph retains its admission run linkage', async () => {
  const fixture = await makeFixture()
  try {
    const start = makeStartInput()
    const graph = persistStartGraph(
      { db: fixture.db, now: () => '2026-09-26T08:30:00.000Z', serverInstanceId: 'srv-t08207' },
      { ...start, executionFormat: 'format1' },
      HELLO,
      undefined
    )

    expect(graph.run?.runId).toBe(String(start.identity.runId))
    expect(graph.runtime.activeRunId).toBe(String(start.identity.runId))
    expect(fixture.db.runtimeOperations.getByOperationId(String(start.identity.operationId))?.runId).toBe(
      String(start.identity.runId)
    )
    expect(graph.invocation.runId).toBe(String(start.identity.runId))
    expect(graph.invocation.executionFormat).toBeUndefined()
    const storedFormat = fixture.db.sqlite
      .query<{ execution_format: string }, [string]>(
        'SELECT execution_format FROM broker_invocations WHERE invocation_id = ?'
      )
      .get(String(start.identity.invocationId))?.execution_format
    expect(storedFormat).toBe('format1')
  } finally {
    await fixture.cleanup()
  }
})
