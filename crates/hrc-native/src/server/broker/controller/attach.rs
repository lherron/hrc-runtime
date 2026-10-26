//! Durable reattach (dispatch-attach.ts attachAndReplay, dispatch-probe.ts,
//! lifecycle.ts failReplayStale).
use super::{
    PROBE_TIMEOUT, after_mapped, apply_one, consume, delete_active, flush,
    is_external_lifecycle_owner, last_projected, log, mark_closing, project_capture_state,
    server_instance_id, set_active,
};
use crate::server::{
    Server, Shared,
    projection::{self, Conflict, db},
    rpc::JsonRpc,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::path::Path;
use tokio::sync::mpsc;

pub fn status_from_invocation_state(state: &str) -> &'static str {
    match state {
        "ready" => "ready",
        "turn_active" => "busy",
        "awaiting_input" => "awaiting_input",
        "stopping" => "stopping",
        "exited" => "stopped",
        "failed" => "failed",
        "disposed" => "disposed",
        _ => "starting",
    }
}

fn rpc_error_code(error: &anyhow::Error) -> Option<String> {
    let text = format!("{error:#}");
    let start = text.find('{')?;
    let value: Value = serde_json::from_str(&text[start..]).ok()?;
    value["data"]["code"]
        .as_str()
        .or_else(|| value["code"].as_str())
        .map(str::to_owned)
}

/// attachAndReplay over a connected, hello-verified durable broker client.
pub async fn attach_and_replay(
    server: &Shared,
    runtime: &Value,
    client: JsonRpc,
    events: mpsc::UnboundedReceiver<Value>,
    token_path: &Path,
) -> Result<()> {
    let runtime_id = runtime["runtimeId"]
        .as_str()
        .context("runtimeId")?
        .to_owned();
    let invocation = runtime["activeInvocationId"]
        .as_str()
        .context("activeInvocationId")?
        .to_owned();
    let (start_hash, profile_hash) = {
        let db = server.store.lock().unwrap();
        let inv =
            db::invocation(&db.sqlite, &invocation)?.context("broker_attach_unknown_runtime")?;
        (inv.start_request_hash, inv.selected_profile_hash)
    };
    let last = last_projected(server, &invocation)?;
    let result: Result<Value> = async {
        let attach = client.request("broker.attach", json!({"runtimeId":runtime_id,"hostSessionId":runtime["hostSessionId"],"generation":runtime["generation"],"invocationId":invocation,"startRequestHash":start_hash,"selectedProfileHash":profile_hash,"controllerInstanceId":server_instance_id(),"attachToken":std::fs::read_to_string(token_path)?,"lastProjectedSeq":last})).await?;
        ensure!(attach["attached"] != false, "broker attach refused");
        let snapshot = client.request("invocation.snapshot", json!({"invocationId":invocation})).await?;
        let floor = [&attach["retentionFloorSeq"], &attach["snapshot"]["retentionFloorSeq"], &snapshot["retentionFloorSeq"]].iter().filter_map(|v| v.as_i64()).max().unwrap_or(0);
        if floor > last + 1 {
            bail!("broker_replay_retention_gap: broker event retention floor is past HRC projected high-water ({floor} > {})", last + 1);
        }
        let replay = client.request("invocation.eventsSince", json!({"invocationId":invocation,"afterSeq":last})).await?;
        let mut replayed = last;
        // Publish the client before replay so ACK and capture refresh reach it.
        // The seat monitor starts after reattach completes (below).
        set_active(server, &runtime_id, &invocation, client.clone());
        for envelope in replay["events"].as_array().cloned().unwrap_or_default() {
            let outcome = apply_one(server, &envelope)?;
            replayed = replayed.max(envelope["seq"].as_i64().unwrap_or(0));
            if outcome.ignored_delta {
                continue;
            }
            after_mapped(server, &runtime_id, &envelope, &outcome).await;
        }
        flush(server, &invocation)?;
        let mut acked = last_projected(server, &invocation)?;
        if acked > 0 {
            let ack = client.request("invocation.ackEvents", json!({"invocationId":invocation,"throughSeq":acked,"controllerInstanceId":server_instance_id()})).await?;
            let through = ack["ackedThroughSeq"].as_i64().unwrap_or(0);
            ensure!(through >= acked, "broker_ack_incomplete: broker acknowledgement did not reach HRC committed projection cursor");
            acked = through;
        }
        // Control proof on this exact candidate client before publishing state.
        let health = client.request_within("broker.health", json!({"probeDrivers":true}), PROBE_TIMEOUT).await.map_err(|e| anyhow!("broker_control_probe_failed: {e}"))?;
        ensure!(health["status"] != "shutting_down", "broker_control_probe_shutting_down");
        ensure!(health["status"] == "ok" || health["status"] == "degraded", "broker_control_probe_failed: unsupported health status");
        let status = client.request_within("invocation.status", json!({"invocationId":invocation}), PROBE_TIMEOUT).await.map_err(|e| anyhow!("broker_control_probe_failed: {e}"))?;
        ensure!(status["invocationId"] == invocation.as_str(), "broker_control_probe_invocation_mismatch");
        let current = [&attach["currentSeq"], &snapshot["currentSeq"], &replay["currentSeq"]].iter().filter_map(|v| v.as_i64()).max().unwrap_or(0);
        let floor = floor.max(replay["retentionFloorSeq"].as_i64().unwrap_or(0));
        Ok(json!({"attach":attach,"snapshot":snapshot,"replayedThroughSeq":replayed,"ackedThroughSeq":acked,"currentSeq":current,"retentionFloorSeq":floor,"lastProjectedSeq":last}))
    }
    .await;
    let proof = match result {
        Ok(proof) => proof,
        Err(error) => {
            delete_active(server, &runtime_id);
            let code = rpc_error_code(&error)
                .filter(|c| c == "replay_below_floor")
                .map(|_| "broker_replay_below_floor".to_owned())
                .unwrap_or_else(|| {
                    let text = format!("{error:#}");
                    if error.downcast_ref::<Conflict>().is_some() {
                        "broker_replay_conflict".to_owned()
                    } else if text.starts_with("broker_replay_retention_gap") {
                        "broker_replay_retention_gap".to_owned()
                    } else if text.contains("control.fenced") || text.contains("controller_fenced")
                    {
                        "broker_controller_fenced".to_owned()
                    } else {
                        "broker_attach_replay_failed".to_owned()
                    }
                });
            fail_replay_stale(
                server,
                &runtime_id,
                &invocation,
                &code,
                &format!("{error:#}"),
            )?;
            bail!("{code}: {error:#}");
        }
    };
    let snapshot = &proof["snapshot"];
    let base = status_from_invocation_state(snapshot["state"].as_str().unwrap_or(""));
    {
        let db = server.store.lock().unwrap();
        let tx = db.sqlite.unchecked_transaction()?;
        let rt = db::runtime(&tx, &runtime_id)?.context("runtime vanished during attach")?;
        let status =
            if projection::turns::any_open_ask(&tx, &rt)? && (base == "busy" || base == "ready") {
                "awaiting_input"
            } else {
                base
            };
        let now = hrc_store::timestamp();
        db::update_invocation(
            &tx,
            &invocation,
            &[
                ("invocation_state", db::opt_text(snapshot["state"].as_str())),
                (
                    "capabilities_json",
                    db::text(snapshot["capabilities"].to_string()),
                ),
                ("owner_server_instance_id", db::text(server_instance_id())),
                ("updated_at", db::text(now.as_str())),
            ],
        )?;
        let mut state = runtime["runtimeStateJson"].clone();
        if !state.is_object() {
            state = json!({});
        }
        state["status"] = status.into();
        state["updatedAt"] = now.as_str().into();
        state["control"] = json!({"mode":"broker-ipc","brokerAttached":true});
        state["brokerReplay"] = json!({"brokerInstanceId":proof["attach"]["brokerInstanceId"],"activeControllerInstanceId":proof["attach"]["activeControllerInstanceId"],"lastProjectedSeq":proof["lastProjectedSeq"],"replayedThroughSeq":proof["replayedThroughSeq"],"ackedThroughSeq":proof["ackedThroughSeq"],"currentSeq":proof["currentSeq"],"retentionFloorSeq":proof["retentionFloorSeq"]});
        db::update_runtime(
            &tx,
            &runtime_id,
            &[
                ("status", db::text(status)),
                ("active_invocation_id", db::text(invocation.as_str())),
                ("updated_at", db::text(now.as_str())),
                ("runtime_state_json", db::text(state.to_string())),
            ],
        )?;
        tx.commit()?;
        server.ledger_committed();
    }
    if let Err(error) = project_capture_state(server, &runtime_id, &snapshot["capture"]) {
        log(
            "warn",
            "broker capture state projection failed",
            json!({"runtimeId":runtime_id,"error":error.to_string()}),
        );
    }
    consume(server, &runtime_id, events, client.clone());
    // The binding-established probe completes before the daemon serves, so a
    // reattached seat's diagnostics always come from this owner.
    let _ = super::seat::probe(server, &runtime_id, "binding-established").await;
    super::seat::monitor(server, &runtime_id, client, false);
    log(
        "info",
        "broker.reattach.complete",
        json!({"runtimeId":runtime_id,"invocationId":invocation,"replayedThroughSeq":proof["replayedThroughSeq"],"ackedThroughSeq":proof["ackedThroughSeq"],"currentSeq":proof["currentSeq"]}),
    );
    Ok(())
}

/// failReplayStale
pub fn fail_replay_stale(
    server: &Server,
    runtime_id: &str,
    invocation: &str,
    code: &str,
    message: &str,
) -> Result<()> {
    if code == "broker_controller_fenced" {
        mark_closing(server, runtime_id, "broker_controller_fenced");
        return Ok(());
    }
    mark_closing(server, runtime_id, code);
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    let Some(rt) = db::runtime(&tx, runtime_id)? else {
        return Ok(());
    };
    if is_external_lifecycle_owner(&rt) {
        return Ok(());
    }
    let now = hrc_store::timestamp();
    let stale = code == "broker_replay_retention_gap" || code == "broker_replay_below_floor";
    db::update_invocation(
        &tx,
        invocation,
        &[
            ("invocation_state", db::text("failed")),
            ("owner_server_instance_id", db::text(server_instance_id())),
            ("updated_at", db::text(now.as_str())),
        ],
    )?;
    let mut state = rt.state_object();
    state["status"] = "stale".into();
    state["updatedAt"] = now.as_str().into();
    if stale {
        state["brokerReplay"] =
            json!({"status":"replay-stale","reason":{"code":code,"message":message}});
    }
    state["control"] = json!({"mode":"broker-ipc","brokerAttached":false,"lastAttachError":{"code":code,"message":message}});
    db::update_runtime(
        &tx,
        runtime_id,
        &[
            ("status", db::text("stale")),
            ("status_changed_at", db::text(now.as_str())),
            ("updated_at", db::text(now.as_str())),
            ("runtime_state_json", db::text(state.to_string())),
        ],
    )?;
    if stale {
        let ev = projection::events::Ev {
            ts: now.clone(),
            host_session_id: rt.host_session_id.clone(),
            scope_ref: rt.scope_ref.clone(),
            lane_ref: rt.lane_ref.clone(),
            generation: rt.generation,
            runtime_id: Some(runtime_id.to_owned()),
            run_id: rt.active_run_id.clone(),
            transport: matches!(rt.transport.as_str(), "headless" | "tmux")
                .then(|| rt.transport.clone()),
            ..Default::default()
        };
        projection::events::append(
            &tx,
            "runtime.stale",
            &ev,
            &json!({"reason":"broker_replay_stale","code":code,"invocationId":invocation}),
        )?;
    }
    tx.commit()?;
    server.ledger_committed();
    Ok(())
}

/// Report-only summary recovery for a live-status broker runtime
/// (runtime-inspect-handlers.ts + bc-attach.ts recoverFinalSummary), raced
/// against `timeout_ms`.
pub async fn recover_final_summary(server: &Shared, runtime: &Value, timeout_ms: f64) -> Value {
    let endpoint = crate::server::startup::hosting(
        &runtime["runtimeStateJson"],
        runtime["generation"].as_i64().unwrap_or(0),
    )
    .map(|h| h.endpoint)
    .filter(|e| e["kind"] == "unix-jsonrpc-ndjson");
    let token = endpoint.as_ref().and_then(|e| {
        std::fs::read_to_string(e["attachTokenRef"]["path"].as_str()?)
            .ok()
            .map(|t| t.trim().to_owned())
    });
    let (Some(endpoint), Some(token)) = (endpoint, token) else {
        return json!({"state":"not_durable"});
    };
    let socket = endpoint["socketPath"].as_str().unwrap_or("").to_owned();
    let once = recover_final_summary_once(server, runtime, &socket, &token);
    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms as u64), once).await {
        Ok(result) => result,
        Err(_) => {
            json!({"state":"timeout","message":format!("summary recovery exceeded {timeout_ms}ms")})
        }
    }
}

fn has_final_summary(server: &Server, runtime_id: &str) -> bool {
    let db = server.store.lock().unwrap();
    db::runtime(&db.sqlite, runtime_id)
        .ok()
        .flatten()
        .is_some_and(|rt| rt.state.is_some_and(|s| s.get("finalSummary").is_some()))
}

async fn recover_final_summary_once(
    server: &Shared,
    runtime: &Value,
    socket: &str,
    token: &str,
) -> Value {
    let runtime_id = runtime["runtimeId"].as_str().unwrap_or("").to_owned();
    // resolveAttachInvocation: the active invocation, else the newest one.
    let invocation = {
        let db = server.store.lock().unwrap();
        let active = runtime["activeInvocationId"]
            .as_str()
            .and_then(|id| db::invocation(&db.sqlite, id).ok().flatten());
        active.or_else(|| {
            db::invocations_for_runtime(&db.sqlite, &runtime_id)
                .ok()
                .and_then(|all| all.into_iter().last())
        })
    };
    let Some(inv) = invocation else {
        return json!({"state":"unavailable","message":"runtime or broker invocation not found"});
    };
    if has_final_summary(server, &runtime_id) {
        return json!({"state":"not_needed"});
    }
    let status = runtime["status"].as_str().unwrap_or("");
    if !matches!(status, "terminated" | "dead" | "stale") {
        return json!({"state":"terminal_fenced","message":format!("runtime is {status}; report-only summary recovery skipped")});
    }
    let invocation = inv.invocation_id.clone();
    let mut client: Option<JsonRpc> = None;
    let result: Result<Value> = async {
        let last = last_projected(server, &invocation)?;
        let (c, _events) = JsonRpc::connect_broker(
            Path::new(socket),
            std::time::Duration::from_secs(30),
            super::permission_handler(std::sync::Arc::downgrade(server)),
        )
        .await?;
        let c = client.insert(c);
        crate::server::broker::hello(c, &runtime["runtimeStateJson"]["executionRelease"]).await?;
        let attach = c.request("broker.attach", json!({"runtimeId":runtime_id,"hostSessionId":runtime["hostSessionId"],"generation":runtime["generation"],"invocationId":invocation,"startRequestHash":inv.start_request_hash,"selectedProfileHash":inv.selected_profile_hash,"controllerInstanceId":server_instance_id(),"attachToken":token,"lastProjectedSeq":last})).await?;
        let snapshot = c.request("invocation.snapshot", json!({"invocationId":invocation})).await?;
        let floor = [&attach["retentionFloorSeq"], &attach["snapshot"]["retentionFloorSeq"], &snapshot["retentionFloorSeq"]].iter().filter_map(|v| v.as_i64()).max().unwrap_or(0);
        if floor > last + 1 {
            return Ok(json!({"state":"retention_gap","message":"broker event retention floor is past HRC projected high-water"}));
        }
        let replay = c.request("invocation.eventsSince", json!({"invocationId":invocation,"afterSeq":last})).await?;
        for envelope in replay["events"].as_array().cloned().unwrap_or_default() {
            let outcome = apply_one(server, &envelope)?;
            if outcome.ignored_delta {
                continue;
            }
            after_mapped(server, &runtime_id, &envelope, &outcome).await;
        }
        flush(server, &invocation)?;
        let committed = last_projected(server, &invocation)?;
        if committed > 0 {
            let ack = c.request("invocation.ackEvents", json!({"invocationId":invocation,"throughSeq":committed,"controllerInstanceId":server_instance_id()})).await?;
            ensure!(ack["ackedThroughSeq"].as_i64().unwrap_or(0) >= committed, "broker acknowledgement did not reach HRC committed projection cursor");
        }
        Ok(if has_final_summary(server, &runtime_id) {
            json!({"state":"recovered"})
        } else {
            json!({"state":"unavailable","message":"broker replay did not include final summary"})
        })
    }
    .await;
    if let Some(c) = client {
        c.close();
    }
    result.unwrap_or_else(|e| json!({"state":"failed","message":format!("{e:#}")}))
}
