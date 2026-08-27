import type { Database } from 'bun:sqlite'

export const HRC_MAIL_STOP_REFUSAL_CAP = 3
export const HRC_MAIL_STOP_HARD_CAP = 50

/**
 * The stop-hook's refusal ledger (T-07612 §8, carried unchanged in mechanics
 * from T-06810).
 *
 * The PREDICATE is a wrkq query — `pendingView.blocking`, which names only what
 * was actually presented and left neither replied nor deferred — and is passed
 * in. What lives here is the part that references a run: how many times this
 * turn has already been refused, and against which obligation, so the count
 * resets when new mail arrives and the hard cap can never trap a turn forever.
 *
 * That split is the boundary rule: the obligation is collaboration and belongs
 * to wrkq; the refusal count is execution and belongs to HRC.
 */

/** One blocking obligation, as wrkq reported it. */
export type HrcMailStopEnvelopeSummary = {
  envelopeId: string
  /** The sender, already rendered for a human reader. */
  from: string
  roomKey: string
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

  /**
   * Decide whether this turn may end, given wrkq's blocking set.
   *
   * `newestEnvelopeSeq` is the marker for "have I already refused over this
   * obligation, or is it new?" — the numeric tail of the newest blocking
   * `EN-xxxxx` id, which is monotonic for the same reason an envelope sequence
   * would be. An empty blocking set is `clear`: an obligation the agent was
   * never shown must not trap its turn, and neither must one it has answered.
   */
  evaluate(
    runId: string,
    targetSessionRef: string,
    blocking: readonly HrcMailStopEnvelopeSummary[],
    newestEnvelopeSeq: number,
    summaryLimit = 8
  ): HrcMailStopDecision {
    const limit = Math.min(Math.max(summaryLimit, 1), 20)
    return this.db
      .transaction(() => {
        const unackedCount = blocking.length
        const previous = this.get(runId)
        if (unackedCount === 0) {
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

        const envelopes = blocking.slice(0, limit)

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
