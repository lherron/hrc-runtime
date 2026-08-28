import { randomUUID } from 'node:crypto'

import type { Database } from 'bun:sqlite'
import type { HrcRuntimeIntent } from 'hrc-core'

/**
 * The per-scope drive slot: HRC's EXECUTION state for driving the wrkq
 * collaboration ledger (T-07612 §2, §10).
 *
 * wrkq owns the envelopes. This repository owns only what references a run: the
 * per-scope slot that serialises drives, the `driveAttemptId` that makes a
 * presentation exactly-once across a crash, and the local receipt of which
 * envelope ids an attempt presented. It NO LONGER READS ANY ENVELOPE TABLE --
 * the actionable set is passed in by the kicker, which read it from wrkq. That
 * is the whole shape of the re-point: the slot machinery is unchanged, and the
 * ledger it drives moved out of this store.
 */

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
  /** The live run this attempt's input was queued behind (T-07612 rev 4, mid-turn attempts). */
  queuedBehindRunId?: string | undefined
  claimedAt: string
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
}

export type HrcMailQueuedAttemptInput = {
  targetSessionRef: string
  runId: string
  wakeReason: HrcMailDriveWakeReason
  prompt: string
  envelopeIds: readonly string[]
  queuedBehindRunId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
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
  /** The envelope ids this attempt presented; the caller advances their rounds in wrkq. */
  presentedEnvelopeIds: string[]
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
  queued_behind_run_id: string | null
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
  started_at, completed_at, updated_at, queued_behind_run_id
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
    ...(row.queued_behind_run_id === null ? {} : { queuedBehindRunId: row.queued_behind_run_id }),
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

/**
 * The actionable set for one target, as the kicker read it from wrkq. The
 * repository never derives this: it is the ledger's answer, not HRC's.
 */
export type HrcMailDriveActionable = {
  /** Envelope ids (`EN-xxxxx`) in presentation order. */
  envelopeIds: readonly string[]
  /** Birth directives carried verbatim by the oldest actionable envelope. */
  materializationIntent?: HrcRuntimeIntent | undefined
}

/**
 * The placeholder prompt a claim carries until presentation composes the real
 * one. A claim happens before the target is even born, so the injected text --
 * which is the section 7 presentation of concrete envelopes -- cannot exist yet.
 */
function claimPlaceholderPrompt(count: number): string {
  return `${count} ${count === 1 ? 'envelope' : 'envelopes'} pending; check \`wrkc inbox\``
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

  /** Scopes with an attempt still in flight; the sweep must observe these. */
  listInFlightTargets(): string[] {
    return this.db
      .query<{ target_session_ref: string }, []>(
        `SELECT DISTINCT target_session_ref
           FROM hrcmail_drive_attempts
          WHERE state IN ('claimed', 'started')
          ORDER BY target_session_ref ASC`
      )
      .all()
      .map((row) => row.target_session_ref)
  }

  /**
   * Targets whose LAST attempt failed before it ever reached a session
   * (T-07661).
   *
   * This is the node's own durable record of "mail arrived for a scope I could
   * not open", and it is the only local source for the `none` designation class
   * — a virgin scope whose sender named no scope, so the registry designated
   * nothing and tier 5 stayed local. There is no designation row to enumerate
   * for those, and no seat, so without this row they have no second wake source
   * at all.
   *
   * `host_session_id IS NULL` is what makes it a REFUSED BIRTH rather than any
   * failed drive: the column is written by `recordSession`, immediately after
   * `ensureTargetSession` returns, so a null one means the failure happened at
   * or before the summon gate. A drive that failed after the session existed is
   * a delivery problem and the ordinary seated-scope sweep already covers it.
   *
   * The LAST attempt, not any: a target that failed once and has since been
   * driven successfully is not owed a birth, and reading "ever failed" would
   * keep every such scope in the candidate set for the life of the store.
   */
  listRefusedBirthTargets(): string[] {
    return this.db
      .query<{ target_session_ref: string }, []>(
        `SELECT target_session_ref FROM hrcmail_drive_attempts a
          WHERE a.state = 'failed'
            AND a.host_session_id IS NULL
            AND a.claimed_at = (
              SELECT MAX(b.claimed_at) FROM hrcmail_drive_attempts b
               WHERE b.target_session_ref = a.target_session_ref
            )
          GROUP BY target_session_ref
          ORDER BY target_session_ref ASC`
      )
      .all()
      .map((row) => row.target_session_ref)
  }

  claim(
    targetSessionRef: string,
    wakeReason: HrcMailDriveWakeReason,
    actionable: HrcMailDriveActionable,
    ids: { driveAttemptId?: string | undefined; runId?: string | undefined } = {}
  ): HrcMailDriveClaimResult {
    const target = normalizeTarget(targetSessionRef)
    return this.db
      .transaction(() => {
        const now = new Date().toISOString()
        this.db
          .query(
            `INSERT OR IGNORE INTO hrcmail_drive_slots (
               target_session_ref, active_drive_attempt_id, updated_at
             ) VALUES (?, NULL, ?)`
          )
          .run(target, now)

        const active = this.getActiveAttempt(target)
        if (active !== undefined) return { outcome: 'active', attempt: active }

        const count = actionable.envelopeIds.length
        if (count === 0) return { outcome: 'clear' }

        const driveAttemptId = ids.driveAttemptId ?? `drive-${randomUUID()}`
        const runId = ids.runId ?? `run-${driveAttemptId.slice('drive-'.length)}`
        const prompt = claimPlaceholderPrompt(count)
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
            actionable.materializationIntent === undefined
              ? null
              : JSON.stringify(actionable.materializationIntent),
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

  /**
   * Record, locally and idempotently, that this attempt is presenting these
   * envelopes, and return the ids in presentation order.
   *
   * The receipt is written BEFORE the ledger is told, and the same
   * `driveAttemptId` goes to `wrkq.envelope.present`, which is itself
   * exactly-once. That ordering is what survives a kill between persisting the
   * attempt and dispatching it: the retry replays the same attempt id, the
   * local receipt already exists, and wrkq answers `recorded: false` rather than
   * writing a second presentation.
   */
  presentForAttempt(driveAttemptId: string, envelopeIds: readonly string[]): string[] {
    return this.db
      .transaction(() => {
        const attempt = this.requireAttempt(driveAttemptId)
        const slot = this.getSlot(attempt.targetSessionRef)
        if (slot?.activeDriveAttemptId !== driveAttemptId) {
          throw new Error(`mail drive attempt ${driveAttemptId} does not own its scope slot`)
        }
        if (attempt.state !== 'claimed') return this.presentationEnvelopeIds(driveAttemptId)

        const now = new Date().toISOString()
        for (const envelopeId of envelopeIds) {
          this.db
            .query(
              `INSERT OR IGNORE INTO hrcmail_drive_presentations (
                 drive_attempt_id, envelope_id, presented_at
               ) VALUES (?, ?, ?)`
            )
            .run(driveAttemptId, envelopeId, now)
        }
        return this.presentationEnvelopeIds(driveAttemptId)
      })
      .immediate() as string[]
  }

  /**
   * A mid-turn presentation as its own attempt (T-07612 rev 4).
   *
   * It never touches the scope slot: the slot is held by the drive whose turn
   * is live, and this attempt's input was queued behind that turn. It is owned
   * by the queued input's run, so `completeStartedAttempt` advances its rounds
   * when THAT run ends undisposed. If the harness merges the input into the
   * live turn instead (no `turn.started` of its own), this attempt advances
   * nothing — HRC does not guess — and bounded redelivery comes from the next
   * ordinary drive after the floor. Presentations are recorded here, so the
   * attempt is `claimed` with its receipts already in place.
   */
  insertQueuedAttempt(input: HrcMailQueuedAttemptInput): HrcMailDriveAttempt {
    const target = normalizeTarget(input.targetSessionRef)
    return this.db
      .transaction(() => {
        const now = new Date().toISOString()
        const driveAttemptId = `queued-${randomUUID()}`
        this.db
          .query(
            `INSERT INTO hrcmail_drive_attempts (
               drive_attempt_id, target_session_ref, run_id, wake_reason, state,
               prompt, presented_count, materialization_intent_json,
               host_session_id, generation, runtime_id, queued_behind_run_id,
               claimed_at, updated_at
             ) VALUES (?, ?, ?, ?, 'claimed', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            driveAttemptId,
            target,
            input.runId,
            input.wakeReason,
            input.prompt,
            input.envelopeIds.length,
            input.hostSessionId,
            input.generation,
            input.runtimeId ?? null,
            input.queuedBehindRunId,
            now,
            now
          )
        for (const envelopeId of input.envelopeIds) {
          this.db
            .query(
              `INSERT OR IGNORE INTO hrcmail_drive_presentations (
                 drive_attempt_id, envelope_id, presented_at
               ) VALUES (?, ?, ?)`
            )
            .run(driveAttemptId, envelopeId, now)
        }
        return this.requireAttempt(driveAttemptId)
      })
      .immediate() as HrcMailDriveAttempt
  }

  /** Every attempt for a target that has not reached a terminal state, slot-holding or not. */
  listUnfinishedAttempts(targetSessionRef: string): HrcMailDriveAttempt[] {
    return this.db
      .query<DriveAttemptRow, [string]>(
        `SELECT ${DRIVE_ATTEMPT_COLUMNS}
         FROM hrcmail_drive_attempts
         WHERE target_session_ref = ? AND state IN ('claimed', 'started')
         ORDER BY claimed_at ASC`
      )
      .all(normalizeTarget(targetSessionRef))
      .map(mapAttempt)
  }

  /**
   * Install the composed section 7 injection text on a claimed attempt.
   *
   * The prompt is only knowable after presentation, because it IS the presented
   * envelopes: header, optional history cue, body, reply line.
   */
  recordPresentation(driveAttemptId: string, prompt: string, presentedCount: number): void {
    this.db
      .query(
        `UPDATE hrcmail_drive_attempts
         SET prompt = ?, presented_count = ?, updated_at = ?
         WHERE drive_attempt_id = ? AND state = 'claimed'`
      )
      .run(prompt, presentedCount, new Date().toISOString(), driveAttemptId)
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

  /**
   * Close a started attempt and report which envelopes it presented.
   *
   * Round accounting moved to wrkq with the ledger: the caller calls
   * `wrkq.envelope.roundEnded` for each returned id. Only a still-`presented`
   * envelope advances there, so a clear-inbox no-op turn still burns nothing --
   * the rule is unchanged, its enforcement is just on the owning side now.
   */
  completeStartedAttempt(
    runId: string,
    terminalEventKind: string
  ): CompleteHrcMailDriveResult | undefined {
    const current = this.getAttemptByRunId(runId)
    if (current === undefined) return undefined
    if (current.state === 'completed') {
      return { attempt: current, presentedEnvelopeIds: [] }
    }
    if (current.state !== 'started' || current.startHrcSeq === undefined) {
      return {
        attempt: this.finishWithoutRounds(
          current.driveAttemptId,
          'failed',
          `terminal ${terminalEventKind} observed without turn.started`
        ),
        presentedEnvelopeIds: [],
      }
    }

    return this.db
      .transaction(() => {
        const attempt = this.getAttemptByRunId(runId)
        if (attempt === undefined) return undefined
        if (attempt.state === 'completed') {
          return { attempt, presentedEnvelopeIds: [] }
        }
        if (attempt.state !== 'started' || attempt.startHrcSeq === undefined) return undefined

        const now = new Date().toISOString()
        const presentedEnvelopeIds = this.presentationEnvelopeIds(attempt.driveAttemptId)
        this.db
          .query(
            `UPDATE hrcmail_drive_attempts
             SET state = 'completed', terminal_event_kind = ?, completed_at = ?,
                 last_error = NULL, updated_at = ?
             WHERE drive_attempt_id = ? AND state = 'started'`
          )
          .run(terminalEventKind, now, now, attempt.driveAttemptId)
        this.releaseSlot(attempt.targetSessionRef, attempt.driveAttemptId, now)
        return { attempt: this.requireAttempt(attempt.driveAttemptId), presentedEnvelopeIds }
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

  private requireAttempt(driveAttemptId: string): HrcMailDriveAttempt {
    const attempt = this.getAttempt(driveAttemptId)
    if (attempt === undefined) throw new Error(`unknown mail drive attempt "${driveAttemptId}"`)
    return attempt
  }
}
