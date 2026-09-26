import { expect, test } from 'bun:test'

import { openHrcDatabase } from '../index.js'

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

function insertObservedCarrier(db: any, runId: string, turnId: string): void {
  db.sessions.insert({
    hostSessionId: 'hsid-t08207',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: 'rt-t08207',
    hostSessionId: 'hsid-t08207',
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
    hostSessionId: 'hsid-t08207',
    runtimeId: 'rt-t08207',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'running',
    startedAt: AT,
    updatedAt: AT,
    executionFormat: 'format2',
    turnKey: `rt-t08207|op-t08207|inv-t08207|${turnId}|g=-|a=-`,
    nativeTurnId: turnId,
    operationId: 'op-t08207',
    invocationId: 'inv-t08207',
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
  expect(db.inputs.listProtectedByRuntimeId('rt-t08207').map((input: { inputId: string }) => input.inputId)).toEqual([
    'input-t08207-a',
  ])
  expect(db.runs.listRuns({ hostSessionId: 'hsid-t08207' })).toEqual([])

  expect(() => db.inputs.insert(admittedInput('input-t08207-b', 'submission-t08207-a'))).toThrow()
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
  expect(() =>
    db.inputs.recordLanding({ ...landing, carrierRunId: 'run-t08207-b' })
  ).toThrow(/input.*landing|landing.*input/i)
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
