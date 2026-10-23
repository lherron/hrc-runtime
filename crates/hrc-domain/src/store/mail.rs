//! Typed delivery accounting, separate from execution and the external obligation ledger.
pub use super::rows::{
    HrcmailBirthRefusalsRow as MailBirthRefusal, HrcmailFailureNoticesRow as MailFailureNotice,
    HrcmailStopRefusalsRow as MailStopRefusal,
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailStopEnvelopeSummary {
    pub envelope_id: String,
    pub from: String,
    pub room_key: String,
    pub body: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "decision",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MailStopDecision {
    Allow {
        reason: MailStopAllowReason,
        unacked_count: usize,
        refusal_count: i64,
        total_refusal_count: i64,
        envelopes: Vec<MailStopEnvelopeSummary>,
    },
    Block {
        unacked_count: usize,
        refusal_count: i64,
        total_refusal_count: i64,
        envelopes: Vec<MailStopEnvelopeSummary>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailStopAllowReason {
    Clear,
    RefusalCap,
    HardCap,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MailHintDecision {
    Suppressed {
        reason: MailHintSuppression,
    },
    Issued {
        reason: MailHintIssue,
        outstanding_count: i64,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailHintSuppression {
    NoOutstandingMail,
    Cadence,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailHintIssue {
    First,
    CountChanged,
    Periodic,
}
pub use super::rows::{
    HrcmailDeliveryIntentsRow as MailDeliveryIntent, HrcmailPresentationsRow as MailPresentation,
};
#[derive(Debug, Clone, Default)]
pub struct OpenMailIntent {
    pub envelope_id: String,
    pub target_session_ref: String,
    pub door: String,
    pub form: String,
    pub presentation_id: String,
    pub runtime_id: Option<String>,
    pub host_session_id: Option<String>,
    pub generation: Option<i64>,
    pub delivery_outcome: Option<String>,
    pub invocation_id: Option<String>,
    pub broker_after_seq: Option<i64>,
    pub submitted_hrc_seq: i64,
}
#[derive(Debug, Clone, Default)]
pub struct MailAdmissionPatch {
    pub door: Option<String>,
    pub submission_id: Option<String>,
    pub runtime_id: Option<String>,
    pub host_session_id: Option<String>,
    pub generation: Option<i64>,
    pub delivery_outcome: Option<String>,
}
#[derive(Debug, Clone)]
pub struct RecordMailPresentation {
    pub envelope_id: String,
    pub runtime_id: String,
    pub target_session_ref: String,
    pub generation: Option<i64>,
    pub presentation_id: String,
    pub input_id: Option<String>,
    pub delivery_outcome: String,
    pub landing_hrc_seq: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct MailPresentationOutcome {
    pub recorded: bool,
    pub presentation: MailPresentation,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailRuntimeBoundTarget {
    pub target_session_ref: String,
    pub runtime_id: String,
}
