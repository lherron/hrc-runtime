import type { Database } from 'bun:sqlite'

import {
  DEFAULT_MAX_DUTY_CYCLE,
  DEFAULT_MAX_WRITE_HOLD_MILLIS,
  DEFAULT_PACE_MILLIS,
  PURGE_DELTA_BACKLOG_OPERATION,
  T07040_BACKFILL_SOURCE_REF,
} from './constants.ts'
import type { PruneStateRetentionOptions } from './types.ts'

export type T07040BackfillInvariant = {
  total: number
  continuationCleared: number
}

export function readT07040BackfillInvariant(db: Database): T07040BackfillInvariant {
  return (
    db
      .query<T07040BackfillInvariant, [string]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN type = 'continuation.cleared' THEN 1 ELSE 0 END), 0)
                  AS continuationCleared
           FROM broker_invocation_events
          WHERE source_ref = ?`
      )
      .get(T07040_BACKFILL_SOURCE_REF) ?? { total: 0, continuationCleared: 0 }
  )
}

export function assertT07040BackfillInvariant(
  invariant: T07040BackfillInvariant,
  expectedRows: number,
  phase: 'before' | 'after'
): void {
  if (invariant.total !== expectedRows || invariant.continuationCleared !== expectedRows) {
    throw new Error(
      `T-07040 backfill invariant failed ${phase} purge: expected ${expectedRows} source_ref='${T07040_BACKFILL_SOURCE_REF}' continuation.cleared rows, found ${invariant.total} total and ${invariant.continuationCleared} continuation.cleared; refusing unsafe cleanup`
    )
  }
}

export function assertPurgeDeltaBacklogGuardrails(options: PruneStateRetentionOptions): void {
  if (options.operation !== PURGE_DELTA_BACKLOG_OPERATION) {
    return
  }
  if (options.deadlineMillis <= 0) {
    throw new Error('--purge-delta-backlog requires a bounded --deadline-minutes greater than 0')
  }
  if (options.paceMillis < DEFAULT_PACE_MILLIS) {
    throw new Error(`--purge-delta-backlog requires --pace-millis >= ${DEFAULT_PACE_MILLIS}`)
  }
  if (options.maxWriteHoldMillis > DEFAULT_MAX_WRITE_HOLD_MILLIS) {
    throw new Error(
      `--purge-delta-backlog requires --max-write-hold-millis <= ${DEFAULT_MAX_WRITE_HOLD_MILLIS}`
    )
  }
  if (options.maxDutyCycle > DEFAULT_MAX_DUTY_CYCLE) {
    throw new Error(`--purge-delta-backlog requires --max-duty-cycle <= ${DEFAULT_MAX_DUTY_CYCLE}`)
  }
}
