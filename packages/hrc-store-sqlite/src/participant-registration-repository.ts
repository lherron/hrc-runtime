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
export type ParticipantActivationClassification =
  | 'attached'
  | 'replacement'
  | 'resume'
  | 'attached_unknown'

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

/**
 * How this registration came to exist. `legacy` is the key-scoped request
 * shape that predates protocol join and keeps every one of its identity
 * columns; `direct` is a participant declaring its own address (R7.1).
 */
export type ParticipantRegistrationMode = 'legacy' | 'direct'

export type ParticipantAddressPolicy = 'permanent-keyed' | 'selected-scope'
export type ParticipantContinuityPolicy = 'key-scoped' | 'host-incarnation'
export type ParticipantLifecycleOwner = 'hrc-managed' | 'externally-owned'
export type ParticipantReplaySemantics = 'none' | 'full-source-replay'

/**
 * The resolved policy a direct join answers for itself.
 *
 * R7.1 stores it on the registration so a direct lookup never needs a class or
 * an adapter to say what an address is. A legacy registration leaves it absent:
 * its class is still the authority, and no such value was ever recorded for it.
 */
export type ParticipantRegistrationPolicy = {
  addressPolicy: ParticipantAddressPolicy
  continuityPolicy: ParticipantContinuityPolicy
  lifecycleOwner: ParticipantLifecycleOwner
  replaySemantics: ParticipantReplaySemantics
}

export type ParticipantRegistration = {
  registrationId: string
  registrationMode: ParticipantRegistrationMode
  /**
   * Every optional field below is optional because a direct join may genuinely
   * have no value for it. R7.1 forbids a fabricated adapter, an empty
   * workspace or a pretend preparation, so absent stays absent through the
   * repository, the API and post-join preparation. A legacy row still has all
   * five, and the database CHECK keeps it that way.
   */
  classId?: string | undefined
  adapterId?: string | undefined
  join: 'hrc-hosted' | 'participant-served'
  participantKey?: string | undefined
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  workspaceCwd?: string | undefined
  /** Participant-owned broker endpoint; absent for HRC-hosted participants. */
  socketPath?: string | undefined
  /** Opaque, JSON-serialized adapter admission output. */
  preparationJson?: string | undefined
  /** Opaque, JSON-serialized continuity evidence, when the adapter supplied it. */
  continuityEvidenceJson?: string | undefined
  /** Present exactly when `registrationMode` is `direct`. */
  policy?: ParticipantRegistrationPolicy | undefined
  /**
   * The participant's declared current host identity. HRC records the
   * declaration; it never certifies it, parses a PID out of it, or asks
   * another component to vouch for it (R6.1).
   */
  hostIncarnationId?: string | undefined
  createdAt: string
  updatedAt: string
}

/** R7.3: why HRC's continuation selection came out the way it did. */
export type ParticipantContinuationReason =
  | 'carried'
  | 'no_continuation'
  | 'continuation_invalidated'
  | 'reuse_disabled'

/**
 * R7.3: what the driver was asked for and what it said, never a claim that
 * native model context was actually restored.
 */
export type ParticipantResumeState = 'not_requested' | 'requested' | 'unsupported' | 'indeterminate'

export type ParticipantContinuationSelection = {
  carried: boolean
  reason: ParticipantContinuationReason
  /** The HRC continuation object carried into this attempt, when one was. */
  selectedJson?: string | undefined
}

export type ParticipantAttempt = {
  attemptId: string
  registrationId: string
  attachEpoch: number
  requestId: string
  operationId: string
  invocationId: string
  runtimeId: string
  /**
   * The host binding this attempt serves. NULL for a legacy key-scoped
   * attempt, which therefore owns its runtime exclusively; attempts that share
   * a runtime must share this binding (R6.5, enforced by trigger).
   */
  hostBindingId?: string | undefined
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
  /** Opaque admission evidence for this exact attempt. */
  continuityEvidenceJson?: string | undefined
  /** Classification frozen when this attempt identity is allocated. */
  activationClassification?: ParticipantActivationClassification | undefined
  /** Exact validated producer receipt for the prior writer. */
  writerEvidenceJson?: string | undefined
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
  /** The participant-served broker endpoint this exact attempt attached on. */
  attachSocketPath?: string | undefined
  /** HRC's own continuation decision, frozen with this attempt's identity. */
  continuation?: ParticipantContinuationSelection | undefined
  resumeState?: ParticipantResumeState | undefined
  resumeReason?: string | undefined
  /** Durable replacement request carried on the existing attempt row. */
  replacementIntentJson?: string | undefined
  dispositionReason?: string | undefined
  createdAt: string
  updatedAt: string
}

type ParticipantRegistrationRow = {
  registration_id: string
  registration_mode: ParticipantRegistrationMode
  class_id: string | null
  adapter_id: string | null
  join_direction: 'hrc-hosted' | 'participant-served'
  participant_key: string | null
  scope_ref: string
  lane_ref: string
  host_session_id: string
  generation: number
  workspace_cwd: string | null
  serving_socket_path: string | null
  preparation_json: string | null
  continuity_evidence_json: string | null
  address_policy: ParticipantAddressPolicy | null
  continuity_policy: ParticipantContinuityPolicy | null
  lifecycle_owner: ParticipantLifecycleOwner | null
  replay_semantics: ParticipantReplaySemantics | null
  host_incarnation_id: string | null
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
  host_binding_id: string | null
  state: ParticipantAttemptState
  prepared_profile_json: string | null
  adapter_dispatch_env_json: string | null
  hosting_intent_json: string | null
  realized_hosting_json: string | null
  dispatch_json: string | null
  broker_identity_json: string | null
  continuity_evidence_json: string | null
  activation_classification: ParticipantActivationClassification | null
  writer_evidence_json: string | null
  initial_activation_confirmed_at: string | null
  recovery_disposition: ParticipantRecoveryDisposition
  recovery_reason: string | null
  establishment_work_state: ParticipantEstablishmentWorkState
  establishment_attempt_count: number
  establishment_next_attempt_at: string | null
  establishment_last_error: string | null
  attach_socket_path: string | null
  continuation_carried: number | null
  continuation_reason: ParticipantContinuationReason | null
  continuation_selected_json: string | null
  continuation_resume_state: ParticipantResumeState | null
  continuation_resume_reason: string | null
  replacement_intent_json: string | null
  disposition_reason: string | null
  created_at: string
  updated_at: string
}

const REGISTRATION_COLUMNS = `
  registration_id, registration_mode, class_id, adapter_id, join_direction, participant_key,
  scope_ref, lane_ref, host_session_id, generation, workspace_cwd,
  serving_socket_path, preparation_json, continuity_evidence_json,
  address_policy, continuity_policy, lifecycle_owner, replay_semantics,
  host_incarnation_id, created_at, updated_at`

const ATTEMPT_COLUMNS = `
  attempt_id, registration_id, attach_epoch, request_id, operation_id, invocation_id, runtime_id,
  host_binding_id, state,
  prepared_profile_json, adapter_dispatch_env_json, hosting_intent_json,
  realized_hosting_json, dispatch_json, broker_identity_json, initial_activation_confirmed_at,
  continuity_evidence_json, activation_classification, writer_evidence_json,
  recovery_disposition, recovery_reason, establishment_work_state, establishment_attempt_count,
  establishment_next_attempt_at, establishment_last_error, attach_socket_path,
  continuation_carried, continuation_reason, continuation_selected_json,
  continuation_resume_state, continuation_resume_reason, replacement_intent_json,
  disposition_reason, created_at, updated_at`

/**
 * R7.2's non-runnable establishment work, in SQL. Kept beside the column lists
 * so the enumeration query and `isNonRunnableEstablishmentAttempt` below stay
 * two spellings of one rule rather than two rules.
 */
const NON_RUNNABLE_ATTEMPT_PREDICATE = `
  state = 'IDENTITY_MINTED'
  AND prepared_profile_json IS NULL
  AND replacement_intent_json IS NULL`

/**
 * The same predicate for a row already in hand. The worker re-applies it
 * immediately before effects, because enumeration and execution are separated
 * by time in which an attempt can stop being runnable.
 */
export function isNonRunnableEstablishmentAttempt(attempt: ParticipantAttempt): boolean {
  return (
    attempt.state === 'IDENTITY_MINTED' &&
    attempt.preparedProfileJson === undefined &&
    attempt.replacementIntentJson === undefined
  )
}

function mapRegistration(row: ParticipantRegistrationRow): ParticipantRegistration {
  // The four policy columns are written together or not at all (the CHECK on
  // registration_mode = 'direct' enforces it), so one non-null value is enough
  // to know the whole record is there.
  const policy: ParticipantRegistrationPolicy | null =
    row.address_policy === null ||
    row.continuity_policy === null ||
    row.lifecycle_owner === null ||
    row.replay_semantics === null
      ? null
      : {
          addressPolicy: row.address_policy,
          continuityPolicy: row.continuity_policy,
          lifecycleOwner: row.lifecycle_owner,
          replaySemantics: row.replay_semantics,
        }
  return {
    registrationId: row.registration_id,
    registrationMode: row.registration_mode,
    ...(row.class_id === null ? {} : { classId: row.class_id }),
    ...(row.adapter_id === null ? {} : { adapterId: row.adapter_id }),
    join: row.join_direction,
    ...(row.participant_key === null ? {} : { participantKey: row.participant_key }),
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    hostSessionId: row.host_session_id,
    generation: row.generation,
    ...(row.workspace_cwd === null ? {} : { workspaceCwd: row.workspace_cwd }),
    ...(row.serving_socket_path === null ? {} : { socketPath: row.serving_socket_path }),
    ...(row.preparation_json === null ? {} : { preparationJson: row.preparation_json }),
    ...(row.continuity_evidence_json === null
      ? {}
      : { continuityEvidenceJson: row.continuity_evidence_json }),
    ...(policy === null ? {} : { policy }),
    ...(row.host_incarnation_id === null ? {} : { hostIncarnationId: row.host_incarnation_id }),
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
    ...(row.host_binding_id === null ? {} : { hostBindingId: row.host_binding_id }),
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
    ...(row.continuity_evidence_json === null
      ? {}
      : { continuityEvidenceJson: row.continuity_evidence_json }),
    ...(row.activation_classification === null
      ? {}
      : { activationClassification: row.activation_classification }),
    ...(row.writer_evidence_json === null ? {} : { writerEvidenceJson: row.writer_evidence_json }),
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
    ...(row.attach_socket_path === null ? {} : { attachSocketPath: row.attach_socket_path }),
    ...(row.continuation_carried === null || row.continuation_reason === null
      ? {}
      : {
          continuation: {
            carried: row.continuation_carried === 1,
            reason: row.continuation_reason,
            ...(row.continuation_selected_json === null
              ? {}
              : { selectedJson: row.continuation_selected_json }),
          },
        }),
    ...(row.continuation_resume_state === null
      ? {}
      : { resumeState: row.continuation_resume_state }),
    ...(row.continuation_resume_reason === null
      ? {}
      : { resumeReason: row.continuation_resume_reason }),
    ...(row.replacement_intent_json === null
      ? {}
      : { replacementIntentJson: row.replacement_intent_json }),
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.registrationId,
      record.registrationMode,
      record.classId ?? null,
      record.adapterId ?? null,
      record.join,
      record.participantKey ?? null,
      record.scopeRef,
      record.laneRef,
      record.hostSessionId,
      record.generation,
      record.workspaceCwd ?? null,
      record.socketPath ?? null,
      record.preparationJson ?? null,
      record.continuityEvidenceJson ?? null,
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
         WHERE registration_mode = 'direct' AND scope_ref = ? AND host_incarnation_id = ?`
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.attemptId,
      record.registrationId,
      record.attachEpoch,
      record.requestId,
      record.operationId,
      record.invocationId,
      record.runtimeId,
      record.hostBindingId ?? null,
      record.state,
      record.preparedProfileJson ?? null,
      record.adapterDispatchEnvJson ?? null,
      record.hostingIntentJson ?? null,
      record.realizedHostingJson ?? null,
      record.dispatchJson ?? null,
      record.brokerIdentityJson ?? null,
      record.initialActivationConfirmedAt ?? null,
      record.continuityEvidenceJson ?? null,
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

  /**
   * Successor allocation refreshes only the adapter-supplied boundary. It
   * deliberately cannot touch `continuity_evidence_json`: that column is the
   * last ACTIVATED known evidence, and an allocated attempt has not activated.
   * The attempt's own column carries the candidate until then.
   */
  updateRegistrationForSuccessor(input: {
    registrationId: string
    workspaceCwd?: string | undefined
    socketPath?: string | undefined
    preparationJson?: string | undefined
    updatedAt: string
  }): boolean {
    // COALESCE, not assignment: with adapter admission gone these three arrive
    // from the request or not at all, and a successor request that omits one
    // must leave the stored value alone rather than blank it.
    const result = this.db
      .query(
        `UPDATE participant_registrations
            SET workspace_cwd = COALESCE(?, workspace_cwd),
                serving_socket_path = COALESCE(?, serving_socket_path),
                preparation_json = COALESCE(?, preparation_json),
                updated_at = ?
          WHERE registration_id = ?`
      )
      .run(
        input.workspaceCwd ?? null,
        input.socketPath ?? null,
        input.preparationJson ?? null,
        input.updatedAt,
        input.registrationId
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
   * Advances the retained known continuity evidence. Only the initial-activation
   * transaction may call this, so an unactivated candidate never replaces the
   * baseline that a later attempt is classified against.
   */
  acceptContinuityEvidence(input: {
    registrationId: string
    continuityEvidenceJson: string
    updatedAt: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_registrations
            SET continuity_evidence_json = ?, updated_at = ?
          WHERE registration_id = ?`
      )
      .run(input.continuityEvidenceJson, input.updatedAt, input.registrationId)
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
   * budget" true: it requires the profile columns to still be NULL, so a
   * retry against an already-prepared attempt changes zero rows and cannot
   * reach the `establishment_attempt_count = 0` this statement performs. The
   * epoch is rechecked in the same predicate, so a stale attach never lands.
   */
  attachPreparedProfile(input: {
    attemptId: string
    attachEpoch: number
    preparedProfileJson: string
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
        input.preparedProfileJson,
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
