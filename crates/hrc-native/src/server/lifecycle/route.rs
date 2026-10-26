use super::{authority, gates, parse, peer};
use crate::server::{ApiError, Shared, stderr_json};
use axum::{
    Json,
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

pub async fn handle(
    server: &Shared,
    bytes: &[u8],
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let request = parse::local(bytes)?;
    let node = server.federation.node_id();
    let target = request.target_node.as_deref().unwrap_or(node);
    let caller = authority::authorize(server, headers, &request.action, target)?;
    let refusal = |code, detail: &str| {
        authority::refused(
            server,
            &request.action,
            target,
            &caller.project,
            code,
            detail,
        )
    };
    if target != node && caller.caller_kind != "mable-primary" {
        return Err(refusal(
            "node_local_cross_node",
            &format!(
                "{} is a node-local seat and may act only on its own node {node}",
                caller.requested_by
            ),
        ));
    }
    let reason = request
        .reason
        .as_deref()
        .ok_or_else(|| refusal("reason_required", "--reason <text> is required"))?;
    let grant = authority::grant(&caller, node, &request.action, reason, request.flags());
    if target != node {
        let peer = server.federation.peer(target).ok_or_else(|| {
            refusal(
                "unknown_node",
                &format!("{target} is not a configured federation peer"),
            )
        })?;
        return peer::forward(server, peer, &request, grant).await;
    }
    if server
        .lifecycle
        .in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(authority::error(
            &request.action,
            node,
            "lifecycle_in_progress",
            format!("a lifecycle action is already in progress on {node}"),
        ));
    }
    let notes = match gates::check(server, &request, &grant).await {
        Ok(notes) => notes,
        Err(error) => {
            server.lifecycle.in_progress.store(false, Ordering::SeqCst);
            return Err(error);
        }
    };
    let mut log = grant.clone();
    log["attributedCaller"] = headers
        .get("x-hrc-lifecycle-session-ref")
        .and_then(|v| v.to_str().ok())
        .map(Value::from)
        .unwrap_or(Value::Null);
    if !notes.is_empty() {
        log["notes"] = json!(notes);
    }
    stderr_json("info", "server", "server.lifecycle.granted", log);
    let weak = Arc::downgrade(server);
    let actuation = grant.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(server) = weak.upgrade() {
            super::actuation::execute(&server, actuation);
        }
    });
    let mut response = json!({"ok":true,"accepted":true,"targetNode":node,"grant":grant});
    if !notes.is_empty() {
        response["notes"] = json!(notes);
    }
    Ok(Json(response).into_response())
}
