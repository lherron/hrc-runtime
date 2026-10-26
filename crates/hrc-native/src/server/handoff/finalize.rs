//! Durable semantic response recovery, independent of broker projection writes.
use crate::server::{Shared, projection::db, stderr_json, turns};
use anyhow::Result;
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;

fn pump(server: &Shared) -> Result<()> {
    let active = server.handoff.active.lock().unwrap().clone();
    let db = server.store.lock().unwrap();
    let mut requests = HashMap::new();
    for request in db.pending_handoffs(100)? {
        if let Some(run) = request["execution"]["runId"].as_str() {
            requests.insert(run.to_owned(), request);
        }
    }
    for (run, (id, ready)) in active {
        if ready && let Some(request) = db.message_by_id(&id)? {
            requests.insert(run, request);
        }
    }
    for (run_id, request) in requests {
        let terminal = db.lifecycle_rows("SELECT * FROM hrc_events WHERE run_id=? AND event_kind IN ('turn.completed','turn.zombied','turn.reaped') ORDER BY hrc_seq ASC LIMIT 1",&[Sql::Text(run_id.clone())],true)?.pop();
        let Some(event) = terminal else { continue };
        let run = db::run(&db.sqlite, &run_id)?;
        let error: Option<String> = db
            .sqlite
            .query_row(
                "SELECT error_message FROM runs WHERE run_id=?",
                [&run_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let failed = event["errorCode"].as_str().is_some_and(|s| !s.is_empty())
            || run.as_ref().is_some_and(|r| r.status == "failed");
        let state = if failed { "failed" } else { "completed" };
        let execution = &request["execution"];
        let marker = &request["metadataJson"]["semanticTurnHandoff"];
        let mode = execution["mode"]
            .as_str()
            .filter(|s| matches!(*s, "headless" | "interactive" | "nonInteractive"))
            .unwrap_or("interactive");
        let session_ref = execution["sessionRef"].as_str().unwrap_or("");
        let runtime = event["runtimeId"]
            .as_str()
            .or_else(|| run.as_ref().and_then(|r| r.runtime_id.as_deref()))
            .or_else(|| execution["runtimeId"].as_str());
        let transport = event["transport"]
            .as_str()
            .or_else(|| run.as_ref().map(|r| r.transport.as_str()))
            .or_else(|| execution["transport"].as_str())
            .filter(|s| matches!(*s, "sdk" | "tmux" | "headless"));
        let mut response_execution = json!({"state":state,"mode":mode,"sessionRef":session_ref,"hostSessionId":event["hostSessionId"],"generation":event["generation"]});
        if let Some(runtime) = runtime.filter(|s| !s.is_empty()) {
            response_execution["runtimeId"] = runtime.into();
        }
        response_execution["runId"] = run_id.clone().into();
        if let Some(transport) = transport {
            response_execution["transport"] = transport.into();
        }
        let mut patch = json!({"state":state});
        if let Some(code) = event["errorCode"].as_str().filter(|s| !s.is_empty()) {
            response_execution["errorCode"] = code.into();
            patch["errorCode"] = code.into();
        }
        if let Some(error) = error.filter(|s| !s.is_empty()) {
            response_execution["errorMessage"] = error.clone().into();
            patch["errorMessage"] = error.into();
        }
        let mut response = json!({"messageId":format!("msg-{}",uuid::Uuid::new_v4()),"kind":"dm","phase":"response","from":request["to"],"to":marker.get("respondTo").unwrap_or(&request["from"]),"body":turns::final_message(&db.sqlite,&run_id)?,"replyToMessageId":request["messageId"],"rootMessageId":request["rootMessageId"],"execution":response_execution});
        if request["metadataJson"]["federationIngress"]["delivery"]["semanticTurnHandoff"]
            .is_object()
            && let (Some(runtime), Some(transport)) = (runtime, transport)
        {
            let mut signal = json!({"version":1,"type":"terminal","sourceHrcSeq":event["hrcSeq"],"identity":{"sessionRef":session_ref,"scopeRef":event["scopeRef"],"laneRef":event["laneRef"],"hostSessionId":event["hostSessionId"],"runtimeId":runtime,"runId":run_id,"generation":event["generation"],"mode":mode,"transport":transport},"outcome":state});
            for key in ["errorCode", "errorMessage"] {
                if let Some(v) = patch.get(key) {
                    signal[key] = v.clone();
                }
            }
            response["metadataJson"] = json!({"federationSemanticTurnSignal":signal});
        }
        let request_id = request["messageId"].as_str().unwrap();
        if db.finalize_handoff(request_id, &response, &patch)? {
            stderr_json(
                "info",
                "messages",
                "semantic_turn_handoff.response_finalized",
                json!({"requestMessageId":request_id,"responseMessageId":response["messageId"],"runId":run_id,"state":state}),
            );
            server.ledger_committed();
        }
        server.handoff.active.lock().unwrap().remove(&run_id);
    }
    Ok(())
}

pub fn start(server: &Shared) {
    assert!(!server.front, "front cannot start semantic finalizers");
    let owned = server.clone();
    let mut wake = server.ledger.subscribe();
    let task = tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {_=timer.tick()=>{},r=wake.changed()=>{if r.is_err(){return;}}}
            if owned
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            if let Err(error) = pump(&owned) {
                stderr_json(
                    "warn",
                    "messages",
                    "semantic_turn_handoff.finalize_failed",
                    json!({"error":error.to_string()}),
                );
            }
        }
    });
    *server.handoff.observer.lock().unwrap() = Some(task);
}
pub async fn stop(server: &Shared) {
    let task = server.handoff.observer.lock().unwrap().take();
    if let Some(task) = task {
        task.abort();
        if let Err(error) = task.await
            && !error.is_cancelled()
        {
            stderr_json(
                "warn",
                "messages",
                "semantic_turn_handoff.stop_failed",
                json!({"error":error.to_string()}),
            );
        }
    }
}
