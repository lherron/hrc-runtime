import { type HrcBrokerInvocationEventRecord, HrcErrorCode } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { isLaunchCarriedInvokeCorrelationJson } from '../server-types.js'

export const UNRESOLVED_ABSORBED_OWNER_MARKER = 'absorbed_submission_owner_unresolved'

type TurnCoordinates = {
  turnId: string
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
}

type ParsedEvent = TurnCoordinates & {
  type: string
  seq: number
  runtimeId: string
  inputId?: string | undefined
  submissionId?: string | undefined
  ownership?: string | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function parseStoredEvent(row: HrcBrokerInvocationEventRecord): ParsedEvent | undefined {
  let payload: Record<string, unknown> | undefined
  let envelope: Record<string, unknown> | undefined
  try {
    payload = record(JSON.parse(row.brokerEventJson) as unknown)
  } catch {
    payload = undefined
  }
  try {
    envelope = row.brokerEnvelopeJson
      ? record(JSON.parse(row.brokerEnvelopeJson) as unknown)
      : undefined
  } catch {
    envelope = undefined
  }
  const turnId = stringField(envelope, 'turnId') ?? stringField(payload, 'turnId')
  if (turnId === undefined) return undefined
  return {
    type: row.type,
    seq: row.seq,
    runtimeId: row.runtimeId,
    turnId,
    ...(row.harnessGeneration !== undefined ? { harnessGeneration: row.harnessGeneration } : {}),
    ...(row.turnAttempt !== undefined ? { turnAttempt: row.turnAttempt } : {}),
    ...((stringField(envelope, 'inputId') ?? stringField(payload, 'inputId'))
      ? {
          inputId: stringField(envelope, 'inputId') ?? stringField(payload, 'inputId'),
        }
      : {}),
    ...(stringField(payload, 'submissionId') !== undefined
      ? { submissionId: stringField(payload, 'submissionId') }
      : {}),
    ...(stringField(payload, 'ownership') !== undefined
      ? { ownership: stringField(payload, 'ownership') }
      : {}),
  }
}

function coordinatesForEnvelope(envelope: InvocationEventEnvelope): TurnCoordinates | undefined {
  const payload = record(envelope.payload)
  const turnId =
    typeof envelope.turnId === 'string' ? envelope.turnId : stringField(payload, 'turnId')
  if (turnId === undefined) return undefined
  return {
    turnId,
    ...(envelope.harnessGeneration !== undefined
      ? { harnessGeneration: envelope.harnessGeneration }
      : {}),
    ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
  }
}

function coordinatesMatch(target: TurnCoordinates, evidence: TurnCoordinates): boolean {
  if (target.turnId !== evidence.turnId) return false
  if (
    target.harnessGeneration !== undefined &&
    evidence.harnessGeneration !== target.harnessGeneration
  ) {
    return false
  }
  if (target.turnAttempt !== undefined && evidence.turnAttempt !== target.turnAttempt) {
    return false
  }
  return true
}

function inputIdForEnvelope(envelope: InvocationEventEnvelope): string | undefined {
  if (typeof envelope.inputId === 'string') return envelope.inputId
  return stringField(record(envelope.payload), 'inputId')
}

function runForInput(db: HrcDatabase, inputId: string) {
  return db.runs.getByDispatchedInputId(inputId) ?? db.runs.getByBrokerSubmissionId(inputId)
}

function historicalEpoch(db: HrcDatabase, invocationId: string) {
  const invocation = db.brokerInvocations.getByInvocationId(invocationId)
  if (invocation === null) return undefined
  const operation = db.runtimeOperations.getByOperationId(invocation.operationId)
  if (
    operation === null ||
    invocation.runtimeId !== operation.runtimeId ||
    invocation.operationId !== operation.operationId
  ) {
    return undefined
  }
  return { invocation, operation }
}

function validCandidate(db: HrcDatabase, invocationId: string, runId: string): string | undefined {
  const epoch = historicalEpoch(db, invocationId)
  const run = db.runs.getByRunId(runId)
  if (
    epoch === undefined ||
    run === null ||
    run.runtimeId !== epoch.invocation.runtimeId ||
    run.invocationId !== invocationId ||
    run.operationId !== epoch.invocation.operationId ||
    run.generation !== epoch.operation.generation
  ) {
    return undefined
  }
  return run.runId
}

const TURN_EVIDENCE_TYPES = ['turn.started', 'turn.attributed', 'submission.executed'] as const
const TURN_TERMINAL_TYPES = ['turn.completed', 'turn.failed', 'turn.interrupted'] as const

/** Resolve one native turn from immutable initiating evidence in its historical epoch. */
export function resolveExactTurnOwner(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope
): string | undefined {
  const target = coordinatesForEnvelope(envelope)
  if (target === undefined) return undefined
  const invocationId = String(envelope.invocationId)
  const epoch = historicalEpoch(db, invocationId)
  if (epoch === undefined) return undefined

  // Read only the initiating evidence for this turn and the invocation's first
  // start, never the whole invocation: this runs for every turn-scoped event, and
  // a full reload made its cost grow with invocation length (T-08781).
  // historicalEpoch guarantees the invocation and operation runtimes agree.
  const priorRows = (options: { types: readonly string[]; turnId?: string; first?: boolean }) =>
    db.brokerInvocationEvents
      .listByInvocationIdAndTypes({
        invocationId,
        types: options.types,
        throughSeq: envelope.seq,
        runtimeId: epoch.invocation.runtimeId,
        ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
        ...(options.first === true ? { hasTurnId: true, limit: 1 } : {}),
      })
      .map(parseStoredEvent)
      .filter((event): event is ParsedEvent => event !== undefined)
  const evidence = priorRows({
    types: TURN_EVIDENCE_TYPES,
    turnId: target.turnId,
  }).filter((event) => coordinatesMatch(target, event))
  const candidates = new Set<string>()
  let foreign = false

  const addInputCandidate = (inputId: string | undefined) => {
    if (inputId === undefined) return
    const run = runForInput(db, inputId)
    if (run !== null) {
      const valid = validCandidate(db, invocationId, run.runId)
      if (valid !== undefined) candidates.add(valid)
    }
  }

  for (const event of evidence) {
    if (event.type === 'turn.started') addInputCandidate(event.inputId)
    if (event.type === 'turn.attributed') {
      if (event.ownership === 'foreign') foreign = true
      if (event.ownership === 'own') addInputCandidate(event.inputId)
    }
    if (event.type === 'submission.executed' && event.submissionId !== undefined) {
      const run = db.runs.getByBrokerSubmissionId(event.submissionId)
      if (run !== null) {
        const valid = validCandidate(db, invocationId, run.runId)
        if (valid !== undefined) candidates.add(valid)
      }
    }
  }

  if (envelope.type === 'turn.started' || envelope.type === 'turn.attributed') {
    const payload = record(envelope.payload)
    const ownership = stringField(payload, 'ownership')
    if (envelope.type === 'turn.attributed' && ownership === 'foreign') foreign = true
    if (envelope.type === 'turn.started' || ownership === 'own') {
      addInputCandidate(inputIdForEnvelope(envelope))
    }
  }

  // The launch marker applies only to the invocation's first input-less start.
  const [storedFirstStart] = priorRows({ types: ['turn.started'], first: true })
  const currentIsFirstStart =
    envelope.type === 'turn.started' &&
    inputIdForEnvelope(envelope) === undefined &&
    storedFirstStart === undefined
  const targetIsStoredFirstStart =
    storedFirstStart !== undefined &&
    storedFirstStart.inputId === undefined &&
    coordinatesMatch(target, storedFirstStart)
  if (currentIsFirstStart || targetIsStoredFirstStart) {
    // isLaunchCarriedInvokeCorrelationJson(null) is false, so only annotated runs
    // of this invocation can qualify.
    for (const run of db.runs.listCorrelatedByInvocationId(invocationId)) {
      if (
        run.runtimeId === epoch.invocation.runtimeId &&
        run.invocationId === invocationId &&
        run.operationId === epoch.invocation.operationId &&
        run.generation === epoch.operation.generation &&
        isLaunchCarriedInvokeCorrelationJson(db.runs.getCorrelationJson(run.runId))
      ) {
        const valid = validCandidate(db, invocationId, run.runId)
        if (valid !== undefined) candidates.add(valid)
      }
    }
  }

  if (foreign || candidates.size !== 1) return undefined
  return [...candidates][0]
}

function coordinateKey(value: TurnCoordinates): string {
  return JSON.stringify([value.turnId, value.harnessGeneration ?? null, value.turnAttempt ?? null])
}

/** True when a different native turn bracket is still open at this event's sequence. */
export function hasOtherOpenTurn(db: HrcDatabase, envelope: InvocationEventEnvelope): boolean {
  const target = coordinatesForEnvelope(envelope)
  if (target === undefined) return false
  const events = db.brokerInvocationEvents
    .listByInvocationIdAndTypes({
      invocationId: String(envelope.invocationId),
      types: ['turn.started', ...TURN_TERMINAL_TYPES],
      throughSeq: envelope.seq,
    })
    .map(parseStoredEvent)
    .filter((event): event is ParsedEvent => event !== undefined)
  const terminalTypes = new Set<string>(TURN_TERMINAL_TYPES)
  const targetKey = coordinateKey(target)
  return events.some((started) => {
    if (started.type !== 'turn.started' || coordinateKey(started) === targetKey) return false
    return !events.some(
      (terminal) =>
        terminal.seq > started.seq &&
        terminalTypes.has(terminal.type) &&
        coordinateKey(terminal) === coordinateKey(started)
    )
  })
}

function payloadForRow(row: HrcBrokerInvocationEventRecord): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(row.brokerEventJson) as unknown)
  } catch {
    return undefined
  }
}

function isSteerSubmission(db: HrcDatabase, invocationId: string, submissionId: string): boolean {
  return db.brokerInvocationEvents
    .listByInvocationIdAndTypes({ invocationId, types: ['admission.admitted'] })
    .some((row) => {
      const payload = payloadForRow(row)
      return stringField(payload, 'submissionId') === submissionId && payload?.['class'] === 'steer'
    })
}

function absorbedRows(db: HrcDatabase, runtimeId: string, invocationId?: string) {
  return db.sqlite
    .query<
      { invocationId: string; runtimeId: string; brokerEventJson: string },
      [string, string, string]
    >(
      `SELECT invocation_id AS invocationId, runtime_id AS runtimeId,
              broker_event_json AS brokerEventJson
         FROM broker_invocation_events
        WHERE runtime_id = ? AND type = 'submission.absorbed'
          AND (? = '' OR invocation_id = ?)
        ORDER BY invocation_id, seq`
    )
    .all(runtimeId, invocationId ?? '', invocationId ?? '')
}

function settleAuxiliary(
  db: HrcDatabase,
  invocationId: string,
  submissionId: string,
  ownerRunId: string,
  completedAt: string
): void {
  const epoch = historicalEpoch(db, invocationId)
  const auxiliary = db.runs.getByBrokerSubmissionId(submissionId)
  const owner = db.runs.getByRunId(ownerRunId)
  if (
    epoch === undefined ||
    auxiliary === null ||
    owner === null ||
    auxiliary.runId === ownerRunId ||
    !isSteerSubmission(db, invocationId, submissionId) ||
    auxiliary.startedAt !== undefined ||
    auxiliary.runtimeId !== epoch.invocation.runtimeId ||
    auxiliary.invocationId !== invocationId ||
    auxiliary.operationId !== epoch.invocation.operationId ||
    auxiliary.generation !== epoch.operation.generation ||
    validCandidate(db, invocationId, ownerRunId) === undefined
  ) {
    return
  }
  if (auxiliary.coalescedIntoRunId !== undefined && auxiliary.coalescedIntoRunId !== ownerRunId) {
    throw new Error(
      `absorbed auxiliary ${auxiliary.runId} already belongs to ${auxiliary.coalescedIntoRunId}`
    )
  }
  if (auxiliary.coalescedIntoRunId === ownerRunId) return
  if (auxiliary.status === 'accepted' || auxiliary.status === 'completed') {
    db.runs.update(auxiliary.runId, {
      status: 'coalesced',
      completedAt: auxiliary.completedAt ?? completedAt,
      updatedAt: completedAt,
      coalescedIntoRunId: ownerRunId,
    })
    return
  }
  if (['failed', 'cancelled', 'zombie'].includes(auxiliary.status)) {
    db.runs.update(auxiliary.runId, {
      coalescedIntoRunId: ownerRunId,
      updatedAt: completedAt,
    })
  }
}

export function settleAbsorbedAuxiliary(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ownerRunId: string,
  now: string
): void {
  const payload = record(envelope.payload)
  const submissionId = stringField(payload, 'submissionId')
  if (envelope.type !== 'submission.absorbed' || submissionId === undefined) return
  settleAuxiliary(db, String(envelope.invocationId), submissionId, ownerRunId, envelope.time ?? now)
}

/** A late own attribution can settle absorbed submissions already committed for this turn. */
export function settlePriorAbsorbedAuxiliaries(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ownerRunId: string,
  now: string
): void {
  const target = coordinatesForEnvelope(envelope)
  if (target === undefined) return
  const absorbed = db.brokerInvocationEvents.listByInvocationIdAndTypes({
    invocationId: String(envelope.invocationId),
    types: ['submission.absorbed'],
    turnId: target.turnId,
  })
  for (const row of absorbed) {
    const event = parseStoredEvent(row)
    if (
      event === undefined ||
      !coordinatesMatch(target, event) ||
      event.submissionId === undefined
    ) {
      continue
    }
    settleAuxiliary(db, String(envelope.invocationId), event.submissionId, ownerRunId, now)
  }
}

function unresolvedMarker(message: string | undefined): boolean {
  return message?.includes(UNRESOLVED_ABSORBED_OWNER_MARKER) === true
}

/** Explicitly dispose definite absorbed steer auxiliaries whose owner never became knowable. */
export function failUnresolvedAbsorbedAuxiliaries(
  db: HrcDatabase,
  runtimeId: string,
  invocationId: string | undefined,
  now: string
): void {
  for (const row of absorbedRows(db, runtimeId, invocationId)) {
    const payload = record(JSON.parse(row.brokerEventJson) as unknown)
    const submissionId = stringField(payload, 'submissionId')
    if (submissionId === undefined || !isSteerSubmission(db, row.invocationId, submissionId))
      continue
    const run = db.runs.getByBrokerSubmissionId(submissionId)
    if (
      run === null ||
      run.startedAt !== undefined ||
      run.coalescedIntoRunId !== undefined ||
      unresolvedMarker(run.errorMessage)
    ) {
      continue
    }
    const detail = `${UNRESOLVED_ABSORBED_OWNER_MARKER}: invocation ${row.invocationId} ended before exact turn ownership was established`
    if (run.status === 'accepted' || run.status === 'completed') {
      db.runs.markCompleted(run.runId, {
        status: 'failed',
        completedAt: run.completedAt ?? now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: detail,
      })
    } else {
      db.runs.update(run.runId, {
        updatedAt: now,
        errorMessage: run.errorMessage ? `${run.errorMessage}; ${detail}` : detail,
      })
    }
  }
}

/** Pruning must retain the graph until every absorbed steer dependency is settled explicitly. */
export function hasUnsettledAbsorbedAuxiliary(db: HrcDatabase, runtimeId: string): boolean {
  for (const row of absorbedRows(db, runtimeId)) {
    const payload = record(JSON.parse(row.brokerEventJson) as unknown)
    const submissionId = stringField(payload, 'submissionId')
    if (submissionId === undefined || !isSteerSubmission(db, row.invocationId, submissionId))
      continue
    const run = db.runs.getByBrokerSubmissionId(submissionId)
    if (
      run !== null &&
      run.startedAt === undefined &&
      run.coalescedIntoRunId === undefined &&
      !unresolvedMarker(run.errorMessage)
    ) {
      return true
    }
  }
  return false
}
