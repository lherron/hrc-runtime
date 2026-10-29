//! POST /v1/interrupt and /v1/terminate (server-session-methods.ts
//! handleInterrupt/handleTerminate, runtime-control-handlers/interrupt-terminate.ts,
//! broker-dispose.ts, bc-rpc.ts dispose).
use super::{
    ApiError, Shared, controller, hrcpty, lease,
    projection::{db, events},
    turns::admission::unavailable,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::time::Duration;

const DISPOSE_TIMEOUT: Duration = Duration::from_millis(15_000);

struct Action {
    runtime_id: String,
    owner_run_id: Option<String>,
}
#[derive(Default)]
struct Terminate {
    drop_continuation: Option<bool>,
    reason: Option<String>,
    source: Option<String>,
    actor: Option<String>,
}

fn bad(message: String, field: &str) -> ApiError {
    ApiError::bad(message, Some(json!({"field":field})))
}
/// isRecord: any non-null object, an array included (its fields read as absent).
fn object(body: &Value) -> Result<Map<String, Value>, ApiError> {
    match body {
        Value::Object(m) => Ok(m.clone()),
        Value::Array(_) => Ok(Map::new()),
        _ => Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        )),
    }
}
/// parseRuntimeActionBody
fn action(body: &Value) -> Result<Action, ApiError> {
    let input = object(body)?;
    let runtime_id = input
        .get("runtimeId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("runtimeId is required".into(), "runtimeId"))?;
    let owner_run_id = match input.get("ownerRunId") {
        None => None,
        Some(v) => Some(
            v.as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| bad("ownerRunId must be a string".into(), "ownerRunId"))?
                .to_owned(),
        ),
    };
    Ok(Action {
        runtime_id: runtime_id.to_owned(),
        owner_run_id,
    })
}
/// parseTerminateRuntimeRequest
fn terminate_options(body: &Value) -> Result<Terminate, ApiError> {
    let input = object(body)?;
    let raw = |field: &str| match input.get(field) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(bad(format!("{field} must be a string"), field)),
    };
    let drop_continuation = match input.get("dropContinuation") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            return Err(bad(
                "dropContinuation must be a boolean".into(),
                "dropContinuation",
            ));
        }
    };
    Ok(Terminate {
        drop_continuation,
        reason: raw("reason")?,
        source: raw("source")?,
        actor: raw("actor")?,
    })
}

/// requireKnownRuntime
fn known(server: &Shared, runtime_id: &str) -> Result<db::Rt, ApiError> {
    let db = server.store.lock().unwrap();
    db::runtime(&db.sqlite, runtime_id)?.ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_runtime",
            format!("unknown runtime \"{runtime_id}\""),
            Some(json!({"runtimeId":runtime_id})),
        )
    })
}
/// requireRuntime: a known runtime in an available status.
fn available(rt: db::Rt) -> Result<db::Rt, ApiError> {
    if lease::unavailable(&rt.status) {
        return Err(unavailable(
            format!("runtime \"{}\" is {}", rt.runtime_id, rt.status),
            json!({"runtimeId":rt.runtime_id,"status":rt.status}),
        ));
    }
    Ok(rt)
}
/// sessionEventBase over requireSession.
fn session_event(db: &Connection, rt: &db::Rt, now: &str) -> Result<events::Ev, ApiError> {
    let row = db
        .query_row(
            "SELECT scope_ref, lane_ref, generation FROM sessions WHERE host_session_id=?",
            [&rt.host_session_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(anyhow::Error::from)?;
    let Some((scope_ref, lane_ref, generation)) = row else {
        return Err(ApiError::missing_host(&rt.host_session_id));
    };
    Ok(events::Ev {
        ts: now.to_owned(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref,
        lane_ref,
        generation,
        runtime_id: Some(rt.runtime_id.clone()),
        ..Default::default()
    })
}
/// requireTmuxPane: (socketPath, sessionName, paneId).
fn tmux_pane(rt: &db::Rt) -> Result<(String, String, String), ApiError> {
    let field = |k: &str| {
        rt.tmux
            .as_ref()
            .and_then(|t| t[k].as_str())
            .map(str::to_owned)
    };
    match (
        field("sessionName"),
        field("sessionId"),
        field("windowId"),
        field("paneId"),
        field("socketPath"),
    ) {
        (Some(session), Some(_), Some(_), Some(pane), Some(socket)) => Ok((socket, session, pane)),
        _ => Err(unavailable(
            format!("runtime \"{}\" is missing tmux state", rt.runtime_id),
            json!({"runtimeId":rt.runtime_id}),
        )),
    }
}
fn action_response(rt: &db::Rt) -> Value {
    json!({"ok":true,"hostSessionId":rt.host_session_id,"runtimeId":rt.runtime_id})
}
fn commit(
    server: &Shared,
    f: impl FnOnce(&Connection) -> anyhow::Result<()>,
) -> Result<(), ApiError> {
    let db = server.store.lock().unwrap();
    let tx = db
        .sqlite
        .unchecked_transaction()
        .map_err(anyhow::Error::from)?;
    f(&tx)?;
    tx.commit().map_err(anyhow::Error::from)?;
    drop(db);
    server.ledger_committed();
    Ok(())
}
fn touch(db: &Connection, runtime_id: &str, now: &str) -> anyhow::Result<()> {
    db::update_runtime(
        db,
        runtime_id,
        &db::activity_cols(db, runtime_id, now, now)?,
    )
}

pub async fn interrupt(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let body = action(&body)?;
    let rt = available(known(server, &body.runtime_id)?)?;
    if let Some(owner) = &body.owner_run_id
        && rt.active_run_id.as_ref() != Some(owner)
    {
        let mut out = action_response(&rt);
        out["warning"] = if rt.active_run_id.is_none() {
            "owned run is no longer active; interrupt skipped"
        } else {
            "another run is active; interrupt skipped"
        }
        .into();
        return Ok(Json(out).into_response());
    }
    if let Some((socket, _)) = hrcpty::substrate(&rt) {
        {
            let db = server.store.lock().unwrap();
            session_event(&db.sqlite, &rt, "")?;
        }
        hrcpty::interrupt(&socket).await?;
        let now = hrc_store::timestamp();
        commit(server, |db| {
            touch(db, &rt.runtime_id, &now)?;
            let ev = session_event(db, &rt, &now).map_err(|e| anyhow::anyhow!(e.message))?;
            events::append(
                db,
                "runtime.interrupted",
                &ev,
                &json!({"transport":"hrcpty","socketPath":socket}),
            )?;
            Ok(())
        })?;
        return Ok(Json(action_response(&rt)).into_response());
    }
    if rt.transport == "tmux" {
        let (socket, _, pane) = tmux_pane(&rt)?;
        {
            let db = server.store.lock().unwrap();
            session_event(&db.sqlite, &rt, "")?;
        }
        let (ok, _, stderr) = lease::tmux(&socket, &["send-keys", "-t", &pane, "C-c"]).await?;
        if !ok {
            return Err(anyhow::anyhow!("tmux send-keys failed: {}", stderr.trim()).into());
        }
        let now = hrc_store::timestamp();
        commit(server, |db| {
            touch(db, &rt.runtime_id, &now)?;
            let mut ev = session_event(db, &rt, &now).map_err(|e| anyhow::anyhow!(e.message))?;
            ev.transport = Some("tmux".into());
            events::append(
                db,
                "runtime.interrupted",
                &ev,
                &json!({"transport":"tmux","paneId":pane}),
            )?;
            Ok(())
        })?;
        return Ok(Json(action_response(&rt)).into_response());
    }
    interrupt_headless(server, &rt).await
}

fn audit_transport(rt: &db::Rt) -> &'static str {
    if rt.transport == "headless" {
        "headless"
    } else {
        "sdk"
    }
}

async fn interrupt_headless(server: &Shared, rt: &db::Rt) -> Result<Response, ApiError> {
    {
        let db = server.store.lock().unwrap();
        session_event(&db.sqlite, rt, "")?;
    }
    let Some(run_id) = rt.active_run_id.clone() else {
        let mut out = action_response(rt);
        out["warning"] = "no active run to interrupt".into();
        return Ok(Json(out).into_response());
    };
    let transport = audit_transport(rt);
    let broker = rt.controller_kind.as_deref() == Some("harness-broker");
    if broker {
        let generation = rt.generation;
        if let Err(error) = controller::submit::with_active(
            server,
            &rt.runtime_id,
            "invocation.interrupt",
            |invocation| json!({"invocationId":invocation,"scope":"turn","runId":run_id,"generation":generation}),
            ("broker_interrupt_failed", "broker_interrupt_timeout"),
            false,
        )
        .await
        {
            return Err(unavailable(
                error.message,
                json!({"runtimeId":rt.runtime_id,"runId":run_id,"generation":rt.generation,"brokerErrorCode":error.code}),
            ));
        }
    }
    let now = hrc_store::timestamp();
    commit(server, |db| {
        if !broker {
            db::mark_run_completed(
                db,
                &run_id,
                db::Completion {
                    status: "cancelled",
                    completed_at: &now,
                    updated_at: &now,
                    error_code: None,
                    error_message: None,
                },
            )?;
            db.execute(
                "UPDATE runtimes SET active_run_id=NULL, updated_at=? WHERE runtime_id=?",
                params![now, rt.runtime_id],
            )?;
            let mut cols = vec![
                ("status", db::text("ready")),
                ("status_changed_at", db::text(now.as_str())),
            ];
            cols.extend(db::activity_cols(db, &rt.runtime_id, &now, &now)?);
            db::update_runtime(db, &rt.runtime_id, &cols)?;
        } else {
            touch(db, &rt.runtime_id, &now)?;
        }
        let mut ev = session_event(db, rt, &now).map_err(|e| anyhow::anyhow!(e.message))?;
        ev.run_id = Some(run_id.clone());
        ev.transport = Some(transport.into());
        let mut payload = json!({"transport":transport,"runId":run_id});
        if broker {
            payload["controllerKind"] = "harness-broker".into();
        }
        events::append(db, "runtime.interrupted", &ev, &payload)?;
        Ok(())
    })?;
    Ok(Json(action_response(rt)).into_response())
}

pub async fn terminate(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let action = action(&body)?;
    let options = terminate_options(&body)?;
    let known = known(server, &action.runtime_id)?;
    let external = controller::is_external_lifecycle_owner(&known);
    let rt = if external { known } else { available(known)? };
    if let Some(owner) = action.owner_run_id.as_deref().filter(|_| !external) {
        let protected = {
            let db = server.store.lock().unwrap();
            protected_owners(&db.sqlite, &rt.runtime_id, owner)?
        };
        if !protected.is_empty() {
            let mut out = action_response(&rt);
            out["droppedContinuation"] = false.into();
            out["warning"] = format!(
                "runtime preserved for other protected work: {}",
                protected.join(", ")
            )
            .into();
            return Ok(Json(out).into_response());
        }
        // Close the runtime to later admission before disposal awaits.
        let now = hrc_store::timestamp();
        commit(server, |db| {
            if let Some(invocation) = &rt.active_invocation_id {
                db::update_invocation(
                    db,
                    invocation,
                    &[
                        ("invocation_state", db::text("stopping")),
                        ("updated_at", db::text(now.as_str())),
                    ],
                )?;
            }
            db::update_runtime(
                db,
                &rt.runtime_id,
                &[
                    ("status", db::text("stopping")),
                    ("status_changed_at", db::text(now.as_str())),
                    ("updated_at", db::text(now.as_str())),
                ],
            )
        })?;
    }
    terminate_runtime(server, &rt, options).await
}

/// Other durable active runs, then protected format-2 inputs, deduplicated.
fn protected_owners(db: &Connection, runtime_id: &str, owner: &str) -> anyhow::Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut runs = db.prepare(
        "SELECT run_id FROM runs WHERE runtime_id=? AND status IN ('accepted','started','running') ORDER BY accepted_at ASC, run_id ASC",
    )?;
    let mut inputs = db.prepare(
        "SELECT input_id FROM inputs WHERE runtime_id=? AND cleanup_protection='protected' ORDER BY created_at ASC, input_id ASC",
    )?;
    let ids = runs
        .query_map([runtime_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|id| id != owner)
        .chain(
            inputs
                .query_map([runtime_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// terminateRuntime: external owners, tmux, then headless.
async fn terminate_runtime(
    server: &Shared,
    rt: &db::Rt,
    o: Terminate,
) -> Result<Response, ApiError> {
    if controller::is_external_lifecycle_owner(rt) {
        return Err(unavailable(
            "external participant terminate is not yet served natively",
            json!({"runtimeId":rt.runtime_id}),
        ));
    }
    let tmux = rt.transport == "tmux";
    let broker = rt.controller_kind.as_deref() == Some("harness-broker");
    let now = hrc_store::timestamp();
    {
        let db = server.store.lock().unwrap();
        session_event(&db.sqlite, rt, &now)?;
    }
    let pane = if tmux { Some(tmux_pane(rt)?) } else { None };
    let dropped = if tmux {
        o.drop_continuation == Some(true)
    } else {
        o.drop_continuation.unwrap_or(rt.active_run_id.is_some())
    };
    let mut response = action_response(rt);
    response["droppedContinuation"] = dropped.into();
    if dropped {
        commit(server, |db| {
            db.execute(
                "UPDATE sessions SET continuation_reuse_disabled=1, updated_at=? WHERE host_session_id=?",
                params![now, rt.host_session_id],
            )?;
            Ok(())
        })?;
    }
    // A repeated tmux terminate re-runs no teardown and appends no second audit.
    if tmux && rt.status == "terminated" {
        return Ok(Json(response).into_response());
    }
    let _terminating = controller::begin_terminating(server, &rt.runtime_id);
    let leased = broker && lease::has_leased_tmux(rt);
    if broker && (tmux || leased || rt.active_invocation_id.is_some()) {
        dispose_logged(
            server,
            &rt.runtime_id,
            o.reason.as_deref(),
            if tmux {
                "broker runtime dispose failed during tmux terminate"
            } else if leased {
                "broker runtime dispose failed during tmux-tui terminate"
            } else {
                "broker runtime dispose failed during headless terminate"
            },
        )
        .await;
    }
    if broker && (tmux || leased) {
        lease::teardown(
            server,
            rt,
            if tmux {
                "broker leased tmux teardown failed during tmux terminate"
            } else {
                "broker leased tmux teardown failed during terminate"
            },
        )
        .await;
    } else if let Some((socket, session, _)) = &pane {
        let (exists, _, _) = lease::tmux(socket, &["has-session", "-t", session]).await?;
        if exists {
            lease::tmux(socket, &["kill-session", "-t", session]).await?;
        }
    }
    let transport = if tmux { "tmux" } else { audit_transport(rt) };
    commit(server, |db| {
        finalize(db, rt, &now)?;
        if !tmux {
            settle_disposed(db, rt, &now)?;
        }
        let mut ev = session_event(db, rt, &now).map_err(|e| anyhow::anyhow!(e.message))?;
        ev.transport = Some(transport.into());
        let mut payload = json!({"transport":transport});
        if let Some((_, session, _)) = &pane {
            payload["sessionName"] = session.as_str().into();
        }
        payload["droppedContinuation"] = dropped.into();
        for (key, value) in [
            ("reason", &o.reason),
            ("source", &o.source),
            ("actor", &o.actor),
        ] {
            if let Some(v) = value {
                payload[key] = v.as_str().into();
            }
        }
        events::append(db, "runtime.terminated", &ev, &payload)?;
        Ok(())
    })?;
    Ok(Json(response).into_response())
}

/// finalizeRuntimeTermination
pub(super) fn finalize(db: &Connection, rt: &db::Rt, now: &str) -> anyhow::Result<()> {
    if let Some(run) = &rt.active_run_id {
        db.execute(
            "UPDATE runtimes SET active_run_id=NULL, updated_at=? WHERE runtime_id=?",
            params![now, rt.runtime_id],
        )?;
        db::mark_run_completed(
            db,
            run,
            db::Completion {
                status: "failed",
                completed_at: now,
                updated_at: now,
                error_code: Some("runtime_unavailable"),
                error_message: Some(&format!("runtime {} was terminated", rt.runtime_id)),
            },
        )?;
    }
    db::update_runtime(
        db,
        &rt.runtime_id,
        &[
            ("status", db::text("terminated")),
            ("status_changed_at", db::text(now)),
            ("updated_at", db::text(now)),
        ],
    )
}
/// settleBrokerRuntimeDisposed
fn settle_disposed(db: &Connection, rt: &db::Rt, now: &str) -> anyhow::Result<()> {
    if rt.controller_kind.as_deref() != Some("harness-broker") {
        return Ok(());
    }
    if let Some(id) = &rt.active_invocation_id
        && let Some(inv) = db::invocation(db, id)?
        && !matches!(
            inv.invocation_state.as_str(),
            "exited" | "failed" | "disposed"
        )
    {
        db::update_invocation(
            db,
            id,
            &[
                ("invocation_state", db::text("disposed")),
                ("updated_at", db::text(now)),
            ],
        )?;
    }
    db.execute(
        "UPDATE runtimes SET active_invocation_id=NULL, updated_at=? WHERE runtime_id=?",
        params![now, rt.runtime_id],
    )?;
    Ok(())
}

/// disposeBrokerRuntime: a failure other than not-active is logged, never thrown.
pub(super) async fn dispose_logged(
    server: &Shared,
    runtime_id: &str,
    reason: Option<&str>,
    message: &str,
) {
    if let Err(error) = dispose(server, runtime_id, reason).await
        && error.code != "broker_runtime_not_active"
    {
        controller::log(
            "warn",
            message,
            json!({"runtimeId":runtime_id,"error":error.message,"code":error.code}),
        );
    }
}

/// controller.dispose: stop, dispose, close within the dispose bound.
pub async fn dispose(
    server: &Shared,
    runtime_id: &str,
    reason: Option<&str>,
) -> Result<(), controller::submit::BrokerError> {
    use controller::submit::BrokerError;
    let Some((invocation, client)) = controller::active(server, runtime_id) else {
        return Err(BrokerError::not_active(runtime_id));
    };
    let reason = reason.unwrap_or("dispose");
    controller::mark_closing(server, runtime_id, reason);
    let sequence = async {
        client
            .request(
                "invocation.stop",
                json!({"invocationId":invocation,"reason":reason}),
            )
            .await?;
        if let Err(error) = client
            .request("invocation.dispose", json!({"invocationId":invocation}))
            .await
        {
            // The broker may exit on stop before answering dispose.
            let text = error.to_string();
            if !text.contains("RPC connection closed") && !text.contains("RPC peer closed") {
                return Err(error);
            }
        }
        client.close();
        anyhow::Ok(())
    };
    let result = tokio::time::timeout(DISPOSE_TIMEOUT, sequence).await;
    controller::delete_active(server, runtime_id);
    match result {
        Ok(Ok(())) => {
            let now = hrc_store::timestamp();
            let db = server.store.lock().unwrap();
            db::update_runtime(
                &db.sqlite,
                runtime_id,
                &[
                    ("status", db::text("disposed")),
                    ("status_changed_at", db::text(now.as_str())),
                    ("updated_at", db::text(now.as_str())),
                ],
            )
            .map_err(|e| BrokerError {
                code: "broker_dispose_failed".into(),
                message: e.to_string(),
                detail: json!({}),
            })?;
            drop(db);
            server.ledger_committed();
            Ok(())
        }
        Ok(Err(error)) => {
            client.close();
            Err(BrokerError {
                code: "broker_dispose_failed".into(),
                message: error.to_string(),
                detail: json!({}),
            })
        }
        Err(_) => {
            client.close();
            Err(BrokerError {
                code: "broker_dispose_timeout".into(),
                message: format!(
                    "broker dispose timed out after {}ms for {runtime_id}",
                    DISPOSE_TIMEOUT.as_millis()
                ),
                detail: json!({"runtimeId":runtime_id,"timeoutMs":DISPOSE_TIMEOUT.as_millis() as u64}),
            })
        }
    }
}
