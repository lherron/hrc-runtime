//! Stored-only presentation observations. The caller supplies the 24-hour cutoff.
use super::{
    ContributionSessionRef, JsString, JsValue, LifecycleEvent, SessionIdentity, SessionRecord,
};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct PresentationSeatsRequest {
    /// Original spellings are Map keys: parsing must not canonicalize these away.
    pub session_refs: Vec<String>,
    pub runtime_ids: Vec<String>,
    pub since: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PresentationSession {
    #[serde(flatten)]
    pub session: SessionRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<JsString>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationTmux {
    pub socket_path: JsString,
    pub attach_target: JsString,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationOperatorSurface {
    pub surface_id: String,
    pub client_tty: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationRuntime {
    pub runtime_id: String,
    pub host_session_id: String,
    #[serde(flatten)]
    pub seat: ContributionSessionRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<SessionIdentity>,
    pub metadata: JsValue,
    pub generation: i64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<PresentationTmux>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_reading: Option<JsValue>,
    pub operator_surfaces: Vec<PresentationOperatorSurface>,
}
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PresentationSeats {
    pub sessions: Vec<PresentationSession>,
    pub runtimes: Vec<PresentationRuntime>,
    pub events: Vec<LifecycleEvent>,
}
