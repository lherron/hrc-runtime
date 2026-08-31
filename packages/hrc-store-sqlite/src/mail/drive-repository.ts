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
  autoReplyCandidate?: HrcMailAutoReplyCandidate | undefined
  claimedAt: string
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
}

/**
 * The one reply a completed drive is eligible to mint (T-07612 rev 6).
 *
 * This is captured before dispatch on the attempt row, while HRC still has the
 * ledger envelopes in hand. It is NOT the durable actuation intent: only the
 * successful `completeStartedAttempt` transaction copies it into the pending
 * intent table.
 */
export type HrcMailAutoReplyCandidate = {
  sourceRef: string
  sourceEnvelopeIds: readonly string[]
  roomKey: string
  counterpartyRef: string
}

export type HrcMailAutoReplyIntentState =
  | 'pending'
  | 'minted'
  | 'already-discharged'
  | 'empty-response'

export type HrcMailAutoReplyIntent = {
  driveAttemptId: string
  sourceRef: string
  sourceEnvelopeIds: string[]
  roomKey: string
  counterpartyRef: string
  runId: string
  targetSessionRef: string
  state: HrcMailAutoReplyIntentState
  attemptCount: number
  sayAttemptCount: number
  verificationPending: boolean
  lastAttemptAt?: string | undefined
  lastError?: string | undefined
  createdAt: string
  updatedAt: string
  terminalAt?: string | undefined
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
  autoReplyCandidate?: HrcMailAutoReplyCandidate | undefined
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
  /**
   * The envelope ids this attempt presented, and NON-EMPTY ONLY when the
   * attempt's own turn provably started and ended.
   *
   * That is the rev 5.1 D5 ownership proof, unchanged from rev 4 and now
   * carrying exactly one thing: an attempt whose input the harness merged into
   * another turn never reaches `started`, comes back empty here, and therefore
   * can neither arm a reminder nor strike an obligation out.
   */
  presentedEnvelopeIds: string[]
}

/**
 * One armed D4 reminder: at most one per (envelope, runtime), forever.
 *
 * `turnEndedAt` is kept because the reminder's header quotes it back ("your
 * turn ended 4m ago"), and by the time the hold expires the run row that knew
 * it may be several turns in the past.
 */
export type HrcMailEnvelopeReminder = {
  envelopeId: string
  runtimeId: string
  targetSessionRef: string
  turnEndedAt: string
  remindAt: string
  driveAttemptId?: string | undefined
  deliveredAt?: string | undefined
  createdAt: string
}

/** One §5 sender-side failure notice awaiting a live generation to land in. */
export type HrcMailFailureNotice = {
  envelopeId: string
  targetSessionRef: string
  notice: string
  createdAt: string
  deliveredAt?: string | undefined
}

type ReminderRow = {
  envelope_id: string
  runtime_id: string
  target_session_ref: string
  turn_ended_at: string
  remind_at: string
  drive_attempt_id: string | null
  delivered_at: string | null
  created_at: string
}

type FailureNoticeRow = {
  envelope_id: string
  target_session_ref: string
  notice: string
  created_at: string
  delivered_at: string | null
}

function mapReminder(row: ReminderRow): HrcMailEnvelopeReminder {
  return {
    envelopeId: row.envelope_id,
    runtimeId: row.runtime_id,
    targetSessionRef: row.target_session_ref,
    turnEndedAt: row.turn_ended_at,
    remindAt: row.remind_at,
    ...(row.drive_attempt_id === null ? {} : { driveAttemptId: row.drive_attempt_id }),
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    createdAt: row.created_at,
  }
}

function mapFailureNotice(row: FailureNoticeRow): HrcMailFailureNotice {
  return {
    envelopeId: row.envelope_id,
    targetSessionRef: row.target_session_ref,
    notice: row.notice,
    createdAt: row.created_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  }
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
  auto_reply_source_ref: string | null
  auto_reply_source_envelope_ids_json: string | null
  auto_reply_room_key: string | null
  auto_reply_counterparty_ref: string | null
}

type AutoReplyIntentRow = {
  drive_attempt_id: string
  source_ref: string
  source_envelope_ids_json: string
  room_key: string
  counterparty_ref: string
  run_id: string
  target_session_ref: string
  state: HrcMailAutoReplyIntentState
  attempt_count: number
  say_attempt_count: number
  verification_pending: number
  last_attempt_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  terminal_at: string | null
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
  started_at, completed_at, updated_at, queued_behind_run_id,
  auto_reply_source_ref, auto_reply_source_envelope_ids_json,
  auto_reply_room_key, auto_reply_counterparty_ref
`

const AUTO_REPLY_INTENT_COLUMNS = `
  drive_attempt_id, source_ref, source_envelope_ids_json, room_key,
  counterparty_ref, run_id, target_session_ref, state, attempt_count,
  say_attempt_count, verification_pending, last_attempt_at, last_error,
  created_at, updated_at, terminal_at
`

function parseEnvelopeIds(json: string): string[] {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('auto-reply source envelope ids must be a JSON string array')
  }
  return parsed
}

function mapAutoReplyCandidate(row: DriveAttemptRow): HrcMailAutoReplyCandidate | undefined {
  if (
    row.auto_reply_source_ref === null ||
    row.auto_reply_source_envelope_ids_json === null ||
    row.auto_reply_room_key === null ||
    row.auto_reply_counterparty_ref === null
  ) {
    return undefined
  }
  return {
    sourceRef: row.auto_reply_source_ref,
    sourceEnvelopeIds: parseEnvelopeIds(row.auto_reply_source_envelope_ids_json),
    roomKey: row.auto_reply_room_key,
    counterpartyRef: row.auto_reply_counterparty_ref,
  }
}

function mapAutoReplyIntent(row: AutoReplyIntentRow): HrcMailAutoReplyIntent {
  return {
    driveAttemptId: row.drive_attempt_id,
    sourceRef: row.source_ref,
    sourceEnvelopeIds: parseEnvelopeIds(row.source_envelope_ids_json),
    roomKey: row.room_key,
    counterpartyRef: row.counterparty_ref,
    runId: row.run_id,
    targetSessionRef: row.target_session_ref,
    state: row.state,
    attemptCount: row.attempt_count,
    sayAttemptCount: row.say_attempt_count,
    verificationPending: row.verification_pending === 1,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
  }
}

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
    ...(() => {
      const candidate = mapAutoReplyCandidate(row)
      return candidate === undefined ? {} : { autoReplyCandidate: candidate }
    })(),
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
               auto_reply_source_ref, auto_reply_source_envelope_ids_json,
               auto_reply_room_key, auto_reply_counterparty_ref,
               claimed_at, updated_at
             ) VALUES (?, ?, ?, ?, 'claimed', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            input.autoReplyCandidate?.sourceRef ?? null,
            input.autoReplyCandidate === undefined
              ? null
              : JSON.stringify(input.autoReplyCandidate.sourceEnvelopeIds),
            input.autoReplyCandidate?.roomKey ?? null,
            input.autoReplyCandidate?.counterpartyRef ?? null,
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

  /**
   * Capture eligibility before dispatch without creating actuation intent.
   *
   * The completion transaction is the sole writer of the pending intent row;
   * these columns merely carry the ledger-derived identity to that boundary.
   */
  recordAutoReplyCandidate(
    driveAttemptId: string,
    candidate: HrcMailAutoReplyCandidate | undefined
  ): void {
    this.db
      .query(
        `UPDATE hrcmail_drive_attempts
            SET auto_reply_source_ref = ?,
                auto_reply_source_envelope_ids_json = ?,
                auto_reply_room_key = ?,
                auto_reply_counterparty_ref = ?,
                updated_at = ?
          WHERE drive_attempt_id = ? AND state = 'claimed'`
      )
      .run(
        candidate?.sourceRef ?? null,
        candidate === undefined ? null : JSON.stringify(candidate.sourceEnvelopeIds),
        candidate?.roomKey ?? null,
        candidate?.counterpartyRef ?? null,
        new Date().toISOString(),
        driveAttemptId
      )
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
    return this.finishUnstarted(driveAttemptId, 'no_op', undefined)
  }

  failWithoutStart(driveAttemptId: string, error: string): HrcMailDriveAttempt {
    return this.finishUnstarted(driveAttemptId, 'failed', error)
  }

  /**
   * Close a started attempt and report which envelopes it presented.
   *
   * The returned ids are the rev 5.1 D4/D5 trigger: this attempt's OWN turn
   * started and ended, and these are the obligations it carried. An attempt
   * that never started returns none, which is precisely what keeps a merged
   * input from arming a reminder it did not show or striking out an obligation
   * it never surfaced.
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
        attempt: this.finishUnstarted(
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
        if (
          (terminalEventKind === 'turn.completed' || terminalEventKind === 'run.completed') &&
          attempt.autoReplyCandidate !== undefined
        ) {
          const candidate = attempt.autoReplyCandidate
          this.db
            .query(
              `INSERT OR IGNORE INTO hrcmail_auto_reply_intents (
                 drive_attempt_id, source_ref, source_envelope_ids_json,
                 room_key, counterparty_ref, run_id, target_session_ref,
                 state, attempt_count, say_attempt_count, verification_pending,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?)`
            )
            .run(
              attempt.driveAttemptId,
              candidate.sourceRef,
              JSON.stringify(candidate.sourceEnvelopeIds),
              candidate.roomKey,
              candidate.counterpartyRef,
              attempt.runId,
              attempt.targetSessionRef,
              now,
              now
            )
        }
        this.releaseSlot(attempt.targetSessionRef, attempt.driveAttemptId, now)
        return { attempt: this.requireAttempt(attempt.driveAttemptId), presentedEnvelopeIds }
      })
      .immediate() as CompleteHrcMailDriveResult | undefined
  }

  getAutoReplyIntent(driveAttemptId: string): HrcMailAutoReplyIntent | undefined {
    const row = this.db
      .query<AutoReplyIntentRow, [string]>(
        `SELECT ${AUTO_REPLY_INTENT_COLUMNS}
           FROM hrcmail_auto_reply_intents
          WHERE drive_attempt_id = ?`
      )
      .get(driveAttemptId)
    return row === null ? undefined : mapAutoReplyIntent(row)
  }

  listPendingAutoReplyIntents(): HrcMailAutoReplyIntent[] {
    return this.db
      .query<AutoReplyIntentRow, []>(
        `SELECT ${AUTO_REPLY_INTENT_COLUMNS}
           FROM hrcmail_auto_reply_intents
          WHERE state = 'pending'
          ORDER BY created_at ASC, drive_attempt_id ASC`
      )
      .all()
      .map(mapAutoReplyIntent)
  }

  recordAutoReplyAttempt(
    driveAttemptId: string,
    error?: string | undefined
  ): HrcMailAutoReplyIntent {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_auto_reply_intents
            SET attempt_count = attempt_count + 1,
                last_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE drive_attempt_id = ? AND state = 'pending'`
      )
      .run(now, error ?? null, now, driveAttemptId)
    return this.requireAutoReplyIntent(driveAttemptId)
  }

  recordAutoReplyError(driveAttemptId: string, error: string): HrcMailAutoReplyIntent {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_auto_reply_intents
            SET last_error = ?, updated_at = ?
          WHERE drive_attempt_id = ? AND state = 'pending'`
      )
      .run(error, now, driveAttemptId)
    return this.requireAutoReplyIntent(driveAttemptId)
  }

  /** Persist BEFORE plain say so a lost response/crash is verified by read on restart. */
  markAutoReplySayStarted(driveAttemptId: string): HrcMailAutoReplyIntent {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_auto_reply_intents
            SET say_attempt_count = say_attempt_count + 1,
                verification_pending = 1, updated_at = ?
          WHERE drive_attempt_id = ? AND state = 'pending'`
      )
      .run(now, driveAttemptId)
    return this.requireAutoReplyIntent(driveAttemptId)
  }

  /** A successful room read proved the prior say did not mint; retry is safe. */
  clearAutoReplyVerification(driveAttemptId: string): HrcMailAutoReplyIntent {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_auto_reply_intents
            SET verification_pending = 0, updated_at = ?
          WHERE drive_attempt_id = ? AND state = 'pending'`
      )
      .run(now, driveAttemptId)
    return this.requireAutoReplyIntent(driveAttemptId)
  }

  completeAutoReplyIntent(
    driveAttemptId: string,
    state: Exclude<HrcMailAutoReplyIntentState, 'pending'>
  ): HrcMailAutoReplyIntent {
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE hrcmail_auto_reply_intents
            SET state = ?, verification_pending = 0, last_error = NULL,
                terminal_at = ?, updated_at = ?
          WHERE drive_attempt_id = ? AND state = 'pending'`
      )
      .run(state, now, now, driveAttemptId)
    return this.requireAutoReplyIntent(driveAttemptId)
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

  /** End an attempt that never proved a turn: no D4 arming, no D5 strike-out. */
  private finishUnstarted(
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

  // ── rev 5.1 obligation lifetime (T-07704) ──────────────────────────────────

  /**
   * (target, runtime) pairs this node presented mail on, since `since`.
   *
   * The D3 lapse backstop's candidate source. It is bounded by a lookback
   * rather than being "every attempt ever", and it is the LOCAL record on
   * purpose: a runtime this node never drove is another node's to lapse, and
   * asking the ledger which runtimes are dead would be asking wrkq a question
   * about execution state it has no business knowing.
   */
  listRuntimeBoundTargets(since: string): { targetSessionRef: string; runtimeId: string }[] {
    return this.db
      .query<{ target_session_ref: string; runtime_id: string }, [string]>(
        `SELECT DISTINCT a.target_session_ref, a.runtime_id
           FROM hrcmail_drive_attempts a
          WHERE a.runtime_id IS NOT NULL
            AND a.updated_at >= ?
            AND EXISTS (
              SELECT 1 FROM hrcmail_drive_presentations p
               WHERE p.drive_attempt_id = a.drive_attempt_id
            )
          ORDER BY a.target_session_ref ASC, a.runtime_id ASC`
      )
      .all(since)
      .map((row) => ({ targetSessionRef: row.target_session_ref, runtimeId: row.runtime_id }))
  }

  /**
   * Arm the D4 reminder for one (envelope, runtime), at most once ever.
   *
   * Returns false when the pair already has a row — armed, delivered, or long
   * spent. That is the whole at-most-once guarantee, and it lives in a UNIQUE
   * key rather than in a read-then-write because the arming trigger is
   * deliberately loose: every turn terminal on the runtime re-offers the same
   * pair, and all but the first must be no-ops.
   */
  armReminder(input: {
    envelopeId: string
    runtimeId: string
    targetSessionRef: string
    turnEndedAt: string
    remindAt: string
  }): boolean {
    const changes = this.db
      .query(
        `INSERT OR IGNORE INTO hrcmail_envelope_reminders (
           envelope_id, runtime_id, target_session_ref, turn_ended_at,
           remind_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.envelopeId,
        input.runtimeId,
        normalizeTarget(input.targetSessionRef),
        input.turnEndedAt,
        input.remindAt,
        new Date().toISOString()
      ).changes
    return changes > 0
  }

  /** Armed, undelivered reminders for one target whose hold has expired. */
  listDueReminders(targetSessionRef: string, now: string): HrcMailEnvelopeReminder[] {
    return this.db
      .query<ReminderRow, [string, string]>(
        `SELECT envelope_id, runtime_id, target_session_ref, turn_ended_at,
                remind_at, drive_attempt_id, delivered_at, created_at
           FROM hrcmail_envelope_reminders
          WHERE target_session_ref = ? AND delivered_at IS NULL AND remind_at <= ?
          ORDER BY remind_at ASC, envelope_id ASC`
      )
      .all(normalizeTarget(targetSessionRef), now)
      .map(mapReminder)
  }

  /** Targets owed a due reminder; a sweep candidate source of its own. */
  listDueReminderTargets(now: string): string[] {
    return this.db
      .query<{ target_session_ref: string }, [string]>(
        `SELECT DISTINCT target_session_ref
           FROM hrcmail_envelope_reminders
          WHERE delivered_at IS NULL AND remind_at <= ?
          ORDER BY target_session_ref ASC`
      )
      .all(now)
      .map((row) => row.target_session_ref)
  }

  /** Bind a delivered reminder to the attempt that carried it (the D5 owner). */
  markReminderDelivered(envelopeId: string, runtimeId: string, driveAttemptId: string): void {
    this.db
      .query(
        `UPDATE hrcmail_envelope_reminders
            SET drive_attempt_id = ?, delivered_at = ?
          WHERE envelope_id = ? AND runtime_id = ? AND delivered_at IS NULL`
      )
      .run(driveAttemptId, new Date().toISOString(), envelopeId, runtimeId)
  }

  /**
   * Retire a reminder whose obligation is no longer standing on that runtime.
   *
   * An armed reminder is only ever DELIVERED if the envelope is still
   * `presented` on the runtime it was armed for. Everything else that can
   * happen to it in the intervening minute — a reply, a defer, a D3 lapse, a
   * delivery that has since been superseded — leaves the row armed and due
   * forever, and `listDueReminderTargets` would then hand the sweep that scope
   * on every tick for the life of the store. Nothing would be DELIVERED (the
   * wake set is still the authority on that), so this is a load and hygiene
   * defect rather than a correctness one — which is exactly the shape that
   * survives review and shows up months later as an unexplained sweep cost.
   *
   * `drive_attempt_id` is deliberately left NULL. `remindersForAttempt` keys on
   * it, so a retired row can never be mistaken for a reminder that was actually
   * shown to someone, and D5 can never strike an obligation out over it.
   */
  retireReminder(envelopeId: string, runtimeId: string): boolean {
    return (
      this.db
        .query(
          `UPDATE hrcmail_envelope_reminders
              SET delivered_at = ?
            WHERE envelope_id = ? AND runtime_id = ?
              AND delivered_at IS NULL AND drive_attempt_id IS NULL`
        )
        .run(new Date().toISOString(), envelopeId, runtimeId).changes > 0
    )
  }

  /**
   * The reminders one drive attempt carried.
   *
   * D5's whole predicate: if the attempt that just proved a start-and-end is a
   * reminder attempt, the obligations it named have had their second strike.
   */
  remindersForAttempt(driveAttemptId: string): HrcMailEnvelopeReminder[] {
    return this.db
      .query<ReminderRow, [string]>(
        `SELECT envelope_id, runtime_id, target_session_ref, turn_ended_at,
                remind_at, drive_attempt_id, delivered_at, created_at
           FROM hrcmail_envelope_reminders
          WHERE drive_attempt_id = ?
          ORDER BY envelope_id ASC`
      )
      .all(driveAttemptId)
      .map(mapReminder)
  }

  /**
   * Queue a §5 failure notice for a sender scope.
   *
   * Keyed on (envelope, target) so the ledger tail re-reading a page, or two
   * nodes observing the same `envelope.failed`, cannot tell one sender the same
   * thing twice.
   */
  recordFailureNotice(input: {
    envelopeId: string
    targetSessionRef: string
    notice: string
  }): boolean {
    const changes = this.db
      .query(
        `INSERT OR IGNORE INTO hrcmail_failure_notices (
           envelope_id, target_session_ref, notice, created_at
         ) VALUES (?, ?, ?, ?)`
      )
      .run(
        input.envelopeId,
        normalizeTarget(input.targetSessionRef),
        input.notice,
        new Date().toISOString()
      ).changes
    return changes > 0
  }

  listUndeliveredFailureNotices(targetSessionRef: string): HrcMailFailureNotice[] {
    return this.db
      .query<FailureNoticeRow, [string]>(
        `SELECT envelope_id, target_session_ref, notice, created_at, delivered_at
           FROM hrcmail_failure_notices
          WHERE target_session_ref = ? AND delivered_at IS NULL
          ORDER BY created_at ASC, envelope_id ASC`
      )
      .all(normalizeTarget(targetSessionRef))
      .map(mapFailureNotice)
  }

  /** Scopes holding an undelivered notice: "on next attend", made findable. */
  listFailureNoticeTargets(): string[] {
    return this.db
      .query<{ target_session_ref: string }, []>(
        `SELECT DISTINCT target_session_ref
           FROM hrcmail_failure_notices
          WHERE delivered_at IS NULL
          ORDER BY target_session_ref ASC`
      )
      .all()
      .map((row) => row.target_session_ref)
  }

  markFailureNoticesDelivered(targetSessionRef: string, envelopeIds: readonly string[]): void {
    if (envelopeIds.length === 0) return
    const now = new Date().toISOString()
    const target = normalizeTarget(targetSessionRef)
    this.db
      .transaction(() => {
        for (const envelopeId of envelopeIds) {
          this.db
            .query(
              `UPDATE hrcmail_failure_notices
                  SET delivered_at = ?
                WHERE envelope_id = ? AND target_session_ref = ? AND delivered_at IS NULL`
            )
            .run(now, envelopeId, target)
        }
      })
      .immediate()
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

  private requireAutoReplyIntent(driveAttemptId: string): HrcMailAutoReplyIntent {
    const intent = this.getAutoReplyIntent(driveAttemptId)
    if (intent === undefined) {
      throw new Error(`unknown mail auto-reply intent "${driveAttemptId}"`)
    }
    return intent
  }
}
