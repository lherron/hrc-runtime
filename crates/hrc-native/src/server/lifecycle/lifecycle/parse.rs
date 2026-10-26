//! server-lifecycle-controller.ts local-body parsing and flag validation.
use crate::server::ApiError;
use serde_json::{Value, json};

pub struct Request {
    pub action: String,
    pub reason: Option<String>,
    pub target_node: Option<String>,
    pub wait: bool,
    pub drain: bool,
    pub force: bool,
    pub wait_timeout_ms: u64,
    pub drain_timeout_ms: u64,
    pub proof_timeout_ms: u64,
    pub requested_run_id: Option<String>,
}
impl Request {
    pub fn flags(&self) -> Value {
        json!({"wait":self.wait,"drain":self.drain,"force":self.force})
    }
}
fn malformed(message: impl Into<String>, field: &str) -> ApiError {
    ApiError::bad(message, Some(json!({"field":field})))
}
fn boolean(body: &Value, field: &str) -> Result<bool, ApiError> {
    match body.get(field) {
        None => Ok(false),
        Some(v) => v
            .as_bool()
            .ok_or_else(|| malformed(format!("{field} must be a boolean"), field)),
    }
}
fn text(body: &Value, field: &str) -> Result<Option<String>, ApiError> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let raw = v
                .as_str()
                .ok_or_else(|| malformed(format!("{field} must be a string"), field))?;
            let raw = hrc_common::js::trim(raw);
            Ok((!raw.is_empty()).then(|| raw.to_owned()))
        }
    }
}
fn timeout(body: &Value, field: &str, fallback: u64) -> Result<u64, ApiError> {
    let Some(value) = body.get(field) else {
        return Ok(fallback);
    };
    value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 1.0 && *v <= 9_007_199_254_740_991.0)
        .map(|v| v as u64)
        .ok_or_else(|| malformed(format!("{field} must be a positive integer"), field))
}
pub fn local(bytes: &[u8]) -> Result<Request, ApiError> {
    let body: Value = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad("lifecycle request body must be JSON", Some(json!({}))))?;
    let fields = body.as_object().ok_or_else(|| {
        ApiError::bad(
            "lifecycle request body must be a JSON object",
            Some(json!({})),
        )
    })?;
    for field in fields.keys() {
        if ![
            "action",
            "reason",
            "targetNode",
            "wait",
            "drain",
            "force",
            "waitTimeoutMs",
            "drainTimeoutMs",
            "proofTimeoutMs",
            "requestedRunId",
        ]
        .contains(&field.as_str())
        {
            return Err(malformed(format!("unknown field {field}"), field));
        }
    }
    let action = body["action"]
        .as_str()
        .filter(|s| matches!(*s, "stop" | "restart"))
        .ok_or_else(|| malformed("action must be stop or restart", "action"))?
        .to_owned();
    let target_node = text(&body, "targetNode")?;
    if target_node
        .as_deref()
        .is_some_and(|s| !hrc_common::federation::is_valid_node_id(s))
    {
        return Err(malformed("targetNode is not a valid nodeId", "targetNode"));
    }
    let reason = text(&body, "reason")?;
    let wait = boolean(&body, "wait")?;
    let drain = boolean(&body, "drain")?;
    let force = boolean(&body, "force")?;
    if drain && wait {
        return Err(ApiError::bad(
            "--drain and --wait are mutually exclusive; --drain owns the closed-admission wait",
            Some(json!({})),
        ));
    }
    if drain && action != "restart" {
        return Err(ApiError::bad(
            "--drain applies to restart only",
            Some(json!({})),
        ));
    }
    Ok(Request {
        action,
        reason,
        target_node,
        wait,
        drain,
        force,
        wait_timeout_ms: timeout(&body, "waitTimeoutMs", 300_000)?,
        drain_timeout_ms: timeout(&body, "drainTimeoutMs", 300_000)?,
        proof_timeout_ms: timeout(&body, "proofTimeoutMs", 60_000)?,
        requested_run_id: text(&body, "requestedRunId")?,
    })
}
