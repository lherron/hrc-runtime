import { existsSync } from 'node:fs'

import { Database } from 'bun:sqlite'

import {
  INITIAL_DELETE_BATCH_SIZE,
  MIN_DELETE_BATCH_SIZE,
  STRIP_ENVELOPE_PAYLOADS_OPERATION,
} from './constants.ts'
import type {
  PrunePhaseStop,
  PruneStateRetentionOptions,
  StripEnvelopePayloadsResult,
} from './types.ts'
import {
  adaptStepSize,
  assertIncrementalAutoVacuum,
  incrementalVacuum,
  readPragmaNumber,
} from './vacuum.ts'
import {
  createWriteBudget,
  deadlineReached,
  isBusyError,
  pauseAfterWrite,
  runWriteStep,
  tolerateBusy,
  worstStopReason,
} from './write-budget.ts'

export type EnvelopePayloadKey = {
  invocation_id: string
  seq: number
}

export type StripEnvelopePayloadBatch = {
  selected: number
  stripped: number
  lastKey: EnvelopePayloadKey | null
}

export const ENVELOPE_PAYLOAD_PRESENT_SQL = `
  broker_envelope_json IS NOT NULL
  AND json_type(broker_envelope_json, '$.payload') IS NOT NULL
`

export function countEnvelopePayloads(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count
           FROM broker_invocation_events
          WHERE ${ENVELOPE_PAYLOAD_PRESENT_SQL}`
      )
      .get()?.count ?? 0
  )
}

export function createStripEnvelopePayloadBatch(
  db: Database
): (
  afterInvocationId: string | null,
  afterSeq: number,
  batchSize: number
) => StripEnvelopePayloadBatch {
  const select = db.query<
    EnvelopePayloadKey,
    [string | null, string | null, string | null, number, number]
  >(
    `SELECT invocation_id, seq
       FROM broker_invocation_events
      WHERE ${ENVELOPE_PAYLOAD_PRESENT_SQL}
        AND (
          ? IS NULL
          OR invocation_id > ?
          OR (invocation_id = ? AND seq > ?)
        )
      ORDER BY invocation_id ASC, seq ASC
      LIMIT ?`
  )
  const update = db.prepare<
    never,
    [string | null, string | null, string | null, number, string, string, number]
  >(
    `UPDATE broker_invocation_events
        SET broker_envelope_json = json_remove(broker_envelope_json, '$.payload')
      WHERE ${ENVELOPE_PAYLOAD_PRESENT_SQL}
        AND (
          ? IS NULL
          OR invocation_id > ?
          OR (invocation_id = ? AND seq > ?)
        )
        AND (
          invocation_id < ?
          OR (invocation_id = ? AND seq <= ?)
        )`
  )
  const transaction = db.transaction(
    (
      afterInvocationId: string | null,
      afterSeq: number,
      batchSize: number
    ): StripEnvelopePayloadBatch => {
      const rows = select.all(
        afterInvocationId,
        afterInvocationId,
        afterInvocationId,
        afterSeq,
        batchSize
      )
      const lastKey = rows.at(-1) ?? null
      const stripped =
        lastKey === null
          ? 0
          : update.run(
              afterInvocationId,
              afterInvocationId,
              afterInvocationId,
              afterSeq,
              lastKey.invocation_id,
              lastKey.invocation_id,
              lastKey.seq
            ).changes
      if (stripped !== rows.length) {
        throw new Error(
          `envelope payload strip batch selected ${rows.length} rows but updated ${stripped}`
        )
      }
      return {
        selected: rows.length,
        stripped,
        lastKey,
      }
    }
  )
  return (afterInvocationId, afterSeq, batchSize) =>
    transaction.immediate(afterInvocationId, afterSeq, batchSize)
}

/**
 * Remove the payload copy embedded in historical broker envelopes. The
 * `(invocation_id, seq)` cursor advances only after an immediate transaction
 * commits, so a deadline, SQLITE_BUSY exit, or process restart can safely
 * resume from the first still-eligible row. The eligibility predicate makes
 * the operation idempotent across repeated runs.
 */
export async function stripEnvelopePayloads(
  options: PruneStateRetentionOptions
): Promise<StripEnvelopePayloadsResult> {
  if (options.operation !== STRIP_ENVELOPE_PAYLOADS_OPERATION) {
    throw new Error('stripEnvelopePayloads requires --strip-envelope-payloads')
  }
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const budget = createWriteBudget(options)
  const db = new Database(options.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')

    let autoVacuumMode: number
    try {
      autoVacuumMode = (await runWriteStep(budget, () => readPragmaNumber(db, 'auto_vacuum'))).value
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return {
        operation: STRIP_ENVELOPE_PAYLOADS_OPERATION,
        eligibleCount: null,
        stripped: 0,
        remainingEligibleCount: null,
        stopReason: 'busy',
        deadlineExceeded: budget.deadlineExceeded,
        elapsedMillis: Date.now() - budget.startedAtMillis,
        pausedMillis: budget.pausedMillis,
        busyRetries: budget.busyRetries,
        writeSteps: budget.writeSteps,
        heldMillis: budget.heldMillis,
        maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
        batchSize: options.batchSize,
        lastInvocationId: null,
        lastSeq: null,
        autoVacuumMode: 0,
        freelistBeforePages: 0,
        freelistBeforeVacuumPages: 0,
        freelistAfterPages: 0,
        reclaimedPages: 0,
        vacuumChunkPages: options.incrementalVacuumChunkPages,
        vacuumStopReason: 'busy',
        checkpointed: false,
      }
    }
    if (options.apply) {
      assertIncrementalAutoVacuum(autoVacuumMode)
    }

    const eligibleCount = options.countEligible
      ? tolerateBusy(() => countEnvelopePayloads(db), null).value
      : null
    const freelistBeforePages = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), 0).value
    let stripped = 0
    let stopReason: PrunePhaseStop = 'complete'
    let batchSize = Math.min(INITIAL_DELETE_BATCH_SIZE, options.batchSize)
    let lastKey: EnvelopePayloadKey | null = null
    let checkpointed = false
    let freelistBeforeVacuumPages = freelistBeforePages
    let vacuumChunkPages = options.incrementalVacuumChunkPages
    let vacuumStopReason: PrunePhaseStop = 'complete'

    if (options.apply) {
      const stripBatch = createStripEnvelopePayloadBatch(db)
      while (true) {
        if (deadlineReached(budget)) {
          stopReason = 'deadline'
          break
        }
        const requestedRows = batchSize
        let batch: StripEnvelopePayloadBatch
        let holdMillis: number
        try {
          const step = await runWriteStep(budget, () =>
            stripBatch(lastKey?.invocation_id ?? null, lastKey?.seq ?? -1, requestedRows)
          )
          batch = step.value
          holdMillis = step.holdMillis
        } catch (error) {
          if (!isBusyError(error)) {
            throw error
          }
          stopReason = 'busy'
          break
        }

        stripped += batch.stripped
        if (batch.lastKey !== null) {
          lastKey = batch.lastKey
        }
        if (batch.selected < requestedRows) {
          const remaining = tolerateBusy(() => countEnvelopePayloads(db), null)
          if (remaining.busy || remaining.value === null) {
            stopReason = 'busy'
            break
          }
          if (remaining.value === 0) {
            stopReason = 'complete'
            break
          }
          // A pre-cutover writer may have inserted an eligible key behind the
          // cursor. Start another keyset pass; rows already stripped no longer
          // match, so this remains bounded by the deadline and idempotent.
          lastKey = null
        }
        batchSize = adaptStepSize(
          requestedRows,
          holdMillis,
          budget.maxWriteHoldMillis,
          MIN_DELETE_BATCH_SIZE,
          options.batchSize
        )
        await pauseAfterWrite(budget, holdMillis)
      }

      if (options.checkpoint) {
        try {
          await runWriteStep(budget, () => db.exec('PRAGMA wal_checkpoint(PASSIVE);'))
          checkpointed = true
        } catch (error) {
          if (!isBusyError(error)) {
            throw error
          }
        }
      }
      freelistBeforeVacuumPages = tolerateBusy(
        () => readPragmaNumber(db, 'freelist_count'),
        freelistBeforePages
      ).value
      if (stopReason === 'complete') {
        const vacuum = await incrementalVacuum(
          db,
          budget,
          options.incrementalVacuumPages,
          options.incrementalVacuumChunkPages
        )
        vacuumStopReason = vacuum.stopReason
        vacuumChunkPages = vacuum.chunkPages
      } else {
        vacuumStopReason = stopReason
      }
    }

    const remainingEligibleCount = tolerateBusy(() => countEnvelopePayloads(db), null).value
    const freelistAfterPages = tolerateBusy(
      () => readPragmaNumber(db, 'freelist_count'),
      freelistBeforeVacuumPages
    ).value

    return {
      operation: STRIP_ENVELOPE_PAYLOADS_OPERATION,
      eligibleCount,
      stripped,
      remainingEligibleCount,
      stopReason: worstStopReason([stopReason, vacuumStopReason]),
      deadlineExceeded: budget.deadlineExceeded,
      elapsedMillis: Date.now() - budget.startedAtMillis,
      pausedMillis: budget.pausedMillis,
      busyRetries: budget.busyRetries,
      writeSteps: budget.writeSteps,
      heldMillis: budget.heldMillis,
      maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
      batchSize,
      lastInvocationId: lastKey?.invocation_id ?? null,
      lastSeq: lastKey?.seq ?? null,
      autoVacuumMode,
      freelistBeforePages,
      freelistBeforeVacuumPages,
      freelistAfterPages,
      reclaimedPages: Math.max(0, freelistBeforeVacuumPages - freelistAfterPages),
      vacuumChunkPages,
      vacuumStopReason,
      checkpointed,
    }
  } finally {
    db.close()
  }
}
