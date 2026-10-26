//! Verified caller identity is separate from authority to stop a node.
use super::credentials;
use crate::server::{ApiError, Server, stderr_json};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

pub struct Authorized {
    pub requested_by: String,
    pub caller_kind: &'static str,
    pub project: String,
}
pub fn error(action: &str, target: &str, code: &'static str, message: String) -> ApiError {
    stderr_json(
        "warn",
        "server",
        "server.lifecycle.refused",
        json!({"refusal":code,"message":message,"action":action,"targetNode":target}),
    );
    let mut detail = json!({"refusal":code});
    if code == "lifecycle_in_progress" {
        detail["retryable"] = true.into();
    }
    ApiError::domain(
        StatusCode::FORBIDDEN,
        "server_lifecycle_refused",
        message,
        Some(detail),
    )
}
pub fn project(scope: Option<&str>) -> &str {
    scope
        .and_then(|s| s.split(':').collect::<Vec<_>>().get(3).copied())
        .unwrap_or("<project>")
}
pub fn refused(
    _server: &Server,
    action: &str,
    target: &str,
    project: &str,
    code: &'static str,
    detail: &str,
) -> ApiError {
    error(
        action,
        target,
        code,
        refusal_text(action, target, project, detail),
    )
}
/// lifecycleRefusalText plus the parenthesized detail.
pub fn refusal_text(action: &str, target: &str, project: &str, detail: &str) -> String {
    let node_seat = match target {
        "svc" => ", this node's Mable seat (mable@<project>:minisvc)",
        "hrcdev" => ", this node's Mable seat (mable@hrc-runtime:hrcdev)",
        _ => "",
    };
    format!(
        "only mable@<project>:primary{node_seat} or Lance may {action} the HRC server on {target}; request it from mable@{project}:primary ({detail})"
    )
}
/// isMablePrimaryScope: a canonical, role-free mable task scope named primary.
pub fn mable_primary(scope: &str) -> bool {
    let p: Vec<_> = scope.split(':').collect();
    hrc_cli::validate_scope(scope).is_ok()
        && p.len() == 6
        && p[4] == "task"
        && p[1] == "mable"
        && p[5] == "primary"
}
pub fn authorize(
    server: &Server,
    headers: &HeaderMap,
    action: &str,
    target: &str,
) -> Result<Authorized, ApiError> {
    let binding = credentials::verify_caller(server, headers).map_err(|e| {
        let detail = if e.code == "credential_missing" {
            format!("{}; Lance acts through a Mable primary or the documented break-glass (launchctl kickstart -k gui/$UID/com.praesidium.hrc-server), which the next boot records as unattributed",e.detail)
        } else { e.detail };
        refused(server, action, target, project(e.scope_ref.as_deref()), e.code, &detail)
    })?;
    let scope = &binding.scope_ref;
    let p: Vec<_> = scope.split(':').collect();
    // Canonical ScopeRef validation excludes role-bearing and project-less callers.
    let exact = hrc_cli::validate_scope(scope).is_ok() && p.len() == 6 && p[4] == "task";
    let primary = mable_primary(scope);
    let local = exact
        && p[1] == "mable"
        && server.federation.config.node_id_provenance == "declared"
        && ((p[5] == "minisvc" && server.federation.node_id() == "svc")
            || (p[3] == "hrc-runtime"
                && p[5] == "hrcdev"
                && server.federation.node_id() == "hrcdev"));
    if !primary && !local {
        return Err(refused(
            server,
            action,
            target,
            project(Some(scope)),
            "not_authorized",
            &format!("caller {scope} is not authorized"),
        ));
    }
    Ok(Authorized {
        requested_by: scope.clone(),
        caller_kind: if primary {
            "mable-primary"
        } else {
            "mable-node-local"
        },
        project: project(Some(scope)).to_owned(),
    })
}
pub fn grant(caller: &Authorized, node: &str, action: &str, reason: &str, flags: Value) -> Value {
    json!({"requestId":format!("lifecycle-{}",uuid::Uuid::new_v4()),"requestedBy":caller.requested_by,"callerKind":caller.caller_kind,"originNode":node,"reason":reason,"action":action,"flags":flags})
}
