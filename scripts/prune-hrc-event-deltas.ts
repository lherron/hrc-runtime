#!/usr/bin/env bun
import { parsePruneStateRetentionArgs } from './prune-hrc-event-deltas/args.ts'
import {
  MILLISECONDS_PER_MINUTE,
  RESTUB_TOOL_RESULTS_OPERATION,
  SPILL_TOOL_RESULTS_OPERATION,
  STRIP_ENVELOPE_PAYLOADS_OPERATION,
} from './prune-hrc-event-deltas/constants.ts'
import { pruneStateRetention } from './prune-hrc-event-deltas/prune-state-retention.ts'
import { restubToolResults } from './prune-hrc-event-deltas/restub-tool-results.ts'
import { spillToolResults } from './prune-hrc-event-deltas/spill-tool-results.ts'
import { stripEnvelopePayloads } from './prune-hrc-event-deltas/strip-envelope-payloads.ts'

export type {
  PruneOperation,
  PruneStateRetentionOptions,
  PrunePhaseStop,
  PruneRetentionTableResult,
  PruneStateRetentionResult,
  StripEnvelopePayloadsResult,
  SpillToolResultsResult,
  RestubToolResultsResult,
  RetentionTable,
  PruneTablePlan,
} from './prune-hrc-event-deltas/types.ts'
export { parsePruneStateRetentionArgs } from './prune-hrc-event-deltas/args.ts'
export {
  selectEligibleBatch,
  selectEligibleBatchSql,
  deleteSelectedBatch,
  deleteSelectedBatchSql,
} from './prune-hrc-event-deltas/batching.ts'
export { stripEnvelopePayloads } from './prune-hrc-event-deltas/strip-envelope-payloads.ts'
export { spillToolResults } from './prune-hrc-event-deltas/spill-tool-results.ts'
export { restubToolResults } from './prune-hrc-event-deltas/restub-tool-results.ts'
export {
  createRetentionPlans,
  createPurgePlans,
  pruneStateRetention,
} from './prune-hrc-event-deltas/prune-state-retention.ts'

if (import.meta.main) {
  try {
    const options = parsePruneStateRetentionArgs(Bun.argv.slice(2))
    const result =
      options.operation === STRIP_ENVELOPE_PAYLOADS_OPERATION
        ? await stripEnvelopePayloads(options)
        : options.operation === SPILL_TOOL_RESULTS_OPERATION
          ? await spillToolResults(options)
          : options.operation === RESTUB_TOOL_RESULTS_OPERATION
            ? await restubToolResults(options)
            : await pruneStateRetention(options)
    console.log(
      JSON.stringify(
        {
          startedAt: options.now.toISOString(),
          dbPath: options.dbPath,
          operation: options.operation,
          applied: options.apply,
          batchSize: options.batchSize,
          checkpoint: options.checkpoint,
          eventRetentionDays: options.eventRetentionDays,
          runtimeBufferRetentionDays: options.runtimeBufferRetentionDays,
          incrementalVacuumPages: options.incrementalVacuumPages,
          deadlineMinutes: options.deadlineMillis / MILLISECONDS_PER_MINUTE,
          paceMillis: options.paceMillis,
          maxWriteHoldMillis: options.maxWriteHoldMillis,
          maxDutyCycle: options.maxDutyCycle,
          countedEligible: options.countEligible,
          ...result,
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
