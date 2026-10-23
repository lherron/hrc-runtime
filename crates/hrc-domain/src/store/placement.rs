use serde::{Deserialize, Serialize};
pub type PlacementLedgerRecord = super::rows::PlacementLedgerRow;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlacementBinding {
    pub scope_ref: String,
    pub home_node_id: String,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone)]
pub struct InstallPlacement {
    pub scope_ref: String,
    pub home_node_id: String,
    pub created_at: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RetirePlacementOutcome {
    Retired,
    Idempotent,
    Conflict,
    NotFound,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetirePlacementResult {
    pub outcome: RetirePlacementOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<PlacementLedgerRecord>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BirthDesignation {
    pub scope_ref: String,
    pub home_node_id: String,
    pub provenance: String,
    pub birth_envelope_id: String,
    pub sender_scope_ref: String,
    pub designation_epoch: i64,
    pub designated_at: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_at: Option<String>,
}
#[derive(Debug, Clone)]
pub struct RecordBirthDesignation {
    pub scope_ref: String,
    pub home_node_id: String,
    pub provenance: String,
    pub birth_envelope_id: String,
    pub sender_scope_ref: String,
    pub now: String,
}
#[derive(Debug, Clone)]
pub enum BirthEstablishmentDecision {
    Supersede { by: String },
    EnforceDesignatedHome,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum EstablishBindingResult {
    Created { binding: PlacementBinding },
    Existing { binding: PlacementBinding },
    DesignationMismatch { designation: Box<BirthDesignation> },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeleteBindingOutcome {
    Deleted,
    Idempotent,
    Conflict,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeleteBindingResult {
    pub outcome: DeleteBindingOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<PlacementBinding>,
}
