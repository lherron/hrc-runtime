//! parseSemanticDmRequest and requireCompleteRuntimeIntent, in Bun check order.
use crate::server::{ApiError, messages, turns::parse};
use axum::http::StatusCode;
use serde_json::{Value, json};

pub struct Request {
    pub from: Value,
    pub to: Value,
    pub body: String,
    pub mode: Option<String>,
    pub reply_to: Option<String>,
    pub respond_to: Option<Value>,
    pub runtime_intent: Option<Value>,
    pub create_if_missing: bool,
    pub allow_stale: bool,
    pub fresh: Option<bool>,
    pub cross_scope: bool,
    pub response_format: Option<Value>,
}
fn provision(value: &Value) -> Result<(), ApiError> {
    let field = "runtimeIntent.provision";
    let invalid = |field: &str, message: String| {
        ApiError::domain(
            StatusCode::BAD_REQUEST,
            "invalid_provision_shape",
            message,
            Some(json!({"field":field,"retryable":false})),
        )
    };
    let table = value.as_object().ok_or_else(|| {
        invalid(
            field,
            format!("{field} must be a table of top-level provisioning scalars"),
        )
    })?;
    for (key, member) in table {
        if !member.is_string() && !member.is_number() && !member.is_boolean() {
            let field = format!("{field}.{key}");
            return Err(invalid(
                &field,
                format!(
                    "{field} must be a scalar: nested provisioning tables are profile-only and can never be set per-summon"
                ),
            ));
        }
    }
    // The pinned agent-scope DENIED_PROVISION_OVERRIDE_KEYS; unknown flat
    // scalars deliberately pass this daemon boundary, as they do in Bun.
    for denied in ["yolo", "sandbox"] {
        if table.contains_key(denied) {
            let field = format!("{field}.{denied}");
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "denied_provision_key",
                format!(
                    "{field} is denied: \"{denied}\" can only be set in the agent profile (denied keys: yolo, sandbox)"
                ),
                Some(json!({"field":field,"retryable":false})),
            ));
        }
    }
    Ok(())
}
pub fn request(v: &Value) -> Result<Request, ApiError> {
    if !parse::record(v) {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let body = v["body"]
        .as_str()
        .ok_or_else(|| parse::bad("body must be a string", "body"))?
        .to_owned();
    let mode = parse::one_of(
        v.get("mode"),
        &["auto", "headless", "nonInteractive"],
        "mode is invalid",
        "mode",
    )?;
    let reply_to = match v.get("replyToMessageId") {
        None => None,
        Some(x) => Some(
            x.as_str()
                .ok_or_else(|| parse::bad("replyToMessageId must be a string", "replyToMessageId"))?
                .to_owned(),
        ),
    };
    let respond_to = v
        .get("respondTo")
        .map(|a| messages::address(a, "respondTo"))
        .transpose()?;
    let runtime_intent = v.get("runtimeIntent").filter(|x| parse::record(x)).cloned();
    if let Some(intent) = &runtime_intent
        && let Some(value) = intent.get("provision")
    {
        provision(value)?;
    }
    let fresh = parse::optional_bool(v, "freshContext")?;
    let response_format = parse::response_format(v.get("responseFormat"))?;
    let from = messages::address(&v["from"], "from")?;
    let to = messages::address(&v["to"], "to")?;
    if runtime_intent
        .as_ref()
        .is_some_and(|i| i.get("placement").is_none())
    {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing_runtime_intent",
            "runtimeIntent must be complete before dispatch",
            Some(json!({"reason":"directive_only_runtime_intent"})),
        ));
    }
    Ok(Request {
        from,
        to,
        body,
        mode,
        reply_to,
        respond_to,
        runtime_intent,
        create_if_missing: v["createIfMissing"] != false,
        allow_stale: v["allowStaleGeneration"] == true,
        fresh,
        cross_scope: v["allowCrossScopeReply"] == true,
        response_format,
    })
}
