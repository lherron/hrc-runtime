//! Current frozen embedded-mail storage documents, distinct from the wrkq ledger.
use super::{JsValue, StoredDocument};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LegacyMailActor {
    Scope {
        #[serde(rename = "sessionRef")]
        session_ref: String,
    },
    Operator {
        principal: String,
    },
}
impl LegacyMailActor {
    pub fn reference(&self) -> &str {
        match self {
            Self::Scope { session_ref } => session_ref,
            Self::Operator { principal } => principal,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Scope { .. } => "scope",
            Self::Operator { .. } => "operator",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyMailPayload {
    pub kind: String,
    pub body: super::JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "present_json")]
    pub metadata: Option<JsValue>,
}
fn present_json<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<JsValue>, D::Error> {
    JsValue::deserialize(d).map(Some)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailEnvelope {
    pub envelope_id: String,
    pub ingress_id: String,
    pub from: LegacyMailActor,
    pub target_session_ref: String,
    pub payload: LegacyMailPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "present_json")]
    pub reply_schema: Option<JsValue>,
    pub state: String,
    pub round_count: i64,
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub response: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presented_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dead_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_actor: Option<LegacyMailActor>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: super::json::Map,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailReceipt {
    pub ingress_id: String,
    pub envelope_id: String,
    pub path: String,
    pub created_at: String,
    #[serde(flatten)]
    pub extra: super::json::Map,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailFederatedOrigin {
    pub ingress_id: String,
    pub envelope_id: String,
    pub request_message_id: String,
    pub request_fingerprint: String,
    pub envelope: StoredDocument<LegacyMailEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disposition_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disposition_fingerprint: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Default)]
pub struct LegacyMailList {
    pub target_session_ref: Option<String>,
    pub state: Option<String>,
    pub dead: bool,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailDisposition {
    pub outcome: String,
    pub envelope: LegacyMailEnvelope,
}
#[derive(Debug, Clone)]
pub struct LegacyMailDefer {
    pub actor: LegacyMailActor,
    pub envelope_id: String,
    pub reason: String,
    pub retry_after_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailSend {
    pub ingress_id: String,
    pub from: LegacyMailActor,
    pub target_session_ref: String,
    pub payload: LegacyMailPayload,
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub reply_schema: Option<JsValue>,
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub materialization_intent: Option<JsValue>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailFederatedDisposition {
    pub outcome: String,
    pub envelope: StoredDocument<LegacyMailEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMailSendResponse {
    pub receipt: StoredDocument<LegacyMailReceipt>,
    pub envelope: StoredDocument<LegacyMailEnvelope>,
}
