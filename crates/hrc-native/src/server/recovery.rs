//! Startup recovery of accepted cold-boot runs whose owed prompt was never
//! submitted (cold-boot-input-recovery.ts, broker-headless-start.ts
//! failColdBootInputContinuation, broker-headless-completion.ts
//! waitForCompilerPrimingTerminal). Native births carry their prompt in the
//! launch, so only a store Bun wrote holds these rows.
use super::{
    ApiError, Shared, controller, lease,
    projection::{db, events},
    sweeps, turns,
};
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};

fn shutting(server: &Shared) -> bool {
    server.controller.shutting_down.load(Ordering::SeqCst)
}

/// parseDurableColdBootTurnInput
fn durable_cold(correlation: Option<&str>) -> Option<Value> {
    let v: Value = serde_json::from_str(correlation?).ok()?;
    (v["kind"] == "durable_cold_boot_turn_input" && v["prompt"].is_string()).then_some(v)
}

/// failColdBootInputContinuation: idempotent; only an accepted, undispatched run.
fn fail(
    server: &Shared,
    run_id: &str,
    code: &str,
    phase: &str,
    message: Option<&str>,
    detail: Value,
) -> anyhow::Result<bool> {
    let Some(_write) = server.owner_writes.enter() else {
        return Ok(false);
    };
    let db = server.store.lock().unwrap();
    let Some(run) = db::run(&db.sqlite, run_id)? else {
        return Ok(false);
    };
    if run.status != "accepted" || run.dispatched_input_id.is_some() {
        return Ok(false);
    }
    let message = message
        .unwrap_or("cold-birth accepted run lost the continuation that owed its prompt")
        .to_owned();
    let now = hrc_store::timestamp();
    let tx = db.sqlite.unchecked_transaction()?;
    db::mark_run_completed(
        &tx,
        run_id,
        db::Completion {
            status: "failed",
            completed_at: &now,
            updated_at: &now,
            error_code: Some(code),
            error_message: Some(&message),
        },
    )?;
    let mut log = json!({"runId":run_id,"runtimeId":run.runtime_id,"hostSessionId":run.host_session_id,"scopeRef":run.scope_ref,"errorCode":code,"phase":phase,"error":message});
    let mut payload = json!({"code":code,"message":message,"phase":phase});
    if let Value::Object(extra) = &detail {
        for (k, v) in extra {
            log[k] = v.clone();
            payload[k] = v.clone();
        }
    }
    super::stderr_json(
        "error",
        "broker",
        "broker.cold_boot_input.continuation_failed",
        log,
    );
    let ev = events::Ev {
        ts: now,
        host_session_id: run.host_session_id.clone(),
        scope_ref: run.scope_ref.clone(),
        lane_ref: run.lane_ref.clone(),
        generation: run.generation,
        runtime_id: run.runtime_id.clone(),
        run_id: Some(run_id.to_owned()),
        transport: Some("headless".into()),
        error_code: Some(code.into()),
        ..Default::default()
    };
    events::append(&tx, "turn.failed", &ev, &payload)?;
    tx.commit()?;
    drop(db);
    server.ledger_committed();
    Ok(true)
}

/// The continuation is lost: nothing can deliver the owed prompt.
fn lost(server: &Shared, run_id: &str, detail: Value) {
    if let Err(e) = fail(
        server,
        run_id,
        "cold_input_continuation_lost",
        "cold-boot-input-recovery",
        None,
        detail,
    ) {
        super::stderr_json(
            "warn",
            "broker",
            "broker.cold_boot_input.recovery_failed",
            json!({"runId":run_id,"error":e.to_string()}),
        );
    }
}

/// waitForCompilerPrimingTerminal on the ledger wake; false when stop aborts it.
async fn wait_priming(server: &Shared, runtime_id: &str) -> bool {
    let mut wake = server.ledger.subscribe();
    loop {
        if shutting(server) {
            return false;
        }
        let active = {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, runtime_id)
                .ok()
                .flatten()
                .map(|rt| sweeps::priming_active(&db.sqlite, &rt).unwrap_or(false))
                .unwrap_or(false)
        };
        if !active {
            return true;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), wake.changed()).await;
    }
}

async fn recover_one(server: Shared, run_id: String) {
    let (run, correlation) = {
        let db = server.store.lock().unwrap();
        let run = db::run(&db.sqlite, &run_id).ok().flatten();
        let correlation = run.as_ref().and_then(|r| r.correlation_json.clone());
        (run, correlation)
    };
    let Some(run) = run else { return };
    let Some(cold) = durable_cold(correlation.as_deref()) else {
        return lost(&server, &run_id, json!({"reason":"prompt_not_durable"}));
    };
    let rt = {
        let db = server.store.lock().unwrap();
        match &run.runtime_id {
            Some(id) => db::runtime(&db.sqlite, id).ok().flatten(),
            None => None,
        }
    };
    let Some(rt) = rt else {
        let mut d = json!({"reason":"runtime_missing"});
        if let Some(id) = &run.runtime_id {
            d["runtimeId"] = id.as_str().into();
        }
        return lost(&server, &run_id, d);
    };
    if lease::unavailable(&rt.status) {
        return lost(
            &server,
            &run_id,
            json!({"reason":"runtime_unavailable","runtimeId":rt.runtime_id,"status":rt.status}),
        );
    }
    let Some(invocation) = rt.active_invocation_id.clone() else {
        return lost(
            &server,
            &run_id,
            json!({"reason":"invocation_absent","runtimeId":rt.runtime_id}),
        );
    };
    // Liveness is proved against the broker binding, never the runtime row.
    if let Err(e) = controller::seat::probe(&server, &rt.runtime_id, "explicit-probe").await {
        return lost(
            &server,
            &run_id,
            json!({"reason":"seat_probe_failed","runtimeId":rt.runtime_id,"invocationId":invocation,"probeError":e["code"]}),
        );
    }
    if !wait_priming(&server, &rt.runtime_id).await {
        super::stderr_json(
            "info",
            "broker",
            "broker.cold_boot_input.continuation_deferred_to_restart",
            json!({"runId":run_id,"error":"compiler priming wait aborted"}),
        );
        return;
    }
    super::stderr_json(
        "info",
        "broker",
        "broker.cold_boot_input.rearmed",
        json!({"runId":run_id,"runtimeId":rt.runtime_id,"invocationId":invocation,"hostSessionId":run.host_session_id,"scopeRef":run.scope_ref}),
    );
    // Taken after the priming wait, so a long wait never holds the fence.
    let Some(_write) = server.owner_writes.enter() else {
        return;
    };
    let result: Result<Value, ApiError> = async {
        // continueAdmittedTurn's provenance check, re-read inside the continuation.
        let (current, session) = {
            let db = server.store.lock().unwrap();
            (
                db::run(&db.sqlite, &run_id)?,
                db.session(&run.host_session_id)?,
            )
        };
        let owned = current.as_ref().is_some_and(|r| {
            r.transport == "headless"
                && r.completed_at.is_none()
                && r.status == "accepted"
                && r.runtime_id.as_deref() == Some(&rt.runtime_id)
                && r.dispatched_input_id.is_none()
        });
        let Some(session) = session.filter(|_| owned && rt.host_session_id == run.host_session_id)
        else {
            return Err(turns::admission::unavailable(
                "continuation has no admitted durable owner",
                json!({"runId":run_id,"source":"accepted-cold-boot"}),
            ));
        };
        turns::continue_cold(&server, session, &rt, &run_id, &cold).await
    }
    .await;
    if let Err(error) = result {
        if shutting(&server) {
            super::stderr_json(
                "info",
                "broker",
                "broker.cold_boot_input.continuation_deferred_to_restart",
                json!({"runId":run_id,"error":error.message}),
            );
            return;
        }
        if let Err(e) = fail(
            &server,
            &run_id,
            "cold_input_continuation_failed",
            "cold-boot-input-continuation",
            Some(&error.message),
            json!({}),
        ) {
            super::stderr_json(
                "warn",
                "broker",
                "broker.cold_boot_input.recovery_failed",
                json!({"runId":run_id,"error":e.to_string()}),
            );
        }
    }
}

/// recoverColdBootInputContinuations: after reattach, every candidate at once.
pub fn start(server: &Shared) {
    let ids: Vec<String> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .prepare("SELECT run_id FROM runs WHERE status='accepted' AND transport='headless' AND dispatched_input_id IS NULL AND completed_at IS NULL ORDER BY accepted_at ASC, run_id ASC")
            .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
            .unwrap_or_default()
    };
    if ids.is_empty() {
        return;
    }
    super::stderr_json(
        "info",
        "broker",
        "broker.cold_boot_input.recovery_started",
        json!({"candidates":ids.len()}),
    );
    for id in ids {
        tokio::spawn(recover_one(server.clone(), id));
    }
}
