import type { Database } from 'bun:sqlite'

import { INITIAL_DELETE_BATCH_SIZE, MIN_DELETE_BATCH_SIZE } from './constants.ts'
import type { PrunePhaseStop, PruneTablePlan } from './types.ts'
import { adaptStepSize } from './vacuum.ts'
import {
  type WriteBudget,
  deadlineReached,
  isBusyError,
  pauseAfterWrite,
  runWriteStep,
} from './write-budget.ts'

export function countEligible(db: Database, plan: PruneTablePlan): number {
  return (
    db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
           FROM ${plan.table} AS ${plan.alias}
          WHERE ${plan.eligibleSql}`
      )
      .get(plan.predicateValue)?.count ?? 0
  )
}

/**
 * Discover candidates without owning the SQLite writer. The full predicate may
 * traverse an arbitrarily large old-but-ineligible prefix; completing this read
 * before DELETE is what keeps that cost out of the write-lock hold.
 */
export function selectEligibleBatch(
  db: Database,
  plan: PruneTablePlan,
  batchSize: number
): number[] {
  return db
    .query<{ key: number }, [string, number]>(selectEligibleBatchSql(plan))
    .all(plan.predicateValue, batchSize)
    .map((row) => row.key)
}

export function selectEligibleBatchSql(plan: PruneTablePlan): string {
  return `SELECT ${plan.alias}.${plan.keyColumn} AS key
            FROM ${plan.table} AS ${plan.alias}
           WHERE ${plan.eligibleSql}
           ORDER BY ${plan.selectionOrderSql}
           LIMIT ?`
}

/**
 * Recheck the complete safety predicate under the writer, but only for the
 * explicit bounded key set discovered by the preceding read. json_each keeps
 * the statement at one binding even when an operator configures a large batch.
 */
export function deleteSelectedBatch(
  db: Database,
  plan: PruneTablePlan,
  selectedKeys: readonly number[]
): number {
  if (selectedKeys.length === 0) return 0
  return db
    .prepare<never, [string, string]>(deleteSelectedBatchSql(plan))
    .run(JSON.stringify(selectedKeys), plan.predicateValue).changes
}

export function deleteSelectedBatchSql(plan: PruneTablePlan): string {
  return `DELETE FROM ${plan.table}
           WHERE ${plan.keyColumn} IN (
             SELECT ${plan.alias}.${plan.keyColumn}
               FROM ${plan.table} AS ${plan.alias}
              WHERE ${plan.alias}.${plan.keyColumn} IN (
                SELECT CAST(value AS INTEGER) FROM json_each(?)
              )
                AND ${plan.eligibleSql}
           )`
}

/**
 * Pacing between batches is worthless if one batch holds the lock for minutes.
 * Row cost varies by orders of magnitude across these tables — `runtime_buffers`
 * carries large text blobs while `events` rows are small — so the batch size
 * tracks measured hold time instead of a single configured guess. The configured
 * `--batch-size` is the ceiling, never exceeded.
 */
export async function deleteInBatches(
  db: Database,
  plan: PruneTablePlan,
  maxBatchSize: number,
  budget: WriteBudget
): Promise<{ deleted: number; stopReason: PrunePhaseStop; batchSize: number }> {
  let deleted = 0
  let batchSize = Math.min(INITIAL_DELETE_BATCH_SIZE, maxBatchSize)
  while (true) {
    if (deadlineReached(budget)) {
      return { deleted, stopReason: 'deadline', batchSize }
    }
    const requestedRows = batchSize
    let selectedKeys: number[]
    try {
      selectedKeys = selectEligibleBatch(db, plan, requestedRows)
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return { deleted, stopReason: 'busy', batchSize }
    }
    if (selectedKeys.length === 0) {
      return { deleted, stopReason: 'complete', batchSize }
    }
    // Discovery can be expensive when many old rows remain live. Do not start
    // a write after that read has consumed the remaining wall-clock budget.
    if (deadlineReached(budget)) {
      return { deleted, stopReason: 'deadline', batchSize }
    }
    let batchDeleted: number
    let holdMillis: number
    try {
      const step = await runWriteStep(budget, () => deleteSelectedBatch(db, plan, selectedKeys))
      batchDeleted = step.value
      holdMillis = step.holdMillis
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return { deleted, stopReason: 'busy', batchSize }
    }
    deleted += batchDeleted
    if (selectedKeys.length < requestedRows) {
      return { deleted, stopReason: 'complete', batchSize }
    }
    batchSize = adaptStepSize(
      selectedKeys.length,
      holdMillis,
      budget.maxWriteHoldMillis,
      MIN_DELETE_BATCH_SIZE,
      maxBatchSize
    )
    await pauseAfterWrite(budget, holdMillis)
  }
}
