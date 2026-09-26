import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'

import { openHrcDatabase } from '../index.js'
import { EVENT_INPUT_ID_SQL } from '../repositories/broker.js'

const AT = '2026-09-26T06:30:00.000Z'

function admittedInput(inputId: string, brokerSubmissionId?: string) {
  return {
    inputId,
    admissionHostSessionId: 'hsid-t08207',
    idempotencyKey: `idem-${inputId}`,
    requestHash: `sha256:${inputId}`,
    hostSessionId: 'hsid-t08207',
    runtimeId: 'rt-t08207',
    operationId: 'op-t08207',
    invocationId: 'inv-t08207',
    ...(brokerSubmissionId === undefined ? {} : { brokerSubmissionId }),
    door: 'steer',
    admissionClass: 'steer',
    origin: 'agent',
    status: 'accepted',
    uncertainty: 'none',
    cleanupProtection: 'protected',
    admittedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  }
}

function insertObservedCarrier(
  db: any,
  runId: string,
  turnId: string,
  coordinate: {
    hostSessionId?: string
    runtimeId?: string
    operationId?: string
    invocationId?: string
    observedStartHrcSeq?: number
  } = {}
): void {
  const hostSessionId = coordinate.hostSessionId ?? 'hsid-t08207'
  const runtimeId = coordinate.runtimeId ?? 'rt-t08207'
  const operationId = coordinate.operationId ?? 'op-t08207'
  const invocationId = coordinate.invocationId ?? 'inv-t08207'
  db.sessions.insert({
    hostSessionId,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    createdAt: AT,
    updatedAt: AT,
  })
  db.runs.insert({
    runId,
    hostSessionId,
    runtimeId,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'running',
    startedAt: AT,
    updatedAt: AT,
    executionFormat: 'format2',
    turnKey: `${runtimeId}|${operationId}|${invocationId}|${turnId}|g=-|a=-`,
    nativeTurnId: turnId,
    observedStartHrcSeq: coordinate.observedStartHrcSeq ?? 42,
    operationId,
    invocationId,
  })
}

test('format-2 admission persists a protected input before any execution run exists', () => {
  const db = openHrcDatabase(':memory:') as any

  const admitted = db.inputs.insert(admittedInput('input-t08207-a', 'submission-t08207-a'))

  expect(admitted).toMatchObject({
    inputId: 'input-t08207-a',
    status: 'accepted',
    cleanupProtection: 'protected',
    brokerSubmissionId: 'submission-t08207-a',
  })
  expect(db.inputs.getByAdmission('hsid-t08207', 'idem-input-t08207-a')).toMatchObject({
    inputId: 'input-t08207-a',
  })
  expect(db.inputs.getByBrokerSubmissionId('submission-t08207-a')).toMatchObject({
    inputId: 'input-t08207-a',
  })
  expect(
    db.inputs
      .listProtectedByRuntimeId('rt-t08207')
      .map((input: { inputId: string }) => input.inputId)
  ).toEqual(['input-t08207-a'])
  expect(db.runs.listRuns({ hostSessionId: 'hsid-t08207' })).toEqual([])

  expect(() => db.inputs.insert(admittedInput('input-t08207-b', 'submission-t08207-a'))).toThrow()
})

test('format-2 warm admission binds its native submission exactly once', () => {
  const db = openHrcDatabase(':memory:') as any
  db.inputs.insert(admittedInput('input-t08207-warm'))

  expect(
    db.inputs.bindBrokerSubmissionId(
      'input-t08207-warm',
      'submission-t08207-warm',
      '2026-09-26T06:30:01.000Z'
    )
  ).toMatchObject({ brokerSubmissionId: 'submission-t08207-warm' })
  expect(
    db.inputs.bindBrokerSubmissionId(
      'input-t08207-warm',
      'submission-t08207-warm',
      '2026-09-26T06:30:02.000Z'
    )
  ).toMatchObject({ brokerSubmissionId: 'submission-t08207-warm' })
  expect(() =>
    db.inputs.bindBrokerSubmissionId(
      'input-t08207-warm',
      'submission-t08207-conflict',
      '2026-09-26T06:30:03.000Z'
    )
  ).toThrow(/broker submission conflict/)
})

test('one exact landing transfers protection to a carrier without permitting a conflicting rebind', () => {
  const db = openHrcDatabase(':memory:') as any
  db.inputs.insert(admittedInput('input-t08207-a'))

  const landing = {
    inputId: 'input-t08207-a',
    kind: 'initiating',
    carrierRunId: 'run-t08207-a',
    turnId: 'turn-t08207-a',
    runStartedHrcSeq: 42,
    landedAt: AT,
  }
  expect(() => db.inputs.recordLanding(landing)).toThrow(/carrier.*run|run.*carrier/i)
  insertObservedCarrier(db, landing.carrierRunId, landing.turnId)
  expect(db.inputs.recordLanding(landing)).toMatchObject({
    status: 'initiating',
    cleanupProtection: 'carrier-run',
    carrierRunId: 'run-t08207-a',
    turnId: 'turn-t08207-a',
  })
  expect(db.inputs.recordLanding(landing)).toMatchObject({ carrierRunId: 'run-t08207-a' })
  expect(() => db.inputs.recordLanding({ ...landing, carrierRunId: 'run-t08207-b' })).toThrow(
    /input.*landing|landing.*input/i
  )
})

test('format-2 landing refuses every live carrier whose durable coordinate or start sequence differs', () => {
  const mismatches = [
    ['host session', { hostSessionId: 'hsid-t08207-foreign' }],
    ['runtime', { runtimeId: 'rt-t08207-foreign' }],
    ['operation', { operationId: 'op-t08207-foreign' }],
    ['invocation', { invocationId: 'inv-t08207-foreign' }],
    ['observed start sequence', { observedStartHrcSeq: 43 }],
  ] as const

  for (const [name, coordinate] of mismatches) {
    const db = openHrcDatabase(':memory:') as any
    const inputId = `input-t08207-mismatch-${name}`
    const carrierRunId = `run-t08207-mismatch-${name}`
    const turnId = `turn-t08207-mismatch-${name}`
    db.inputs.insert(admittedInput(inputId))
    insertObservedCarrier(db, carrierRunId, turnId, coordinate)

    expect(() =>
      db.inputs.recordLanding({
        inputId,
        kind: 'initiating',
        carrierRunId,
        turnId,
        runStartedHrcSeq: 42,
        landedAt: AT,
      })
    ).toThrow(/exact carrier|carrier.*coordinate|coordinate.*carrier/i)
    expect(db.inputs.getByInputId(inputId)).toMatchObject({
      status: 'accepted',
      cleanupProtection: 'protected',
    })
  }
})

test('only a proved pre-landing rejection releases an input without minting a run', () => {
  const db = openHrcDatabase(':memory:') as any
  db.inputs.insert(admittedInput('input-t08207-rejected'))

  expect(
    db.inputs.recordTerminal({
      inputId: 'input-t08207-rejected',
      terminal: 'rejected',
      terminalAt: AT,
      errorCode: 'broker_rejected',
      errorMessage: 'driver refused input',
    })
  ).toMatchObject({
    status: 'rejected',
    cleanupProtection: 'released',
    terminalAt: AT,
    errorCode: 'broker_rejected',
  })
  expect(db.runs.listRuns({ hostSessionId: 'hsid-t08207' })).toEqual([])
})

test('repairs the format-2 input-id index so malformed historical broker events remain readable', () => {
  const migrationId = '0077_format2_input_event_index_json_guard'
  const indexName = 'idx_broker_invocation_events_input_id'
  const dbPath = `/tmp/hrc-t08207-json-index-${process.pid}-${Date.now()}.sqlite`
  let db = openHrcDatabase(dbPath) as any
  try {
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-t08207-json-index',
      seq: 1,
      time: AT,
      type: 'turn.started',
      runtimeId: 'rt-t08207-json-index',
      payload: { inputId: 'input-t08207-indexed' },
    })

    // Model a database that opened under the original 0076 migration before
    // the repair release: it has the unsafe expression index and no repair
    // migration record yet.
    db.sqlite.exec(`
      DROP INDEX ${indexName};
      CREATE INDEX ${indexName}
        ON broker_invocation_events(invocation_id, json_extract(broker_event_json, '$.inputId'));
      DELETE FROM hrc_migrations WHERE id = '${migrationId}';
    `)
  } finally {
    db.close()
  }

  db = openHrcDatabase(dbPath) as any
  try {
    expect(db.migrations.applied).toContain(migrationId)
    const index = db.sqlite
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
      )
      .get(indexName)
    expect(index?.sql).toContain('json_valid(broker_event_json)')

    const lookupSql = `SELECT seq FROM broker_invocation_events
      WHERE invocation_id = ? AND ${EVENT_INPUT_ID_SQL} = ?`
    const plan = db.sqlite
      .query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${lookupSql}`)
      .all('inv-t08207-json-index', 'input-t08207-indexed')
      .map((row: { detail: string }) => row.detail)
      .join('\n')
    expect(plan).toContain(indexName)
    expect(
      db.sqlite
        .query<{ seq: number }, [string, string]>(lookupSql)
        .all('inv-t08207-json-index', 'input-t08207-indexed')
        .map((row: { seq: number }) => row.seq)
    ).toEqual([1])

    expect(() =>
      db.sqlite
        .query(
          'UPDATE broker_invocation_events SET broker_event_json = ? WHERE invocation_id = ? AND seq = ?'
        )
        .run('{not valid json', 'inv-t08207-json-index', 1)
    ).not.toThrow()
    expect(
      db.sqlite
        .query<{ seq: number }, [string, string]>(lookupSql)
        .all('inv-t08207-json-index', 'input-t08207-indexed')
    ).toEqual([])
  } finally {
    db.close()
    rmSync(dbPath, { force: true })
  }
})
