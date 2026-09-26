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
        identity: { ...identity, initialInputId: 'input-t08207-f2' },
        executionFormat: 'format2',
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
