//! HRC API-fed observation domain and stage-1b owner-API facade.
pub mod api;
pub mod attach;
pub mod declarations;
pub mod ledger;
mod preview;
pub mod projection;
mod projection_json;
pub mod projector;
pub mod restart;
pub mod summon;

use cardo_core::{CoreEdit, Refusal, decode_core_edit};
use serde_json::Value;

pub fn decode_edits(wire: Value) -> Result<Vec<CoreEdit>, Refusal> {
    let Value::Array(items) = wire else {
        return Err(Refusal::invalid("edit_rejected", "edits must be an array"));
    };
    items
        .into_iter()
        .map(|v| {
            let Value::Object(mut fields) = v else {
                return Err(Refusal::invalid("edit_rejected", "edit must be an object"));
            };
            let kind = fields
                .remove("kind")
                .and_then(|k| k.as_str().map(str::to_owned))
                .ok_or_else(|| Refusal::invalid("edit_rejected", "missing kind"))?;
            decode_core_edit(&kind, Value::Object(fields)).unwrap_or_else(|| {
                Err(Refusal::invalid(
                    "edit_rejected",
                    format!("unknown kind {kind}"),
                ))
            })
        })
        .collect()
}
