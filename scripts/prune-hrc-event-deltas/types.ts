export type PruneOperation = 'strip-envelope-payloads' | 'restub-tool-results'
export type PruneStateRetentionOptions = {
  dbPath: string
  operation: PruneOperation
  apply: boolean
  batchSize: number
  checkpoint: boolean
  incrementalVacuumPages: number
  incrementalVacuumChunkPages: number
  deadlineMillis: number
  paceMillis: number
  maxWriteHoldMillis: number
  maxDutyCycle: number
  busyMaxRetries: number
  countEligible: boolean
  tables: readonly string[]
  now: Date
}
export type PrunePhaseStop = 'complete' | 'deadline' | 'busy' | 'skipped'

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
