use self::json as serde_json;
// Shared persistence contracts. No SQLite or owner transport is required.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A patch distinguishes an absent update, an explicit SQL NULL, and a value.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Patch<T> {
    #[default]
    Unchanged,
    Clear,
    Set(T),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub kind: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleFields {
    pub ts: String,
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_session_key: Option<String>,
    pub category: String,
    pub event_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default)]
    pub replayed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEvent {
    pub hrc_seq: i64,
    pub stream_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_seq: Option<i64>,
    #[serde(flatten)]
    pub fields: LifecycleFields,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<SessionIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecyclePage {
    pub ledger_incarnation_id: String,
    pub head: i64,
    pub rows: Vec<LifecycleEvent>,
    pub scanned_through: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleTail {
    pub ledger_incarnation_id: String,
    pub head_hrc_seq: i64,
    pub events: Vec<LifecycleEvent>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct LifecycleFilters {
    /// None: no predicate, Some(None): local, Some(Some(ref)): imported source.
    pub source_ref: Option<Option<String>>,
    pub host_session_id: Option<String>,
    pub generation: Option<i64>,
    pub scope_ref: Option<String>,
    pub lane_ref: Option<String>,
    pub runtime_id: Option<String>,
    pub run_id: Option<String>,
    pub launch_id: Option<String>,
    pub event_kind: Option<String>,
    pub category: Option<String>,
    pub from_hrc_seq: Option<i64>,
    pub from_stream_seq: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommittedChange {
    Lifecycle { event: Box<LifecycleEvent> },
    Message { message_id: String },
    Runtime { runtime_id: String },
}

/// SQL row types, separate from wire records and patches.
pub mod rows;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlobKind {
    BrokerRaw,
    LifecycleCanonical,
}
impl BlobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BrokerRaw => "broker_raw",
            Self::LifecycleCanonical => "lifecycle_canonical",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultBlob {
    pub rowid: i64,
    pub blob_id: String,
    pub runtime_id: String,
    pub kind: BlobKind,
    pub bytes: i64,
    pub complete: bool,
    pub result_json: String,
    pub created_at: String,
}
#[derive(Debug, Clone)]
pub struct BlobPart {
    pub blob_id: String,
    pub runtime_id: String,
    pub kind: BlobKind,
    pub bytes: i64,
    pub part: i64,
    pub parts: i64,
    pub chunk: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct BlobPartOutcome {
    pub completed: bool,
    pub duplicate: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpillDescriptor {
    pub blob_id: String,
    pub bytes: i64,
    pub kind: BlobKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_host_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied_intent_json: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<SessionIdentity>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityRecord {
    pub session_ref: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub identity: SessionIdentity,
    pub active_host_session_id: String,
    pub updated_at: String,
    pub prior_host_session_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetadataSource {
    Api,
    Launch,
    Hrc,
}
impl MetadataSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::Launch => "launch",
            Self::Hrc => "hrc",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataShadow {
    pub source: MetadataSource,
    pub value: Value,
    pub updated_by: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataProvenance {
    pub source: MetadataSource,
    pub updated_by: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub shadowed: Vec<MetadataShadow>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataResponse {
    pub metadata: Value,
    pub metadata_sources: std::collections::BTreeMap<String, MetadataProvenance>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetadataRejection {
    pub key: JsString,
    pub reason: String,
}
#[derive(Debug, Clone)]
pub struct MetadataWrite {
    pub scope_ref: String,
    pub lane_ref: String,
    pub source: MetadataSource,
    pub set: Value,
    pub clear: Vec<String>,
    pub replace: bool,
    pub updated_by: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataWriteResult {
    #[serde(flatten)]
    pub resolved: MetadataResponse,
    pub rejected: Vec<MetadataRejection>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitle {
    pub host_session_id: String,
    pub title: String,
    pub source: String,
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// These records' stored fields have the same scalar/null semantics as Bun's domain records.
pub use rows::{
    FederationAcceptedRequestsRow as FederationAcceptedRequest,
    FederationPeerAcceptancesRow as FederationPeerAcceptance, LocalBridgesRow as LocalBridge,
    PermissionDecisionsRow as PermissionDecision, RosterClaimsRow as RosterClaim,
    RuntimeArtifactsRow as RuntimeArtifact, RuntimeBuffersRow as RuntimeBuffer,
    SurfaceBindingsRow as SurfaceBinding,
};
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecordOutcome {
    Recorded,
    Duplicate,
}
#[derive(Debug, Clone, Serialize)]
pub struct Recorded<T> {
    pub outcome: RecordOutcome,
    pub record: T,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetainedOutcome {
    pub outcome_id: i64,
    pub runtime_id: String,
    pub invocation_id: String,
    pub recorded_at: String,
    pub outcome: String,
    pub outcome_class: String,
    pub trigger: String,
    pub attempts: i64,
    pub detail: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurn {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_rowid: Option<i64>,
    pub invocation_id: String,
    pub runtime_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<i64>,
    pub seq_from: i64,
    pub seq_to: i64,
    pub started_at: String,
    pub completed_at: String,
    pub terminal_status: String,
    pub message_count: i64,
    pub truncated: bool,
    pub user_text: String,
    pub final_text: String,
    pub mid_text: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchHit {
    #[serde(flatten)]
    pub turn: TranscriptTurn,
    pub score: f64,
    pub snippet: String,
    pub scope_generation_count: i64,
}
#[derive(Debug, Clone, Default)]
pub struct TranscriptSearchFilters {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub task: Option<String>,
    pub scope_ref: Option<String>,
    pub runtime_id: Option<String>,
    pub invocation_id: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}
#[derive(Debug, Clone)]
pub struct TranscriptSearchOptions {
    pub limit: usize,
    pub per_runtime_cap: Option<usize>,
    pub weights: [f64; 3],
}
impl Default for TranscriptSearchOptions {
    fn default() -> Self {
        Self {
            limit: 100,
            per_runtime_cap: None,
            weights: [1.0; 3],
        }
    }
}
pub use rows::TranscriptIndexInvocationsRow as TranscriptInvocationMark;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStats {
    pub turns_indexed: i64,
    pub last_event_id: i64,
}

mod execution;
pub use execution::*;
#[derive(Debug, Clone, Default)]
pub struct RunFilters {
    pub run_id: Option<String>,
    pub host_session_id: Option<String>,
    pub generation: Option<i64>,
    pub runtime_id: Option<String>,
    pub scope_ref: Option<String>,
    pub lane_ref: Option<String>,
    pub statuses: Vec<String>,
    pub limit: Option<usize>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSeatRef {
    pub scope_ref: String,
    pub lane_ref: String,
    pub runtime_id: String,
    pub host_session_id: String,
}
#[derive(Debug, Clone, Default)]
pub struct RunWriter {
    pub runtime_id: Option<String>,
    pub operation_id: Option<String>,
    pub host_session_id: String,
    pub generation: i64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunReservationOutcome {
    Reserved,
    Exists,
    ReservedByOther,
}

pub use rows::{InputsRow as InputRecord, SubmissionAdmissionsRow as SubmissionAdmission};
#[derive(Debug, Clone)]
pub struct InputLanding {
    pub input_id: String,
    pub kind: String,
    pub carrier_run_id: String,
    pub turn_id: String,
    pub run_started_hrc_seq: i64,
    pub landed_at: String,
}
#[derive(Debug, Clone)]
pub struct InputTerminal {
    pub input_id: String,
    pub terminal: String,
    pub terminal_at: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}
#[derive(Debug, Clone)]
pub struct InputCorrelation {
    pub input_id: String,
    pub fact: String,
    pub observed_at: String,
}

pub use rows::{
    CompiledRuntimePlansRow as CompiledRuntimePlan, LifecyclePoliciesRow as LifecyclePolicy,
};

pub type BrokerEvent = rows::BrokerInvocationEventsRow;
pub type ProjectionDisposition = rows::BrokerProjectionDispositionsRow;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerEventAppend {
    pub invocation_id: String,
    pub seq: i64,
    pub time: String,
    pub r#type: String,
    pub runtime_id: String,
    pub run_id: Option<String>,
    pub harness_generation: Option<i64>,
    pub turn_attempt: Option<i64>,
    pub payload: serde_json::Value,
    pub envelope_json: Option<String>,
    pub hrc_event_seq: Option<i64>,
    pub projection_status: Option<String>,
    pub projection_error: Option<String>,
    pub evidence_origin: Option<String>,
}
#[derive(Debug, Clone, Default)]
pub struct BrokerEventTypesQuery {
    pub invocation_id: String,
    pub types: Vec<String>,
    pub through_seq: Option<i64>,
    pub runtime_id: Option<String>,
    pub turn_id: Option<String>,
    pub require_turn_id: bool,
    pub limit: Option<usize>,
}
#[derive(Debug, Clone, Default)]
pub struct BrokerProjectionPatch {
    pub hrc_event_seq: Patch<i64>,
    pub projection_status: Patch<String>,
    pub projection_error: Patch<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerSubmissionDisposition {
    pub r#type: String,
    pub turn_id: Option<String>,
    pub reason: Option<String>,
}

pub type FirstTurnWatch = rows::RuntimeFirstTurnWatchRow;
#[derive(Debug, Clone)]
pub struct ArmFirstTurnWatch {
    pub runtime_id: String,
    pub generation: i64,
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub run_id: Option<String>,
    pub invocation_id: Option<String>,
    pub transport: Option<String>,
    pub priming_dispatched_at: String,
    pub first_turn_deadline_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SteerContribution {
    pub contribution_id: String,
    pub host_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub runtime_id: String,
    pub invocation_id: String,
    pub active_run_id: String,
    pub input_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct AttemptContribution {
    pub contribution_id: String,
    pub host_session_id: String,
    pub idempotency_key: Option<String>,
    pub runtime_id: String,
    pub invocation_id: String,
    pub active_run_id: String,
    pub input_id: String,
    pub now: String,
}
#[derive(Debug, Clone, Copy)]
pub enum ContributionTerminal {
    Admitted,
    Presented,
    StartedFresh,
    QueuedFallback,
    Unsupported,
    RaceLost,
    Ambiguous,
}
impl ContributionTerminal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Presented => "presented",
            Self::StartedFresh => "started_fresh",
            Self::QueuedFallback => "queued_fallback",
            Self::Unsupported => "unsupported",
            Self::RaceLost => "race_lost",
            Self::Ambiguous => "ambiguous",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRegistrationGrant {
    pub registration_id: String,
    pub class_id: String,
    pub derived_scope: String,
    pub socket_path: String,
    pub credential_hash: String,
    pub expires_at: String,
    pub consumed: bool,
    pub turns_allowed: bool,
    pub provisioner: serde_json::Map,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_token_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub establishment_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Map>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_info: Option<serde_json::Map>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub established_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retirement_reason: Option<String>,
}
#[derive(Debug, Clone)]
pub struct ExternalRegistrationMint {
    pub host_session_id: String,
    pub runtime_id: String,
    pub operation_id: String,
    pub invocation_id: String,
    pub attach_token_ref: String,
    pub controller_instance_id: String,
    pub capabilities: serde_json::Map,
    pub participant_info: serde_json::Map,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome")]
pub enum IssueGrantOutcome {
    #[serde(rename = "issued")]
    Issued {
        grant: Box<ExternalRegistrationGrant>,
    },
    #[serde(rename = "instances-exhausted")]
    InstancesExhausted { occupied: i64 },
}

mod participant;
pub use participant::*;
mod messages;
pub use messages::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskBracket {
    pub run_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub harness_generation: Option<i64>,
    pub turn_attempt: Option<i64>,
    pub seq: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedBrokerInput {
    pub seq: i64,
    pub input_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FencedBrokerInput {
    pub seq: i64,
    pub input_id: Option<String>,
    pub run_id: String,
}
#[derive(Debug, Clone)]
pub struct FailAcceptedCarrier {
    pub run_id: String,
    pub runtime_id: String,
    pub invocation_id: String,
    pub dispatched_input_id: String,
    pub broker_submission_id: String,
    pub at: String,
    pub error_code: String,
    pub error_message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightRun {
    pub run_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub status: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEventFields {
    pub ts: String,
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    pub source: String,
    pub event_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_json: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEvent {
    pub seq: i64,
    pub stream_seq: Option<i64>,
    #[serde(flatten)]
    pub fields: LegacyEventFields,
}
#[derive(Debug, Clone, Default)]
pub struct LegacyEventFilters {
    pub host_session_id: Option<String>,
    pub generation: Option<i64>,
    pub runtime_id: Option<String>,
    pub run_id: Option<String>,
    pub from_seq: Option<i64>,
    pub limit: Option<usize>,
}
#[derive(Debug, Clone, Default)]
pub struct LifecycleMonitorFilters {
    pub base: LifecycleFilters,
    pub scope_refs: Vec<String>,
    pub scope_ref_prefixes: Vec<String>,
    pub task_ids: Vec<String>,
    pub exact_task_ids: Vec<String>,
    pub event_kinds: Vec<String>,
    pub tool_names: Vec<String>,
    pub payload_contains: Option<String>,
    pub milestone: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RuntimePruneCounts {
    pub broker_invocation_events: i64,
    pub hrc_events: i64,
    pub broker_invocations: i64,
    pub runtime_operations: i64,
    pub runtime_first_turn_watch: i64,
    pub runtime_artifacts: i64,
    pub tool_result_blob_parts: i64,
    pub tool_result_blobs: i64,
    pub compiled_runtime_plans: i64,
    pub events: i64,
    pub runtime_buffers: i64,
    pub surface_bindings: i64,
    pub local_bridges: i64,
    pub runs: i64,
    pub runtimes: i64,
}
mod active_delivery;
pub use active_delivery::*;
mod placement;
pub use placement::*;
mod session_index;
pub use session_index::*;

pub mod json;
pub use json::{JsString, JsValue};
mod mail;
pub use mail::*;
mod collective;
pub use collective::*;
mod outbox;
pub use outbox::*;

/// Explicit bridge to the existing API-fed page. Refuses opaque strings that
/// serde_json::Value cannot represent; it never substitutes Unicode replacement.
impl TryFrom<LifecyclePage> for crate::api::EventPage {
    type Error = ::serde_json::Error;
    fn try_from(page: LifecyclePage) -> Result<Self, Self::Error> {
        let rows = page
            .rows
            .iter()
            .map(|event| json::to_value(event)?.try_serde_value())
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            ledger_incarnation_id: page.ledger_incarnation_id,
            head: page.head,
            rows,
            scanned_through: page.scanned_through,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContinuationHistoryRepair {
    pub sessions: i64,
}

mod legacy_mail;
pub use legacy_mail::*;
