//! Operator attach descriptors and durable UI surface fences.
use super::{ApiError, Server, runtime_views, runtimes};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{env, os::unix::fs::PermissionsExt, path::PathBuf};
fn text<'a>(body: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    body[key]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad(format!("{key} is required"), Some(json!({"field":key}))))
}
fn unavailable(message: impl Into<String>, detail: Value) -> ApiError {
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        message,
        Some(detail),
    )
}
fn optional_text(body: &Value, key: &str, allow_empty: bool) -> Result<Option<String>, ApiError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::String(v)) if allow_empty || !v.trim().is_empty() => {
            Ok(if v.trim().is_empty() {
                None
            } else {
                Some(v.trim().to_owned())
            })
        }
        _ => Err(ApiError::bad(
            format!("{key} must be a string"),
            Some(json!({"field":key})),
        )),
    }
}
fn object(body: &Value) -> Result<(), ApiError> {
    if !body.is_object() && !body.is_array() {
        Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ))
    } else {
        Ok(())
    }
}
fn is_unavailable(runtime: &Value) -> bool {
    ["terminated", "dead", "stale", "crashed", "detached"]
        .iter()
        .any(|s| runtime["status"] == *s)
}
fn tmux_binary() -> String {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|v| env::split_paths(&v).collect::<Vec<_>>())
        .map(|p| p.join("tmux"))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
        .unwrap_or_else(|| PathBuf::from("tmux"))
        .to_string_lossy()
        .into_owned()
}
pub fn attach(server: &Server, body: Value) -> Result<Response, ApiError> {
    object(&body)?;
    let id = text(&body, "runtimeId")?;
    optional_text(&body, "ownerRunId", false)?;
    descriptor(server, id, false)
}
/// attachRuntimeEffectfully over an already-reconciled runtime; `strict` marks
/// the GET /v1/attach door (strictRuntimeId on the replacement refusal).
pub fn descriptor(server: &Server, id: &str, strict: bool) -> Result<Response, ApiError> {
    Ok(Json(descriptor_value(server, id, strict)?).into_response())
}
/// attachRuntime's descriptor body.
pub fn descriptor_value(server: &Server, id: &str, strict: bool) -> Result<Value, ApiError> {
    let runtime = runtimes::runtime(server, id)?;
    let detail = json!({"runtimeId":id,"transport":runtime["transport"]});
    if runtime["transport"] == "sdk" {
        return Err(unavailable(
            "attach is only available for interactive runtimes",
            detail,
        ));
    }
    // Pending-start serialization and controller event reconciliation belong to
    // the N2 controller; this consumes the already-realized hosting state.
    if is_unavailable(&runtime)
        || (runtime["controllerKind"] == "harness-broker" && runtime["status"] == "failed")
    {
        let mut detail = json!({"runtimeId":id,"hostSessionId":runtime["hostSessionId"],"transport":runtime["transport"],"replacementRequired":true});
        if let Some(kind) = runtime.get("controllerKind") {
            detail["controllerKind"] = kind.clone();
        }
        if strict {
            detail["strictRuntimeId"] = true.into();
        }
        return Err(unavailable(
            "runtime cannot be attached without replacing it",
            detail,
        ));
    }
    let tmux = &runtime["tmuxJson"];
    let hosting = runtime_views::hosting(&runtime);
    let operator = hosting
        .as_ref()
        .is_some_and(|h| h["presentation"]["kind"] != "none");
    let (socket, target) = if runtime["controllerKind"] == "harness-broker"
        && (runtime["transport"] == "tmux" || operator)
    {
        let socket=tmux["socketPath"].as_str().filter(|s|!s.is_empty()).or_else(||hosting.as_ref().and_then(|h|if h["substrate"]["kind"]=="leased-tmux"{h["substrate"]["tmuxSocketPath"].as_str()}else{None})).or_else(||runtime["runtimeStateJson"]["tmux"]["socketPath"].as_str().filter(|s|!s.is_empty())).ok_or_else(||unavailable(format!("broker runtime \"{id}\" is missing tmux socket state"),json!({"runtimeId":id,"transport":runtime["transport"],"controllerKind":runtime["controllerKind"]})))?;
        let name = tmux["sessionName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                hosting.as_ref().and_then(|h| {
                    if h["presentation"]["kind"] == "tmux-tui"
                        && h["substrate"]["kind"] == "leased-tmux"
                    {
                        h["substrate"]["sessionName"].as_str()
                    } else {
                        None
                    }
                })
            })
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "hrc-{}",
                    runtime["hostSessionId"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(12)
                        .collect::<String>()
                )
            });
        let window = tmux["windowName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                if hosting.as_ref().is_some_and(|h| {
                    h["presentation"]["kind"] == "tmux-tui"
                        && h["substrate"]["kind"] == "leased-tmux"
                }) {
                    Some("tui")
                } else {
                    None
                }
            });
        (
            socket.to_owned(),
            if let Some(window) = window {
                format!("{name}:{window}")
            } else {
                name
            },
        )
    } else {
        if runtime["transport"] != "tmux" {
            return Err(unavailable(
                "attach is only available for interactive runtimes",
                detail,
            ));
        }
        // Legacy tmux descriptor state is already realized. Never compile or
        // replace a runtime just to answer an attachment request.
        let name = tmux["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                unavailable(
                    format!("runtime \"{id}\" is missing tmux pane state"),
                    json!({"runtimeId":id}),
                )
            })?;
        (
            server
                .runtime
                .join("tmux.sock")
                .to_string_lossy()
                .into_owned(),
            name.to_owned(),
        )
    };
    let mut fence = json!({"hostSessionId":runtime["hostSessionId"],"runtimeId":runtime["runtimeId"],"generation":runtime["generation"]});
    for key in ["windowId", "paneId"] {
        if let Some(v) = tmux
            .get(key)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            fence[key] = v.clone();
        }
    }
    Ok(
        json!({"transport":"tmux","argv":[tmux_binary(),"-S",socket,"attach-session","-t",target],"bindingFence":fence}),
    )
}
pub fn bind(server: &Server, body: Value) -> Result<Response, ApiError> {
    object(&body)?;
    let mut parsed = json!({});
    for key in ["surfaceKind", "surfaceId"] {
        parsed[key] = text(&body, key)?.into();
    }
    if let Some(v) = optional_text(&body, "clientTty", false)? {
        parsed["clientTty"] = v.into();
    }
    for key in ["runtimeId", "hostSessionId"] {
        parsed[key] = text(&body, key)?.into();
    }
    let generation = body["generation"]
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0)
        .ok_or_else(|| {
            ApiError::bad(
                "generation is required",
                Some(json!({"field":"generation"})),
            )
        })?;
    parsed["generation"] = json!(generation as i64);
    for key in ["windowId", "paneId"] {
        if let Some(v) = optional_text(&body, key, true)? {
            parsed[key] = v.into();
        }
    }
    let id = parsed["runtimeId"].as_str().unwrap();
    let runtime = runtimes::runtime(server, id)?;
    if is_unavailable(&runtime) {
        return Err(unavailable(
            format!(
                "runtime \"{id}\" is {}",
                runtime["status"].as_str().unwrap_or("unknown")
            ),
            json!({"runtimeId":id,"status":runtime["status"]}),
        ));
    }
    if runtime["hostSessionId"] != parsed["hostSessionId"]
        || runtime["generation"] != parsed["generation"]
    {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            "surface bind fence no longer matches runtime state",
            Some(
                json!({"runtimeId":id,"expectedHostSessionId":parsed["hostSessionId"],"actualHostSessionId":runtime["hostSessionId"],"expectedGeneration":parsed["generation"],"actualGeneration":runtime["generation"]}),
            ),
        ));
    }
    Ok(Json(
        server
            .store
            .lock()
            .unwrap()
            .bind_surface(&parsed, &runtime)?,
    )
    .into_response())
}
