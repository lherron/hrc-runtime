use super::{SessionIdentity, rows};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Default)]
pub struct SessionIndexFilters {
    pub q: Option<String>,
    pub agent_id: Option<String>,
    pub project_id: Option<String>,
    pub lane_ref: Option<String>,
    pub effective_status: Option<String>,
    pub execution_mode: Option<String>,
}
#[derive(Debug, Clone)]
pub struct SessionIndexCursor {
    pub last_activity_at: String,
    pub host_session_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionIndexRecord {
    #[serde(flatten)]
    pub fields: rows::SessionIndexRow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<SessionIdentity>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexPage {
    pub items: Vec<SessionIndexRecord>,
    pub has_more: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexFacets {
    pub total: i64,
    pub node_facet_count: i64,
    pub by_effective_status: std::collections::BTreeMap<String, i64>,
    pub by_execution_mode: std::collections::BTreeMap<String, i64>,
    pub by_agent_id: std::collections::BTreeMap<String, i64>,
}
pub type SessionIndexBackfillEvidence = rows::SessionIndexBackfillEvidenceRow;
