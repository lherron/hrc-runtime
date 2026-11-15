//! HRC owner-operation facades for the ops-only cardo provider.
pub mod annotation;
pub mod declarations;
pub mod owner;
pub mod restart;
pub mod send;
pub mod summon;

use cardo_runtime::service::DispatchFailure;
use serde_json::json;

/// A refusal or failure from HRC's ledger or owner, by HRC error code.
#[derive(Debug, Clone)]
pub struct HrcError {
    pub code: String,
    pub message: String,
    /// HRC's `error.detail`, when the owner sent one.
    pub detail: Option<serde_json::Value>,
}
impl HrcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }
}
impl std::fmt::Display for HrcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for HrcError {}
/// An owner operation's refusal keeps HRC's code for the caller.
impl From<HrcError> for DispatchFailure {
    fn from(e: HrcError) -> Self {
        let mut details = json!({"hrc_code":e.code,"message":e.message});
        if let Some(detail) = e.detail {
            details["detail"] = detail;
        }
        DispatchFailure {
            details,
            code: e.code,
            message: e.message,
        }
    }
}
