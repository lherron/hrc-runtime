//! Terminal invocations and lost brokers (lifecycle.ts markBrokerInvocationTerminal,
//! markBrokerCrashTerminal; bc-events.ts condemnation check).
use super::{
    active, delete_active, intentional_close_reason, is_external_lifecycle_owner, mark_closing,
};
use crate::server::{
    Server, Shared,
    projection::{self, db},
};
use anyhow::Result;
use rusqlite::params;
use serde_json::{Value, json};

pub(super) fn user_exit_reason(
    db: &rusqlite::Connection,
    invocation: &str,
    before: Option<i64>,
) -> Result<Option<String>> {
    let reason: Option<Option<String>> = match before {
        Some(seq) => db.query_row("SELECT json_extract(broker_event_json, '$.reason') FROM broker_invocation_events WHERE invocation_id = ? AND type = 'continuation.cleared' AND seq < ? ORDER BY seq DESC LIMIT 1", params![invocation, seq], |r| r.get(0)),
        None => db.query_row("SELECT json_extract(broker_event_json, '$.reason') FROM broker_invocation_events WHERE invocation_id = ? AND type = 'continuation.cleared' ORDER BY seq DESC LIMIT 1", [invocation], |r| r.get(0)),
    }
    .map(Some)
    .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
    Ok(reason
        .flatten()
        .filter(|r| ["prompt_input_exit", "logout", "clear"].contains(&r.as_str())))
}

/// markBrokerInvocationTerminal
pub async fn mark_invocation_terminal(
    server: &Shared,
    runtime_id: &str,
    envelope: &Value,
    idempotent: bool,
) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("").to_owned();
    // The terminate in flight finalizes the runtime and writes its terminal
    // event; Bun projects this exit after that finalize and records nothing.
    if super::is_terminating(server, runtime_id) {
        return Ok(());
    }
    let closing = intentional_close_reason(server, runtime_id);
    let user_exit = {
        let db = server.store.lock().unwrap();
        let tx = db.sqlite.unchecked_transaction()?;
        let Some(rt) = db::runtime(&tx, runtime_id)? else {
            return Ok(());
        };
        if rt.active_invocation_id.as_deref() != Some(&invocation)
            || hrc_store::status::BROKER_TERMINAL.contains(&rt.status.as_str())
        {
            return Ok(());
        }
        let now = hrc_store::timestamp();
        let inv = db::invocation(&tx, &invocation)?;
        hrc_store::fail_unresolved_absorbed(&tx, runtime_id, Some(&invocation), &now)?;
        let run_id = inv
            .as_ref()
            .and_then(|i| i.run_id.clone())
            .or(rt.active_run_id.clone());
        let kind = envelope["type"].as_str().unwrap_or("");
        let user_exit = if kind == "invocation.exited" {
            user_exit_reason(&tx, &invocation, envelope["seq"].as_i64())?
        } else {
            None
        };
        let intentional = user_exit.is_some() || closing.is_some();
        let status = if intentional { "terminated" } else { "crashed" };
        let occurred = envelope["time"].as_str().unwrap_or(&now).to_owned();
        let p = &envelope["payload"];
        let provider_message = if kind == "invocation.failed" {
            p["message"].as_str().filter(|m| !m.trim().is_empty())
        } else {
            None
        };
        let reason = if user_exit.is_some() {
            "user_initiated_session_end".to_owned()
        } else if closing.is_some() {
            "operator_initiated_teardown".to_owned()
        } else {
            provider_message
                .unwrap_or("broker_invocation_abnormal_terminal")
                .to_owned()
        };
        if let Some(active_run) = &rt.active_run_id {
            if let Some(r) = db::run(&tx, active_run)?
                && ["accepted", "started", "running"].contains(&r.status.as_str())
            {
                let message = if let Some(u) = &user_exit {
                    format!("broker invocation {invocation} ended by user request ({u})")
                } else if let Some(c) = &closing {
                    format!("broker invocation {invocation} ended by operator teardown ({c})")
                } else if let Some(m) = provider_message {
                    format!("broker invocation {invocation} failed: {m}")
                } else {
                    format!("broker invocation {invocation} reached terminal state {kind}")
                };
                db::mark_run_completed(
                    &tx,
                    active_run,
                    db::Completion {
                        status: "failed",
                        completed_at: &now,
                        updated_at: &now,
                        error_code: Some("runtime_unavailable"),
                        error_message: Some(&message),
                    },
                )?;
            }
            tx.execute(
                "UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ?",
                params![now, runtime_id],
            )?;
        }
        let mut state = rt.state_object();
        state["status"] = status.into();
        state["updatedAt"] = now.as_str().into();
        state["terminalReason"] = reason.as_str().into();
        if let Some(u) = &user_exit {
            state["userExitReason"] = u.as_str().into();
        }
        if let Some(c) = &closing {
            state["operatorCloseReason"] = c.as_str().into();
        }
        state["terminalInvocation"] =
            json!({"invocationId":invocation,"eventType":kind,"seq":envelope["seq"]});
        let mut cols = vec![
            ("status", db::text(status)),
            ("status_changed_at", db::text(occurred.as_str())),
        ];
        cols.extend(db::activity_cols(&tx, runtime_id, &occurred, &now)?);
        cols.push(("runtime_state_json", db::text(state.to_string())));
        db::update_runtime(&tx, runtime_id, &cols)?;
        if !idempotent {
            let mut payload = json!({"reason":reason});
            if let Some(u) = &user_exit {
                payload["userExitReason"] = u.as_str().into();
            }
            if let Some(c) = &closing {
                payload["operatorCloseReason"] = c.as_str().into();
            }
            payload["invocationId"] = invocation.as_str().into();
            payload["eventType"] = kind.into();
            payload["seq"] = envelope["seq"].clone();
            if !intentional {
                let mut terminal = json!({"eventType":kind});
                for key in ["exitCode", "signal", "message", "code", "reason"] {
                    if let Some(v) = p.get(key) {
                        terminal[key] = v.clone();
                    }
                }
                payload["providerTerminal"] = terminal;
            }
            let ev = projection::events::Ev {
                ts: now.clone(),
                host_session_id: rt.host_session_id.clone(),
                scope_ref: rt.scope_ref.clone(),
                lane_ref: rt.lane_ref.clone(),
                generation: rt.generation,
                runtime_id: Some(runtime_id.to_owned()),
                run_id,
                transport: matches!(rt.transport.as_str(), "headless" | "tmux")
                    .then(|| rt.transport.clone()),
                error_code: (!intentional).then(|| "runtime_unavailable".to_owned()),
                ..Default::default()
            };
            projection::events::append(
                &tx,
                if intentional {
                    "runtime.terminated"
                } else {
                    "runtime.crashed"
                },
                &ev,
                &payload,
            )?;
        }
        tx.commit()?;
        server.ledger_committed();
        user_exit
    };
    if active(server, runtime_id).is_some_and(|(i, _)| i == invocation) {
        mark_closing(server, runtime_id, "broker_invocation_terminal");
        delete_active(server, runtime_id);
    }
    if user_exit.is_some() {
        crate::server::lease::reap(server, runtime_id, "invocation_exited").await;
    }
    Ok(())
}

/// markBrokerCrashTerminal for a lost broker this daemon owned.
pub fn mark_crash_terminal(
    server: &Server,
    runtime_id: &str,
    code: &str,
    message: &str,
) -> Result<()> {
    delete_active(server, runtime_id);
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    let Some(rt) = db::runtime(&tx, runtime_id)? else {
        return Ok(());
    };
    if rt.status == "crashed" || is_external_lifecycle_owner(&rt) {
        return Ok(());
    }
    let now = hrc_store::timestamp();
    let inv = match &rt.active_invocation_id {
        Some(id) => db::invocation(&tx, id)?,
        None => db::invocations_for_runtime(&tx, runtime_id)?.pop(),
    };
    let mut crashed = Vec::new();
    for id in [
        inv.as_ref().and_then(|i| i.run_id.clone()),
        rt.active_run_id.clone(),
    ]
    .into_iter()
    .flatten()
    {
        if crashed.contains(&id) {
            continue;
        }
        if let Some(r) = db::run(&tx, &id)?
            && ["accepted", "started", "running"].contains(&r.status.as_str())
        {
            db::mark_run_completed(
                &tx,
                &id,
                db::Completion {
                    status: "failed",
                    completed_at: &now,
                    updated_at: &now,
                    error_code: Some("runtime_unavailable"),
                    error_message: Some(message),
                },
            )?;
            crashed.push(id);
        }
    }
    if let Some(inv) = &inv {
        db::update_invocation(
            &tx,
            &inv.invocation_id,
            &[
                ("invocation_state", db::text("failed")),
                ("updated_at", db::text(now.as_str())),
            ],
        )?;
        tx.execute("UPDATE runtime_operations SET status='failed', completed_at=?, updated_at=?, error_code=?, error_message=? WHERE operation_id=?", params![now, now, code, message, inv.operation_id])?;
    }
    db::settle_terminal_runtime_runs(&tx, runtime_id, &now, message)?;
    let mut state = rt.state_object();
    state["status"] = "crashed".into();
    state["updatedAt"] = now.as_str().into();
    state["brokerCrash"] = json!({"code":code,"message":message});
    db::update_runtime(
        &tx,
        runtime_id,
        &[
            ("status", db::text("crashed")),
            ("status_changed_at", db::text(now.as_str())),
            ("updated_at", db::text(now.as_str())),
            ("runtime_state_json", db::text(state.to_string())),
        ],
    )?;
    let last: Option<(i64, String, String)> = match &inv {
        Some(i) => tx.query_row("SELECT seq,type,time FROM broker_invocation_events WHERE invocation_id=? ORDER BY seq DESC LIMIT 1", [&i.invocation_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok(),
        None => None,
    };
    let mut payload = json!({"reason":"broker_process_closed"});
    if let Some(i) = &inv {
        payload["invocationId"] = i.invocation_id.as_str().into();
    }
    payload["brokerError"] = json!({"code":code,"message":message});
    if let Some((seq, kind, time)) = last {
        payload["lastBrokerEvent"] = json!({"seq":seq,"type":kind,"time":time});
    }
    let terminal_run = [
        inv.as_ref().and_then(|i| i.run_id.clone()),
        rt.active_run_id.clone(),
    ]
    .into_iter()
    .flatten()
    .find(|r| crashed.contains(r));
    let ev = projection::events::Ev {
        ts: now.clone(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation: rt.generation,
        runtime_id: Some(runtime_id.to_owned()),
        run_id: terminal_run,
        transport: matches!(rt.transport.as_str(), "headless" | "tmux")
            .then(|| rt.transport.clone()),
        error_code: Some(code.to_owned()),
        ..Default::default()
    };
    projection::events::append(&tx, "runtime.crashed", &ev, &payload)?;
    tx.commit()?;
    server.ledger_committed();
    Ok(())
}

/// The leased broker is still live (condemnation averted).
pub(super) async fn broker_pane_alive(server: &Server, runtime_id: &str) -> bool {
    let state = {
        let db = server.store.lock().unwrap();
        db::runtime(&db.sqlite, runtime_id).ok().flatten()
    };
    let Some(rt) = state else { return false };
    if let Some((socket, pid)) = crate::server::hrcpty::substrate(&rt) {
        return super::super::lease::hrcpty_broker_alive(&socket, pid).await;
    }
    let state = rt.state_object();
    let window = &state["broker"]["brokerWindow"];
    let (Some(socket), Some(pane)) = (window["socketPath"].as_str(), window["paneId"].as_str())
    else {
        return false;
    };
    let out = tokio::process::Command::new("tmux")
        .args([
            "-S",
            socket,
            "display-message",
            "-p",
            "-t",
            pane,
            "#{pane_pid} #{pane_dead}",
        ])
        .output()
        .await;
    let Ok(out) = out else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let pid = parts
        .next()
        .and_then(|p| p.parse::<i32>().ok())
        .unwrap_or(0);
    let dead = parts.next() == Some("1");
    out.status.success() && pid > 0 && !dead && unsafe { libc::kill(pid, 0) } == 0
}
