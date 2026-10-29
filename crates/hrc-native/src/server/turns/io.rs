//! GET /v1/attach and GET /v1/capture (server-session-methods.ts
//! handleAttach/handleCapture, runtime-io-handlers.ts).
use super::{
    ApiError, Shared, hrcpty, lease, projection::db, runtime_views, surfaces,
    turns::admission::unavailable,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashMap;

/// parseRuntimeIdQuery
fn runtime_id(query: &HashMap<String, String>) -> Result<String, ApiError> {
    query
        .get("runtimeId")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("runtimeId is required", Some(json!({}))))
}

/// handleAttach: reconcile liveness, then describe the realized execution.
pub async fn attach(
    server: &Shared,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let id = runtime_id(query)?;
    super::runtimes::runtime(server, &id)?;
    lease::reconcile_liveness(server, &id).await?;
    surfaces::descriptor(server, &id, true)
}

/// getBrokerPresentationPane, else requireTmuxPane for a tmux runtime:
/// (socketPath, sessionName, windowName, sessionId, windowId, paneId).
fn presentation_pane(runtime: &Value) -> Result<Option<[String; 6]>, ApiError> {
    if let Some(h) =
        runtime_views::hosting(runtime).filter(|h| h["substrate"]["kind"] == "leased-tmux")
    {
        let window = match h["presentation"]["kind"].as_str() {
            Some("tmux-tui") => Some(("tui", &h["presentation"]["tuiWindow"])),
            Some("observer") => Some(("observer", &h["presentation"]["observerWindow"])),
            _ => None,
        };
        if let Some((name, w)) = window {
            let s = |v: &Value| v.as_str().unwrap_or("").to_owned();
            return Ok(Some([
                s(&h["substrate"]["tmuxSocketPath"]),
                s(&h["substrate"]["sessionName"]),
                w["windowName"].as_str().unwrap_or(name).to_owned(),
                s(&w["sessionId"]),
                s(&w["windowId"]),
                s(&w["paneId"]),
            ]));
        }
    }
    if runtime["transport"] != "tmux" {
        return Ok(None);
    }
    let t = &runtime["tmuxJson"];
    let field = |k: &str| t[k].as_str().map(str::to_owned);
    match (
        field("socketPath"),
        field("sessionName"),
        field("sessionId"),
        field("windowId"),
        field("paneId"),
    ) {
        (Some(socket), Some(session), Some(sid), Some(wid), Some(pid)) => {
            Ok(Some([socket, session, "main".into(), sid, wid, pid]))
        }
        _ => Err(unavailable(
            format!(
                "runtime \"{}\" is missing tmux state",
                runtime["runtimeId"].as_str().unwrap_or("")
            ),
            json!({"runtimeId":runtime["runtimeId"]}),
        )),
    }
}

/// handleCapture → captureRuntime
pub async fn capture(
    server: &Shared,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let id = runtime_id(query)?;
    let runtime = super::runtimes::runtime(server, &id)?;
    let status = runtime["status"].as_str().unwrap_or("");
    if lease::unavailable(status) {
        return Err(unavailable(
            format!("runtime \"{id}\" is {status}"),
            json!({"runtimeId":id,"status":status}),
        ));
    }
    if let Some(socket) = runtime_views::hosting(&runtime)
        .filter(|h| h["substrate"]["kind"] == hrcpty::SUBSTRATE)
        .and_then(|h| h["substrate"]["socketPath"].as_str().map(str::to_owned))
    {
        let captured = hrcpty::capture(std::path::Path::new(&socket)).await?;
        touch(server, &id)?;
        return Ok(Json(json!({"text":captured["text"],"cursor":captured["cursor"],"screen":captured["screen"]})).into_response());
    }
    let Some(pane) = presentation_pane(&runtime)? else {
        return Err(ApiError::bad(
            "cannot capture a non-interactive runtime; use the runtime event stream instead",
            Some(json!({"runtimeId":id,"transport":runtime["transport"]})),
        ));
    };
    let [socket, session, window, sid, wid, pid] = &pane;
    let (ok, stdout, _) = lease::tmux(
        socket,
        &[
            "display-message",
            "-p",
            "-t",
            pid,
            "-F",
            "#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}\t#{window_name}",
        ],
    )
    .await?;
    let observed: Vec<&str> = stdout.trim().split('\t').collect();
    let observed = (ok && observed.len() == 5 && !stdout.trim().is_empty()).then(|| {
        json!({"socketPath":socket,"sessionName":observed[3],"windowName":observed[4],"sessionId":observed[0],"windowId":observed[1],"paneId":observed[2]})
    });
    let expected = json!({"socketPath":socket,"sessionName":session,"windowName":window,"sessionId":sid,"windowId":wid,"paneId":pid});
    if observed.as_ref() != Some(&expected) {
        return Err(unavailable(
            format!("runtime \"{id}\" presentation pane is unavailable or changed"),
            json!({"runtimeId":id,"expected":expected,"observed":observed}),
        ));
    }
    let (ok, text, stderr) = lease::tmux(socket, &["capture-pane", "-t", pid, "-p"]).await?;
    if !ok {
        return Err(anyhow::anyhow!("tmux capture-pane failed: {}", stderr.trim()).into());
    }
    let now = hrc_store::timestamp();
    {
        let db = server.store.lock().unwrap();
        db::update_runtime(
            &db.sqlite,
            &id,
            &db::activity_cols(&db.sqlite, &id, &now, &now)?,
        )?;
    }
    server.ledger_committed();
    Ok(Json(json!({"text":text})).into_response())
}

/// throwCaptureControlError
fn capture_control_error(error: super::controller::submit::BrokerError) -> ApiError {
    if let Some(reason) = error.detail["reason"].as_str() {
        return ApiError::bad(reason.to_owned(), Some(error.detail.clone()));
    }
    let mut detail = json!({"code":error.code});
    if let Value::Object(extra) = &error.detail {
        for (k, v) in extra {
            detail[k] = v.clone();
        }
    }
    unavailable(error.message, detail)
}

/// POST /v1/runtimes/capture/status (handleBrokerCaptureStatus)
pub async fn capture_status(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let id = body["runtimeId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad("runtimeId is required", Some(json!({}))))?
        .to_owned();
    super::runtimes::runtime(server, &id)?;
    let (_, snapshot) = super::controller::submit::with_active(
        server,
        &id,
        "invocation.snapshot",
        |i| json!({"invocationId":i}),
        (
            "broker_capture_status_failed",
            "broker_capture_status_timeout",
        ),
        false,
    )
    .await
    .map_err(capture_control_error)?;
    let mut out = json!({"runtimeId":id});
    if let Some(capture) = snapshot.get("capture") {
        super::controller::project_capture_state(server, &id, capture)?;
        server.ledger_committed();
        out["capture"] = capture.clone();
    }
    Ok(Json(out).into_response())
}

/// rehydrateInspectionCapabilities: the hello's inspection capabilities as
/// persisted on the runtime.
fn inspection(runtime: &Value) -> Option<Value> {
    let i = runtime["runtimeStateJson"]["broker"]["inspection"].clone();
    let flags = [
        "listInvocations",
        "timestamps",
        "lifecycleView",
        "eventTypeFilter",
    ];
    (flags.iter().all(|f| i[f].is_boolean())
        && matches!(i["liveness"].as_str(), Some("none" | "cached" | "probe")))
    .then_some(i)
}

/// POST /v1/runtimes/broker/inspect (handleBrokerInspect). Read-only.
pub async fn broker_inspect(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let input = match &body {
        Value::Object(m) => m.clone(),
        Value::Array(_) => serde_json::Map::new(),
        _ => {
            return Err(ApiError::bad(
                "request body must be an object",
                Some(json!({})),
            ));
        }
    };
    let id = input
        .get("runtimeId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("runtimeId is required", Some(json!({"field":"runtimeId"}))))?
        .to_owned();
    if let Some(v) = input.get("ownerRunId")
        && !v.as_str().is_some_and(|s| !s.trim().is_empty())
    {
        return Err(ApiError::bad(
            "ownerRunId must be a string",
            Some(json!({"field":"ownerRunId"})),
        ));
    }
    let mut flags = HashMap::new();
    for field in ["probeLiveness", "includeDisposed", "includeInvocations"] {
        match input.get(field) {
            None => {}
            Some(Value::Bool(b)) => {
                flags.insert(field, *b);
            }
            Some(_) => {
                return Err(ApiError::bad(
                    format!("{field} must be a boolean"),
                    Some(json!({"field":field})),
                ));
            }
        }
    }
    if let Some(recover) = input.get("recoverFinalSummary") {
        if !recover.is_object() && !recover.is_array() {
            return Err(ApiError::bad(
                "recoverFinalSummary must be an object",
                Some(json!({"field":"recoverFinalSummary"})),
            ));
        }
        if let Some(t) = recover.get("timeoutMs")
            && !t.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
        {
            return Err(ApiError::bad(
                "recoverFinalSummary.timeoutMs must be a non-negative number",
                Some(json!({"field":"recoverFinalSummary.timeoutMs"})),
            ));
        }
    }
    let mut runtime = super::runtimes::runtime(server, &id)?;
    let mut final_summary = runtime["runtimeStateJson"].get("finalSummary").cloned();
    let recovery = match input.get("recoverFinalSummary") {
        None => None,
        Some(_) if final_summary.is_some() => Some(json!({"state":"not_needed"})),
        Some(_) if runtime["controllerKind"] != "harness-broker" => {
            Some(json!({"state":"not_broker"}))
        }
        // No report path connects to a terminal runtime's broker: its retained
        // evidence is read offline instead, bounded by timeoutMs (750).
        Some(r) if runtime["status"] == "terminated" || runtime["status"] == "failed" => {
            let timeout = r["timeoutMs"].as_f64().unwrap_or(750.0).max(0.0);
            let attempt = tokio::spawn({
                let (server, id) = (server.clone(), id.clone());
                async move { super::retained::recover(&server, &id, "report").await }
            });
            let settled =
                tokio::time::timeout(std::time::Duration::from_millis(timeout as u64), attempt)
                    .await;
            runtime = super::runtimes::runtime(server, &id)?;
            final_summary = runtime["runtimeStateJson"].get("finalSummary").cloned();
            Some(match (&final_summary, settled) {
                (Some(_), _) => json!({"state":"recovered"}),
                (None, Err(_)) => {
                    json!({"state":"timeout","message":format!("summary recovery exceeded {timeout}ms")})
                }
                (None, Ok(done)) => {
                    let outcome = done
                        .ok()
                        .and_then(Result::ok)
                        .flatten()
                        .and_then(|r| r["outcome"].as_str().map(str::to_owned));
                    json!({"state":"unavailable","message":outcome.unwrap_or_else(|| "unknown_runtime".into())})
                }
            })
        }
        Some(r) => {
            let timeout = r["timeoutMs"].as_f64().unwrap_or(750.0).max(0.0);
            let result = super::controller::recover_final_summary(server, &runtime, timeout).await;
            runtime = super::runtimes::runtime(server, &id)?;
            final_summary = runtime["runtimeStateJson"].get("finalSummary").cloned();
            Some(result)
        }
    };
    let mut out = json!({"runtimeId":id,"transport":runtime["transport"]});
    if let Some(h) = runtime.get("harness").filter(|h| !h.is_null()) {
        out["harness"] = h.clone();
    }
    out["status"] = runtime["status"].clone();
    out["lastActivityAt"] = runtime
        .get("lastActivityAt")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(s) = final_summary {
        out["finalSummary"] = s;
    }
    if let Some(r) = recovery {
        out["finalSummaryRecovery"] = r;
    }
    let retained = runtime_views::retained_evidence(server, &id)?;
    if !retained.is_empty() {
        out["retainedEvidence"] = json!(retained);
    }
    if runtime["controllerKind"] != "harness-broker" {
        out["source"] = "hrc-derived".into();
        out["lifecycle"] = json!({"retention":{"mode":"db-only"}});
        out["note"] = "HRC-runtime-derived, not broker-reported".into();
        return Ok(Json(out).into_response());
    }
    out["source"] = "broker".into();
    if flags.get("includeInvocations") == Some(&false) {
        return Ok(Json(out).into_response());
    }
    let inspection = inspection(&runtime);
    let mut invocations = json!([]);
    if super::controller::active(server, &id).is_some()
        && inspection
            .as_ref()
            .is_some_and(|i| i["listInvocations"] == true)
    {
        let mut request = json!({});
        if let Some(d) = flags.get("includeDisposed") {
            request["includeDisposed"] = (*d).into();
        }
        let probe_allowed = inspection.as_ref().is_none_or(|i| i["liveness"] == "probe");
        if flags.get("probeLiveness") == Some(&true) && probe_allowed {
            request["probeLiveness"] = true.into();
        }
        if let Ok((_, response)) = super::controller::submit::with_active(
            server,
            &id,
            "broker.listInvocations",
            |_| request,
            (
                "broker_list_invocations_failed",
                "broker_list_invocations_timeout",
            ),
            true,
        )
        .await
            && response["invocations"].is_array()
        {
            invocations = response["invocations"].clone();
        }
    }
    out["invocations"] = invocations;
    Ok(Json(out).into_response())
}

/// parseSelectorRequest: (body, selector.sessionRef).
pub fn selector_request(
    body: &Value,
) -> Result<(serde_json::Map<String, Value>, String), ApiError> {
    let map = match body {
        Value::Object(m) => m.clone(),
        Value::Array(_) => serde_json::Map::new(),
        _ => return Err(ApiError::bad("selector is required", Some(json!({})))),
    };
    if !matches!(
        map.get("selector"),
        Some(Value::Object(_) | Value::Array(_))
    ) {
        return Err(ApiError::bad("selector is required", Some(json!({}))));
    }
    let session_ref = map["selector"]["sessionRef"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "selector.sessionRef is required",
                Some(json!({"field":"selector.sessionRef"})),
            )
        })?
        .to_owned();
    Ok((map, session_ref))
}
/// formatSelectorRef
pub fn selector_ref(session: &Value) -> String {
    let lane = hrc_store::storage_lane(session["laneRef"].as_str().unwrap_or(""));
    format!(
        "{}/lane:{}",
        session["scopeRef"].as_str().unwrap_or(""),
        if lane == "default" { "main" } else { lane }
    )
}
pub fn unknown_session(session_ref: &str) -> ApiError {
    ApiError::domain(
        axum::http::StatusCode::NOT_FOUND,
        "unknown_session",
        format!("unknown session \"{session_ref}\""),
        Some(json!({"sessionRef":session_ref})),
    )
}
/// findBoundSessionRuntime: the latest available tmux runtime, else the latest
/// available one, else the latest.
fn bound_runtime(server: &Shared, host: &str) -> Result<Option<db::Rt>, ApiError> {
    let db = server.store.lock().unwrap();
    let ids: Vec<String> = db
        .sqlite
        .prepare("SELECT runtime_id FROM runtimes WHERE host_session_id=? ORDER BY created_at ASC, runtime_id ASC")
        .map_err(anyhow::Error::from)?
        .query_map([host], |r| r.get(0))
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<_>>()
        .map_err(anyhow::Error::from)?;
    let mut all = Vec::new();
    for id in ids {
        if let Some(rt) = db::runtime(&db.sqlite, &id)? {
            all.push(rt);
        }
    }
    let pick = all
        .iter()
        .rfind(|r| r.transport == "tmux" && !lease::unavailable(&r.status))
        .or_else(|| all.iter().rfind(|r| !lease::unavailable(&r.status)))
        .or(all.last())
        .cloned();
    Ok(pick)
}

/// POST /v1/capture/by-selector (handleCaptureBySelector)
pub async fn capture_by_selector(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let (body, session_ref) = selector_request(&body)?;
    let Some(session) = runtime_views::find_target_session(server, &session_ref)? else {
        return Err(unknown_session(&session_ref));
    };
    let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
    let Some(rt) = bound_runtime(server, &host)?.filter(|r| !lease::unavailable(&r.status)) else {
        return Err(unavailable(
            "no capturable runtime is currently bound",
            json!({"sessionRef":session_ref,"hostSessionId":host}),
        ));
    };
    let lines = body.get("lines").and_then(Value::as_f64);
    let mut text = if rt.transport == "sdk" || rt.transport == "headless" {
        let limit = lines
            .filter(|l| l.is_finite() && *l > 0.0)
            .map(|l| (l.ceil() as i64 * 32).clamp(32, 8_192));
        let db = server.store.lock().unwrap();
        // LIMIT -1 is unbounded: the whole buffer in order.
        let mut stmt = db
            .sqlite
            .prepare("SELECT text FROM (SELECT text, created_at, chunk_seq FROM runtime_buffers WHERE runtime_id=?1 ORDER BY created_at DESC, chunk_seq DESC LIMIT ?2) ORDER BY created_at ASC, chunk_seq ASC")
            .map_err(anyhow::Error::from)?;
        let rows = stmt
            .query_map(rusqlite::params![rt.runtime_id, limit.unwrap_or(-1)], |r| {
                r.get::<_, String>(0)
            })
            .map_err(anyhow::Error::from)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(anyhow::Error::from)?;
        rows.concat()
    } else if let Some((socket, _)) = hrcpty::substrate(&rt) {
        let captured = hrcpty::capture(&socket).await?;
        captured["text"].as_str().unwrap_or("").to_owned()
    } else {
        let pane = rt.tmux.as_ref();
        let field = |k: &str| pane.and_then(|t| t[k].as_str()).map(str::to_owned);
        let (Some(socket), Some(_), Some(_), Some(_), Some(pane_id)) = (
            field("socketPath"),
            field("sessionName"),
            field("sessionId"),
            field("windowId"),
            field("paneId"),
        ) else {
            return Err(unavailable(
                format!("runtime \"{}\" is missing tmux state", rt.runtime_id),
                json!({"runtimeId":rt.runtime_id}),
            ));
        };
        let (ok, out, stderr) =
            lease::tmux(&socket, &["capture-pane", "-t", &pane_id, "-p"]).await?;
        if !ok {
            return Err(anyhow::anyhow!("tmux capture-pane failed: {}", stderr.trim()).into());
        }
        out
    };
    if let Some(l) = lines.filter(|l| *l > 0.0) {
        // allLines.slice(-lines): a fractional count truncates toward zero.
        let all: Vec<&str> = text.split('\n').collect();
        let keep = (l.trunc() as usize).min(all.len());
        text = if keep == 0 {
            all.join("\n")
        } else {
            all[all.len() - keep..].join("\n")
        };
    }
    let now = hrc_store::timestamp();
    {
        let db = server.store.lock().unwrap();
        db::update_runtime(
            &db.sqlite,
            &rt.runtime_id,
            &db::activity_cols(&db.sqlite, &rt.runtime_id, &now, &now)?,
        )?;
    }
    server.ledger_committed();
    Ok(
        Json(json!({"text":text,"sessionRef":selector_ref(&session),"runtimeId":rt.runtime_id}))
            .into_response(),
    )
}

/// Stamp capture activity on the runtime (the tmux capture's own write).
fn touch(server: &Shared, id: &str) -> Result<(), ApiError> {
    let now = hrc_store::timestamp();
    {
        let db = server.store.lock().unwrap();
        db::update_runtime(
            &db.sqlite,
            id,
            &db::activity_cols(&db.sqlite, id, &now, &now)?,
        )?;
    }
    server.ledger_committed();
    Ok(())
}
