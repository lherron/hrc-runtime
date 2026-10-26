//! Broker tmux lease liveness and teardown (runtime-io-handlers.ts
//! reconcileTmuxRuntimeLiveness, startup-reconcile/runtime-mutations.ts,
//! controller-factory.ts reapBrokerTmuxLease).
use super::{
    Server, Shared, controller,
    projection::{db, events},
};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

pub fn unavailable(status: &str) -> bool {
    matches!(
        status,
        "terminated" | "dead" | "stale" | "crashed" | "detached"
    )
}
fn terminal_invocation_state(state: &str) -> bool {
    matches!(state, "exited" | "failed" | "disposed")
}
fn hosting(rt: &db::Rt) -> Option<Value> {
    super::runtime_views::hosting(
        &json!({"runtimeStateJson":rt.state_object(),"generation":rt.generation}),
    )
}
pub fn socket_path(rt: &db::Rt) -> Option<String> {
    if let Some(s) = rt
        .tmux
        .as_ref()
        .and_then(|t| t["socketPath"].as_str())
        .filter(|s| !s.is_empty())
    {
        return Some(s.to_owned());
    }
    if let Some(h) = hosting(rt).filter(|h| h["substrate"]["kind"] == "leased-tmux") {
        return h["substrate"]["tmuxSocketPath"].as_str().map(str::to_owned);
    }
    rt.state_object()["tmux"]["socketPath"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
pub fn session_name(rt: &db::Rt) -> String {
    if let Some(s) = rt
        .tmux
        .as_ref()
        .and_then(|t| t["sessionName"].as_str())
        .filter(|s| !s.is_empty())
    {
        return s.to_owned();
    }
    if let Some(h) = hosting(rt).filter(|h| {
        h["presentation"]["kind"] == "tmux-tui" && h["substrate"]["kind"] == "leased-tmux"
    }) {
        return h["substrate"]["sessionName"]
            .as_str()
            .unwrap_or("")
            .to_owned();
    }
    format!(
        "hrc-{}",
        rt.host_session_id.chars().take(12).collect::<String>()
    )
}
fn leased_pane(rt: &db::Rt) -> Option<String> {
    if let Some(p) = rt
        .tmux
        .as_ref()
        .and_then(|t| t["paneId"].as_str())
        .filter(|s| !s.is_empty())
    {
        return Some(p.to_owned());
    }
    hosting(rt)
        .filter(|h| h["substrate"]["kind"] == "leased-tmux")
        .and_then(|h| {
            h["substrate"]["brokerWindow"]["paneId"]
                .as_str()
                .map(str::to_owned)
        })
}
fn leased_substrate(rt: &db::Rt) -> bool {
    hosting(rt).is_some_and(|h| h["substrate"]["kind"] == "leased-tmux")
}

pub async fn tmux(socket: &str, args: &[&str]) -> Result<(bool, String, String)> {
    let out = Command::new("tmux")
        .args(["-S", socket])
        .args(args)
        .output()
        .await?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}
/// inspectPaneLiveness: None when the pane or server is gone.
async fn pane_liveness(socket: &str, pane: &str) -> Option<(bool, bool, String)> {
    let (ok, stdout, _) = tmux(
        socket,
        &[
            "display-message",
            "-p",
            "-t",
            pane,
            "-F",
            "#{pane_dead}\t#{pane_current_command}",
        ],
    )
    .await
    .ok()?;
    if !ok {
        return None;
    }
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        return Some((false, false, String::new()));
    }
    let mut parts = line.splitn(2, ['\t', '_']);
    let dead = parts.next().unwrap_or("").trim() == "1";
    let command = parts.next().unwrap_or("").trim().to_owned();
    let shell = [
        "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "login",
    ]
    .contains(&command.trim_start_matches('-').to_lowercase().as_str());
    Some((!dead && !command.is_empty() && !shell, dead, command))
}
async fn kill_lease(socket: &str, payload: &Value) {
    if let Err(error) = tmux(socket, &["kill-server"]).await {
        super::stderr_json(
            "warn",
            "broker",
            "failed to remove broker tmux lease server",
            json!({"payload":payload,"error":error.to_string()}),
        );
    }
}

fn session_generation(db: &Connection, host: &str, fallback: i64) -> i64 {
    db.query_row(
        "SELECT generation FROM sessions WHERE host_session_id=?",
        [host],
        |r| r.get(0),
    )
    .unwrap_or(fallback)
}
fn settle(db: &Connection, rt: &db::Rt, now: &str, state: &str, message: &str) -> Result<()> {
    if rt.controller_kind.as_deref() == Some("harness-broker") {
        hrc_store::fail_unresolved_absorbed(db, &rt.runtime_id, None, now)?;
        if let Some(id) = &rt.active_invocation_id {
            hrc_store::fail_unresolved_absorbed(db, &rt.runtime_id, Some(id), now)?;
            if let Some(inv) = db::invocation(db, id)?
                && !terminal_invocation_state(&inv.invocation_state)
            {
                db::update_invocation(
                    db,
                    id,
                    &[
                        ("invocation_state", db::text(state)),
                        ("updated_at", db::text(now)),
                    ],
                )?;
            }
        }
    }
    if let Some(run) = &rt.active_run_id {
        db.execute(
            "UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ?",
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
                error_message: Some(message),
            },
        )?;
    }
    Ok(())
}
fn ev(db: &Connection, rt: &db::Rt, now: &str) -> events::Ev {
    events::Ev {
        ts: now.to_owned(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation: session_generation(db, &rt.host_session_id, rt.generation),
        runtime_id: Some(rt.runtime_id.clone()),
        ..Default::default()
    }
}
/// markRuntimeStale
pub fn mark_stale(db: &Connection, rt: &db::Rt, payload: &Value) -> Result<()> {
    let now = hrc_store::timestamp();
    settle(
        db,
        rt,
        &now,
        "disposed",
        &format!(
            "runtime {} is stale after startup reconciliation",
            rt.runtime_id
        ),
    )?;
    let mut state = rt.state_object();
    state["status"] = "stale".into();
    state["updatedAt"] = now.as_str().into();
    state["staleReason"] = payload["reason"].clone();
    state["stalePayload"] = payload.clone();
    if let Some(id) = &rt.active_invocation_id {
        state["terminalInvocation"] = json!({"invocationId":id,"eventType":"hrc.runtime.stale"});
    }
    db::update_runtime(
        db,
        &rt.runtime_id,
        &[
            ("status", db::text("stale")),
            ("status_changed_at", db::text(now.as_str())),
            ("updated_at", db::text(now.as_str())),
            ("runtime_state_json", db::text(state.to_string())),
        ],
    )?;
    events::append(db, "runtime.stale", &ev(db, rt, &now), payload)?;
    Ok(())
}
/// markRuntimeTerminatedAfterUserExit
pub fn mark_terminated_after_user_exit(
    db: &Connection,
    rt: &db::Rt,
    payload: &Value,
) -> Result<()> {
    let now = hrc_store::timestamp();
    settle(
        db,
        rt,
        &now,
        "exited",
        &format!("runtime {} was terminated by user exit", rt.runtime_id),
    )?;
    let mut state = rt.state_object();
    state["status"] = "terminated".into();
    state["updatedAt"] = now.as_str().into();
    state["terminationReason"] = "user_initiated_session_end".into();
    state["userExitReason"] = payload["userExitReason"].clone();
    state["terminationPayload"] = payload.clone();
    if let Some(id) = &rt.active_invocation_id {
        state["terminalInvocation"] =
            json!({"invocationId":id,"eventType":"hrc.runtime.terminated"});
    }
    db::update_runtime(
        db,
        &rt.runtime_id,
        &[
            ("status", db::text("terminated")),
            ("status_changed_at", db::text(now.as_str())),
            ("updated_at", db::text(now.as_str())),
            ("runtime_state_json", db::text(state.to_string())),
        ],
    )?;
    let mut out = payload.clone();
    out["reason"] = "user_initiated_session_end".into();
    events::append(db, "runtime.terminated", &ev(db, rt, &now), &out)?;
    Ok(())
}
fn user_exit(db: &Connection, rt: &db::Rt) -> Option<String> {
    let id = rt.active_invocation_id.as_deref()?;
    db.query_row("SELECT json_extract(broker_event_json, '$.reason') FROM broker_invocation_events WHERE invocation_id = ? AND type = 'continuation.cleared' ORDER BY seq DESC LIMIT 1", [id], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .filter(|r| ["prompt_input_exit", "logout", "clear"].contains(&r.as_str()))
}
fn not_live(server: &Server, runtime_id: &str, payload: Value) -> Result<()> {
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    let Some(rt) = db::runtime(&tx, runtime_id)? else {
        return Ok(());
    };
    match user_exit(&tx, &rt) {
        Some(reason) => {
            let mut payload = payload;
            payload["userExitReason"] = reason.into();
            mark_terminated_after_user_exit(&tx, &rt, &payload)?;
        }
        None => mark_stale(&tx, &rt, &payload)?,
    }
    tx.commit()?;
    server.ledger_committed();
    Ok(())
}

/// reconcileTmuxRuntimeLiveness for a broker runtime; other runtimes unchanged.
pub async fn reconcile_liveness(server: &Server, runtime_id: &str) -> Result<()> {
    let rt = {
        let db = server.store.lock().unwrap();
        db::runtime(&db.sqlite, runtime_id)?
    };
    let Some(rt) = rt else { return Ok(()) };
    if controller::is_external_lifecycle_owner(&rt)
        || rt.controller_kind.as_deref() != Some("harness-broker")
        || !(rt.transport == "tmux" || leased_substrate(&rt))
        || unavailable(&rt.status)
    {
        return Ok(());
    }
    let lifecycle_reason = {
        let db = server.store.lock().unwrap();
        match &rt.active_invocation_id {
            Some(id) => db::invocation(&db.sqlite, id)?.and_then(|i| i.lifecycle_terminal_reason),
            None => None,
        }
    };
    if let Some(reason) = lifecycle_reason {
        let db = server.store.lock().unwrap();
        let tx = db.sqlite.unchecked_transaction()?;
        mark_stale(
            &tx,
            &rt,
            &json!({"runtimeId":rt.runtime_id,"reason":reason,"classification":"lifecycle_terminal","invocationId":rt.active_invocation_id}),
        )?;
        db::update_runtime(
            &tx,
            runtime_id,
            &[
                ("lifecycle_terminal_reason", db::text(reason)),
                ("updated_at", db::text(hrc_store::timestamp())),
            ],
        )?;
        tx.commit()?;
        server.ledger_committed();
        return Ok(());
    }
    let Some(socket) = socket_path(&rt) else {
        return not_live(
            server,
            runtime_id,
            json!({"runtimeId":rt.runtime_id,"reason":"broker_tmux_socket_missing"}),
        );
    };
    let session = session_name(&rt);
    let pane = leased_pane(&rt);
    let inspected = match &pane {
        Some(p) => pane_liveness(&socket, p).await.is_some(),
        None => false,
    };
    if inspected {
        let pane = pane.unwrap();
        let mut liveness = pane_liveness(&socket, &pane).await;
        if !liveness.as_ref().is_some_and(|l| l.0) {
            for delay in [100, 250, 500, 1000, 2000] {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                liveness = pane_liveness(&socket, &pane).await;
                if liveness.as_ref().is_some_and(|l| l.0) {
                    return Ok(());
                }
            }
        }
        if liveness.as_ref().is_some_and(|l| l.0) {
            return Ok(());
        }
        let payload = json!({"runtimeId":rt.runtime_id,"sessionName":session,"socketPath":socket,"paneId":pane,"paneDead":liveness.as_ref().map(|l|l.1),"paneCommand":liveness.as_ref().map(|l|l.2.clone()),"reason":"broker_tmux_harness_not_live"});
        not_live(server, runtime_id, payload.clone())?;
        kill_lease(&socket, &payload).await;
        return Ok(());
    }
    let payload = json!({"runtimeId":rt.runtime_id,"sessionName":session,"socketPath":socket,"reason":"broker_tmux_session_missing"});
    not_live(server, runtime_id, payload.clone())?;
    kill_lease(&socket, &payload).await;
    Ok(())
}

/// reapBrokerTmuxLease: tear a user-exited lease down once per runtime.
pub async fn reap(server: &Shared, runtime_id: &str, reason: &str) {
    if !server.reaped.lock().unwrap().insert(runtime_id.to_owned()) {
        return;
    }
    let result: Result<()> = async {
        let rt = {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, runtime_id)?
        };
        let Some(rt) = rt else { return Ok(()) };
        if controller::is_external_lifecycle_owner(&rt)
            || rt.controller_kind.as_deref() != Some("harness-broker")
            || (rt.transport != "tmux" && !leased_substrate(&rt))
        {
            return Ok(());
        }
        let Some(socket) = socket_path(&rt) else {
            super::stderr_json(
                "warn",
                "broker",
                "broker.user_exit_reap.skipped_no_lease_socket",
                json!({"runtimeId":runtime_id}),
            );
            return Ok(());
        };
        let session = session_name(&rt);
        let (exists, _, _) = tmux(&socket, &["has-session", "-t", &session]).await?;
        if exists {
            let _ = tmux(&socket, &["kill-session", "-t", &session]).await;
        }
        let _ = tmux(&socket, &["kill-server"]).await;
        super::stderr_json(
            "info",
            "broker",
            "broker.user_exit_reap.session_killed",
            json!({"runtimeId":runtime_id,"sessionName":session}),
        );
        reconcile_liveness(server, runtime_id).await
    }
    .await;
    if let Err(error) = result {
        super::stderr_json(
            "warn",
            "broker",
            "broker tmux lease reap failed",
            json!({"runtimeId":runtime_id,"reason":reason,"error":error.to_string()}),
        );
    }
}
