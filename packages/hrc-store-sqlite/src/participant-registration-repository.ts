import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

/** Durable state names from T-08344 rev6 C.7. */
export type ParticipantAttemptState =
  | 'REGISTERED'
  | 'IDENTITY_MINTED'
  | 'PREPARED'
  | 'HOSTING_INTENT_PERSISTED'
  | 'REALIZED'
  | 'DISPATCH_FROZEN'
  | 'INSTALL_CONFIRMED'
  | 'INVOCATION_READY'
  | 'ATTACH_CONFIRMED'
  | 'ACTIVE'
  | 'DETACHED'
  | 'SUPERSEDED'
  | 'ABANDONED'
  | 'TERMINAL'

export type ParticipantRecoveryDisposition = 'unresolved' | 'reconciled' | 'abandoned'
export type ParticipantEstablishmentWorkState = 'pending' | 'retry_wait' | 'exhausted' | 'completed'

/**
 * C.7 is a graph, not a rank. In particular, a detached participant returns
 * through current attach confirmation; it does not mint a new user resume.
 */
const participantAttemptTransitions: Readonly<
  Record<ParticipantAttemptState, readonly ParticipantAttemptState[]>
> = {
  REGISTERED: ['IDENTITY_MINTED'],
  IDENTITY_MINTED: ['PREPARED', 'ABANDONED'],
  PREPARED: ['HOSTING_INTENT_PERSISTED', 'ABANDONED'],
  HOSTING_INTENT_PERSISTED: ['REALIZED', 'ABANDONED'],
  REALIZED: ['DISPATCH_FROZEN', 'ABANDONED'],
  DISPATCH_FROZEN: ['INSTALL_CONFIRMED', 'ABANDONED'],
  INSTALL_CONFIRMED: ['INVOCATION_READY', 'ABANDONED'],
  INVOCATION_READY: ['ATTACH_CONFIRMED', 'ABANDONED', 'TERMINAL'],
  ATTACH_CONFIRMED: ['ABANDONED', 'TERMINAL'],
  ACTIVE: ['DETACHED', 'ABANDONED', 'TERMINAL'],
  DETACHED: ['ATTACH_CONFIRMED', 'ABANDONED', 'TERMINAL'],
  SUPERSEDED: [],
  ABANDONED: [],
  TERMINAL: [],
}

function allowsParticipantAttemptTransition(
  from: ParticipantAttemptState,
  to: ParticipantAttemptState,
  dispositionReason: string | undefined
): boolean {
  if (!participantAttemptTransitions[from].includes(to)) return false
  if (to === 'ABANDONED' || to === 'TERMINAL') return dispositionReason !== undefined
  return true
}

export type ParticipantRegistration = {
  registrationId: string
  classId: string
  adapterId: string
  join: 'hrc-hosted' | 'participant-served'
  participantKey: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  workspaceCwd: string
  /** Participant-owned broker endpoint; absent for HRC-hosted participants. */
  socketPath?: string | undefined
  /** Opaque, JSON-serialized adapter admission output. */
  preparationJson: string
  /** Opaque, JSON-serialized continuity evidence, when the adapter supplied it. */
  continuityEvidenceJson?: string | undefined
  createdAt: string
  updatedAt: string
}

export type ParticipantAttempt = {
  attemptId: string
  registrationId: string
  attachEpoch: number
  requestId: string
  operationId: string
  invocationId: string
  runtimeId: string
  state: ParticipantAttemptState
  /** The first validated adapter profile/request snapshot, before any spawn. */
  preparedProfileJson?: string | undefined
  adapterDispatchEnvJson?: string | undefined
  /** HRC-owned executable, paths, token reference, and requested presentation. */
  hostingIntentJson?: string | undefined
  /** Actual leases read after realization or validated rediscovery. */
  realizedHostingJson?: string | undefined
  /** Full immutable dispatch tuple, frozen before the first ensure call. */
  dispatchJson?: string | undefined
  /** Immutable broker acknowledgement after INSTALL -> HELLO succeeds. */
  brokerIdentityJson?: string | undefined
  /** Marks the one initial activation whose classification may release replay. */
  initialActivationConfirmedAt?: string | undefined
  /** Independent C.8 disposition for recovery of this attempt by a successor. */
  recoveryDisposition: ParticipantRecoveryDisposition
  recoveryReason?: string | undefined
  /** Durable, restart-discoverable establishment delivery state. */
  establishmentWorkState: ParticipantEstablishmentWorkState
  establishmentAttemptCount: number
  establishmentNextAttemptAt?: string | undefined
  establishmentLastError?: string | undefined
  dispositionReason?: string | undefined
  createdAt: string
  updatedAt: string
}

type ParticipantRegistrationRow = {
  registration_id: string
  class_id: string
  adapter_id: string
  join_direction: 'hrc-hosted' | 'participant-served'
  participant_key: string
  scope_ref: string
  lane_ref: string
  host_session_id: string
  generation: number
  workspace_cwd: string
  serving_socket_path: string | null
  preparation_json: string
  continuity_evidence_json: string | null
  created_at: string
  updated_at: string
}

type ParticipantAttemptRow = {
  attempt_id: string
  registration_id: string
  attach_epoch: number
  request_id: string
  operation_id: string
  invocation_id: string
  runtime_id: string
  state: ParticipantAttemptState
  prepared_profile_json: string | null
  adapter_dispatch_env_json: string | null
  hosting_intent_json: string | null
  realized_hosting_json: string | null
  dispatch_json: string | null
  broker_identity_json: string | null
  initial_activation_confirmed_at: string | null
  recovery_disposition: ParticipantRecoveryDisposition
  recovery_reason: string | null
  establishment_work_state: ParticipantEstablishmentWorkState
  establishment_attempt_count: number
  establishment_next_attempt_at: string | null
  establishment_last_error: string | null
  disposition_reason: string | null
  created_at: string
  updated_at: string
}

const REGISTRATION_COLUMNS = `
  registration_id, class_id, adapter_id, join_direction, participant_key,
  scope_ref, lane_ref, host_session_id, generation, workspace_cwd,
  serving_socket_path, preparation_json, continuity_evidence_json, created_at, updated_at`

const ATTEMPT_COLUMNS = `
  attempt_id, registration_id, attach_epoch, request_id, operation_id, invocation_id, runtime_id, state,
  prepared_profile_json, adapter_dispatch_env_json, hosting_intent_json,
  realized_hosting_json, dispatch_json, broker_identity_json, initial_activation_confirmed_at,
  recovery_disposition, recovery_reason, establishment_work_state, establishment_attempt_count,
  establishment_next_attempt_at, establishment_last_error,
  disposition_reason, created_at, updated_at`

function mapRegistration(row: ParticipantRegistrationRow): ParticipantRegistration {
  return {
    registrationId: row.registration_id,
    classId: row.class_id,
    adapterId: row.adapter_id,
    join: row.join_direction,
    participantKey: row.participant_key,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    hostSessionId: row.host_session_id,
    generation: row.generation,
    workspaceCwd: row.workspace_cwd,
    ...(row.serving_socket_path === null ? {} : { socketPath: row.serving_socket_path }),
    preparationJson: row.preparation_json,
    ...(row.continuity_evidence_json === null
      ? {}
      : { continuityEvidenceJson: row.continuity_evidence_json }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAttempt(row: ParticipantAttemptRow): ParticipantAttempt {
  return {
    attemptId: row.attempt_id,
    registrationId: row.registration_id,
    attachEpoch: row.attach_epoch,
    requestId: row.request_id,
    operationId: row.operation_id,
    invocationId: row.invocation_id,
    runtimeId: row.runtime_id,
    state: row.state,
    ...(row.prepared_profile_json === null
      ? {}
      : { preparedProfileJson: row.prepared_profile_json }),
    ...(row.adapter_dispatch_env_json === null
      ? {}
      : { adapterDispatchEnvJson: row.adapter_dispatch_env_json }),
    ...(row.hosting_intent_json === null ? {} : { hostingIntentJson: row.hosting_intent_json }),
    ...(row.realized_hosting_json === null
      ? {}
      : { realizedHostingJson: row.realized_hosting_json }),
    ...(row.dispatch_json === null ? {} : { dispatchJson: row.dispatch_json }),
    ...(row.broker_identity_json === null ? {} : { brokerIdentityJson: row.broker_identity_json }),
    ...(row.initial_activation_confirmed_at === null
      ? {}
      : { initialActivationConfirmedAt: row.initial_activation_confirmed_at }),
    recoveryDisposition: row.recovery_disposition,
    ...(row.recovery_reason === null ? {} : { recoveryReason: row.recovery_reason }),
    establishmentWorkState: row.establishment_work_state,
    establishmentAttemptCount: row.establishment_attempt_count,
    ...(row.establishment_next_attempt_at === null
      ? {}
      : { establishmentNextAttemptAt: row.establishment_next_attempt_at }),
    ...(row.establishment_last_error === null
      ? {}
      : { establishmentLastError: row.establishment_last_error }),
    ...(row.disposition_reason === null ? {} : { dispositionReason: row.disposition_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.registrationId,
      record.classId,
      record.adapterId,
      record.join,
      record.participantKey,
      record.scopeRef,
      record.laneRef,
      record.hostSessionId,
      record.generation,
      record.workspaceCwd,
      record.socketPath ?? null,
      record.preparationJson,
      record.continuityEvidenceJson ?? null,
      record.createdAt,
      record.updatedAt
    )
    return record
  }

  getRegistrationByClassAndKey(
    classId: string,
    participantKey: string
  ): ParticipantRegistration | null {
    const row = this.db
      .query<ParticipantRegistrationRow, [string, string]>(
        `SELECT ${REGISTRATION_COLUMNS} FROM participant_registrations
         WHERE class_id = ? AND participant_key = ?`
      )
      .get(classId, participantKey)
    return row === null ? null : mapRegistration(row)
  }

  getRegistrationByScopeRef(scopeRef: string): ParticipantRegistration | null {
    const row = this.db
      .query<ParticipantRegistrationRow, [string]>(
        `SELECT ${REGISTRATION_COLUMNS} FROM participant_registrations WHERE scope_ref = ?`
      )
      .get(scopeRef)
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

  countRegistrationsByClassId(classId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM participant_registrations WHERE class_id = ?'
      )
      .get(classId)
    return row?.count ?? 0
  }

  insertAttempt(record: ParticipantAttempt): ParticipantAttempt {
    execute(
      this.db,
      `INSERT INTO participant_registration_attempts (${ATTEMPT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.attemptId,
      record.registrationId,
      record.attachEpoch,
      record.requestId,
      record.operationId,
      record.invocationId,
      record.runtimeId,
      record.state,
      record.preparedProfileJson ?? null,
      record.adapterDispatchEnvJson ?? null,
      record.hostingIntentJson ?? null,
      record.realizedHostingJson ?? null,
      record.dispatchJson ?? null,
      record.brokerIdentityJson ?? null,
      record.initialActivationConfirmedAt ?? null,
      record.recoveryDisposition,
      record.recoveryReason ?? null,
      record.establishmentWorkState,
      record.establishmentAttemptCount,
      record.establishmentNextAttemptAt ?? null,
      record.establishmentLastError ?? null,
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

  listEstablishmentWork(): ParticipantAttempt[] {
    const rows = this.db
      .query<ParticipantAttemptRow, []>(
        `SELECT ${ATTEMPT_COLUMNS} FROM participant_registration_attempts
         WHERE establishment_work_state IN ('pending', 'retry_wait')
         ORDER BY COALESCE(establishment_next_attempt_at, created_at), attempt_id`
      )
      .all()
    return rows.map(mapAttempt)
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

  /**
   * Freeze one durable boundary once. A retry can observe its existing bytes,
   * but no caller may replace them under the same attempt identity.
   */
  freezePreparedBoundaryIfAbsent(
    attemptId: string,
    preparedProfileJson: string,
    /** JSON `null` represents an omitted adapter dispatch environment. */
    adapterDispatchEnvJson: string,
    updatedAt: string
  ): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registration_attempts
            SET prepared_profile_json = ?, adapter_dispatch_env_json = ?, updated_at = ?
          WHERE attempt_id = ?
            AND prepared_profile_json IS NULL
            AND adapter_dispatch_env_json IS NULL`
      )
      .run(preparedProfileJson, adapterDispatchEnvJson, updatedAt, attemptId)
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
