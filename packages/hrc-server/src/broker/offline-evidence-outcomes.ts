/** T-08566 stage 2 — retained-evidence outcome constants and classification (SPEC §4.2). */

import type { RetainedEvidenceOutcomeClass } from 'hrc-core'

export const OFFLINE_EVIDENCE_SCHEMA = 'harness-broker.offline-evidence/v1'
export const OFFLINE_EVIDENCE_CAPABILITY = OFFLINE_EVIDENCE_SCHEMA
export const RETAINED_EVIDENCE_OUTCOME_SCHEMA = 'hrc.offline-evidence/v1'

export const OFFLINE_EVIDENCE_PAGE_LIMIT = 500
export const OFFLINE_EVIDENCE_PAGE_MAX_BYTES = 4 * 1024 * 1024
export const OFFLINE_EVIDENCE_STDOUT_SLACK_BYTES = 64 * 1024
export const OFFLINE_EVIDENCE_STDERR_MAX_BYTES = 64 * 1024
export const OFFLINE_EVIDENCE_READER_TIMEOUT_MS = 10_000
export const OFFLINE_EVIDENCE_SLICE_MAX_PAGES = 64
export const OFFLINE_EVIDENCE_SLICE_MAX_BYTES = 64 * 1024 * 1024
export const OFFLINE_EVIDENCE_SLICE_MAX_MS = 60_000
/** U3: automatic attempts before the outcome pauses for disposition. */
export const OFFLINE_EVIDENCE_RETRY_BUDGET = 5

export const ELIGIBLE_STATUSES = new Set(['terminated', 'failed'])

const INCOMPLETE_OUTCOMES = new Set([
  'recovered_torn_tail',
  'ledger_corrupt',
  'ledger_conflicting_duplicate',
  'replay_below_floor',
  'release_unavailable',
  'reader_release_mismatch',
  'reader_contract_violation',
  'invalid_request',
  'offline_record_too_large',
  'offline_schema_unsupported',
  'offline_reader_unsupported',
  'ledger_index_unavailable',
  'ledger_path_unknown',
  'projection_halted',
])
const RETRYABLE_OUTCOMES = new Set([
  'reader_failed',
  'reader_timeout',
  'ledger_snapshot_unstable',
  'ledger_unavailable',
  'in_progress',
  'offline_read_attach_in_flight',
])
/** Retryable outcomes that do not consume the automatic retry budget. */
export const BUDGET_FREE_OUTCOMES = new Set(['in_progress', 'offline_read_attach_in_flight'])

export function classifyRetainedOutcome(outcome: string): RetainedEvidenceOutcomeClass | 'paused' {
  if (outcome === 'recovered') return 'complete'
  if (outcome === 'operator_disposed') return 'disposed'
  if (outcome === 'offline_reader_unsupported_unbound_release') return 'unbound'
  if (outcome === 'paused_needs_disposition') return 'paused'
  if (RETRYABLE_OUTCOMES.has(outcome)) return 'retryable'
  if (INCOMPLETE_OUTCOMES.has(outcome)) return 'incomplete'
  return 'incomplete'
}

/** §4.2: whether an outcome keeps a bound runtime's ledger directory held. */
export function outcomeHoldsEvidence(outcome: string | undefined): boolean {
  if (outcome === undefined) return true
  const outcomeClass = classifyRetainedOutcome(outcome)
  return outcomeClass === 'incomplete' || outcomeClass === 'retryable' || outcomeClass === 'paused'
}
