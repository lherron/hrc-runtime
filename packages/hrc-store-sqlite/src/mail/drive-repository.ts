import { randomUUID } from 'node:crypto'

import type { Database } from 'bun:sqlite'
import type { HrcMailEnvelope, HrcRuntimeIntent } from 'hrc-core'

export type HrcMailDriveWakeReason = 'insert' | 'turn_completion' | 'periodic' | 'recovery'

export type HrcMailDriveAttemptState = 'claimed' | 'started' | 'completed' | 'failed' | 'no_op'

export type HrcMailDriveAttempt = {
  driveAttemptId: string
  targetSessionRef: string
  runId: string
  wakeReason: HrcMailDriveWakeReason
  state: HrcMailDriveAttemptState
  prompt: string
  presentedCount: number
  materializationIntent?: HrcRuntimeIntent | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  startHrcSeq?: number | undefined
  terminalEventKind?: string | undefined
  lastError?: string | undefined
  claimedAt: string
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
}

export type HrcMailDriveSlot = {
  targetSessionRef: string
  activeDriveAttemptId?: string | undefined
  updatedAt: string
}

export type HrcMailDriveClaimResult =
  | { outcome: 'clear' }
  | { outcome: 'active'; attempt: HrcMailDriveAttempt }
  | { outcome: 'acquired'; attempt: HrcMailDriveAttempt }

export type CompleteHrcMailDriveResult = {
  attempt: HrcMailDriveAttempt
  roundsAdvanced: number
  deadLettered: number
}

type DriveAttemptRow = {
  drive_attempt_id: string
  target_session_ref: string
  run_id: string
  wake_reason: HrcMailDriveWakeReason
  state: HrcMailDriveAttemptState
  prompt: string
  presented_count: number
  materialization_intent_json: string | null
  host_session_id: string | null
  generation: number | null
  runtime_id: string | null
  start_hrc_seq: number | null
  terminal_event_kind: string | null
  last_error: string | null
  claimed_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

type DriveSlotRow = {
  target_session_ref: string
  active_drive_attempt_id: string | null
  updated_at: string
}

const DRIVE_ATTEMPT_COLUMNS = `
  drive_attempt_id, target_session_ref, run_id, wake_reason, state, prompt,
  presented_count, materialization_intent_json, host_session_id, generation,
  runtime_id, start_hrc_seq, terminal_event_kind, last_error, claimed_at,
  started_at, completed_at, updated_at
`

function mapAttempt(row: DriveAttemptRow): HrcMailDriveAttempt {
  return {
    driveAttemptId: row.drive_attempt_id,
    targetSessionRef: row.target_session_ref,
    runId: row.run_id,
    wakeReason: row.wake_reason,
    state: row.state,
    prompt: row.prompt,
    presentedCount: row.presented_count,
    ...(row.materialization_intent_json === null
      ? {}
      : { materializationIntent: JSON.parse(row.materialization_intent_json) as HrcRuntimeIntent }),
    ...(row.host_session_id === null ? {} : { hostSessionId: row.host_session_id }),
    ...(row.generation === null ? {} : { generation: row.generation }),
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id }),
    ...(row.start_hrc_seq === null ? {} : { startHrcSeq: row.start_hrc_seq }),
    ...(row.terminal_event_kind === null ? {} : { terminalEventKind: row.terminal_event_kind }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    claimedAt: row.claimed_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at,
  }
}

function mapSlot(row: DriveSlotRow): HrcMailDriveSlot {
  return {
    targetSessionRef: row.target_session_ref,
    ...(row.active_drive_attempt_id === null
      ? {}
      : { activeDriveAttemptId: row.active_drive_attempt_id }),
    updatedAt: row.updated_at,
  }
}

function normalizeTarget(targetSessionRef: string): string {
  const target = targetSessionRef.trim()
  if (target.length === 0) throw new Error('targetSessionRef must not be empty')
  return target
}

function drivePrompt(count: number): string {
  return `${count} ${count === 1 ? 'envelope' : 'envelopes'} pending; check \`hrcmail inbox\``
}

export class HrcMailDriveRepository {
  constructor(private readonly db: Database) {}

  getAttempt(driveAttemptId: string): HrcMailDriveAttempt | undefined {
    const row = this.db
      .query<DriveAttemptRow, [string]>(
        `SELECT ${DRIVE_ATTEMPT_COLUMNS}
         FROM hrcmail_drive_attempts
         WHERE drive_attempt_id = ?`
      )
      .get(driveAttemptId)
    return row === null ? undefined : mapAttempt(row)
  }

  getAttemptByRunId(runId: string): HrcMailDriveAttempt | undefined {
    const row = this.db
      .query<DriveAttemptRow, [string]>(
        `SELECT ${DRIVE_ATTEMPT_COLUMNS}
         FROM hrcmail_drive_attempts
         WHERE run_id = ?`
      )
      .get(runId)
    return row === null ? undefined : mapAttempt(row)
  }

  listAttempts(targetSessionRef?: string): HrcMailDriveAttempt[] {
    const rows =
      targetSessionRef === undefined
        ? this.db
            .query<DriveAttemptRow, []>(
              `SELECT ${DRIVE_ATTEMPT_COLUMNS}
               FROM hrcmail_drive_attempts
               ORDER BY claimed_at ASC, drive_attempt_id ASC`
            )
            .all()
        : this.db
            .query<DriveAttemptRow, [string]>(
              `SELECT ${DRIVE_ATTEMPT_COLUMNS}
               FROM hrcmail_drive_attempts
               WHERE target_session_ref = ?
               ORDER BY claimed_at ASC, drive_attempt_id ASC`
            )
            .all(normalizeTarget(targetSessionRef))
    return rows.map(mapAttempt)
  }

  getSlot(targetSessionRef: string): HrcMailDriveSlot | undefined {
    const row = this.db
      .query<DriveSlotRow, [string]>(
        `SELECT target_session_ref, active_drive_attempt_id, updated_at
         FROM hrcmail_drive_slots
         WHERE target_session_ref = ?`
      )
      .get(normalizeTarget(targetSessionRef))
    return row === null ? undefined : mapSlot(row)
  }

  getActiveAttempt(targetSessionRef: string): HrcMailDriveAttempt | undefined {
    const row = this.db
      .query<DriveAttemptRow, [string]>(
        `SELECT ${DRIVE_ATTEMPT_COLUMNS}
         FROM hrcmail_drive_attempts
         WHERE drive_attempt_id = (
           SELECT active_drive_attempt_id
           FROM hrcmail_drive_slots
           WHERE target_session_ref = ?
         )`
      )
      .get(normalizeTarget(targetSessionRef))
    return row === null ? undefined : mapAttempt(row)
  }

  actionableCount(targetSessionRef: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM hrcmail_envelopes
         WHERE target_session_ref = ?
           AND payload_kind = 'request'
           AND state IN ('pending', 'presented')`
      )
      .get(normalizeTarget(targetSessionRef))
    return row?.count ?? 0
  }

  listWakeTargets(now = new Date().toISOString()): string[] {
    return this.db
      .query<{ target_session_ref: string }, [string]>(
        `SELECT target_session_ref
         FROM hrcmail_drive_slots
         WHERE active_drive_attempt_id IS NOT NULL
         UNION
         SELECT target_session_ref
         FROM hrcmail_envelopes
         WHERE payload_kind = 'request'
           AND state IN ('pending', 'presented')
         UNION
         SELECT target_session_ref
         FROM hrcmail_envelopes
         WHERE state = 'deferred'
           AND retry_at IS NOT NULL
           AND retry_at <= ?
         ORDER BY target_session_ref ASC`
      )
      .all(now)
      .map((row) => row.target_session_ref)
  }

  claim(
    targetSessionRef: string,
    wakeReason: HrcMailDriveWakeReason,
    ids: { driveAttemptId?: string | undefined; runId?: string | undefined } = {}
  ): HrcMailDriveClaimResult {
    const target = normalizeTarget(targetSessionRef)
    return this.db
      .transaction(() => {
        const now = new Date().toISOString()
        this.settlePendingConversational(target, now)
        this.db
          .query(
            `INSERT OR IGNORE INTO hrcmail_drive_slots (
               target_session_ref, active_drive_attempt_id, updated_at
             ) VALUES (?, NULL, ?)`
          )
          .run(target, now)

        const active = this.getActiveAttempt(target)
        if (active !== undefined) return { outcome: 'active', attempt: active }

        const actionable = this.db
          .query<{ count: number; materialization_intent_json: string | null }, [string, string]>(
            `SELECT
               COUNT(*) AS count,
               (
                 SELECT materialization_intent_json
                 FROM hrcmail_envelopes
                 WHERE target_session_ref = ?
                   AND payload_kind = 'request'
                   AND state IN ('pending', 'presented')
                   AND materialization_intent_json IS NOT NULL
                 ORDER BY envelope_seq ASC
                 LIMIT 1
               ) AS materialization_intent_json
             FROM hrcmail_envelopes
             WHERE target_session_ref = ?
               AND payload_kind = 'request'
               AND state IN ('pending', 'presented')`
          )
          .get(target, target)
        const count = actionable?.count ?? 0
        if (count === 0) return { outcome: 'clear' }

        const driveAttemptId = ids.driveAttemptId ?? `drive-${randomUUID()}`
        const runId = ids.runId ?? `run-${driveAttemptId.slice('drive-'.length)}`
        const prompt = drivePrompt(count)
        this.db
          .query(
            `INSERT INTO hrcmail_drive_attempts (
               drive_attempt_id, target_session_ref, run_id, wake_reason, state,
               prompt, presented_count, materialization_intent_json,
               claimed_at, updated_at
             ) VALUES (?, ?, ?, ?, 'claimed', ?, 0, ?, ?, ?)`
          )
          .run(
            driveAttemptId,
            target,
            runId,
            wakeReason,
            prompt,
            actionable?.materialization_intent_json ?? null,
            now,
            now
          )

        const claimed = this.db
          .query(
            `UPDATE hrcmail_drive_slots
             SET active_drive_attempt_id = ?, updated_at = ?
             WHERE target_session_ref = ? AND active_drive_attempt_id IS NULL`
          )
          .run(driveAttemptId, now, target)
        if (claimed.changes !== 1) {
          throw new Error(`failed to CAS mail drive slot for ${target}`)
        }
        return { outcome: 'acquired', attempt: this.requireAttempt(driveAttemptId) }
      })
      .immediate() as HrcMailDriveClaimResult
  }

  presentForAttempt(
    driveAttemptId: string,
    loadEnvelope: (envelopeId: string) => HrcMailEnvelope,
    limit = 100
  ): HrcMailEnvelope[] {
    return this.db
      .transaction(() => {
        const attempt = this.requireAttempt(driveAttemptId)
        const slot = this.getSlot(attempt.targetSessionRef)
        if (slot?.activeDriveAttemptId !== driveAttemptId) {
          throw new Error(`mail drive attempt ${driveAttemptId} does not own its scope slot`)
        }
        if (attempt.state !== 'claimed') {
          return this.presentationEnvelopeIds(driveAttemptId).map(loadEnvelope)
        }

        const now = new Date().toISOString()
        this.settlePendingConversational(attempt.targetSessionRef, now)
        const rows = this.db
          .query<{ envelope_id: string; state: 'pending' | 'presented' }, [string, number]>(
            `SELECT envelope_id, state
             FROM hrcmail_envelopes
             WHERE target_session_ref = ?
               AND payload_kind = 'request'
               AND state IN ('pending', 'presented')
             ORDER BY envelope_seq ASC
             LIMIT ?`
          )
          .all(attempt.targetSessionRef, Math.min(Math.max(limit, 1), 1000))

        for (const row of rows) {
          if (row.state === 'pending') {
            this.db
              .query(
                `UPDATE hrcmail_envelopes
                 SET state = 'presented',
                     presented_at = COALESCE(presented_at, ?),
                     updated_at = ?
                 WHERE envelope_id = ? AND state = 'pending'`
              )
              .run(now, now, row.envelope_id)
          }
          this.db
            .query(
              `INSERT OR IGNORE INTO hrcmail_drive_presentations (
                 drive_attempt_id, envelope_id, presented_at
               ) VALUES (?, ?, ?)`
            )
            .run(driveAttemptId, row.envelope_id, now)
        }

        const prompt = drivePrompt(rows.length)
        this.db
          .query(
            `UPDATE hrcmail_drive_attempts
             SET prompt = ?, presented_count = ?, updated_at = ?
             WHERE drive_attempt_id = ? AND state = 'claimed'`
          )
          .run(prompt, rows.length, now, driveAttemptId)

        return rows.map((row) => loadEnvelope(row.envelope_id))
      })
      .immediate() as HrcMailEnvelope[]
  }

  recordSession(
    driveAttemptId: string,
    input: { hostSessionId: string; generation: number; runtimeId?: string | undefined }
  ): HrcMailDriveAttempt {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_drive_attempts
         SET host_session_id = ?, generation = ?, runtime_id = COALESCE(?, runtime_id),
             updated_at = ?
         WHERE drive_attempt_id = ? AND state IN ('claimed', 'started')`
      )
      .run(input.hostSessionId, input.generation, input.runtimeId ?? null, now, driveAttemptId)
    return this.requireAttempt(driveAttemptId)
  }

  recordStart(input: {
    runId: string
    startHrcSeq: number
    startedAt: string
    hostSessionId: string
    generation: number
    runtimeId?: string | undefined
  }): HrcMailDriveAttempt | undefined {
    const existing = this.getAttemptByRunId(input.runId)
    if (existing === undefined) return undefined
    if (existing.startHrcSeq !== undefined) return existing

    this.db
      .query(
        `UPDATE hrcmail_drive_attempts
         SET state = 'started', start_hrc_seq = ?, started_at = ?,
             host_session_id = ?, generation = ?,
             runtime_id = COALESCE(?, runtime_id), last_error = NULL, updated_at = ?
         WHERE run_id = ? AND state = 'claimed' AND start_hrc_seq IS NULL`
      )
      .run(
        input.startHrcSeq,
        input.startedAt,
        input.hostSessionId,
        input.generation,
        input.runtimeId ?? null,
        input.startedAt,
        input.runId
      )
    return this.getAttemptByRunId(input.runId)
  }

  recordError(driveAttemptId: string, error: string): HrcMailDriveAttempt {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_drive_attempts
         SET last_error = ?, updated_at = ?
         WHERE drive_attempt_id = ? AND state IN ('claimed', 'started')`
      )
      .run(error, now, driveAttemptId)
    return this.requireAttempt(driveAttemptId)
  }

  completeNoOp(driveAttemptId: string): HrcMailDriveAttempt {
    return this.finishWithoutRounds(driveAttemptId, 'no_op', undefined)
  }

  failWithoutStart(driveAttemptId: string, error: string): HrcMailDriveAttempt {
    return this.finishWithoutRounds(driveAttemptId, 'failed', error)
  }

  completeStartedAttempt(
    runId: string,
    terminalEventKind: string,
    maxRounds: number
  ): CompleteHrcMailDriveResult | undefined {
    if (!Number.isSafeInteger(maxRounds) || maxRounds <= 0) {
      throw new Error('maxRounds must be a positive integer')
    }
    const current = this.getAttemptByRunId(runId)
    if (current === undefined) return undefined
    if (current.state === 'completed') {
      return { attempt: current, roundsAdvanced: 0, deadLettered: 0 }
    }
    if (current.state !== 'started' || current.startHrcSeq === undefined) {
      return {
        attempt: this.finishWithoutRounds(
          current.driveAttemptId,
          'failed',
          `terminal ${terminalEventKind} observed without turn.started`
        ),
        roundsAdvanced: 0,
        deadLettered: 0,
      }
    }

    return this.db
      .transaction(() => {
        const attempt = this.getAttemptByRunId(runId)
        if (attempt === undefined) return undefined
        if (attempt.state === 'completed') {
          return { attempt, roundsAdvanced: 0, deadLettered: 0 }
        }
        if (attempt.state !== 'started' || attempt.startHrcSeq === undefined) return undefined

        const now = new Date().toISOString()
        let roundsAdvanced = 0
        let deadLettered = 0
        for (const envelopeId of this.presentationEnvelopeIds(attempt.driveAttemptId)) {
          const before = this.db
            .query<{ round_count: number }, [string]>(
              `SELECT round_count
               FROM hrcmail_envelopes
               WHERE envelope_id = ? AND state = 'presented'`
            )
            .get(envelopeId)
          if (before === null) continue

          const nextRound = before.round_count + 1
          const shouldDeadLetter = nextRound >= maxRounds
          const changed = this.db
            .query(
              `UPDATE hrcmail_envelopes
               SET round_count = ?,
                   state = CASE WHEN ? = 1 THEN 'dead' ELSE state END,
                   dead_at = CASE WHEN ? = 1 THEN ? ELSE dead_at END,
                   updated_at = ?
               WHERE envelope_id = ? AND state = 'presented'`
            )
            .run(
              nextRound,
              shouldDeadLetter ? 1 : 0,
              shouldDeadLetter ? 1 : 0,
              now,
              now,
              envelopeId
            )
          if (changed.changes === 1) {
            roundsAdvanced += 1
            if (shouldDeadLetter) deadLettered += 1
          }
        }

        this.db
          .query(
            `UPDATE hrcmail_drive_attempts
             SET state = 'completed', terminal_event_kind = ?, completed_at = ?,
                 last_error = NULL, updated_at = ?
             WHERE drive_attempt_id = ? AND state = 'started'`
          )
          .run(terminalEventKind, now, now, attempt.driveAttemptId)
        this.releaseSlot(attempt.targetSessionRef, attempt.driveAttemptId, now)
        return {
          attempt: this.requireAttempt(attempt.driveAttemptId),
          roundsAdvanced,
          deadLettered,
        }
      })
      .immediate() as CompleteHrcMailDriveResult | undefined
  }

  presentationEnvelopeIds(driveAttemptId: string): string[] {
    return this.db
      .query<{ envelope_id: string }, [string]>(
        `SELECT envelope_id
         FROM hrcmail_drive_presentations
         WHERE drive_attempt_id = ?
         ORDER BY presented_at ASC, envelope_id ASC`
      )
      .all(driveAttemptId)
      .map((row) => row.envelope_id)
  }

  private finishWithoutRounds(
    driveAttemptId: string,
    state: 'failed' | 'no_op',
    error: string | undefined
  ): HrcMailDriveAttempt {
    return this.db
      .transaction(() => {
        const attempt = this.requireAttempt(driveAttemptId)
        if (
          attempt.state === 'completed' ||
          attempt.state === 'failed' ||
          attempt.state === 'no_op'
        ) {
          return attempt
        }
        const now = new Date().toISOString()
        this.db
          .query(
            `UPDATE hrcmail_drive_attempts
             SET state = ?, last_error = ?, completed_at = ?, updated_at = ?
             WHERE drive_attempt_id = ? AND state IN ('claimed', 'started')`
          )
          .run(state, error ?? null, now, now, driveAttemptId)
        this.releaseSlot(attempt.targetSessionRef, driveAttemptId, now)
        return this.requireAttempt(driveAttemptId)
      })
      .immediate() as HrcMailDriveAttempt
  }

  private releaseSlot(targetSessionRef: string, driveAttemptId: string, now: string): void {
    this.db
      .query(
        `UPDATE hrcmail_drive_slots
         SET active_drive_attempt_id = NULL, updated_at = ?
         WHERE target_session_ref = ? AND active_drive_attempt_id = ?`
      )
      .run(now, targetSessionRef, driveAttemptId)
  }

  private settlePendingConversational(targetSessionRef: string, now: string): void {
    this.db
      .query(
        `UPDATE hrcmail_envelopes
         SET state = 'acked',
             presented_at = COALESCE(presented_at, ?),
             acked_at = COALESCE(acked_at, ?),
             updated_at = ?
         WHERE target_session_ref = ?
           AND payload_kind = 'conversational'
           AND state IN ('pending', 'presented')`
      )
      .run(now, now, now, targetSessionRef)
  }

  private requireAttempt(driveAttemptId: string): HrcMailDriveAttempt {
    const attempt = this.getAttempt(driveAttemptId)
    if (attempt === undefined) throw new Error(`unknown mail drive attempt "${driveAttemptId}"`)
    return attempt
  }
}
