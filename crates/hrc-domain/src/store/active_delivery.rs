use super::json as serde_json;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
/// JSON columns keep historical/additive documents even when they predate today's typed shape.
/// Invalid JSON still fails decoding. This is data preservation, never an operation dispatcher.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum StoredDocument<T> {
    Current(T),
    Historical(Value),
}
impl<T> StoredDocument<T> {
    pub fn current(&self) -> Option<&T> {
        match self {
            Self::Current(v) => Some(v),
            Self::Historical(_) => None,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributionSessionRef {
    pub scope_ref: String,
    pub lane_ref: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributionSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<ContributionSessionRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributionFences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_host_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_generation: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_latest: Option<bool>,
    #[serde(flatten)]
    pub extra: Map,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveContributionRequest {
    pub selector: ContributionSelector,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fences: Option<ContributionFences>,
    pub input_attempt_id: String,
    pub input_application_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantics: Option<String>,
    #[serde(flatten)]
    pub extra: Map,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveContributionCapability {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_semantics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ack_semantics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordering: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_pending: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_attachments: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_interrupt_tools: Option<bool>,
    #[serde(flatten)]
    pub extra: Map,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveContributionResponse {
    pub status: String,
    pub input_application_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<ActiveContributionCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_turns: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(flatten)]
    pub extra: Map,
}
#[derive(Debug, Clone, Default)]
pub struct ActiveDeliveryContext {
    pub host_session_id: Option<String>,
    pub generation: Option<i64>,
    pub runtime_id: Option<String>,
    pub run_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInputDelivery {
    pub input_application_id: String,
    pub input_attempt_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub status: String,
    pub request: StoredDocument<ActiveContributionRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<StoredDocument<ActiveContributionResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for StoredDocument<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        match serde_json::from_value(value.clone()) {
            Ok(v) => Ok(Self::Current(v)),
            Err(_) => Ok(Self::Historical(value)),
        }
    }
}
