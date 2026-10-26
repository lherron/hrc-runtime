//! Execution ownership of external brokers (broker/controller bc-events.ts,
//! bc-projection.ts, bc-close.ts, dispatch-attach.ts, lifecycle.ts).
//!
//! Every envelope is projected and committed before the broker is ACKed
//! through the durable contiguous cursor; a reattach replays from that cursor
//! and re-ACKs even when the replay is empty (crash after commit, before ACK).
use super::{
    Server, Shared,
    projection::{self, Outcome, db},
    rpc::{Inbound, JsonRpc},
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::mpsc;

mod attach;
pub mod seat;
pub mod submit;
mod terminal;
pub use attach::attach_and_replay;
use terminal::{broker_pane_alive, user_exit_reason};
pub use terminal::{mark_crash_terminal, mark_invocation_terminal};

const GAP_BACKFILL_DELAY: Duration = Duration::from_millis(250);
const BUSY_RETRY_WINDOW: Duration = Duration::from_secs(30);
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// A debounced backfill: (runtime, missing seqs, debounce generation).
type Gap = (String, BTreeSet<i64>, u64);

#[derive(Default)]
pub struct State {
    /// runtime -> active invocation (Bun's `active` map; the client is in Server.brokers)
    active: Mutex<HashMap<String, String>>,
    /// runtime -> intentional close reason (markBrokerClosing)
    closing: Mutex<HashMap<String, String>>,
    /// invocation -> (runtime, missing seqs, debounce generation)
    gaps: Mutex<HashMap<String, Gap>>,
    /// Runtimes a terminate is finalizing; their projected exit records nothing.
    terminating: Mutex<std::collections::HashSet<String>>,
    pub shutting_down: std::sync::atomic::AtomicBool,
}

/// Held while a terminate owns a runtime's terminal record.
pub struct Terminating<'a>(&'a Server, String);
impl Drop for Terminating<'_> {
    fn drop(&mut self) {
        self.0
            .controller
            .terminating
            .lock()
            .unwrap()
            .remove(&self.1);
    }
}
pub fn begin_terminating<'a>(server: &'a Server, runtime: &str) -> Terminating<'a> {
    server
        .controller
        .terminating
        .lock()
        .unwrap()
        .insert(runtime.to_owned());
    Terminating(server, runtime.to_owned())
}
pub fn is_terminating(server: &Server, runtime: &str) -> bool {
    server
        .controller
        .terminating
        .lock()
        .unwrap()
        .contains(runtime)
}

pub(super) fn log(level: &str, event: &str, data: Value) {
    super::stderr_json(level, "broker", event, data);
}
pub fn server_instance_id() -> String {
    format!("hrc-server:{}", std::process::id())
}
fn shutting(server: &Server) -> bool {
    server
        .controller
        .shutting_down
        .load(std::sync::atomic::Ordering::SeqCst)
}

pub fn set_active(server: &Server, runtime: &str, invocation: &str, client: JsonRpc) {
    server
        .controller
        .active
        .lock()
        .unwrap()
        .insert(runtime.to_owned(), invocation.to_owned());
    server
        .brokers
        .lock()
        .unwrap()
        .insert(runtime.to_owned(), client);
}
/// Publish an active binding and start its seat monitor (startSeatMonitor).
pub fn bind(server: &Shared, runtime: &str, invocation: &str, client: JsonRpc) {
    set_active(server, runtime, invocation, client.clone());
    seat::monitor(server, runtime, client, true);
}
pub fn delete_active(server: &Server, runtime: &str) {
    server.controller.active.lock().unwrap().remove(runtime);
    server.brokers.lock().unwrap().remove(runtime);
}
pub(super) fn active(server: &Server, runtime: &str) -> Option<(String, JsonRpc)> {
    let invocation = server
        .controller
        .active
        .lock()
        .unwrap()
        .get(runtime)
        .cloned()?;
    let client = server.brokers.lock().unwrap().get(runtime).cloned()?;
    Some((invocation, client))
}
pub fn mark_closing(server: &Server, runtime: &str, reason: &str) {
    server
        .controller
        .closing
        .lock()
        .unwrap()
        .insert(runtime.to_owned(), reason.to_owned());
}
pub fn intentional_close_reason(server: &Server, runtime: &str) -> Option<String> {
    server
        .controller
        .closing
        .lock()
        .unwrap()
        .get(runtime)
        .cloned()
}

/// handlePermissionRequest without a permission channel: the runtime's policy.
pub fn permission_handler(server: Weak<Server>) -> Inbound {
    Arc::new(move |method, params| {
        if method != "invocation.permission.request" {
            bail!("Unsupported broker-to-client request: {method}");
        }
        let Some(server) = server.upgrade() else {
            bail!("hrc server is shutting down");
        };
        let db = server.store.lock().unwrap();
        let invocation = db::invocation(&db.sqlite, params["invocationId"].as_str().unwrap_or(""))?;
        let runtime = match invocation {
            Some(i) => db::runtime(&db.sqlite, &i.runtime_id)?,
            None => None,
        };
        let mode = runtime
            .and_then(|r| r.state)
            .map(|s| s["permission"]["policy"]["mode"].clone())
            .unwrap_or(Value::Null);
        Ok(if mode == "allow" {
            json!({"decision":"allow","message":"Allowed by HRC policy."})
        } else {
            json!({"decision":"deny","message":"Denied by HRC policy: no permission request channel is configured."})
        })
    })
}

pub(super) fn last_projected(server: &Server, invocation: &str) -> Result<i64> {
    let db = server.store.lock().unwrap();
    Ok(db::invocation(&db.sqlite, invocation)?.map_or(0, |i| i.last_projected_seq))
}

/// ackCommittedProjection: ACK only what the durable cursor proves committed.
pub async fn ack(server: &Server, runtime: &str, invocation: &str) -> Result<()> {
    let Some((active_invocation, client)) = active(server, runtime) else {
        return Ok(());
    };
    if active_invocation != invocation {
        return Ok(());
    }
    let through = last_projected(server, invocation)?;
    if through <= 0 {
        return Ok(());
    }
    let ack = client
        .request(
            "invocation.ackEvents",
            json!({"invocationId":invocation,"throughSeq":through,"controllerInstanceId":server_instance_id()}),
        )
        .await?;
    let acked = ack["ackedThroughSeq"].as_i64().unwrap_or(0);
    ensure!(
        acked >= through,
        "broker_ack_incomplete: broker acknowledgement did not reach HRC committed projection cursor ({acked} < {through})"
    );
    Ok(())
}

fn busy(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        e.downcast_ref::<rusqlite::Error>().is_some_and(|e| {
            matches!(
                e.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            )
        })
    })
}
pub(super) fn apply_one(server: &Server, envelope: &Value) -> Result<Outcome> {
    let db = server.store.lock().unwrap();
    let mut mem = server.projection.lock().unwrap();
    let outcome = projection::apply(&db.sqlite, &mut mem, envelope)?;
    drop((mem, db));
    if !outcome.idempotent {
        server.ledger_committed();
    }
    Ok(outcome)
}
pub(super) fn flush(server: &Server, invocation: &str) -> Result<i64> {
    let db = server.store.lock().unwrap();
    let mut mem = server.projection.lock().unwrap();
    let through = projection::flush(&db.sqlite, &mut mem, invocation)?;
    drop((mem, db));
    server.ledger_committed();
    Ok(through)
}

/// projectBrokerEventWithBusyRetry
pub async fn project_live(server: &Shared, runtime: &str, envelope: &Value) -> Result<()> {
    let started = std::time::Instant::now();
    let mut attempt = 0u32;
    let invocation = envelope["invocationId"].as_str().unwrap_or("").to_owned();
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    loop {
        if shutting(server) {
            return Ok(());
        }
        // The fence covers the commit, never a broker RPC. A closed fence
        // drops the envelope unprojected and unACKed: it replays.
        let Some(write) = server.owner_writes.enter() else {
            return Ok(());
        };
        let result: Result<Option<Outcome>> = (|| {
            if projection::is_delta(envelope) {
                apply_one(server, envelope)?;
                return Ok(None);
            }
            flush(server, &invocation)?;
            let db = server.store.lock().unwrap();
            let inv = db::invocation(&db.sqlite, &invocation)?;
            match inv {
                Some(i) if i.runtime_id == runtime => {
                    let missing: Vec<i64> = ((i.last_projected_seq + 1)..seq)
                        .filter(|s| {
                            !projection::has_disposition(&db.sqlite, &invocation, *s)
                                .unwrap_or(false)
                        })
                        .collect();
                    drop(db);
                    if !missing.is_empty() {
                        log(
                            "warn",
                            "broker.event_gap_detected",
                            json!({"runtimeId":runtime,"invocationId":invocation,"missingSeqs":missing,"arrivedSeq":seq}),
                        );
                        schedule_gap(server, runtime, &invocation, missing);
                    }
                    Ok(Some(apply_one(server, envelope)?))
                }
                other => {
                    log(
                        "warn",
                        "dropped broker event for non-consuming runtime",
                        json!({"runtimeId":runtime,"invocationId":invocation,"invocationRuntimeId":other.map(|i|i.runtime_id),"eventType":envelope["type"],"seq":seq}),
                    );
                    Ok(None)
                }
            }
        })();
        drop(write);
        match result {
            Ok(None) => return Ok(()),
            Ok(Some(outcome)) => {
                ack(server, runtime, &invocation).await?;
                if outcome.capture_refresh {
                    refresh_capture(server, runtime, &invocation).await;
                }
                after_mapped(server, runtime, envelope, &outcome).await;
                return Ok(());
            }
            Err(error) if busy(&error) && started.elapsed() < BUSY_RETRY_WINDOW => {
                attempt += 1;
                let delay = Duration::from_millis((25u64 << attempt.min(6)).min(1000));
                log(
                    "warn",
                    "harness broker event persistence busy; retrying",
                    json!({"runtimeId":runtime,"invocationId":invocation,"eventType":envelope["type"],"seq":seq,"attempt":attempt}),
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn schedule_gap(server: &Shared, runtime: &str, invocation: &str, missing: Vec<i64>) {
    let generation = {
        let mut gaps = server.controller.gaps.lock().unwrap();
        let entry = gaps
            .entry(invocation.to_owned())
            .or_insert_with(|| (runtime.to_owned(), BTreeSet::new(), 0));
        entry.1.extend(missing);
        entry.2 += 1;
        entry.2
    };
    let server = server.clone();
    let invocation = invocation.to_owned();
    tokio::spawn(async move {
        tokio::time::sleep(GAP_BACKFILL_DELAY).await;
        let pending = {
            let mut gaps = server.controller.gaps.lock().unwrap();
            match gaps.get(&invocation) {
                Some(entry) if entry.2 == generation => gaps.remove(&invocation),
                _ => None,
            }
        };
        if let Some((runtime, missing, _)) = pending {
            backfill(
                &server,
                &runtime,
                &invocation,
                missing.into_iter().collect(),
            )
            .await;
        }
    });
}
/// flushBrokerEventGapBackfill: a terminal envelope repairs a debounced gap now.
async fn flush_gap(server: &Shared, invocation: &str) {
    let pending = server.controller.gaps.lock().unwrap().remove(invocation);
    if let Some((runtime, missing, _)) = pending {
        backfill(server, &runtime, invocation, missing.into_iter().collect()).await;
    }
}
async fn backfill(server: &Shared, runtime: &str, invocation: &str, candidates: Vec<i64>) {
    if shutting(server) {
        return;
    }
    let missing: Vec<i64> = {
        let db = server.store.lock().unwrap();
        candidates
            .into_iter()
            .filter(|s| !projection::has_disposition(&db.sqlite, invocation, *s).unwrap_or(false))
            .collect()
    };
    if missing.is_empty() {
        return;
    }
    let unrecoverable = |reason: &str, extra: Value| {
        let mut data = json!({"runtimeId":runtime,"invocationId":invocation,"missingSeqs":missing,"reason":reason});
        if let Value::Object(m) = extra {
            for (k, v) in m {
                data[k] = v;
            }
        }
        log("warn", "broker.event_gap_unrecoverable", data);
    };
    let Some((active_invocation, client)) =
        active(server, runtime).filter(|(i, _)| i == invocation)
    else {
        unrecoverable("client_unavailable", json!({}));
        // A terminal runtime's gap is repaired only from its retained evidence;
        // a non-terminal gap waits for the next live attach.
        let terminal = {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, runtime)
                .ok()
                .flatten()
                .is_some_and(|r| matches!(r.status.as_str(), "terminated" | "failed"))
        };
        if terminal {
            let (server, runtime) = (server.clone(), runtime.to_owned());
            tokio::spawn(async move {
                if let Err(error) = super::retained::recover(&server, &runtime, "gap").await {
                    log(
                        "warn",
                        "retained_evidence.gap_attempt_failed",
                        json!({"runtimeId":runtime,"error":format!("{error:#}")}),
                    );
                }
            });
        }
        return;
    };
    let _ = active_invocation;
    let after = missing[0] - 1;
    let result: Result<()> = async {
        let replay = client
            .request("invocation.eventsSince", json!({"invocationId":invocation,"afterSeq":after}))
            .await?;
        let floor = replay["retentionFloorSeq"].as_i64().unwrap_or(0);
        if floor > after {
            unrecoverable("retention_floor", json!({"retentionFloorSeq":floor}));
            return Ok(());
        }
        let mut repaired = Vec::new();
        for envelope in replay["events"].as_array().cloned().unwrap_or_default() {
            let seq = envelope["seq"].as_i64().unwrap_or(0);
            if !missing.contains(&seq) || {
                let db = server.store.lock().unwrap();
                projection::has_disposition(&db.sqlite, invocation, seq)?
            } {
                continue;
            }
            // Entered after eventsSince returned; refused = left unprojected.
            let Some(write) = server.owner_writes.enter() else {
                return Ok(());
            };
            let outcome = apply_one(server, &envelope)?;
            drop(write);
            if outcome.ignored_delta {
                continue;
            }
            ack(server, runtime, invocation).await?;
            Box::pin(after_mapped(server, runtime, &envelope, &outcome)).await;
            if !outcome.idempotent {
                repaired.push(seq);
            }
        }
        {
            let Some(_write) = server.owner_writes.enter() else {
                return Ok(());
            };
            flush(server, invocation)?;
        }
        ack(server, runtime, invocation).await?;
        if !repaired.is_empty() {
            log("warn", "broker.event_gap_backfilled", json!({"runtimeId":runtime,"invocationId":invocation,"repairedSeqs":repaired}));
        }
        let committed = last_projected(server, invocation)?;
        let still: Vec<i64> = {
            let db = server.store.lock().unwrap();
            missing
                .iter()
                .copied()
                .filter(|s| *s > committed && !projection::has_disposition(&db.sqlite, invocation, *s).unwrap_or(false))
                .collect()
        };
        if !still.is_empty() {
            log("warn", "broker.event_gap_unrecoverable", json!({"runtimeId":runtime,"invocationId":invocation,"missingSeqs":still,"reason":"events_not_in_ledger","currentSeq":replay["currentSeq"],"retentionFloorSeq":floor}));
        }
        Ok(())
    }
    .await;
    if let Err(error) = result
        && !shutting(server)
    {
        unrecoverable(&error.to_string(), json!({}));
    }
}

async fn refresh_capture(server: &Shared, runtime: &str, invocation: &str) {
    let Some((active_invocation, client)) = active(server, runtime) else {
        return;
    };
    if active_invocation != invocation {
        return;
    }
    match client
        .request("invocation.snapshot", json!({"invocationId":invocation}))
        .await
    {
        Ok(snapshot) => {
            let Some(_write) = server.owner_writes.enter() else {
                return;
            };
            if let Err(error) = project_capture_state(server, runtime, &snapshot["capture"]) {
                log(
                    "warn",
                    "broker capture snapshot refresh failed",
                    json!({"runtimeId":runtime,"invocationId":invocation,"error":error.to_string()}),
                );
            }
        }
        Err(error) => log(
            "warn",
            "broker capture snapshot refresh failed",
            json!({"runtimeId":runtime,"invocationId":invocation,"error":error.to_string()}),
        ),
    }
}
/// projectCaptureState: store the broker's capture view; announce a state flip.
pub fn project_capture_state(server: &Server, runtime_id: &str, capture: &Value) -> Result<()> {
    if capture.is_null() {
        return Ok(());
    }
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    let rt = db::runtime(&tx, runtime_id)?
        .with_context(|| format!("runtime not found for capture state: {runtime_id}"))?;
    let mut state = rt.state_object();
    let previous = state.get("capture").cloned();
    if previous.as_ref() == Some(capture) {
        return Ok(());
    }
    let now = hrc_store::timestamp();
    state["capture"] = capture.clone();
    db::update_runtime_state(&tx, runtime_id, &state, &now)?;
    let previous_state = previous.as_ref().map(|p| p["state"].clone());
    let flipped = previous_state.as_ref() != Some(&capture["state"])
        && (previous_state.is_some() || capture["state"] == "blocked");
    if flipped {
        let ev = projection::events::Ev {
            ts: now.clone(),
            host_session_id: rt.host_session_id.clone(),
            scope_ref: rt.scope_ref.clone(),
            lane_ref: rt.lane_ref.clone(),
            generation: rt.generation,
            runtime_id: Some(runtime_id.to_owned()),
            run_id: rt.active_run_id.clone(),
            transport: Some(projection::lifecycle_transport(&rt.transport).to_owned()),
            ..Default::default()
        };
        projection::events::append(
            &tx,
            "runtime.capture_state_changed",
            &ev,
            &json!({"previousCapture":previous,"capture":capture}),
        )?;
    }
    tx.commit()?;
    server.ledger_committed();
    Ok(())
}

const PROBE_TYPES: [&str; 5] = [
    "input.accepted",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
];
/// afterMappedEvent
pub async fn after_mapped(server: &Shared, runtime: &str, envelope: &Value, outcome: &Outcome) {
    let kind = envelope["type"].as_str().unwrap_or("").to_owned();
    let invocation = envelope["invocationId"].as_str().unwrap_or("").to_owned();
    let Some(write) = server.owner_writes.enter() else {
        return;
    };
    if !outcome.idempotent {
        let result: Result<()> = (|| {
            let db = server.store.lock().unwrap();
            let seq = envelope["seq"].as_i64().unwrap_or(0);
            let previous = db::invocation(&db.sqlite, &invocation)?
                .and_then(|i| i.last_event_seq)
                .unwrap_or(0);
            db::update_invocation(
                &db.sqlite,
                &invocation,
                &[
                    ("last_event_seq", db::int(previous.max(seq))),
                    ("updated_at", db::text(hrc_store::timestamp())),
                ],
            )?;
            let tx = db.sqlite.unchecked_transaction()?;
            if let Err(error) = projection::observe::record(
                &tx,
                runtime,
                envelope,
                outcome.run_id.as_deref(),
                &hrc_store::timestamp(),
            ) {
                drop(tx);
                log(
                    "warn",
                    "broker.dispatch_observability.failed",
                    json!({"runtimeId":runtime,"cause":format!("broker-event:{kind}"),"error":error.to_string()}),
                );
                return Ok(());
            }
            tx.commit()?;
            server.ledger_committed();
            Ok(())
        })();
        if let Err(error) = result {
            log(
                "warn",
                "broker.after_mapped.failed",
                json!({"runtimeId":runtime,"error":error.to_string()}),
            );
        }
        if PROBE_TYPES.contains(&kind.as_str()) {
            probe_in_background(server, runtime, &format!("broker-event:{kind}"));
        }
    }
    // Lever 2 graceful exit: a user-exit continuation clear schedules a
    // summary-aware lease reap (BROKER_TMUX_PROMPT_EXIT_REASONS).
    if kind == "continuation.cleared"
        && let Some(reason) = envelope["payload"]["reason"]
            .as_str()
            .filter(|r| matches!(*r, "prompt_input_exit" | "logout"))
    {
        log(
            "info",
            "broker-tmux prompt exit; scheduling summary-aware lease reap",
            json!({"runtimeId":runtime,"reason":reason,"graceMs":500}),
        );
        super::lease::reap_after_summary(server, runtime, &format!("prompt_exit:{reason}"));
    }
    if kind == "invocation.summary" {
        let db = server.store.lock().unwrap();
        if let Ok(Some(rt)) = db::runtime(&db.sqlite, runtime) {
            let mut state = rt.state_object();
            state["finalSummary"] = envelope["payload"].clone();
            let _ = db::update_runtime_state(&db.sqlite, runtime, &state, &hrc_store::timestamp());
        }
    }
    // Gap flushes below run broker RPCs; each takes its own guard.
    drop(write);
    let external = {
        let db = server.store.lock().unwrap();
        db::runtime(&db.sqlite, runtime)
            .ok()
            .flatten()
            .is_some_and(|r| is_external_lifecycle_owner(&r))
    };
    let terminal = kind == "invocation.exited"
        || (kind == "invocation.failed" && envelope["payload"]["retryable"] != true);
    if external && kind == "invocation.exited" {
        flush_gap(server, &invocation).await;
        log(
            "info",
            "broker.external_participant_terminal",
            json!({"runtimeId":runtime,"invocationId":invocation}),
        );
    } else if !external && terminal {
        flush_gap(server, &invocation).await;
        // Local writes and a tmux reap only: no broker RPC under the guard.
        let Some(_write) = server.owner_writes.enter() else {
            return;
        };
        if let Err(error) =
            mark_invocation_terminal(server, runtime, envelope, outcome.idempotent).await
        {
            log(
                "warn",
                "broker.invocation_terminal.failed",
                json!({"runtimeId":runtime,"error":error.to_string()}),
            );
        }
    }
    if kind == "invocation.disposed" {
        flush_gap(server, &invocation).await;
    }
}

pub fn is_external_lifecycle_owner(rt: &db::Rt) -> bool {
    rt.state.as_ref().is_some_and(|s| {
        s["lifecycleOwner"] == "external"
            || s["participant"]["lifecycleOwner"] == "externally-owned"
    })
}

pub fn probe_in_background(server: &Shared, runtime_id: &str, cause: &str) {
    seat::probe_in_background(server, runtime_id, cause);
}

/// consumeEvents: project the live stream until the transport closes.
pub fn consume(
    server: &Shared,
    runtime_id: &str,
    mut events: mpsc::UnboundedReceiver<Value>,
    client: JsonRpc,
) {
    let server = server.clone();
    let runtime_id = runtime_id.to_owned();
    tokio::spawn(async move {
        let mut last = None;
        let mut failure = None;
        while let Some(envelope) = events.recv().await {
            if shutting(&server) {
                return;
            }
            last = envelope["invocationId"].as_str().map(str::to_owned);
            if let Err(error) = project_live(&server, &runtime_id, &envelope).await {
                failure = Some(error);
                break;
            }
        }
        if shutting(&server) {
            return;
        }
        if failure.is_none()
            && let Some(invocation) = &last
        {
            {
                let Some(_write) = server.owner_writes.enter() else {
                    return;
                };
                let _ = flush(&server, invocation);
            }
            let _ = ack(&server, &runtime_id, invocation).await;
        }
        // A superseded client's close never speaks for the runtime.
        let current = server.brokers.lock().unwrap().get(&runtime_id).cloned();
        if current.is_some_and(|c| !c.same(&client)) {
            return;
        }
        let error = failure.map_or_else(
            || "broker transport closed".to_owned(),
            |e| format!("{e:#}"),
        );
        if let Some(reason) = intentional_close_reason(&server, &runtime_id) {
            log(
                "info",
                "harness broker process closed intentionally",
                json!({"runtimeId":runtime_id,"reason":reason,"error":error}),
            );
            delete_active(&server, &runtime_id);
            return;
        }
        let user_exit = {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, &runtime_id)
                .ok()
                .flatten()
                .and_then(|r| r.active_invocation_id)
                .and_then(|i| user_exit_reason(&db.sqlite, &i, None).ok().flatten())
        };
        if let Some(reason) = user_exit {
            log(
                "info",
                "harness broker closed after user-initiated exit; reaping lease",
                json!({"runtimeId":runtime_id,"userExitReason":reason,"error":error}),
            );
            delete_active(&server, &runtime_id);
            let Some(_write) = server.owner_writes.enter() else {
                return;
            };
            super::lease::reap(&server, &runtime_id, "broker_close").await;
            return;
        }
        if broker_pane_alive(&server, &runtime_id).await {
            log(
                "warn",
                "runtime.condemnation_averted",
                json!({"runtimeId":runtime_id,"brokerErrorCode":"broker_event_consumer_failed","error":error}),
            );
            delete_active(&server, &runtime_id);
            return;
        }
        let Some(_write) = server.owner_writes.enter() else {
            return;
        };
        log(
            "error",
            "harness broker event consumer failed",
            json!({"runtimeId":runtime_id,"error":error}),
        );
        try_mark_crash(
            server.clone(),
            runtime_id.clone(),
            error,
            1,
            std::time::Instant::now(),
        );
    });
}

/// tryMarkBrokerCrashTerminal: a crash-terminal bookkeeping write that fails
/// retries (3 attempts at 1 s·2^n; under SQLITE_BUSY, within the 15 s busy
/// window) so a crashed broker never leaves its runtime non-terminal.
fn try_mark_crash(
    server: Shared,
    runtime_id: String,
    error: String,
    attempt: u32,
    started: std::time::Instant,
) {
    if shutting(&server) {
        return;
    }
    let Err(store_error) =
        mark_crash_terminal(&server, &runtime_id, "broker_process_closed", &error)
    else {
        return;
    };
    let sqlite_busy = busy(&store_error);
    let elapsed = started.elapsed();
    let scheduled = if sqlite_busy {
        elapsed < Duration::from_secs(15)
    } else {
        attempt < 3
    };
    log(
        "error",
        "harness broker crash bookkeeping failed",
        json!({"runtimeId":runtime_id,"brokerErrorCode":"broker_process_closed","error":format!("{store_error:#}"),"attempt":attempt,"sqliteBusy":sqlite_busy,"elapsedMs":elapsed.as_millis() as u64,"retryWindowMs":15000,"retryScheduled":scheduled}),
    );
    if !scheduled {
        return;
    }
    let next = attempt + 1;
    let delay = if sqlite_busy {
        let exponential = Duration::from_millis((100u64 << (next - 2).min(10)).min(1000));
        exponential.min(Duration::from_secs(15).saturating_sub(elapsed))
    } else {
        Duration::from_millis(1000u64 << (next - 2))
    };
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let Some(_write) = server.owner_writes.enter() else {
            return;
        };
        try_mark_crash(server.clone(), runtime_id, error, next, started);
    });
}
