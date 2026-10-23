//! Bounded native lifecycle errors; no transport or execution side effects.
use serde::Serialize;
use serde_json::{Value, json};
use std::fmt;

pub type Result<T> = std::result::Result<T, NativeError>;

#[derive(Debug, Clone, Serialize)]
pub struct NativeError {
    #[serde(skip)]
    pub status: u16,
    pub code: String,
    pub message: String,
    pub detail: Box<Value>,
}
impl NativeError {
    pub fn new(status: u16, code: &str, message: impl Into<String>, detail: Value) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            detail: Box::new(detail),
        }
    }
    pub fn malformed(message: impl Into<String>, field: &str) -> Self {
        Self::new(400, "malformed_request", message, json!({"field": field}))
    }
    pub fn stale(message: &str) -> Self {
        Self::new(409, "stale_context", message, json!({}))
    }
    pub fn io(operation: &str, error: std::io::Error) -> Self {
        // The caller supplies an operation label, never credential contents.
        Self::new(
            503,
            "runtime_unavailable",
            format!("{operation}: {error}"),
            json!({"code": "lifecycle_io", "operation": operation}),
        )
    }
    pub fn envelope(&self) -> Value {
        json!({"ok": false, "error": {"code": self.code, "message": self.message, "detail": self.detail}})
    }
}
impl fmt::Display for NativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for NativeError {}
impl From<hrc_store::StoreError> for NativeError {
    fn from(error: hrc_store::StoreError) -> Self {
        use hrc_store::StoreError;
        let status = match &error {
            StoreError::Invalid(_) => 400,
            StoreError::Conflict { .. } | StoreError::CursorInvalid { .. } => 409,
            StoreError::MissingRecord(_) => 404,
            _ => 503,
        };
        // Do not expose SQL/JSON payloads embedded in a store diagnostic.
        Self::new(
            status,
            error.code(),
            "native store operation refused",
            json!({}),
        )
    }
}
