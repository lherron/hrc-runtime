import type { Database } from 'bun:sqlite'
import type { HrcMailActor, HrcMailEnvelopeState } from 'hrc-core'

export const HRC_MAIL_STOP_REFUSAL_CAP = 3
export const HRC_MAIL_STOP_HARD_CAP = 50

export type HrcMailStopEnvelopeSummary = {
  envelopeId: string
  from: HrcMailActor
  state: Extract<HrcMailEnvelopeState, 'pending' | 'presented'>
  body: string
}

export type HrcMailStopRefusalRecord = {
  runId: string
  targetSessionRef: string
  observedEnvelopeSeq: number
  refusalCount: number
  totalRefusalCount: number
  createdAt: string
  updatedAt: string
}

export type HrcMailStopDecision =
  | {
      decision: 'allow'
      reason: 'clear' | 'refusal_cap' | 'hard_cap'
      unackedCount: number
      refusalCount: number
      totalRefusalCount: number
      envelopes: HrcMailStopEnvelopeSummary[]
    }
  | {
      decision: 'block'
      unackedCount: number
      refusalCount: number
      totalRefusalCount: number
      envelopes: HrcMailStopEnvelopeSummary[]
    }

type StopRefusalRow = {
  run_id: string
  target_session_ref: string
  observed_envelope_seq: number
  refusal_count: number
  total_refusal_count: number
  created_at: string
  updated_at: string
}

type UnackedAggregateRow = {
  unacked_count: number
  newest_envelope_seq: number | null
}

type UnackedSummaryRow = {
  envelope_id: string
  from_kind: HrcMailActor['kind']
  from_ref: string
  state: Extract<HrcMailEnvelopeState, 'pending' | 'presented'>
  body: string
}

export class HrcMailStopRefusalRepository {
  constructor(private readonly db: Database) {}

  get(runId: string): HrcMailStopRefusalRecord | undefined {
    const row = this.db
      .query<StopRefusalRow, [string]>(
        `SELECT run_id, target_session_ref, observed_envelope_seq,
                refusal_count, total_refusal_count, created_at, updated_at
         FROM hrcmail_stop_refusals
         WHERE run_id = ?`
      )
      .get(runId)
    return row === null
      ? undefined
      : {
          runId: row.run_id,
          targetSessionRef: row.target_session_ref,
          observedEnvelopeSeq: row.observed_envelope_seq,
          refusalCount: row.refusal_count,
          totalRefusalCount: row.total_refusal_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
  }

  evaluate(runId: string, targetSessionRef: string, summaryLimit = 8): HrcMailStopDecision {
    const limit = Math.min(Math.max(summaryLimit, 1), 20)
    return this.db
      .transaction(() => {
        const aggregate = this.db
          .query<UnackedAggregateRow, [string]>(
            `SELECT COUNT(*) AS unacked_count, MAX(envelope_seq) AS newest_envelope_seq
             FROM hrcmail_envelopes
             WHERE target_session_ref = ? AND state IN ('pending', 'presented')`
          )
          .get(targetSessionRef)
        const unackedCount = aggregate?.unacked_count ?? 0
        const newestEnvelopeSeq = aggregate?.newest_envelope_seq ?? null
        const previous = this.get(runId)
        if (unackedCount === 0 || newestEnvelopeSeq === null) {
          return {
            decision: 'allow',
            reason: 'clear',
            unackedCount: 0,
            refusalCount: previous?.refusalCount ?? 0,
            totalRefusalCount: previous?.totalRefusalCount ?? 0,
            envelopes: [],
          }
        }

        const isNewEnvelope =
          previous === undefined || newestEnvelopeSeq > previous.observedEnvelopeSeq
        const refusalCount = Math.min(
          (isNewEnvelope ? 0 : previous.refusalCount) + 1,
          HRC_MAIL_STOP_REFUSAL_CAP
        )
        const totalRefusalCount = Math.min(
          (previous?.totalRefusalCount ?? 0) + 1,
          HRC_MAIL_STOP_HARD_CAP
        )
        const now = new Date().toISOString()
        this.db
          .query(
            `INSERT INTO hrcmail_stop_refusals (
               run_id, target_session_ref, observed_envelope_seq,
               refusal_count, total_refusal_count, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET
               target_session_ref = excluded.target_session_ref,
               observed_envelope_seq = excluded.observed_envelope_seq,
               refusal_count = excluded.refusal_count,
               total_refusal_count = excluded.total_refusal_count,
               updated_at = excluded.updated_at`
          )
          .run(
            runId,
            targetSessionRef,
            newestEnvelopeSeq,
            refusalCount,
            totalRefusalCount,
            previous?.createdAt ?? now,
            now
          )

        const envelopes = this.db
          .query<UnackedSummaryRow, [string, number]>(
            `SELECT envelope_id, from_kind, from_ref, state, body
             FROM hrcmail_envelopes
             WHERE target_session_ref = ? AND state IN ('pending', 'presented')
             ORDER BY envelope_seq ASC
             LIMIT ?`
          )
          .all(targetSessionRef, limit)
          .map(mapSummary)

        if (totalRefusalCount >= HRC_MAIL_STOP_HARD_CAP) {
          return {
            decision: 'allow',
            reason: 'hard_cap',
            unackedCount,
            refusalCount,
            totalRefusalCount,
            envelopes,
          }
        }
        if (refusalCount >= HRC_MAIL_STOP_REFUSAL_CAP) {
          return {
            decision: 'allow',
            reason: 'refusal_cap',
            unackedCount,
            refusalCount,
            totalRefusalCount,
            envelopes,
          }
        }
        return {
          decision: 'block',
          unackedCount,
          refusalCount,
          totalRefusalCount,
          envelopes,
        }
      })
      .immediate() as HrcMailStopDecision
  }
}

function mapSummary(row: UnackedSummaryRow): HrcMailStopEnvelopeSummary {
  return {
    envelopeId: row.envelope_id,
    from:
      row.from_kind === 'scope'
        ? { kind: 'scope', sessionRef: row.from_ref }
        : { kind: 'operator', principal: row.from_ref },
    state: row.state,
    body: row.body,
  }
}
