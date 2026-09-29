import type { HrcBrokerInvocationEventRecord } from 'hrc-core'

export type BrokerInvocationEventAppendInput = {
  invocationId: string
  seq: number
  time: string
  type: string
  runtimeId: string
  runId?: string | undefined
  /**
   * Envelope-level identity persisted alongside the payload (T-01946) so the
   * durable ledger can reconstruct the full ask-bracket identity on restart.
   */
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  /**
   * Broker event content to persist. Serialized verbatim and compared on
   * re-append: the same `(invocationId, seq)` with the same payload is a no-op;
   * a different payload throws.
   */
  payload: unknown
  /**
   * Full serialized broker `InvocationEventEnvelope` (T-05078). Persisted verbatim
   * as the wire authority for the raw observer so it can reconstruct a true
   * envelope incl. optional `turnId`/`inputId`/`itemId`/`correlation`/`driver`.
   * Optional for back-compat; the broker event mapper always supplies it.
   */
  envelopeJson?: string | undefined
  hrcEventSeq?: number | undefined
  projectionStatus?: HrcBrokerInvocationEventRecord['projectionStatus'] | undefined
  projectionError?: string | undefined
  /** `'retained'` only for rows mirrored by retained (offline) projection (T-08566). */
  evidenceOrigin?: 'retained' | undefined
}

export type ImportedBrokerInvocationEventInput = {
  sourceRef: string
  originSeq: number
  event: HrcBrokerInvocationEventRecord
}

export type BrokerProjectionDisposition = {
  invocationId: string
  seq: number
  envelopeHash: string
  disposition: 'applied' | 'skipped_fenced' | 'skipped_duplicate'
  createdAt: string
}

export type BrokerInvocationEventAppendResult = {
  record: HrcBrokerInvocationEventRecord
  /** True when an identical event already existed and the append was a no-op. */
  idempotent: boolean
}

export type BrokerInvocationEventAfterSeqSelector = {
  invocationId: string
  runId?: string | undefined
  runtimeId: string
  afterSeq: number
}

export class BrokerInvocationEventConflictError extends Error {
  constructor(
    readonly invocationId: string,
    readonly seq: number
  ) {
    super(
      `broker_invocation_events conflict: (invocation_id=${invocationId}, seq=${seq}) already exists with a different payload; refusing to overwrite`
    )
    this.name = 'BrokerInvocationEventConflictError'
  }
}
