import type { FirstTurnRetentionResult } from '../../packages/hrc-server/src/first-turn-retention.ts'

export type PruneOperation =
  | 'retention'
  | 'purge-delta-backlog'
  | 'strip-envelope-payloads'
  | 'spill-tool-results'
  | 'restub-tool-results'

export type PruneStateRetentionOptions = {
  dbPath: string
  operation: PruneOperation
  expectedT07040BackfillRows: number
  apply: boolean
  batchSize: number
  checkpoint: boolean
  eventRetentionDays: number
  runtimeBufferRetentionDays: number
  incrementalVacuumPages: number
  incrementalVacuumChunkPages: number
  deadlineMillis: number
  paceMillis: number
  maxWriteHoldMillis: number
  maxDutyCycle: number
  busyMaxRetries: number
  countEligible: boolean
  tables: readonly RetentionTable[]
  /** Root that holds `artifacts/<runtimeId>/first-turn-missing/<tripEventId>`. */
  runtimeRoot: string
  firstTurnBundleKeep: number
  firstTurnBundleTtlDays: number
  now: Date
}

/**
 * Why a phase stopped. `complete` drained the phase; `deadline` hit the
 * wall-clock budget; `busy` gave the writer lock back to the daemon after the
 * backoff ladder was exhausted; `skipped` means the table was not selected for
 * retention at all. Only `complete` means "nothing left to do".
 */
export type PrunePhaseStop = 'complete' | 'deadline' | 'busy' | 'skipped'

export type PruneRetentionTableResult = {
  eligibleCount: number | null
  deleted: number
  remainingEligibleCount: number | null
  stopReason: PrunePhaseStop
  /** Batch size this table settled on to keep each write step under the hold target. */
  batchSize: number
}

export type PruneStateRetentionResult = {
  operation: PruneOperation
  eventCutoff: string
  runtimeBufferCutoff: string
  t07040BackfillRowsBefore: number | null
  t07040BackfillRowsAfter: number | null
  eligibleCount: number | null
  deleted: number
  remainingEligibleCount: number | null
  autoVacuumMode: number
  freelistBeforePages: number
  freelistBeforeVacuumPages: number
  freelistAfterPages: number
  reclaimedPages: number
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  /** Write steps taken, total and longest time the writer lock was held. */
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  vacuumChunkPages: number
  vacuumStopReason: PrunePhaseStop
  checkpointed: boolean
  /** T-07235 bundle-directory retention. Null when the pass did not run. */
  firstTurnBundles: FirstTurnRetentionResult | null
  tables: {
    events: PruneRetentionTableResult
    hrc_events: PruneRetentionTableResult
    broker_invocation_events: PruneRetentionTableResult
    runtime_buffers: PruneRetentionTableResult
  }
}

export type StripEnvelopePayloadsResult = {
  operation: 'strip-envelope-payloads'
  eligibleCount: number | null
  stripped: number
  remainingEligibleCount: number | null
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  batchSize: number
  lastInvocationId: string | null
  lastSeq: number | null
  autoVacuumMode: number
  freelistBeforePages: number
  freelistBeforeVacuumPages: number
  freelistAfterPages: number
  reclaimedPages: number
  vacuumChunkPages: number
  vacuumStopReason: PrunePhaseStop
  checkpointed: boolean
}

export type SpillToolResultsResult = {
  operation: 'spill-tool-results'
  brokerInvocationEvents: { candidates: number; stubbed: number }
  hrcEvents: { candidates: number; stubbed: number }
  blobs: { sharedBrokerRaw: number; lifecycleCanonical: number }
  equalityCheckMisses: number
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  lastInvocationId: string | null
  lastBrokerSeq: number | null
  lastHrcSeq: number | null
  checkpointed: boolean
}

export type RestubLedgerResult = {
  candidates: number
  rewritten: number
  bytesBefore: number
  bytesAfter: number
  skipped: {
    invalidDescriptor: number
    missingBlob: number
    incompleteBlob: number
    kindMismatch: number
    updateConflict: number
  }
}

export type RestubToolResultsResult = {
  operation: 'restub-tool-results'
  brokerInvocationEvents: RestubLedgerResult
  hrcEvents: RestubLedgerResult
  stopReason: PrunePhaseStop
  deadlineExceeded: boolean
  elapsedMillis: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  lastInvocationId: string | null
  lastBrokerSeq: number | null
  lastHrcSeq: number | null
  checkpointed: boolean
}

export type RetentionTable = keyof PruneStateRetentionResult['tables']

export const RETENTION_TABLES: readonly RetentionTable[] = [
  'events',
  'hrc_events',
  'broker_invocation_events',
  'runtime_buffers',
]

/**
 * Lance's 2026-07-28 ruling: non-delta observation events are kept
 * indefinitely. Only terminal runtime buffers age out, so the event tables are
 * off the retention list unless an operator names them explicitly. Encoding the
 * policy here rather than in the launchd arguments means an ad-hoc `--apply`
 * cannot quietly delete semantic history.
 */
export const DEFAULT_RETENTION_TABLES: readonly RetentionTable[] = ['runtime_buffers']

export type PruneTablePlan = {
  table: RetentionTable
  alias: string
  keyColumn: string
  predicateValue: string
  eligibleSql: string
  selectionOrderSql: string
}
