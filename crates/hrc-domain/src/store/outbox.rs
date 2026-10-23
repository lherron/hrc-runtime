use super::{
    MessageAddress,
    json::{JsObject, JsValue},
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FederationExpectedPlacement {
    pub home_node_id: String,
}
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FederationMessageDelivery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_intent: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_if_missing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<MessageAddress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_stale_generation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_turn_handoff: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urgent: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission_door: Option<String>,
    #[serde(flatten)]
    pub extra: JsObject,
}
/// Retained transport record, not a federation protocol validator or execution request.
/// The optional context members are opaque retained domain documents owned by their feature.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FederationEnvelope {
    pub message_id: String,
    pub kind: String,
    pub phase: String,
    pub from: MessageAddress,
    pub to: MessageAddress,
    pub body: String,
    pub root_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<FederationExpectedPlacement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<FederationMessageDelivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_turn_signal: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive_signal: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mail: Option<JsValue>,
    #[serde(flatten)]
    pub extra: JsObject,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FederationEstablishRequest {
    pub scope_ref: String,
    pub intent: String,
    pub correlation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_node_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "stage",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OutboxPayload {
    Establishing {
        establish: FederationEstablishRequest,
        envelope: FederationEnvelope,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_error: Option<OutboxError>,
    },
    Delivering {
        envelope: FederationEnvelope,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_error: Option<OutboxError>,
    },
}
impl OutboxPayload {
    pub fn envelope(&self) -> &FederationEnvelope {
        match self {
            Self::Establishing { envelope, .. } | Self::Delivering { envelope, .. } => envelope,
        }
    }
    pub fn clear_error(&mut self) {
        match self {
            Self::Establishing { last_error, .. } | Self::Delivering { last_error, .. } => {
                *last_error = None
            }
        }
    }
    pub fn set_error(&mut self, e: Option<OutboxError>) {
        match self {
            Self::Establishing { last_error, .. } | Self::Delivering { last_error, .. } => {
                *last_error = e
            }
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxDelivery {
    pub delivery_id: String,
    pub message_id: String,
    pub peer_node_id: String,
    #[serde(flatten)]
    pub payload: OutboxPayload,
    pub state: String,
    pub total_attempts: i64,
    pub cycle_attempts: i64,
    pub replay_count: i64,
    pub retry_window_started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dead_lettered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct EnqueueOutbox {
    pub delivery_id: String,
    pub message_id: String,
    pub peer_node_id: String,
    pub payload: OutboxPayload,
    pub now: String,
}
#[derive(Debug, Clone, Default)]
pub struct OutboxAttemptFailure {
    pub delivery_id: String,
    pub attempted_at: String,
    pub error_code: String,
    pub error_message: String,
    pub structured_error_code: Option<String>,
    pub error_reason: Option<String>,
    pub retryable: Option<bool>,
    pub home_node_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FederationEnvelopeFields {
    pub message_id: String,
    pub kind: String,
    pub phase: String,
    pub from: MessageAddress,
    pub to: MessageAddress,
    pub body: String,
    pub root_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<FederationExpectedPlacement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<FederationMessageDelivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_turn_signal: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive_signal: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mail: Option<JsValue>,
}
impl<'de> Deserialize<'de> for FederationEnvelope {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = JsValue::deserialize(d)?;
        let JsValue::Object(mut extra) = value else {
            return Err(serde::de::Error::custom(
                "expected retained federation object",
            ));
        };
        let mut known = JsObject::new();
        for key in [
            "messageId",
            "kind",
            "phase",
            "from",
            "to",
            "body",
            "rootMessageId",
            "replyToMessageId",
            "expected",
            "delivery",
            "semanticTurnSignal",
            "interactiveSignal",
            "mail",
        ] {
            if let Some(v) = extra.remove(key) {
                known.insert(key.into(), v);
            }
        }
        let fields: FederationEnvelopeFields =
            super::json::from_value(JsValue::Object(known)).map_err(serde::de::Error::custom)?;
        Ok(Self {
            message_id: fields.message_id,
            kind: fields.kind,
            phase: fields.phase,
            from: fields.from,
            to: fields.to,
            body: fields.body,
            root_message_id: fields.root_message_id,
            reply_to_message_id: fields.reply_to_message_id,
            expected: fields.expected,
            delivery: fields.delivery,
            semantic_turn_signal: fields.semantic_turn_signal,
            interactive_signal: fields.interactive_signal,
            mail: fields.mail,
            extra,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FederationMessageDeliveryFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_intent: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_if_missing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<MessageAddress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_stale_generation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_turn_handoff: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urgent: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission_door: Option<String>,
}
impl<'de> Deserialize<'de> for FederationMessageDelivery {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = JsValue::deserialize(d)?;
        let JsValue::Object(mut extra) = value else {
            return Err(serde::de::Error::custom(
                "expected retained federation object",
            ));
        };
        let mut known = JsObject::new();
        for key in [
            "runtimeIntent",
            "createIfMissing",
            "respondTo",
            "responseFormat",
            "allowStaleGeneration",
            "semanticTurnHandoff",
            "urgent",
            "submissionDoor",
        ] {
            if let Some(v) = extra.remove(key) {
                known.insert(key.into(), v);
            }
        }
        let fields: FederationMessageDeliveryFields =
            super::json::from_value(JsValue::Object(known)).map_err(serde::de::Error::custom)?;
        Ok(Self {
            runtime_intent: fields.runtime_intent,
            create_if_missing: fields.create_if_missing,
            respond_to: fields.respond_to,
            response_format: fields.response_format,
            allow_stale_generation: fields.allow_stale_generation,
            semantic_turn_handoff: fields.semantic_turn_handoff,
            urgent: fields.urgent,
            submission_door: fields.submission_door,
            extra,
        })
    }
}

impl<'de> Deserialize<'de> for OutboxPayload {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = JsValue::deserialize(d)?;
        let decode = |key: &str| {
            value
                .get(key)
                .cloned()
                .ok_or_else(|| serde::de::Error::custom(format!("missing outbox {key}")))
        };
        let envelope =
            super::json::from_value(decode("envelope")?).map_err(serde::de::Error::custom)?;
        let last_error = value
            .get("lastError")
            .cloned()
            .map(super::json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        match value.get("stage").and_then(JsValue::as_str) {
            Some("establishing") => Ok(Self::Establishing {
                establish: super::json::from_value(decode("establish")?)
                    .map_err(serde::de::Error::custom)?,
                envelope,
                last_error,
            }),
            Some("delivering") => Ok(Self::Delivering {
                envelope,
                last_error,
            }),
            _ => Err(serde::de::Error::custom("unknown outbox stage")),
        }
    }
}
