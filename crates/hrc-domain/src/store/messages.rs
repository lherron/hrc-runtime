use super::Patch;
use super::json as serde_json;
use serde::{Deserialize, Serialize};
use serde_json::Map;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MessageAddress {
    Entity {
        entity: String,
    },
    Session {
        #[serde(rename = "sessionRef")]
        session_ref: String,
    },
}
impl MessageAddress {
    pub fn flatten(&self) -> (&str, &str) {
        match self {
            Self::Entity { entity } => ("entity", entity),
            Self::Session { session_ref } => ("session", session_ref),
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageExecution {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coalesced_into_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coalesced_position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}
#[derive(Debug, Clone, Default)]
pub struct MessageExecutionPatch {
    pub state: Patch<String>,
    pub mode: Patch<String>,
    pub session_ref: Patch<String>,
    pub host_session_id: Patch<String>,
    pub generation: Patch<i64>,
    pub runtime_id: Patch<String>,
    pub run_id: Patch<String>,
    pub coalesced_into_run_id: Patch<String>,
    pub coalesced_position: Patch<i64>,
    pub transport: Patch<String>,
    pub error_code: Patch<String>,
    pub error_message: Patch<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub message_seq: i64,
    pub message_id: String,
    pub created_at: String,
    pub kind: String,
    pub phase: String,
    pub from: MessageAddress,
    pub to: MessageAddress,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    pub root_message_id: String,
    pub body: String,
    pub body_format: String,
    pub execution: MessageExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_json: Option<Map>,
}
#[derive(Debug, Clone)]
pub struct MessageInsert {
    pub message_id: String,
    pub kind: String,
    pub phase: String,
    pub from: MessageAddress,
    pub to: MessageAddress,
    pub body: String,
    pub reply_to_message_id: Option<String>,
    pub root_message_id: Option<String>,
    pub execution: Option<MessageExecution>,
    pub metadata_json: Option<Map>,
}
#[derive(Debug, Clone, Default)]
pub struct MessageFilter {
    pub message_id: Option<String>,
    pub from: Option<MessageAddress>,
    pub to: Option<MessageAddress>,
    pub participant: Option<MessageAddress>,
    pub root_message_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub host_session_id: Option<String>,
    pub run_id: Option<String>,
    pub generation: Option<i64>,
    pub after_seq: Option<i64>,
    pub kinds: Vec<String>,
    pub phases: Vec<String>,
    pub limit: Option<usize>,
    pub descending: bool,
}
