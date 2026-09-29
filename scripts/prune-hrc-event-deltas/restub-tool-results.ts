import { existsSync } from 'node:fs'

import { Database } from 'bun:sqlite'
import {
  createToolResultSpillStub,
  readToolResultSpillDescriptor,
} from '../../packages/hrc-core/src/index.ts'

import { RESTUB_TOOL_RESULTS_OPERATION } from './constants.ts'
import { type SpillBrokerRow, type SpillLifecycleRow, isRecord } from './spill-tool-results.ts'
import type {
  PrunePhaseStop,
  PruneStateRetentionOptions,
  RestubLedgerResult,
  RestubToolResultsResult,
} from './types.ts'
import {
  createWriteBudget,
  deadlineReached,
  isBusyError,
  pauseAfterWrite,
  runWriteStep,
} from './write-budget.ts'

export type RestubBlobRow = {
  kind: string
  complete: number
}

export function emptyRestubLedgerResult(): RestubLedgerResult {
  return {
    candidates: 0,
    rewritten: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    skipped: {
      invalidDescriptor: 0,
      missingBlob: 0,
      incompleteBlob: 0,
      kindMismatch: 0,
      updateConflict: 0,
    },
  }
}

/**
 * Compact historical spill stubs only after proving their blob remains a complete
 * authority of the descriptor's declared kind. Rows commit independently and
 * the oversized predicate makes reruns idempotent.
 */
// EXCEPTION(T-08422): keep the two ledger walks explicit so their cursors and byte reports cannot be conflated.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the reviewed maintenance path has two deliberately separate ledger phases.
export async function restubToolResults(
  options: PruneStateRetentionOptions
): Promise<RestubToolResultsResult> {
  if (options.operation !== RESTUB_TOOL_RESULTS_OPERATION) {
    throw new Error('restubToolResults requires --restub-tool-results')
  }
  if (!existsSync(options.dbPath)) throw new Error(`HRC store does not exist: ${options.dbPath}`)

  const budget = createWriteBudget(options)
  const db = new Database(options.dbPath)
  db.exec('PRAGMA busy_timeout = 5000;')
  const brokerInvocationEvents = emptyRestubLedgerResult()
  const hrcEvents = emptyRestubLedgerResult()
  let lastInvocationId: string | null = null
  let lastBrokerSeq: number | null = null
  let lastHrcSeq: number | null = null
  let stopReason: PrunePhaseStop = 'complete'
  let checkpointed = false

  const blobById = db.query<RestubBlobRow, [string]>(
    'SELECT kind, complete FROM tool_result_blobs WHERE blob_id = ?'
  )
  const validateAndRestub = (
    result: unknown,
    ledger: RestubLedgerResult
  ): ReturnType<typeof createToolResultSpillStub> | undefined => {
    const descriptor = readToolResultSpillDescriptor(result)
    if (!descriptor) {
      ledger.skipped.invalidDescriptor += 1
      return undefined
    }
    const blob = blobById.get(descriptor.blobId)
    if (!blob) {
      ledger.skipped.missingBlob += 1
      return undefined
    }
    if (blob.complete !== 1) {
      ledger.skipped.incompleteBlob += 1
      return undefined
    }
    if (blob.kind !== descriptor.kind) {
      ledger.skipped.kindMismatch += 1
      return undefined
    }
    return createToolResultSpillStub(result, descriptor, { preserveExistingExcerpt: true })
  }

  try {
    const hasTable = db
      .query<{ present: number }, []>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_result_blobs') AS present"
      )
      .get()?.present
    if (hasTable !== 1) throw new Error('tool_result_blobs migration is not applied')

    const selectBroker = db.query<SpillBrokerRow, [string, number, number]>(
      `SELECT invocation_id, seq, runtime_id, broker_event_json, created_at
         FROM broker_invocation_events
        WHERE type = 'tool.call.completed'
          AND length(CAST(broker_event_json AS BLOB)) > 32768
          AND json_type(broker_event_json, '$.result.details.spill') IS NOT NULL
          AND (invocation_id, seq) > (?, ?)
        ORDER BY invocation_id ASC, seq ASC
        LIMIT ?`
    )
    const updateBroker = db.transaction(
      (row: SpillBrokerRow, beforeJson: string, afterJson: string) =>
        db
          .query<never, [string, string, number, string]>(
            `UPDATE broker_invocation_events
                SET broker_event_json = ?
              WHERE invocation_id = ? AND seq = ?
                AND broker_event_json = ?
                AND length(CAST(broker_event_json AS BLOB)) > 32768
                AND json_type(broker_event_json, '$.result.details.spill') IS NOT NULL`
          )
          .run(afterJson, row.invocation_id, row.seq, beforeJson).changes
    )

    while (stopReason === 'complete') {
      if (deadlineReached(budget)) {
        stopReason = 'deadline'
        break
      }
      const rows = selectBroker.all(lastInvocationId ?? '', lastBrokerSeq ?? -1, options.batchSize)
      if (rows.length === 0) break
      for (const row of rows) {
        lastInvocationId = row.invocation_id
        lastBrokerSeq = row.seq
        const ledger = brokerInvocationEvents
        ledger.candidates += 1
        const beforeBytes = Buffer.byteLength(row.broker_event_json, 'utf8')
        ledger.bytesBefore += beforeBytes
        const payload = JSON.parse(row.broker_event_json) as unknown
        const stub = isRecord(payload) ? validateAndRestub(payload['result'], ledger) : undefined
        if (!isRecord(payload) || !stub) {
          if (!isRecord(payload)) ledger.skipped.invalidDescriptor += 1
          ledger.bytesAfter += beforeBytes
          continue
        }
        const afterJson = JSON.stringify({ ...payload, result: stub })
        const afterBytes = Buffer.byteLength(afterJson, 'utf8')
        if (!options.apply) {
          ledger.bytesAfter += afterBytes
          continue
        }
        if (deadlineReached(budget)) {
          ledger.bytesAfter += beforeBytes
          stopReason = 'deadline'
          break
        }
        try {
          const step = await runWriteStep(budget, () =>
            updateBroker.immediate(row, row.broker_event_json, afterJson)
          )
          if (step.value === 1) {
            ledger.rewritten += 1
            ledger.bytesAfter += afterBytes
          } else {
            ledger.skipped.updateConflict += 1
            ledger.bytesAfter += beforeBytes
          }
          await pauseAfterWrite(budget, step.holdMillis)
        } catch (error) {
          ledger.bytesAfter += beforeBytes
          if (!isBusyError(error)) throw error
          stopReason = 'busy'
          break
        }
      }
      if (rows.length < options.batchSize) break
    }

    if (stopReason === 'complete') {
      const selectLifecycle = db.query<SpillLifecycleRow, [number, number]>(
        `SELECT hrc_seq, runtime_id, payload_json, ts
           FROM hrc_events
          WHERE hrc_seq > ?
            AND event_kind = 'turn.tool_result'
            AND length(CAST(payload_json AS BLOB)) > 32768
            AND json_type(payload_json, '$.result.details.spill') IS NOT NULL
          ORDER BY hrc_seq ASC
          LIMIT ?`
      )
      const updateLifecycle = db.transaction(
        (row: SpillLifecycleRow, beforeJson: string, afterJson: string) =>
          db
            .query<never, [string, number, string]>(
              `UPDATE hrc_events
                  SET payload_json = ?
                WHERE hrc_seq = ?
                  AND payload_json = ?
                  AND length(CAST(payload_json AS BLOB)) > 32768
                  AND json_type(payload_json, '$.result.details.spill') IS NOT NULL`
            )
            .run(afterJson, row.hrc_seq, beforeJson).changes
      )

      while (stopReason === 'complete') {
        if (deadlineReached(budget)) {
          stopReason = 'deadline'
          break
        }
        const rows = selectLifecycle.all(lastHrcSeq ?? 0, options.batchSize)
        if (rows.length === 0) break
        for (const row of rows) {
          lastHrcSeq = row.hrc_seq
          const ledger = hrcEvents
          ledger.candidates += 1
          const beforeBytes = Buffer.byteLength(row.payload_json, 'utf8')
          ledger.bytesBefore += beforeBytes
          const payload = JSON.parse(row.payload_json) as unknown
          const stub = isRecord(payload) ? validateAndRestub(payload['result'], ledger) : undefined
          if (!isRecord(payload) || !stub) {
            if (!isRecord(payload)) ledger.skipped.invalidDescriptor += 1
            ledger.bytesAfter += beforeBytes
            continue
          }
          const afterJson = JSON.stringify({ ...payload, result: stub })
          const afterBytes = Buffer.byteLength(afterJson, 'utf8')
          if (!options.apply) {
            ledger.bytesAfter += afterBytes
            continue
          }
          if (deadlineReached(budget)) {
            ledger.bytesAfter += beforeBytes
            stopReason = 'deadline'
            break
          }
          try {
            const step = await runWriteStep(budget, () =>
              updateLifecycle.immediate(row, row.payload_json, afterJson)
            )
            if (step.value === 1) {
              ledger.rewritten += 1
              ledger.bytesAfter += afterBytes
            } else {
              ledger.skipped.updateConflict += 1
              ledger.bytesAfter += beforeBytes
            }
            await pauseAfterWrite(budget, step.holdMillis)
          } catch (error) {
            ledger.bytesAfter += beforeBytes
            if (!isBusyError(error)) throw error
            stopReason = 'busy'
            break
          }
        }
        if (rows.length < options.batchSize) break
      }
    }

    if (options.apply && options.checkpoint) {
      try {
        await runWriteStep(budget, () => db.exec('PRAGMA wal_checkpoint(PASSIVE);'))
        checkpointed = true
      } catch (error) {
        if (!isBusyError(error)) throw error
        if (stopReason === 'complete') stopReason = 'busy'
      }
    }

    return {
      operation: RESTUB_TOOL_RESULTS_OPERATION,
      brokerInvocationEvents,
      hrcEvents,
      stopReason,
      deadlineExceeded: budget.deadlineExceeded,
      elapsedMillis: Date.now() - budget.startedAtMillis,
      pausedMillis: budget.pausedMillis,
      busyRetries: budget.busyRetries,
      writeSteps: budget.writeSteps,
      heldMillis: budget.heldMillis,
      maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
      lastInvocationId,
      lastBrokerSeq,
      lastHrcSeq,
      checkpointed,
    }
  } finally {
    db.close()
  }
}
