//! Durable semantic response recovery, independent of broker projection writes.
use crate::server::{Shared, projection::db, stderr_json, turns};
use anyhow::Result;
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

const TERMINAL: &str = "event_kind IN ('turn.completed','turn.zombied','turn.reaped')";

/// The first pass recovers every durable pending request (owner restart);
/// later passes see only terminal events past `cursor`, by idx_hrc_events_kind_seq,
/// as Bun finalizes per terminal event. The wake fires on every ledger commit,
/// so a per-pass messages scan under the store mutex starved ingest (T-11915).
fn pump(server: &Shared, cursor: &mut Option<i64>) -> Result<()> {
    let Some(_write) = server.owner_writes.enter() else {
        return Ok(());
    };
    let active = server.handoff.active.lock().unwrap().clone();
    let db = server.store.lock().unwrap();
    let mut requests = HashMap::new();
    let mut add = |request: Value| {
        if let Some(run) = request["execution"]["runId"].as_str() {
            requests.insert(run.to_owned(), request);
        }
    };
    let next = match *cursor {
        None => {
            let head: i64 = db.sqlite.query_row(
                "SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events",
                [],
                |r| r.get(0),
            )?;
            let mut after = 0;
            loop {
                let page = db.pending_handoffs(after, 100)?;
                let Some(last) = page.last().and_then(|m| m["messageSeq"].as_i64()) else {
                    break;
                };
                after = last;
                page.into_iter().for_each(&mut add);
            }
            head
        }
        Some(from) => {
            let mut head = from;
            let mut terminal = db.sqlite.prepare_cached(&format!("SELECT hrc_seq, run_id FROM hrc_events WHERE {TERMINAL} AND hrc_seq>? AND run_id IS NOT NULL ORDER BY hrc_seq ASC"))?;
            for row in terminal.query_map([from], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })? {
                let (seq, run) = row?;
                head = seq;
                if let Some(request) = db.pending_handoff_for_run(&run)? {
                    add(request);
                }
            }
            head
        }
    };
    for (run, (id, ready)) in active {
        if ready && let Some(request) = db.message_by_id(&id)? {
            requests.insert(run, request);
        }
    }
    let mut ready = Vec::new();
    for (run_id, request) in requests {
        let terminal = db.lifecycle_rows(&format!("SELECT * FROM hrc_events WHERE run_id=? AND {TERMINAL} ORDER BY hrc_seq ASC LIMIT 1"),&[Sql::Text(run_id.clone())],true)?.pop();
        if let Some(event) = terminal {
            ready.push((run_id, request, event));
        }
    }
    ready.sort_by_key(|(_, _, event)| event["hrcSeq"].as_i64());
    for (run_id, request, event) in ready {
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
    // Advanced only after every candidate finalized, so a failed pass retries.
    *cursor = Some(next);
    Ok(())
}

pub fn start(server: &Shared) {
    assert!(!server.front, "front cannot start semantic finalizers");
    let owned = server.clone();
    let mut wake = server.ledger.subscribe();
    let task = tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        let mut cursor = None;
        loop {
            tokio::select! {_=timer.tick()=>{},r=wake.changed()=>{if r.is_err(){return;}}}
            if owned
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            if let Err(error) = pump(&owned, &mut cursor) {
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
