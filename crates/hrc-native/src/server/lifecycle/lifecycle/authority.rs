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
        .and_then(|s| hrc_common::scope::legacy_project(s))
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
/// How a refusal names the node's own Mable seat, on a node that has one.
fn node_seat_text(node: &str) -> &'static str {
    match node {
        "svc" => ", this node's Mable seat (mable@<project>:minisvc)",
        "hrcdev" => ", this node's Mable seat (mable@hrc-runtime:hrcdev)",
        _ => "",
    }
}
/// A satellite node's own Mable seat: mable@<project>:minisvc on svc,
/// mable@hrc-runtime:hrcdev on hrcdev, and only where the node id is declared.
fn node_mable_seat(server: &Server, scope: &str) -> bool {
    hrc_common::scope::ScopeRef::parse(scope).is_ok_and(|p| {
        p.project.is_some()
            && p.task.is_some()
            && p.role.is_none()
            && p.agent == "mable"
            && server.federation.config.node_id_provenance == "declared"
            && ((p.task == Some("minisvc") && server.federation.node_id() == "svc")
                || (p.project == Some("hrc-runtime")
                    && p.task == Some("hrcdev")
                    && server.federation.node_id() == "hrcdev"))
    })
}
/// lifecycleRefusalText plus the parenthesized detail.
pub fn refusal_text(action: &str, target: &str, project: &str, detail: &str) -> String {
    let node_seat = node_seat_text(target);
    format!(
        "only mable@<project>:primary{node_seat} or Lance may {action} the HRC server on {target}; request it from mable@{project}:primary ({detail})"
    )
}
/// isMablePrimaryScope: a canonical, role-free mable task scope named primary.
pub fn mable_primary(scope: &str) -> bool {
    hrc_common::scope::ScopeRef::parse(scope).is_ok_and(|p| {
        p.agent == "mable" && p.project.is_some() && p.task == Some("primary") && p.role.is_none()
    })
}
/// Operator routes preserve the legacy headerless contract. Any lifecycle
/// header opts into verified owner authority, including partial credentials.
/// Termination additionally permits another runtime belonging to this seat,
/// and any runtime on this node when the caller is the node's own Mable seat.
pub fn authorize_operator(
    server: &Server,
    headers: &HeaderMap,
    action: &str,
    own_runtime: Option<&str>,
) -> Result<(), ApiError> {
    if !headers
        .keys()
        .any(|key| key.as_str().starts_with("x-hrc-lifecycle-"))
    {
        return Ok(());
    }
    let refusal = |code, scope: Option<&str>, detail: &str| {
        error(
            action,
            server.federation.node_id(),
            code,
            format!(
                "only mable@<project>:primary{}{} may {action}; request it from mable@{}:primary ({detail})",
                if own_runtime.is_some() {
                    node_seat_text(server.federation.node_id())
                } else {
                    ""
                },
                if own_runtime.is_some() {
                    " or the runtime's own seat"
                } else {
                    ""
                },
                project(scope),
            ),
        )
    };
    let binding = credentials::verify_caller(server, headers)
        .map_err(|e| refusal(e.code, e.scope_ref.as_deref(), &e.detail))?;
    if mable_primary(&binding.scope_ref) {
        return Ok(());
    }
    if own_runtime.is_some() && node_mable_seat(server, &binding.scope_ref) {
        return Ok(());
    }
    if let Some(id) = own_runtime {
        let store = server.store.lock().unwrap();
        if crate::server::projection::db::runtime(&store.sqlite, id)?
            .is_some_and(|runtime| runtime.scope_ref == binding.scope_ref)
        {
            return Ok(());
        }
    }
    Err(refusal(
        "not_authorized",
        Some(&binding.scope_ref),
        &format!("caller {} is not authorized", binding.scope_ref),
    ))
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
    let primary = mable_primary(scope);
    let local = node_mable_seat(server, scope);
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
