use super::{authority, gates, parse, peer};
use crate::server::{ApiError, Shared, stderr_json};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
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
    let attributed = headers
        .get("x-hrc-lifecycle-session-ref")
        .and_then(|v| v.to_str().ok())
        .map(Value::from)
        .unwrap_or(Value::Null);
    match execute(
        server,
        &request,
        grant,
        json!({"attributedCaller":attributed}),
    )
    .await
    {
        Ok(response) => Ok(Json(response).into_response()),
        Err(Refused::InProgress(message)) => Err(authority::error(
            &request.action,
            node,
            "lifecycle_in_progress",
            message,
        )),
        Err(Refused::Gate(error)) => Err(error),
    }
}

enum Refused {
    InProgress(String),
    Gate(ApiError),
}

/// The in-progress claim. Dropping it before `keep` releases the flag, so a
/// gate refusal or a caller that disconnects during `--wait` (which drops this
/// future mid-drain) cannot leave every later lifecycle action refused.
struct Claim<'a>(Option<&'a AtomicBool>);

impl<'a> Claim<'a> {
    fn take(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self(Some(flag)))
    }
    fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if let Some(flag) = self.0 {
            flag.store(false, Ordering::SeqCst);
        }
    }
}

/// executeLocally: one action at a time, gated on in-flight work, actuated
/// after the acknowledgement has been answered.
async fn execute(
    server: &Shared,
    request: &parse::Request,
    grant: Value,
    context: Value,
) -> Result<Value, Refused> {
    let node = server.federation.node_id();
    let Some(claim) = Claim::take(&server.lifecycle.in_progress) else {
        return Err(Refused::InProgress(format!(
            "a lifecycle action is already in progress on {node}"
        )));
    };
    let notes = gates::check(server, request, &grant)
        .await
        .map_err(Refused::Gate)?;
    claim.keep();
    let mut log = grant.clone();
    log.as_object_mut()
        .unwrap()
        .extend(context.as_object().cloned().unwrap_or_default());
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
    Ok(response)
}

const PEER_FIELDS: [&str; 9] = [
    "requestId",
    "originNode",
    "requestedBy",
    "callerKind",
    "reason",
    "action",
    "flags",
    "waitTimeoutMs",
    "drainTimeoutMs",
];

/// server-lifecycle-controller.ts handlePeerRequest: a Mable primary on the
/// authenticated origin attested this grant; act on this node only.
pub async fn peer(
    server: &Shared,
    authenticated: &str,
    body: &Map<String, Value>,
) -> (StatusCode, Value) {
    let node = server.federation.node_id();
    let invalid = |message: String| {
        (
            StatusCode::BAD_REQUEST,
            json!({"ok":false,"error":{"code":"invalid_request","message":message}}),
        )
    };
    if let Some(key) = body.keys().find(|k| !PEER_FIELDS.contains(&k.as_str())) {
        return invalid(format!("unknown field {key}"));
    }
    let text = |field: &str| {
        body.get(field)
            .and_then(Value::as_str)
            .map(hrc_common::js::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let Some(action) = body
        .get("action")
        .and_then(Value::as_str)
        .filter(|a| matches!(*a, "stop" | "restart"))
    else {
        return invalid("action must be stop or restart".into());
    };
    let flags = match body.get("flags").and_then(Value::as_object) {
        Some(f)
            if f.keys()
                .all(|k| matches!(k.as_str(), "wait" | "drain" | "force"))
                && f.values().all(Value::is_boolean) =>
        {
            f
        }
        _ => return invalid("flags must be {wait, drain, force} booleans".into()),
    };
    let (Some(request_id), Some(origin), Some(requested_by), Some(caller_kind)) = (
        text("requestId"),
        text("originNode"),
        text("requestedBy"),
        text("callerKind"),
    ) else {
        return invalid("requestId, originNode, requestedBy and callerKind are required".into());
    };
    let flag = |k: &str| flags.get(k) == Some(&Value::Bool(true));
    let (wait, drain, force) = (flag("wait"), flag("drain"), flag("force"));
    if drain && wait {
        return invalid(
            "--drain and --wait are mutually exclusive; --drain owns the closed-admission wait"
                .into(),
        );
    }
    if drain && action != "restart" {
        return invalid("--drain applies to restart only".into());
    }
    // A missing or malformed timeout falls back; it is not a refusal here.
    let timeout = |field: &str| {
        body.get(field)
            .and_then(Value::as_f64)
            .filter(|v| v.fract() == 0.0 && *v >= 1.0 && *v <= 9_007_199_254_740_991.0)
            .map_or(300_000, |v| v as u64)
    };
    let flags_value = json!({"wait":wait,"drain":drain,"force":force});
    let refuse = |code: &'static str, message: String| {
        stderr_json(
            "warn",
            "server",
            "server.lifecycle.refused",
            json!({"refusal":code,"message":message,"action":action,"targetNode":node,"flags":flags_value,
                   "attributedCaller":requested_by,"originNode":origin,"authenticatedNodeId":authenticated,
                   "callerKind":caller_kind}),
        );
        (
            if code == "lifecycle_in_progress" {
                StatusCode::CONFLICT
            } else {
                StatusCode::FORBIDDEN
            },
            json!({"ok":false,"error":{"code":"server_lifecycle_refused","message":message,"detail":{"refusal":code}}}),
        )
    };
    // checkLifecycleAttestation
    let attestation = |detail: String| {
        refuse(
            "attestation_refused",
            authority::refusal_text(
                action,
                node,
                authority::project(Some(&requested_by)),
                &detail,
            ),
        )
    };
    if origin != authenticated {
        return attestation(format!(
            "attested originNode {origin} is not the authenticated peer {authenticated}"
        ));
    }
    if caller_kind != "mable-primary" {
        return attestation(format!("callerKind {caller_kind} may not act across nodes"));
    }
    if !authority::mable_primary(&requested_by) {
        return attestation(format!(
            "attested requestedBy {requested_by} is not a Mable primary"
        ));
    }
    let Some(reason) = text("reason") else {
        return refuse(
            "reason_required",
            authority::refusal_text(action, node, "<project>", "--reason <text> is required"),
        );
    };
    let request = parse::Request {
        action: action.to_owned(),
        reason: Some(reason.clone()),
        target_node: None,
        wait,
        drain,
        force,
        wait_timeout_ms: timeout("waitTimeoutMs"),
        drain_timeout_ms: timeout("drainTimeoutMs"),
        proof_timeout_ms: 60_000,
        requested_run_id: None,
    };
    let grant = json!({"requestId":request_id,"requestedBy":requested_by,"callerKind":"mable-primary",
                       "originNode":origin,"reason":reason,"action":action,"flags":flags_value});
    match execute(
        server,
        &request,
        grant,
        json!({"authenticatedNodeId":authenticated}),
    )
    .await
    {
        Ok(response) => (StatusCode::OK, response),
        Err(Refused::InProgress(message)) => refuse("lifecycle_in_progress", message),
        Err(Refused::Gate(error)) => (
            error.status,
            json!({"ok":false,"error":{"code":error.code,"message":error.message,"detail":error.detail.unwrap_or(json!({}))}}),
        ),
    }
}
