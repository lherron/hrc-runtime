use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantRegistration {
    pub registration_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_id: Option<String>,
    pub join: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_key: Option<String>,
    pub scope_ref: String,
    pub lane_ref: String,
    pub host_session_id: String,
    pub generation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_incarnation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<ParticipantRegistrationPolicy>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantAttempt {
    pub attempt_id: String,
    pub registration_id: String,
    pub attach_epoch: i64,
    pub request_id: String,
    pub operation_id: String,
    pub invocation_id: String,
    pub runtime_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_binding_id: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_descriptor_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_dispatch_env_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosting_intent_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realized_hosting_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatch_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broker_identity_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_activation_confirmed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writer_evidence_json: Option<String>,
    pub recovery_disposition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_reason: Option<String>,
    pub establishment_work_state: String,
    pub establishment_attempt_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub establishment_next_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub establishment_last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_socket_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_intent_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disposition_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<ParticipantContinuationSelection>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantRegistrationPolicy {
    pub address_policy: String,
    pub continuity_policy: String,
    pub lifecycle_owner: String,
    pub replay_semantics: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantContinuationSelection {
    pub carried: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_json: Option<String>,
}
pub type ParticipantReservation = super::rows::ParticipantAddressReservationsRow;
pub type ParticipantBinding = super::rows::ParticipantHostBindingsRow;
#[derive(Debug, Clone, Copy)]
pub enum ParticipantSnapshot {
    HostingIntent,
    RealizedHosting,
    Dispatch,
    BrokerIdentity,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReplacementIntentResult {
    Stored,
    Same,
    Conflict,
}
#[derive(Debug, Clone)]
pub struct ParticipantBindingTransition {
    pub binding_id: String,
    pub from: Vec<String>,
    pub to: String,
    pub now: String,
    pub retirement_receipt_json: Option<String>,
    pub disposition_reason: Option<String>,
}
#[derive(Debug, Clone)]
pub struct CancelParticipantReplacement {
    pub attempt_id: String,
    pub attach_epoch: i64,
    pub expected_intent_json: String,
    pub establishment_work_state: String,
    pub establishment_attempt_count: i64,
    pub establishment_next_attempt_at: Option<String>,
    pub establishment_last_error: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct ParticipantHostSuccessor {
    pub registration_id: String,
    pub expected_host_session_id: String,
    pub host_session_id: String,
    pub generation: i64,
    pub host_incarnation_id: String,
    pub workspace_cwd: Option<String>,
    pub socket_path: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct ParticipantBridgeSuccessor {
    pub registration_id: String,
    pub expected_host_session_id: String,
    pub expected_host_incarnation_id: String,
    pub workspace_cwd: Option<String>,
    pub socket_path: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct PrepareParticipantDescriptor {
    pub attempt_id: String,
    pub attach_epoch: i64,
    pub prepared_descriptor_json: String,
    pub adapter_dispatch_env_json: String,
    pub attach_socket_path: Option<String>,
    pub resume_state: Option<String>,
    pub resume_reason: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct ParticipantEstablishmentFailure {
    pub attempt_id: String,
    pub attach_epoch: i64,
    pub failed_at: String,
    pub next_attempt_at: String,
    pub error: String,
    pub max_attempts: i64,
}
