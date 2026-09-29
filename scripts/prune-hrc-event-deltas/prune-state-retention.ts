import { existsSync } from 'node:fs'

import { Database } from 'bun:sqlite'
import {
  type FirstTurnRetentionResult,
  pruneFirstTurnMissingBundles,
} from '../../packages/hrc-server/src/first-turn-retention.ts'
import { RuntimeArtifactRepository } from '../../packages/hrc-store-sqlite/src/repositories/broker-repositories.ts'
import { FirstTurnWatchRepository } from '../../packages/hrc-store-sqlite/src/repositories/first-turn-watch-repository.ts'

import { countEligible, deleteInBatches } from './batching.ts'
import {
  BROKER_INVOCATION_EVENTS_ELIGIBLE_SQL,
  EVENTS_ELIGIBLE_SQL,
  HRC_EVENTS_ELIGIBLE_SQL,
  MILLISECONDS_PER_DAY,
  PURGE_BROKER_INVOCATION_DELTAS_ELIGIBLE_SQL,
  PURGE_DELTA_BACKLOG_OPERATION,
  PURGE_EVENTS_ELIGIBLE_SQL,
  RESTUB_TOOL_RESULTS_OPERATION,
  RUNTIME_BUFFERS_ELIGIBLE_SQL,
  SPILL_TOOL_RESULTS_OPERATION,
  STRIP_ENVELOPE_PAYLOADS_OPERATION,
} from './constants.ts'
import {
  assertPurgeDeltaBacklogGuardrails,
  assertT07040BackfillInvariant,
  readT07040BackfillInvariant,
} from './guardrails.ts'
import {
  type PrunePhaseStop,
  type PruneStateRetentionOptions,
  type PruneStateRetentionResult,
  type PruneTablePlan,
  RETENTION_TABLES,
  type RetentionTable,
} from './types.ts'
import { assertIncrementalAutoVacuum, incrementalVacuum, readPragmaNumber } from './vacuum.ts'
import {
  createWriteBudget,
  isBusyError,
  runWriteStep,
  sumOrNull,
  tolerateBusy,
  worstStopReason,
} from './write-budget.ts'

export function createRetentionPlans(
  eventCutoff: string,
  runtimeBufferCutoff: string
): PruneTablePlan[] {
  return [
    {
      table: 'events',
      alias: 'e',
      keyColumn: 'seq',
      predicateValue: eventCutoff,
      eligibleSql: EVENTS_ELIGIBLE_SQL,
      selectionOrderSql: 'e.ts ASC, e.seq ASC',
    },
    {
      table: 'hrc_events',
      alias: 'e',
      keyColumn: 'hrc_seq',
      predicateValue: eventCutoff,
      eligibleSql: HRC_EVENTS_ELIGIBLE_SQL,
      selectionOrderSql: 'e.ts ASC, e.hrc_seq ASC',
    },
    {
      table: 'broker_invocation_events',
      alias: 'e',
      keyColumn: 'id',
      predicateValue: eventCutoff,
      eligibleSql: BROKER_INVOCATION_EVENTS_ELIGIBLE_SQL,
      selectionOrderSql: 'e.time ASC, e.id ASC',
    },
    {
      table: 'runtime_buffers',
      alias: 'e',
      keyColumn: 'rowid',
      predicateValue: runtimeBufferCutoff,
      eligibleSql: RUNTIME_BUFFERS_ELIGIBLE_SQL,
      selectionOrderSql: 'e.created_at ASC, e.rowid ASC',
    },
  ]
}

export function createPurgePlans(): PruneTablePlan[] {
  return [
    {
      table: 'events',
      alias: 'e',
      keyColumn: 'seq',
      predicateValue: PURGE_DELTA_BACKLOG_OPERATION,
      eligibleSql: PURGE_EVENTS_ELIGIBLE_SQL,
      selectionOrderSql: 'e.event_kind COLLATE NOCASE ASC, e.seq ASC',
    },
    {
      table: 'broker_invocation_events',
      alias: 'e',
      keyColumn: 'id',
      predicateValue: PURGE_DELTA_BACKLOG_OPERATION,
      eligibleSql: PURGE_BROKER_INVOCATION_DELTAS_ELIGIBLE_SQL,
      selectionOrderSql: 'e.type ASC, e.id ASC',
    },
  ]
}

export async function pruneStateRetention(
  options: PruneStateRetentionOptions
): Promise<PruneStateRetentionResult> {
  if (
    options.operation === STRIP_ENVELOPE_PAYLOADS_OPERATION ||
    options.operation === SPILL_TOOL_RESULTS_OPERATION ||
    options.operation === RESTUB_TOOL_RESULTS_OPERATION
  ) {
    throw new Error(`--${options.operation} must run through its dedicated operation`)
  }
  assertPurgeDeltaBacklogGuardrails(options)
  if (!existsSync(options.dbPath)) {
    throw new Error(`HRC store does not exist: ${options.dbPath}`)
  }

  const eventCutoff = new Date(
    options.now.getTime() - options.eventRetentionDays * MILLISECONDS_PER_DAY
  ).toISOString()
  const runtimeBufferCutoff = new Date(
    options.now.getTime() - options.runtimeBufferRetentionDays * MILLISECONDS_PER_DAY
  ).toISOString()
  const retentionPlans = createRetentionPlans(eventCutoff, runtimeBufferCutoff)
  const purgePlans = createPurgePlans()
  const allPlans = options.operation === PURGE_DELTA_BACKLOG_OPERATION ? purgePlans : retentionPlans
  const plans = allPlans.filter((plan) => options.tables.includes(plan.table))

  const budget = createWriteBudget(options)
  const emptyTableResult = (stopReason: PrunePhaseStop): PruneStateRetentionResult['tables'] =>
    Object.fromEntries(
      RETENTION_TABLES.map((table) => [
        table,
        {
          eligibleCount: null,
          deleted: 0,
          remainingEligibleCount: null,
          stopReason,
          batchSize: options.batchSize,
        },
      ])
    ) as PruneStateRetentionResult['tables']

  const db = new Database(options.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')

    // The auto-vacuum mode gates every delete, so it cannot fall back to a
    // guess. If the daemon holds the lock through the backoff ladder, this run
    // simply does not start.
    let autoVacuumMode: number
    try {
      autoVacuumMode = (await runWriteStep(budget, () => readPragmaNumber(db, 'auto_vacuum'))).value
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return {
        operation: options.operation,
        eventCutoff,
        runtimeBufferCutoff,
        t07040BackfillRowsBefore: null,
        t07040BackfillRowsAfter: null,
        eligibleCount: null,
        deleted: 0,
        remainingEligibleCount: null,
        autoVacuumMode: 0,
        freelistBeforePages: 0,
        freelistBeforeVacuumPages: 0,
        freelistAfterPages: 0,
        reclaimedPages: 0,
        stopReason: 'busy',
        deadlineExceeded: budget.deadlineExceeded,
        elapsedMillis: Date.now() - budget.startedAtMillis,
        pausedMillis: budget.pausedMillis,
        busyRetries: budget.busyRetries,
        writeSteps: budget.writeSteps,
        heldMillis: budget.heldMillis,
        maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
        vacuumChunkPages: options.incrementalVacuumChunkPages,
        vacuumStopReason: 'busy',
        checkpointed: false,
        firstTurnBundles: null,
        tables: emptyTableResult('busy'),
      }
    }
    if (options.apply) {
      assertIncrementalAutoVacuum(autoVacuumMode)
    }
    let t07040BackfillRowsBefore: number | null = null
    let t07040BackfillRowsAfter: number | null = null
    if (options.operation === PURGE_DELTA_BACKLOG_OPERATION) {
      const before = readT07040BackfillInvariant(db)
      assertT07040BackfillInvariant(before, options.expectedT07040BackfillRows, 'before')
      t07040BackfillRowsBefore = before.total
    }
    const freelistBeforePages = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), 0).value
    const eligible = Object.fromEntries(
      plans.map((plan) => [
        plan.table,
        options.countEligible ? tolerateBusy(() => countEligible(db, plan), null).value : null,
      ])
    ) as Record<RetentionTable, number | null>
    const deleted = {
      events: 0,
      hrc_events: 0,
      broker_invocation_events: 0,
      runtime_buffers: 0,
    } satisfies Record<RetentionTable, number>
    const stopReasons = Object.fromEntries(
      RETENTION_TABLES.map((table) => [
        table,
        options.tables.includes(table) ? 'complete' : 'skipped',
      ])
    ) as Record<RetentionTable, PrunePhaseStop>
    const batchSizes: Record<RetentionTable, number> = {
      events: options.batchSize,
      hrc_events: options.batchSize,
      broker_invocation_events: options.batchSize,
      runtime_buffers: options.batchSize,
    }
    let freelistBeforeVacuumPages = freelistBeforePages
    let vacuumStopReason: PrunePhaseStop = 'complete'
    let vacuumChunkPages = options.incrementalVacuumChunkPages
    let checkpointed = false

    if (options.apply) {
      for (const plan of plans) {
        const outcome = await deleteInBatches(db, plan, options.batchSize, budget)
        deleted[plan.table] = outcome.deleted
        stopReasons[plan.table] = outcome.stopReason
        batchSizes[plan.table] = outcome.batchSize
      }
      if (options.operation === PURGE_DELTA_BACKLOG_OPERATION) {
        const afterDelete = readT07040BackfillInvariant(db)
        assertT07040BackfillInvariant(afterDelete, options.expectedT07040BackfillRows, 'after')
        t07040BackfillRowsAfter = afterDelete.total
      }
      if (options.checkpoint) {
        // A busy checkpoint is the daemon working; leave the WAL for next run.
        try {
          // PASSIVE, never TRUNCATE: TRUNCATE waits for readers and writers to
          // clear, which is exactly the unbounded blocking this job must not do.
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
      const vacuum = await incrementalVacuum(
        db,
        budget,
        options.incrementalVacuumPages,
        options.incrementalVacuumChunkPages
      )
      vacuumStopReason = vacuum.stopReason
      vacuumChunkPages = vacuum.chunkPages
    }

    // T-07235 bundle-directory retention. Runs AFTER the row deletes so a tight
    // wall-clock budget still spends itself on table retention first; it is a
    // handful of unlink calls plus one indexed read, and it never holds the
    // writer lock across the filesystem work.
    let firstTurnBundles: FirstTurnRetentionResult | null = null
    if (options.operation !== PURGE_DELTA_BACKLOG_OPERATION) {
      try {
        firstTurnBundles = await pruneFirstTurnMissingBundles(
          {
            firstTurnWatch: new FirstTurnWatchRepository(db),
            runtimeArtifacts: new RuntimeArtifactRepository(db),
          },
          {
            runtimeRoot: options.runtimeRoot,
            keepPerGeneration: options.firstTurnBundleKeep,
            ttlDays: options.firstTurnBundleTtlDays,
            now: options.now,
            apply: options.apply,
          }
        )
      } catch (error) {
        firstTurnBundles = {
          scanned: 0,
          overKeepLimit: 0,
          expired: 0,
          orphanDirs: 0,
          deletedDirs: 0,
          deletedArtifactRows: 0,
          errors: [error instanceof Error ? error.message : String(error)],
        }
      }
    }

    // A partial run leaves rows behind, so the remaining count is measured, not
    // assumed. Without the pre-flight scan it is honestly unknown.
    const remaining = Object.fromEntries(
      plans.map((plan) => [
        plan.table,
        options.apply
          ? options.countEligible
            ? tolerateBusy(() => countEligible(db, plan), null).value
            : null
          : eligible[plan.table],
      ])
    ) as Record<RetentionTable, number | null>
    const freelistAfterPages = tolerateBusy(
      () => readPragmaNumber(db, 'freelist_count'),
      freelistBeforeVacuumPages
    ).value
    if (options.operation === PURGE_DELTA_BACKLOG_OPERATION) {
      const after = readT07040BackfillInvariant(db)
      assertT07040BackfillInvariant(after, options.expectedT07040BackfillRows, 'after')
      t07040BackfillRowsAfter = after.total
    }
    const tableResult = Object.fromEntries(
      RETENTION_TABLES.map((table) => [
        table,
        {
          eligibleCount: eligible[table] ?? null,
          deleted: deleted[table],
          remainingEligibleCount: remaining[table] ?? null,
          stopReason: stopReasons[table],
          batchSize: batchSizes[table],
        },
      ])
    ) as PruneStateRetentionResult['tables']

    return {
      operation: options.operation,
      eventCutoff,
      runtimeBufferCutoff,
      t07040BackfillRowsBefore,
      t07040BackfillRowsAfter,
      eligibleCount: sumOrNull(Object.values(eligible)),
      deleted: Object.values(deleted).reduce((sum, count) => sum + count, 0),
      remainingEligibleCount: sumOrNull(Object.values(remaining)),
      autoVacuumMode,
      freelistBeforePages,
      freelistBeforeVacuumPages,
      freelistAfterPages,
      reclaimedPages: Math.max(0, freelistBeforeVacuumPages - freelistAfterPages),
      stopReason: worstStopReason([...Object.values(stopReasons), vacuumStopReason]),
      deadlineExceeded: budget.deadlineExceeded,
      elapsedMillis: Date.now() - budget.startedAtMillis,
      pausedMillis: budget.pausedMillis,
      busyRetries: budget.busyRetries,
      writeSteps: budget.writeSteps,
      heldMillis: budget.heldMillis,
      maxObservedWriteHoldMillis: budget.maxObservedWriteHoldMillis,
      vacuumChunkPages,
      vacuumStopReason,
      checkpointed,
      firstTurnBundles,
      tables: tableResult,
    }
  } finally {
    db.close()
  }
}
