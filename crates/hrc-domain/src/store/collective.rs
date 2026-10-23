use super::MessageRecord;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectiveObservationInput {
    pub source_node_id: String,
    pub source_role: String,
    pub origin_node_id: String,
    pub accepted_destination_node_id: Option<String>,
    pub observed_at: Option<String>,
    pub record: MessageRecord,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectiveReplicationRecord {
    pub message_id: String,
    pub source_node_id: String,
    pub source_message_seq: i64,
    pub source_role: String,
    pub origin_node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_destination_node_id: Option<String>,
    pub record: MessageRecord,
    pub fingerprint: String,
    pub total_attempts: i64,
    pub next_attempt_at: String,
}
#[derive(Debug, Clone)]
pub struct CollectiveReplicationRetry {
    pub message_id: String,
    pub fingerprint: String,
    pub now: String,
    pub next_attempt_at: String,
    pub error_code: String,
    pub error_message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MessageDeliveryEvidence {
    RuntimeDelivery { observed_at: String },
    StoreOnly { reason: String, observed_at: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectiveHistoryObservation {
    pub node_id: String,
    pub message_seq: i64,
    pub role: String,
    pub observed_at: String,
    pub origin_node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_destination_node_id: Option<String>,
    pub execution: super::MessageExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<MessageDeliveryEvidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectiveHistoryEvidence {
    pub authority_node_id: String,
    pub observations: Vec<CollectiveHistoryObservation>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectiveMessageRecord {
    #[serde(flatten)]
    pub record: MessageRecord,
    pub collective_seq: i64,
    pub collective_history: CollectiveHistoryEvidence,
}
