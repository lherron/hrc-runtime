import { existsSync } from 'node:fs'

import { Database } from 'bun:sqlite'
import {
  type ToolResultBlobKind,
  brokerToolResultBlobId,
  createToolResultSpillStub,
  lifecycleToolResultBlobId,
  toolResultExceedsSpillThreshold,
  toolResultFromBrokerResult,
} from '../../packages/hrc-core/src/index.ts'

import { SPILL_TOOL_RESULTS_OPERATION } from './constants.ts'
import type { PrunePhaseStop, PruneStateRetentionOptions, SpillToolResultsResult } from './types.ts'
import {
  createWriteBudget,
  deadlineReached,
  isBusyError,
  pauseAfterWrite,
  runWriteStep,
} from './write-budget.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
  )
}

export type SpillBrokerRow = {
  invocation_id: string
  seq: number
  runtime_id: string
  broker_event_json: string
  created_at: string
}

export type SpillLifecycleRow = {
  hrc_seq: number
  runtime_id: string | null
  payload_json: string
  ts: string
}

/**
 * Phase 4 historical backfill. Candidate discovery is a bounded set-based
 * keyset walk; the one threshold authority is applied after parsing. Each
 * qualifying row's blob INSERT and stub UPDATE commits in its own immediate
 * transaction, making a killed process safely resumable by spill presence.
 */
export async function spillToolResults(
  options: PruneStateRetentionOptions
): Promise<SpillToolResultsResult> {
  if (options.operation !== SPILL_TOOL_RESULTS_OPERATION) {
    throw new Error('spillToolResults requires --spill-tool-results')
  }
  if (!existsSync(options.dbPath)) throw new Error(`HRC store does not exist: ${options.dbPath}`)

  const budget = createWriteBudget(options)
  const db = new Database(options.dbPath)
  db.exec('PRAGMA busy_timeout = 5000;')
  let brokerCandidates = 0
  let brokerStubbed = 0
  let lifecycleCandidates = 0
  let lifecycleStubbed = 0
  let sharedBrokerRaw = 0
  let lifecycleCanonical = 0
  let equalityCheckMisses = 0
  let lastInvocationId: string | null = null
  let lastBrokerSeq: number | null = null
  let lastHrcSeq: number | null = null
  let stopReason: PrunePhaseStop = 'complete'
  let checkpointed = false

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
          AND json_type(broker_event_json, '$.result.details.spill') IS NULL
          AND (invocation_id, seq) > (?, ?)
        ORDER BY invocation_id ASC, seq ASC
        LIMIT ?`
    )
    const updateBroker = db.transaction((row: SpillBrokerRow, payload: Record<string, unknown>) => {
      const result = payload['result']
      const toolCallId = payload['toolCallId']
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        throw new Error(`large broker tool result ${row.invocation_id}/${row.seq} lacks toolCallId`)
      }
      const resultJson = JSON.stringify(result)
      const bytes = Buffer.byteLength(resultJson, 'utf8')
      const blobId = brokerToolResultBlobId(row.runtime_id, toolCallId)
      db.query<never, [string, string, number, string, string]>(
        `INSERT OR IGNORE INTO tool_result_blobs (
           blob_id, runtime_id, kind, bytes, complete, result_json, created_at
         ) VALUES (?, ?, 'broker_raw', ?, 1, ?, ?)`
      ).run(blobId, row.runtime_id, bytes, resultJson, row.created_at)
      const stubbedJson = JSON.stringify({
        ...payload,
        result: createToolResultSpillStub(result, {
          blobId,
          bytes,
          kind: 'broker_raw',
        }),
      })
      return db
        .query<never, [string, string, number]>(
          `UPDATE broker_invocation_events
              SET broker_event_json = ?
            WHERE invocation_id = ? AND seq = ?
              AND json_type(broker_event_json, '$.result.details.spill') IS NULL`
        )
        .run(stubbedJson, row.invocation_id, row.seq).changes
    })

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
        brokerCandidates += 1
        const payload = JSON.parse(row.broker_event_json) as unknown
        if (!isRecord(payload) || !toolResultExceedsSpillThreshold(payload['result'])) continue
        if (!options.apply) continue
        if (deadlineReached(budget)) {
          stopReason = 'deadline'
          break
        }
        try {
          const step = await runWriteStep(budget, () => updateBroker.immediate(row, payload))
          brokerStubbed += step.value
          await pauseAfterWrite(budget, step.holdMillis)
        } catch (error) {
          if (!isBusyError(error)) throw error
          stopReason = 'busy'
          break
        }
      }
      if (rows.length < options.batchSize) break
    }

    if (stopReason === 'complete') {
      const ledgerIncarnationId = db
        .query<{ ledger_incarnation_id: string }, []>(
          'SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id = 1'
        )
        .get()?.ledger_incarnation_id
      if (!ledgerIncarnationId)
        throw new Error('lifecycle-event ledger incarnation metadata is missing')
      const selectLifecycle = db.query<SpillLifecycleRow, [number, number]>(
        `SELECT hrc_seq, runtime_id, payload_json, ts
           FROM hrc_events
          WHERE hrc_seq > ?
            AND event_kind = 'turn.tool_result'
            AND length(CAST(payload_json AS BLOB)) > 32768
            AND json_type(payload_json, '$.result.details.spill') IS NULL
          ORDER BY hrc_seq ASC
          LIMIT ?`
      )
      const updateLifecycle = db.transaction(
        (
          row: SpillLifecycleRow,
          payload: Record<string, unknown>,
          blobId: string,
          kind: ToolResultBlobKind,
          bytes: number,
          resultJson: string
        ) => {
          if (kind === 'lifecycle_canonical') {
            if (row.runtime_id === null) {
              throw new Error(`large lifecycle tool result ${row.hrc_seq} lacks runtime_id`)
            }
            db.query<never, [string, string, number, string, string]>(
              `INSERT OR IGNORE INTO tool_result_blobs (
                 blob_id, runtime_id, kind, bytes, complete, result_json, created_at
               ) VALUES (?, ?, 'lifecycle_canonical', ?, 1, ?, ?)`
            ).run(blobId, row.runtime_id, bytes, resultJson, row.ts)
          }
          const stubbedJson = JSON.stringify({
            ...payload,
            result: createToolResultSpillStub(payload['result'], {
              blobId,
              bytes,
              kind,
            }),
          })
          return db
            .query<never, [string, number]>(
              `UPDATE hrc_events SET payload_json = ?
                WHERE hrc_seq = ?
                  AND json_type(payload_json, '$.result.details.spill') IS NULL`
            )
            .run(stubbedJson, row.hrc_seq).changes
        }
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
          lifecycleCandidates += 1
          const payload = JSON.parse(row.payload_json) as unknown
          if (!isRecord(payload) || !toolResultExceedsSpillThreshold(payload['result'])) continue
          if (!row.runtime_id)
            throw new Error(`large lifecycle tool result ${row.hrc_seq} lacks runtime_id`)
          const canonicalResultJson = JSON.stringify(payload['result'])
          let blobId = lifecycleToolResultBlobId(ledgerIncarnationId, row.hrc_seq)
          let kind: ToolResultBlobKind = 'lifecycle_canonical'
          let bytes = Buffer.byteLength(canonicalResultJson, 'utf8')
          const toolUseId = payload['toolUseId']
          if (typeof toolUseId === 'string' && toolUseId.length > 0) {
            const candidateId = brokerToolResultBlobId(row.runtime_id, toolUseId)
            const candidate = db
              .query<{ result_json: string; bytes: number }, [string]>(
                `SELECT result_json, bytes FROM tool_result_blobs
                  WHERE blob_id = ? AND complete = 1 AND kind = 'broker_raw'`
              )
              .get(candidateId)
            if (candidate) {
              const converted = toolResultFromBrokerResult(
                JSON.parse(candidate.result_json) as unknown
              )
              if (deepEqual(converted, payload['result'])) {
                blobId = candidateId
                kind = 'broker_raw'
                bytes = candidate.bytes
              } else {
                equalityCheckMisses += 1
              }
            }
          }
          if (!options.apply) continue
          if (deadlineReached(budget)) {
            stopReason = 'deadline'
            break
          }
          try {
            const step = await runWriteStep(budget, () =>
              updateLifecycle.immediate(row, payload, blobId, kind, bytes, canonicalResultJson)
            )
            lifecycleStubbed += step.value
            if (step.value > 0) {
              if (kind === 'broker_raw') sharedBrokerRaw += 1
              else lifecycleCanonical += 1
            }
            await pauseAfterWrite(budget, step.holdMillis)
          } catch (error) {
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
      operation: SPILL_TOOL_RESULTS_OPERATION,
      brokerInvocationEvents: {
        candidates: brokerCandidates,
        stubbed: brokerStubbed,
      },
      hrcEvents: { candidates: lifecycleCandidates, stubbed: lifecycleStubbed },
      blobs: { sharedBrokerRaw, lifecycleCanonical },
      equalityCheckMisses,
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
