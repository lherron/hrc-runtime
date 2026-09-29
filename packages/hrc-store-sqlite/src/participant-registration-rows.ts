import type {
  ParticipantActivationClassification,
  ParticipantAddressPolicy,
  ParticipantAttempt,
  ParticipantAttemptState,
  ParticipantContinuationReason,
  ParticipantContinuityPolicy,
  ParticipantEstablishmentWorkState,
  ParticipantLifecycleOwner,
  ParticipantRecoveryDisposition,
  ParticipantRegistration,
  ParticipantRegistrationMode,
  ParticipantRegistrationPolicy,
  ParticipantReplaySemantics,
  ParticipantResumeState,
} from './participant-registration-types.js'

export type ParticipantRegistrationRow = {
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

export type ParticipantAttemptRow = {
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

export const REGISTRATION_COLUMNS = `
  registration_id, registration_mode, class_id, adapter_id, join_direction, participant_key,
  scope_ref, lane_ref, host_session_id, generation, workspace_cwd,
  serving_socket_path, preparation_json, continuity_evidence_json,
  address_policy, continuity_policy, lifecycle_owner, replay_semantics,
  host_incarnation_id, created_at, updated_at`

export const ATTEMPT_COLUMNS = `
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
export const NON_RUNNABLE_ATTEMPT_PREDICATE = `
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
    attempt.preparedDescriptorJson === undefined &&
    attempt.replacementIntentJson === undefined
  )
}

export function mapRegistration(row: ParticipantRegistrationRow): ParticipantRegistration {
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

export function mapAttempt(row: ParticipantAttemptRow): ParticipantAttempt {
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
      : { preparedDescriptorJson: row.prepared_profile_json }),
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
