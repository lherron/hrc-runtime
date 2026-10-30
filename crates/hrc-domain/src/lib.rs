//! HRC native-ledger observation domain and owner-operation facades.
pub mod attach;
pub mod declarations;
pub mod ledger;
pub mod owner;
mod preview;
pub mod projection;
mod projection_json;
pub mod projector;
pub mod reader;
pub mod restart;
pub mod send;
pub mod summon;

use cardo_core::{CoreEdit, Refusal, decode_core_edit};
use cardo_runtime::{ingest::ProjectorError, service::DispatchFailure};
use serde_json::{Value, json};

/// A refusal or failure from HRC's ledger or owner, by HRC error code.
#[derive(Debug, Clone)]
pub struct HrcError {
    pub code: String,
    pub message: String,
}
impl HrcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    /// A ledger read that failed for any reason other than a fence.
    pub fn read(e: impl std::fmt::Display) -> Self {
        Self::new("hrc_read_failed", e.to_string())
    }
}
impl std::fmt::Display for HrcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for HrcError {}
impl From<HrcError> for ProjectorError {
    fn from(e: HrcError) -> Self {
        ProjectorError::new(e.code, e.message)
    }
}
/// An owner operation's refusal keeps HRC's code for the caller.
impl From<HrcError> for DispatchFailure {
    fn from(e: HrcError) -> Self {
        DispatchFailure {
            details: json!({"hrc_code":e.code,"message":e.message}),
            code: e.code,
            message: e.message,
        }
    }
}

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
