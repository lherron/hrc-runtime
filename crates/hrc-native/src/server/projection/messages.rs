//! Message HTTP parsing and local reads. N4 supplies collective authority.
use super::{ApiError, Shared, runtime_views, turns::parse};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub fn address(v: &Value, field: &str) -> Result<Value, ApiError> {
    if !parse::record(v) {
        return Err(parse::bad(format!("{field} must be an object"), field));
    }
    match v["kind"].as_str() {
        Some("entity") => {
            let entity = v["entity"]
                .as_str()
                .filter(|s| matches!(*s, "human" | "system"))
                .ok_or_else(|| {
                    parse::bad(
                        format!("{field}.entity must be \"human\" or \"system\""),
                        &format!("{field}.entity"),
                    )
                })?;
            Ok(json!({"kind":"entity","entity":entity}))
        }
        Some("session") => {
            let raw = v["sessionRef"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    parse::bad(
                        format!("{field}.sessionRef is required"),
                        &format!("{field}.sessionRef"),
                    )
                })?;
            let (scope, lane) = runtime_views::parse_target_ref(raw)?;
            Ok(json!({"kind":"session","sessionRef":format!("{scope}/lane:{lane}")}))
        }
        _ => Err(parse::bad(
            format!("{field}.kind must be \"session\" or \"entity\""),
            &format!("{field}.kind"),
        )),
    }
}
pub fn filter(v: &Value) -> Result<Value, ApiError> {
    if !parse::record(v) {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    if let Some(t) = v.get("thread")
        && (!parse::record(t) || !t["rootMessageId"].is_string())
    {
        return Err(parse::bad(
            "thread.rootMessageId is required when thread is provided",
            "thread.rootMessageId",
        ));
    }
    for (key, min, message) in [
        ("afterSeq", 0, "afterSeq must be a non-negative integer"),
        ("limit", 1, "limit must be a positive integer"),
    ] {
        if let Some(x) = v.get(key)
            && parse::integral(x).filter(|n| *n >= min).is_none()
        {
            return Err(parse::bad(message, key));
        }
    }
    if let Some(x) = v.get("order")
        && x != "asc"
        && x != "desc"
    {
        return Err(parse::bad("order must be \"asc\" or \"desc\"", "order"));
    }
    for (key, allowed) in [
        ("kinds", &["dm", "literal", "system"][..]),
        ("phases", &["request", "response", "oneway"][..]),
    ] {
        if let Some(x) = v.get(key) {
            let items = x
                .as_array()
                .ok_or_else(|| parse::bad(format!("{key} must be an array"), key))?;
            for (index, item) in items.iter().enumerate() {
                if !item.as_str().is_some_and(|s| allowed.contains(&s)) {
                    let field = format!("{key}[{index}]");
                    return Err(parse::bad(format!("{field} is invalid"), &field));
                }
            }
        }
    }
    for key in ["replyToMessageId", "messageId", "hostSessionId", "runId"] {
        if let Some(x) = v.get(key)
            && !x.is_string()
        {
            return Err(parse::bad(format!("{key} must be a string"), key));
        }
    }
    if let Some(x) = v.get("generation")
        && parse::integral(x).filter(|n| *n >= 0).is_none()
    {
        return Err(parse::bad(
            "generation must be a non-negative integer",
            "generation",
        ));
    }
    let mut out = json!({});
    if let Some(id) = v.get("messageId") {
        out["messageId"] = id.clone();
    }
    for key in ["participant", "from", "to"] {
        if let Some(a) = v.get(key) {
            out[key] = address(a, key)?;
        }
    }
    for key in [
        "thread",
        "replyToMessageId",
        "hostSessionId",
        "runId",
        "generation",
        "afterSeq",
        "kinds",
        "phases",
        "limit",
        "order",
    ] {
        if let Some(x) = v.get(key) {
            out[key] = if matches!(key, "generation" | "afterSeq" | "limit") {
                json!(parse::integral(x).unwrap())
            } else {
                x.clone()
            };
        }
    }
    Ok(out)
}
/// Shared local fallback for the N4 history coordinator. It reports pending
/// durable replication rows but does not enqueue, retry or mutate them.
pub fn local_query(
    server: &Shared,
    filter: &Value,
    code: &str,
    message: &str,
) -> Result<Value, ApiError> {
    let db = server.store.lock().unwrap();
    Ok(
        json!({"messages":db.message_query(filter)?,"history":{"source":"local","complete":false,"authorityNodeId":"svc","queriedNodeId":super::publication::node_id(server),"cursorKind":"node-local","pendingReplicationCount":db.local_history_pending()?,"degraded":{"code":code,"message":message}}}),
    )
}
pub async fn query(server: &Shared, body: &[u8]) -> Result<Response, ApiError> {
    let body = super::parse_body(body).map_err(|mut e| {
        e.detail = Some(json!({}));
        e
    })?;
    let filter = filter(&body)?;
    if let Some(answer) = super::federation::history::query(server, &filter).await? {
        return Ok(Json(answer).into_response());
    }
    Ok(Json(local_query(
        server,
        &filter,
        "collective_not_configured",
        "collective history authority svc is not configured as a peer",
    )?)
    .into_response())
}
