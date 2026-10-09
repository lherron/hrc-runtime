import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'
import {
  ATTEMPT_COLUMNS,
  NON_RUNNABLE_ATTEMPT_PREDICATE,
  type ParticipantAttemptRow,
  type ParticipantRegistrationRow,
  REGISTRATION_COLUMNS,
  isNonRunnableEstablishmentAttempt,
  mapAttempt,
  mapRegistration,
} from './participant-registration-rows.js'
import {
  type ParticipantAttempt,
  type ParticipantAttemptState,
  type ParticipantContinuationSelection,
  type ParticipantEstablishmentWorkState,
  type ParticipantRecoveryDisposition,
  type ParticipantRegistration,
  type ParticipantResumeState,
  allowsParticipantAttemptTransition,
} from './participant-registration-types.js'

export { isNonRunnableEstablishmentAttempt }
export type * from './participant-registration-types.js'

/**
 * Permanent generic participant address plus per-attempt durable boundaries.
 *
 * The registration row is never deleted: a class/key pair reserves its scope
 * across observer loss and daemon restart. The attempt row deliberately keeps
 * prepared, hosting, realized, and dispatch snapshots separate so a replay can
 * distinguish "not spawned" from "spawned but not yet dispatch-frozen".
 */
export class ParticipantRegistrationRepository {
  constructor(private readonly db: Database) {}

  insertRegistration(record: ParticipantRegistration): ParticipantRegistration {
    execute(
      this.db,
      `INSERT INTO participant_registrations (${REGISTRATION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.registrationId,
      record.classId ?? null,
      record.join,
      record.participantKey ?? null,
      record.scopeRef,
      record.laneRef,
      record.hostSessionId,
      record.generation,
      record.workspaceCwd ?? null,
      record.socketPath ?? null,
      record.policy?.addressPolicy ?? null,
      record.policy?.continuityPolicy ?? null,
      record.policy?.lifecycleOwner ?? null,
      record.policy?.replaySemantics ?? null,
      record.hostIncarnationId ?? null,
      record.createdAt,
      record.updatedAt
    )
    return record
  }

  getRegistrationByScopeRef(scopeRef: string): ParticipantRegistration | null {
    const row = this.db
      .query<ParticipantRegistrationRow, [string]>(
        `SELECT ${REGISTRATION_COLUMNS} FROM participant_registrations WHERE scope_ref = ?`
      )
      .get(scopeRef)
    return row === null ? null : mapRegistration(row)
  }

  /**
   * R7.1's direct duplicate lookup: the canonical address plus the declared
   * incarnation, independent of any optional class or key. A direct request
   * always carries both, which is why it needs no extra retry token.
   */
  getDirectRegistrationByAddressAndIncarnation(
    scopeRef: string,
    hostIncarnationId: string
  ): ParticipantRegistration | null {
    const row = this.db
      .query<ParticipantRegistrationRow, [string, string]>(
        `SELECT ${REGISTRATION_COLUMNS} FROM participant_registrations
         WHERE scope_ref = ? AND host_incarnation_id = ?`
      )
      .get(scopeRef, hostIncarnationId)
    return row === null ? null : mapRegistration(row)
  }

  getRegistrationById(registrationId: string): ParticipantRegistration | null {
    const row = this.db
      .query<ParticipantRegistrationRow, [string]>(
        `SELECT ${REGISTRATION_COLUMNS} FROM participant_registrations WHERE registration_id = ?`
      )
      .get(registrationId)
    return row === null ? null : mapRegistration(row)
  }

  getAttemptByRegistrationId(registrationId: string): ParticipantAttempt | null {
    const row = this.db
      .query<ParticipantAttemptRow, [string]>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts
         WHERE registration_id = ? ORDER BY attach_epoch DESC LIMIT 1`
      )
      .get(registrationId)
    return row === null ? null : mapAttempt(row)
  }

  listAttemptsByRegistrationId(registrationId: string): ParticipantAttempt[] {
    const rows = this.db
      .query<ParticipantAttemptRow, [string]>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts
         WHERE registration_id = ? ORDER BY attach_epoch ASC, attempt_id ASC`
      )
      .all(registrationId)
    return rows.map(mapAttempt)
  }

  insertAttempt(record: ParticipantAttempt): ParticipantAttempt {
    execute(
      this.db,
      `INSERT INTO participant_registration_attempts (${ATTEMPT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.attemptId,
      record.registrationId,
      record.attachEpoch,
      record.requestId,
      record.operationId,
      record.invocationId,
      record.runtimeId,
      record.hostBindingId ?? null,
      record.state,
      record.preparedDescriptorJson ?? null,
      record.adapterDispatchEnvJson ?? null,
      record.hostingIntentJson ?? null,
      record.realizedHostingJson ?? null,
      record.dispatchJson ?? null,
      record.brokerIdentityJson ?? null,
      record.initialActivationConfirmedAt ?? null,
      record.activationClassification ?? null,
      record.writerEvidenceJson ?? null,
      record.recoveryDisposition,
      record.recoveryReason ?? null,
      record.establishmentWorkState,
      record.establishmentAttemptCount,
      record.establishmentNextAttemptAt ?? null,
      record.establishmentLastError ?? null,
      record.attachSocketPath ?? null,
      record.continuation === undefined ? null : record.continuation.carried ? 1 : 0,
      record.continuation?.reason ?? null,
      record.continuation?.selectedJson ?? null,
      record.resumeState ?? null,
      record.resumeReason ?? null,
      record.replacementIntentJson ?? null,
      record.dispositionReason ?? null,
      record.createdAt,
      record.updatedAt
    )
    return record
  }

  getAttempt(attemptId: string): ParticipantAttempt | null {
    const row = this.db
      .query<ParticipantAttemptRow, [string]>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts WHERE attempt_id = ?`
      )
      .get(attemptId)
    return row === null ? null : mapAttempt(row)
  }

  /** Every attempt naming this runtime, whether or not a broker invocation row exists. */
  listAttemptsByRuntimeId(runtimeId: string): ParticipantAttempt[] {
    const rows = this.db
      .query<ParticipantAttemptRow, [string]>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts
         WHERE runtime_id = ? ORDER BY attach_epoch ASC, attempt_id ASC`
      )
      .all(runtimeId)
    return rows.map(mapAttempt)
  }

  getAttemptByInvocationId(invocationId: string): ParticipantAttempt | null {
    const row = this.db
      .query<ParticipantAttemptRow, [string]>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts WHERE invocation_id = ?`
      )
      .get(invocationId)
    return row === null ? null : mapAttempt(row)
  }

  recordWriterEvidence(
    attemptId: string,
    attachEpoch: number,
    writerEvidenceJson: string,
    updatedAt: string
  ): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET writer_evidence_json = ?, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ?`
      )
      .run(writerEvidenceJson, updatedAt, attemptId, attachEpoch)
    return result.changes === 1
  }

  storeReplacementIntent(input: {
    attemptId: string
    attachEpoch: number
    replacementIntentJson: string
    updatedAt: string
  }): 'stored' | 'same' | 'conflict' {
    const current = this.getAttempt(input.attemptId)
    if (current === null || current.attachEpoch !== input.attachEpoch) return 'conflict'
    if (current.replacementIntentJson !== undefined) {
      return current.replacementIntentJson === input.replacementIntentJson ? 'same' : 'conflict'
    }
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET replacement_intent_json = ?, establishment_work_state = 'pending',
                establishment_next_attempt_at = NULL, establishment_last_error = NULL,
                updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ? AND replacement_intent_json IS NULL`
      )
      .run(input.replacementIntentJson, input.updatedAt, input.attemptId, input.attachEpoch)
    return result.changes === 1 ? 'stored' : 'conflict'
  }

  replaceReplacementIntent(input: {
    attemptId: string
    attachEpoch: number
    expectedJson: string
    replacementJson: string
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET replacement_intent_json = ?, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ? AND replacement_intent_json = ?`
      )
      .run(
        input.replacementJson,
        input.updatedAt,
        input.attemptId,
        input.attachEpoch,
        input.expectedJson
      )
    return result.changes === 1
  }

  cancelReplacementIntent(input: {
    attemptId: string
    attachEpoch: number
    expectedIntentJson: string
    establishmentWorkState: ParticipantEstablishmentWorkState
    establishmentAttemptCount: number
    establishmentNextAttemptAt?: string | undefined
    establishmentLastError?: string | undefined
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET replacement_intent_json = NULL, establishment_work_state = ?,
                establishment_attempt_count = ?, establishment_next_attempt_at = ?,
                establishment_last_error = ?, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ? AND replacement_intent_json = ?`
      )
      .run(
        input.establishmentWorkState,
        input.establishmentAttemptCount,
        input.establishmentNextAttemptAt ?? null,
        input.establishmentLastError ?? null,
        input.updatedAt,
        input.attemptId,
        input.attachEpoch,
        input.expectedIntentJson
      )
    return result.changes === 1
  }

  pauseReplacementWork(input: {
    attemptId: string
    attachEpoch: number
    expectedIntentJson: string
    reason: string
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET establishment_work_state = 'completed', establishment_next_attempt_at = NULL,
                establishment_last_error = ?, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ? AND replacement_intent_json = ?`
      )
      .run(
        input.reason,
        input.updatedAt,
        input.attemptId,
        input.attachEpoch,
        input.expectedIntentJson
      )
    return result.changes === 1
  }

  rearmReplacementWork(input: { attemptId: string; reason: string; updatedAt: string }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET establishment_work_state = 'pending', establishment_next_attempt_at = NULL,
                establishment_last_error = ?, updated_at = ?
          WHERE attempt_id = ? AND replacement_intent_json IS NOT NULL
            AND establishment_work_state = 'completed'`
      )
      .run(input.reason, input.updatedAt, input.attemptId)
    return result.changes === 1
  }

  completeReplacementWork(input: {
    attemptId: string
    attachEpoch: number
    expectedIntentJson: string
    completedIntentJson: string
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET replacement_intent_json = ?, establishment_work_state = 'completed',
                establishment_next_attempt_at = NULL, establishment_last_error = NULL,
                updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ? AND replacement_intent_json = ?`
      )
      .run(
        input.completedIntentJson,
        input.updatedAt,
        input.attemptId,
        input.attachEpoch,
        input.expectedIntentJson
      )
    return result.changes === 1
  }

  /** Explicit, reasoned recovery only; an ordinary duplicate cannot reset exhaustion. */
  renewExhaustedReplacement(input: {
    attemptId: string
    reason: string
    updatedAt: string
  }): boolean {
    const reason = input.reason.trim()
    if (reason.length === 0) return false
    const current = this.getAttempt(input.attemptId)
    if (
      current?.replacementIntentJson === undefined ||
      current.establishmentWorkState !== 'exhausted'
    ) {
      return false
    }
    let intent: Record<string, unknown>
    try {
      intent = JSON.parse(current.replacementIntentJson) as Record<string, unknown>
    } catch {
      return false
    }
    intent['renewedRecovery'] = { reason, recordedAt: input.updatedAt }
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET replacement_intent_json = ?, establishment_work_state = 'pending',
                establishment_attempt_count = 0, establishment_next_attempt_at = NULL,
                establishment_last_error = NULL, updated_at = ?
          WHERE attempt_id = ? AND establishment_work_state = 'exhausted'
            AND replacement_intent_json = ?`
      )
      .run(JSON.stringify(intent), input.updatedAt, input.attemptId, current.replacementIntentJson)
    return result.changes === 1
  }

  updateDirectRegistrationForHostSuccessor(input: {
    registrationId: string
    expectedHostSessionId: string
    hostSessionId: string
    generation: number
    hostIncarnationId: string
    workspaceCwd?: string | undefined
    socketPath?: string | undefined
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registrations
            SET host_session_id = ?, generation = ?, host_incarnation_id = ?,
                workspace_cwd = COALESCE(?, workspace_cwd),
                serving_socket_path = COALESCE(?, serving_socket_path), updated_at = ?
          WHERE registration_id = ?
            AND host_session_id = ?`
      )
      .run(
        input.hostSessionId,
        input.generation,
        input.hostIncarnationId,
        input.workspaceCwd ?? null,
        input.socketPath ?? null,
        input.updatedAt,
        input.registrationId,
        input.expectedHostSessionId
      )
    return result.changes === 1
  }

  updateDirectRegistrationForBridgeSuccessor(input: {
    registrationId: string
    expectedHostSessionId: string
    expectedHostIncarnationId: string
    workspaceCwd?: string | undefined
    socketPath?: string | undefined
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registrations
            SET workspace_cwd = COALESCE(?, workspace_cwd),
                serving_socket_path = COALESCE(?, serving_socket_path), updated_at = ?
          WHERE registration_id = ?
            AND host_session_id = ? AND host_incarnation_id = ?`
      )
      .run(
        input.workspaceCwd ?? null,
        input.socketPath ?? null,
        input.updatedAt,
        input.registrationId,
        input.expectedHostSessionId,
        input.expectedHostIncarnationId
      )
    return result.changes === 1
  }

  /**
   * Record the participant-served broker endpoint when the registration has
   * none yet. R6.4 lets a participant supply its endpoint at registration OR
   * later at attachment, and the hosting intent needs it wherever it came from.
   * `IS NULL` in the predicate keeps this from silently relocating an endpoint
   * an earlier attachment already froze.
   */
  setServingSocketPathIfAbsent(input: {
    registrationId: string
    socketPath: string
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registrations
            SET serving_socket_path = ?, updated_at = ?
          WHERE registration_id = ? AND serving_socket_path IS NULL`
      )
      .run(input.socketPath, input.updatedAt, input.registrationId)
    return result.changes === 1
  }

  /**
   * Startup work enumeration, with R7.2's non-runnable exclusion applied in
   * SQL rather than after the read.
   *
   * An `IDENTITY_MINTED` attempt with no profile is a participant that has
   * joined and not attached. Handing it to the worker would burn a retry and
   * record a profile-missing failure for doing nothing wrong, and enough of
   * those exhaust the budget purely by waiting. The replacement-intent clause
   * is the exception R7.2 names: successor work is a separate runnable reason
   * and must not be stranded because its candidate is not prepared yet.
   */
  listEstablishmentWork(): ParticipantAttempt[] {
    const rows = this.db
      .query<ParticipantAttemptRow, []>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts
         WHERE establishment_work_state IN ('pending', 'retry_wait')
           AND NOT (${NON_RUNNABLE_ATTEMPT_PREDICATE})
         ORDER BY COALESCE(establishment_next_attempt_at, created_at), attempt_id`
      )
      .all()
    return rows.map(mapAttempt)
  }

  /**
   * R7.2's attachment transaction, as one conditional UPDATE.
   *
   * The guard is what makes "only the first successful preparation resets the
   * budget" true: it requires the descriptor columns to still be NULL, so a
   * retry against an already-prepared attempt changes zero rows and cannot
   * reach the `establishment_attempt_count = 0` this statement performs. The
   * epoch is rechecked in the same predicate, so a stale attach never lands.
   */
  attachPreparedDescriptor(input: {
    attemptId: string
    attachEpoch: number
    preparedDescriptorJson: string
    adapterDispatchEnvJson: string
    attachSocketPath?: string | undefined
    resumeState?: ParticipantResumeState | undefined
    resumeReason?: string | undefined
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET prepared_profile_json = ?,
                adapter_dispatch_env_json = ?,
                attach_socket_path = COALESCE(?, attach_socket_path),
                continuation_resume_state = COALESCE(?, continuation_resume_state),
                continuation_resume_reason = COALESCE(?, continuation_resume_reason),
                state = 'PREPARED',
                establishment_work_state = 'pending',
                establishment_attempt_count = 0,
                establishment_next_attempt_at = NULL,
                establishment_last_error = NULL,
                updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ?
            AND state = 'IDENTITY_MINTED'
            AND prepared_profile_json IS NULL
            AND adapter_dispatch_env_json IS NULL`
      )
      .run(
        input.preparedDescriptorJson,
        input.adapterDispatchEnvJson,
        input.attachSocketPath ?? null,
        input.resumeState ?? null,
        input.resumeReason ?? null,
        input.updatedAt,
        input.attemptId,
        input.attachEpoch
      )
    return result.changes === 1
  }

  /**
   * R7.3: the selection is frozen with the attempt's identity, so a repeat
   * registration returns the same answer rather than recomputing one. Write
   * once; a second write would be a silent replacement of what was promised.
   */
  recordContinuationSelectionIfAbsent(input: {
    attemptId: string
    selection: ParticipantContinuationSelection
    resumeState: ParticipantResumeState
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET continuation_carried = ?, continuation_reason = ?,
                continuation_selected_json = ?, continuation_resume_state = ?,
                updated_at = ?
          WHERE attempt_id = ? AND continuation_carried IS NULL`
      )
      .run(
        input.selection.carried ? 1 : 0,
        input.selection.reason,
        input.selection.selectedJson ?? null,
        input.resumeState,
        input.updatedAt,
        input.attemptId
      )
    return result.changes === 1
  }

  /**
   * A driver reporting that it cannot resume native state. It records an
   * outcome; it never retracts the selection, which stays exactly as promised.
   */
  recordResumeOutcome(input: {
    attemptId: string
    attachEpoch: number
    resumeState: ParticipantResumeState
    reason?: string | undefined
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET continuation_resume_state = ?, continuation_resume_reason = ?, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ?`
      )
      .run(
        input.resumeState,
        input.reason ?? null,
        input.updatedAt,
        input.attemptId,
        input.attachEpoch
      )
    return result.changes === 1
  }

  /**
   * Activated attempts, for controller reconnect after a daemon restart.
   *
   * Deliberately NOT `listEstablishmentWork`: that one answers "what work is
   * outstanding", and an activated participant's work is `completed` by
   * definition. Asking it the reconnect question is what left a live host
   * unreachable across a restart -- the recovery existed and nothing ever
   * handed it the row.
   */
  listActivatedAttempts(): ParticipantAttempt[] {
    return this.db
      .query<ParticipantAttemptRow, []>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts a
         WHERE a.state = 'ACTIVE' AND a.establishment_work_state = 'completed'
           AND a.prepared_profile_json IS NOT NULL
           -- Only the CURRENT attempt of its registration. Selecting every
           -- ACTIVE row would offer recovery to a superseded epoch, which is
           -- how a reconnect ends up serving a different writer.
           AND a.attach_epoch = (
             SELECT MAX(b.attach_epoch) FROM participant_registration_attempts b
              WHERE b.registration_id = a.registration_id
           )
         ORDER BY a.updated_at`
      )
      .all()
      .map(mapAttempt)
  }

  /**
   * Durably arm a NEW reconnect cycle before any effect is attempted.
   *
   * `stageExistingParticipantAttachment` persists ACTIVE -> DETACHED before it
   * awaits install/hello. Driving it outside the establishment work machine
   * left a broker outage, or a crash at that instant, with a row in
   * DETACHED/`completed` -- which every re-entry door excludes, so it was
   * stranded permanently: no boot enumeration, no scheduler, and delivery
   * answering `activation_pending` forever with the host healthy. Arming first
   * hands the cycle to the bounded retry/failure/recovery machinery that
   * already exists, and `listEstablishmentWork` finds it again after a crash
   * whatever intermediate state it stopped in.
   *
   * The predicate is the initiation rule itself, so this is idempotent and can
   * never re-arm an exhausted or already-running cycle or reset its budget.
   */
  armParticipantReconnect(attemptId: string, updatedAt: string): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET establishment_work_state = 'pending',
                establishment_attempt_count = 0,
                establishment_next_attempt_at = NULL,
                establishment_last_error = NULL,
                updated_at = ?
          WHERE attempt_id = ?
            AND state = 'ACTIVE'
            AND establishment_work_state = 'completed'
            AND prepared_profile_json IS NOT NULL`
      )
      .run(updatedAt, attemptId)
    return result.changes === 1
  }

  recordEstablishmentFailure(input: {
    attemptId: string
    attachEpoch: number
    failedAt: string
    nextAttemptAt: string
    error: string
    maxAttempts: number
  }): ParticipantAttempt | null {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET establishment_attempt_count = establishment_attempt_count + 1,
                establishment_work_state = CASE
                  WHEN establishment_attempt_count + 1 >= ? THEN 'exhausted'
                  ELSE 'retry_wait'
                END,
                establishment_next_attempt_at = CASE
                  WHEN establishment_attempt_count + 1 >= ? THEN NULL
                  ELSE ?
                END,
                establishment_last_error = ?, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ?
            AND establishment_work_state IN ('pending', 'retry_wait')`
      )
      .run(
        input.maxAttempts,
        input.maxAttempts,
        input.nextAttemptAt,
        input.error,
        input.failedAt,
        input.attemptId,
        input.attachEpoch
      )
    return result.changes === 1 ? this.getAttempt(input.attemptId) : null
  }

  recordRecoveryDisposition(
    attemptId: string,
    disposition: Exclude<ParticipantRecoveryDisposition, 'unresolved'>,
    reason: string,
    updatedAt: string
  ): boolean {
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0) return false
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET recovery_disposition = ?, recovery_reason = ?, updated_at = ?
          WHERE attempt_id = ? AND recovery_disposition = 'unresolved'
            AND state IN ('SUPERSEDED', 'ABANDONED', 'TERMINAL')`
      )
      .run(disposition, normalizedReason, updatedAt, attemptId)
    return result.changes === 1
  }

  markEstablishmentCompleted(attemptId: string, attachEpoch: number, updatedAt: string): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET establishment_work_state = 'completed',
                establishment_next_attempt_at = NULL, updated_at = ?
          WHERE attempt_id = ? AND attach_epoch = ?
            AND establishment_work_state IN ('pending', 'retry_wait')`
      )
      .run(updatedAt, attemptId, attachEpoch)
    return result.changes === 1
  }

  setSnapshotIfAbsent(
    attemptId: string,
    field: 'hostingIntentJson' | 'realizedHostingJson' | 'dispatchJson' | 'brokerIdentityJson',
    value: string,
    updatedAt: string
  ): boolean {
    const column = {
      hostingIntentJson: 'hosting_intent_json',
      realizedHostingJson: 'realized_hosting_json',
      dispatchJson: 'dispatch_json',
      brokerIdentityJson: 'broker_identity_json',
    }[field]
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET ${column} = ?, updated_at = ?
          WHERE attempt_id = ? AND ${column} IS NULL`
      )
      .run(value, updatedAt, attemptId)
    return result.changes === 1
  }

  /**
   * Marks the sole activation allowed to classify continuity and release replay.
   * `handleRegisterParticipant`'s future lifecycle transaction owns that
   * classification; this repository only durably fences current attach proof.
   */
  confirmInitialActivation(attemptId: string, confirmedAt: string): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', initial_activation_confirmed_at = ?, updated_at = ?
          WHERE attempt_id = ?
            AND state = 'ATTACH_CONFIRMED'
            AND initial_activation_confirmed_at IS NULL`
      )
      .run(confirmedAt, confirmedAt, attemptId)
    return result.changes === 1
  }

  /**
   * Restores an already-active attempt after a new attach confirmation. It
   * intentionally cannot run initial activation classification or release replay.
   */
  confirmReattachment(attemptId: string, confirmedAt: string): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', updated_at = ?
          WHERE attempt_id = ?
            AND state = 'ATTACH_CONFIRMED'
            AND initial_activation_confirmed_at IS NOT NULL`
      )
      .run(confirmedAt, attemptId)
    return result.changes === 1
  }

  transitionAttempt(
    attemptId: string,
    from: readonly ParticipantAttemptState[],
    to: ParticipantAttemptState,
    updatedAt: string,
    dispositionReason?: string
  ): boolean {
    if (from.length === 0) return false
    if (!from.every((state) => allowsParticipantAttemptTransition(state, to, dispositionReason))) {
      return false
    }
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET state = ?, disposition_reason = ?, updated_at = ?
          WHERE attempt_id = ? AND state IN (${placeholders})`
      )
      .run(to, dispositionReason ?? null, updatedAt, attemptId, ...from)
    return result.changes === 1
  }
}
