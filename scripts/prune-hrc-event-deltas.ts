#!/usr/bin/env bun
import { formatServerLogLine } from '../packages/hrc-server/src/server-log.ts'
import { parsePruneStateRetentionArgs } from './prune-hrc-event-deltas/args.ts'
import {
  MILLISECONDS_PER_MINUTE,
  STRIP_ENVELOPE_PAYLOADS_OPERATION,
} from './prune-hrc-event-deltas/constants.ts'
import { restubToolResults } from './prune-hrc-event-deltas/restub-tool-results.ts'
import { stripEnvelopePayloads } from './prune-hrc-event-deltas/strip-envelope-payloads.ts'

export type {
  PruneOperation,
  PruneStateRetentionOptions,
  PrunePhaseStop,
  StripEnvelopePayloadsResult,
  RestubToolResultsResult,
} from './prune-hrc-event-deltas/types.ts'
export { parsePruneStateRetentionArgs } from './prune-hrc-event-deltas/args.ts'
export { stripEnvelopePayloads } from './prune-hrc-event-deltas/strip-envelope-payloads.ts'
export { restubToolResults } from './prune-hrc-event-deltas/restub-tool-results.ts'

const PRUNE_LOG_COMPONENT = 'hrc-prune-deltas'

if (import.meta.main) {
  try {
    const options = parsePruneStateRetentionArgs(Bun.argv.slice(2))
    const result =
      options.operation === STRIP_ENVELOPE_PAYLOADS_OPERATION
        ? await stripEnvelopePayloads(options)
        : await restubToolResults(options)
    // One L2 line per run (logging standard); the report is the `data` object.
    process.stdout.write(
      formatServerLogLine(
        'info',
        'prune.report',
        {
          startedAt: options.now.toISOString(),
          dbPath: options.dbPath,
          operation: options.operation,
          applied: options.apply,
          batchSize: options.batchSize,
          checkpoint: options.checkpoint,
          incrementalVacuumPages: options.incrementalVacuumPages,
          deadlineMinutes: options.deadlineMillis / MILLISECONDS_PER_MINUTE,
          paceMillis: options.paceMillis,
          maxWriteHoldMillis: options.maxWriteHoldMillis,
          maxDutyCycle: options.maxDutyCycle,
          countedEligible: options.countEligible,
          ...result,
        },
        PRUNE_LOG_COMPONENT
      )
    )
  } catch (error) {
    process.stdout.write(
      formatServerLogLine(
        'error',
        'prune.failed',
        {
          message: error instanceof Error ? error.message : String(error),
        },
        PRUNE_LOG_COMPONENT
      )
    )
    process.exit(1)
  }
}
