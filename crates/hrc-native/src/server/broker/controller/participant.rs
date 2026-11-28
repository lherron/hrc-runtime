//! External process fate (lifecycle.ts markExternalParticipantInvocationTerminal).
use crate::server::{
    Server,
    projection::{self, db},
};
use anyhow::Result;
use rusqlite::Transaction;
use serde_json::{Value, json};

/// A participant reports its own clean exit. HRC releases observation of any
/// open runs, without condemning its process or reaping its presentation.
pub(super) fn mark_terminal(
    server: &Server,
    runtime_id: &str,
    envelope: &Value,
    idempotent: bool,
) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    server.write(|db| {
        let tx = db.sqlite.unchecked_transaction()?;
        let Some(rt) = db::runtime(&tx, runtime_id)? else {
            return Ok(());
        };
        if rt.active_invocation_id.as_deref() != Some(invocation) || rt.status == "terminated" {
            return Ok(());
        }
        let now = hrc_store::timestamp();
        super::super::submission_loss::settle_runtime(&tx, &rt, &now, "participant_exit")?;
        super::super::lease::retire_hrc_launched(&tx, &rt, &now, "participant_exit")?;
        let occurred = envelope["time"].as_str().unwrap_or(&now);
        let message = format!(
            "external_participant_exit: invocation {invocation} exited cleanly; HRC no longer observes this turn, its native outcome is unknown"
        );
        db::settle_terminal_runtime_runs(&tx, runtime_id, &now, &message)?;
        let mut state = rt.state_object();
        state["status"] = "terminated".into();
        state["updatedAt"] = now.as_str().into();
        state["terminalReason"] = "external_participant_exit".into();
        state["terminalInvocation"] =
            json!({"invocationId":invocation,"eventType":envelope["type"],"seq":envelope["seq"]});
        let mut cols = vec![
            ("status", db::text("terminated")),
            ("status_changed_at", db::text(occurred)),
            (
                "lifecycle_terminal_reason",
                db::text("external_participant_exit"),
            ),
        ];
        cols.extend(db::activity_cols(&tx, runtime_id, occurred, &now)?);
        cols.push(("runtime_state_json", db::text(state.to_string())));
        db::update_runtime(&tx, runtime_id, &cols)?;
        if !idempotent {
            let ev = projection::events::Ev {
                ts: now.clone(),
                host_session_id: rt.host_session_id,
                scope_ref: rt.scope_ref,
                lane_ref: rt.lane_ref,
                generation: rt.generation,
                runtime_id: Some(runtime_id.to_owned()),
                transport: Some("headless".to_owned()),
                ..Default::default()
            };
            projection::events::append(
                &tx,
                "runtime.terminated",
                &ev,
                &json!({"reason":"external_participant_exit","invocationId":invocation,"seq":envelope["seq"]}),
            )?;
        }
        tx.commit()?;
        server.ledger_committed();
        Ok(())
    })
}

/// Losing HRC's attachment says nothing about the external broker's process
/// or any of its submissions. Preserve its binding and continuation.
pub(in crate::server) fn detach(
    tx: &Transaction<'_>,
    rt: &db::Rt,
    now: &str,
    reason: &str,
) -> Result<()> {
    if !super::external_lifecycle(rt)
        || super::super::lease::unavailable(&rt.status)
        || matches!(
            rt.status.as_str(),
            "failed" | "stopped" | "disposed" | "exited"
        )
    {
        return Ok(());
    }
    let mut state = rt.state_object();
    state["status"] = "detached".into();
    state["updatedAt"] = now.into();
    if !state["control"].is_object() {
        state["control"] = json!({"mode":"broker-ipc"});
    }
    state["control"]["brokerAttached"] = false.into();
    db::update_runtime(
        tx,
        &rt.runtime_id,
        &[
            ("status", db::text("detached")),
            ("status_changed_at", db::text(now)),
            ("updated_at", db::text(now)),
            ("runtime_state_json", db::text(state.to_string())),
        ],
    )?;
    let ev = projection::events::Ev {
        ts: now.into(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation: rt.generation,
        runtime_id: Some(rt.runtime_id.clone()),
        transport: Some(rt.transport.clone()),
        ..Default::default()
    };
    projection::events::append(
        tx,
        "runtime.detached",
        &ev,
        &json!({"reason":reason,"invocationId":rt.active_invocation_id}),
    )?;
    Ok(())
}
