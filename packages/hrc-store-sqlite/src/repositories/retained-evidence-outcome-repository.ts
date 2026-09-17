import type { Database } from 'bun:sqlite'

import { execute } from './shared.js'

export type RetainedEvidenceOutcomeClass =
  | 'complete'
  | 'incomplete'
  | 'retryable'
  | 'unbound'
  | 'disposed'

export type RetainedEvidenceOutcomeTrigger = 'terminal' | 'startup' | 'report' | 'gap' | 'operator'

export type RetainedEvidenceOutcomeRecord = {
  outcomeId: number
  runtimeId: string
  invocationId: string
  recordedAt: string
  outcome: string
  outcomeClass: RetainedEvidenceOutcomeClass
  trigger: RetainedEvidenceOutcomeTrigger
  /** Automatic attempts counted against the retry budget. */
  attempts: number
  detail: Record<string, unknown>
}

type RetainedEvidenceOutcomeRow = {
  outcome_id: number
  runtime_id: string
  invocation_id: string
  recorded_at: string
  outcome: string
  outcome_class: string
  trigger: string
  attempts: number
  detail_json: string
}

function mapRow(row: RetainedEvidenceOutcomeRow): RetainedEvidenceOutcomeRecord {
  return {
    outcomeId: row.outcome_id,
    runtimeId: row.runtime_id,
    invocationId: row.invocation_id,
    recordedAt: row.recorded_at,
    outcome: row.outcome,
    outcomeClass: row.outcome_class as RetainedEvidenceOutcomeClass,
    trigger: row.trigger as RetainedEvidenceOutcomeTrigger,
    attempts: row.attempts,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
  }
}

const COLUMNS = `outcome_id, runtime_id, invocation_id, recorded_at, outcome, outcome_class,
  trigger, attempts, detail_json`

/**
 * T-08566 — keep-forever audit of retained-evidence recovery attempts.
 *
 * Append-only; the latest row per `(runtime_id, invocation_id)` is the current
 * outcome. Deliberately outside the lifecycle event stream (no `hrc_events`
 * row, no follow, no federation, no runtime `updated_at`) and without a foreign
 * key, so neither ordinary nor ledger-inclusive prune can cascade it away.
 */
export class RetainedEvidenceOutcomeRepository {
  constructor(private readonly db: Database) {}

  append(input: Omit<RetainedEvidenceOutcomeRecord, 'outcomeId'>): RetainedEvidenceOutcomeRecord {
    execute(
      this.db,
      `INSERT INTO retained_evidence_outcomes (
         runtime_id, invocation_id, recorded_at, outcome, outcome_class, trigger, attempts, detail_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runtimeId,
      input.invocationId,
      input.recordedAt,
      input.outcome,
      input.outcomeClass,
      input.trigger,
      input.attempts,
      JSON.stringify(input.detail)
    )
    const row = this.db
      .query<RetainedEvidenceOutcomeRow, []>(
        `SELECT ${COLUMNS} FROM retained_evidence_outcomes WHERE outcome_id = last_insert_rowid()`
      )
      .get()
    if (!row) throw new Error('failed to reload retained evidence outcome')
    return mapRow(row)
  }

  latest(runtimeId: string, invocationId: string): RetainedEvidenceOutcomeRecord | null {
    const row = this.db
      .query<RetainedEvidenceOutcomeRow, [string, string]>(
        `SELECT ${COLUMNS} FROM retained_evidence_outcomes
          WHERE runtime_id = ? AND invocation_id = ?
          ORDER BY outcome_id DESC LIMIT 1`
      )
      .get(runtimeId, invocationId)
    return row ? mapRow(row) : null
  }

  /** Latest outcome per invocation of one runtime, oldest invocation first. */
  latestByRuntime(runtimeId: string): RetainedEvidenceOutcomeRecord[] {
    return this.db
      .query<RetainedEvidenceOutcomeRow, [string, string]>(
        `SELECT ${COLUMNS} FROM retained_evidence_outcomes o
          WHERE o.runtime_id = ?
            AND o.outcome_id = (
              SELECT MAX(i.outcome_id) FROM retained_evidence_outcomes i
               WHERE i.runtime_id = ? AND i.invocation_id = o.invocation_id
            )
          ORDER BY o.outcome_id ASC`
      )
      .all(runtimeId, runtimeId)
      .map(mapRow)
  }

  listByRuntime(runtimeId: string): RetainedEvidenceOutcomeRecord[] {
    return this.db
      .query<RetainedEvidenceOutcomeRow, [string]>(
        `SELECT ${COLUMNS} FROM retained_evidence_outcomes WHERE runtime_id = ? ORDER BY outcome_id ASC`
      )
      .all(runtimeId)
      .map(mapRow)
  }
}
